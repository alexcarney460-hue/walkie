// Pure pieces of the integrations: parsers, mention mapping, secrets, config, transitions, backoff.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadIntegrations, saveIntegrations } from "../../src/integrations/config.ts";
import { formatMeeting, formatTranscript, type TranscriptMeta } from "../../src/integrations/fireflies.ts";
import { graphql, ExternalError } from "../../src/integrations/http.ts";
import { issueKeysIn, transitionsOf, type LinearIssue } from "../../src/integrations/linear.ts";
import { annotateMentions, teammatesIn } from "../../src/integrations/mentions.ts";
import { readKeyFile, resolveKey, scrub, storeSecret, SecretError } from "../../src/integrations/secrets.ts";
import { summarizeWithClaude } from "../../src/integrations/summarize.ts";
import { completedMeetings, parseClock, readMeeting } from "../../src/integrations/wispr.ts";
import { parseShareJson, parseSharePage, shareLinks } from "../../src/integrations/wispr-unfurl.ts";
import { redactSecrets } from "../../src/protocol/safety.ts";
import { z } from "zod";

const root = mkdtempSync("/tmp/walkie-int-unit-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const FIXTURES = join(import.meta.dir, "..", "fixtures");

const TEAM = [
  { handle: "maren", display_name: "Maren Okafor" },
  { handle: "kira", display_name: "Kira Moore" },
  { handle: "sol" },
];

describe("mention mapping", () => {
  test("matches handle, full display name and first name, case-insensitive, whole words", () => {
    expect(teammatesIn("KIRA MOORE to ship it", TEAM)).toEqual(["kira"]);
    expect(teammatesIn("maren reviews", TEAM)).toEqual(["maren"]);
    expect(teammatesIn("ask Sol about it", TEAM)).toEqual(["sol"]);
    expect(teammatesIn("solve the billing bug", TEAM)).toEqual([]); // "sol" inside a word
    expect(teammatesIn("Marenko is not Maren", TEAM)).toEqual(["maren"]);
    expect(teammatesIn("email kira@example.com", TEAM)).toEqual(["kira"]);
  });
  test("annotates only lines that name someone, and doesn't double-mention", () => {
    const out = annotateMentions("**Kira Moore**\nShip it\nMaren and Sol pair on it\n@kira already here", TEAM);
    expect(out.split("\n")).toEqual(["**Kira Moore** → @kira", "Ship it", "Maren and Sol pair on it → @maren @sol", "@kira already here"]);
  });
});

describe("fireflies formatting", () => {
  const t: TranscriptMeta = {
    id: "t1", title: "Weekly sync", date: Date.UTC(2026, 8, 24, 15, 0), duration: 31.6, transcript_url: "https://app.fireflies.ai/view/t1",
    participants: ["a@x.example", "b@x.example"], speakers: [{ name: "Kira Moore" }, { name: "Kira Moore" }, { name: "Maren Okafor" }],
    summary: { overview: "Invoices in cents.", action_items: "**Kira Moore**\nShip the dry run", keywords: ["billing", null] },
  };
  test("post carries title, date, duration, speakers, overview, action items with mentions, link", () => {
    const text = formatMeeting(t, TEAM);
    expect(text).toContain("**Meeting: Weekly sync**");
    expect(text).toContain("2026-09-24 15:00 UTC · 32 min · 2 participants");
    expect(text).toContain("Speakers: Kira Moore, Maren Okafor");
    expect(text).toContain("**Kira Moore** → @kira");
    expect(text).toContain("Transcript in Fireflies: https://app.fireflies.ai/view/t1");
    expect(text).not.toContain("a@x.example"); // participant emails are counted, not posted
  });
  test("non-https transcript links are dropped", () => {
    expect(formatMeeting({ ...t, transcript_url: "javascript:alert(1)" }, TEAM)).not.toContain("javascript:");
  });
  test("transcript artifact is Speaker: text lines with timestamps", () => {
    const out = formatTranscript(t, [{ speaker_name: "Kira Moore", text: "hello", start_time: 65 }, { speaker_name: null, text: "  ", start_time: 70 }]);
    expect(out).toContain("[1:05] Kira Moore: hello");
    expect(out.split("\n").filter((l) => l.startsWith("[")).length).toBe(1);
  });
});

describe("graphql client", () => {
  const S = z.object({ viewer: z.object({ id: z.string() }) });
  const call = (res: Response) => graphql({ fetch: async () => res, url: "https://x.example/graphql", auth: "k", service: "svc", query: "{ viewer { id } }" }, S);
  test("parses data and validates shape", async () => {
    expect(await call(Response.json({ data: { viewer: { id: "u1" } } }))).toEqual({ viewer: { id: "u1" } });
    await expect(call(Response.json({ data: { viewer: { id: 7 } } }))).rejects.toBeInstanceOf(ExternalError);
  });
  test("401 names the key problem; GraphQL errors without data fail; oversize is refused", async () => {
    await expect(call(new Response("{}", { status: 401 }))).rejects.toThrow("check the API key");
    await expect(call(Response.json({ data: null, errors: [{ message: "Entity not found" }] }))).rejects.toThrow("Entity not found");
    const huge = new Response("x".repeat(10), { headers: { "content-length": String(64 * 1024 * 1024) } });
    await expect(call(huge)).rejects.toThrow("larger than");
  });
  test("network failure becomes an ExternalError without details", async () => {
    await expect(graphql({ fetch: async () => { throw new Error("ECONNREFUSED 10.0.0.1"); }, url: "u", auth: "k", service: "svc", query: "q" }, S)).rejects.toThrow("svc: network error");
  });
});

describe("secrets and config", () => {
  test("key files: absolute or ~/, regular, small, one token; messages never include content", () => {
    const good = join(root, "good.txt");
    writeFileSync(good, "fixture_key_ABCDEFGH12345\n", { mode: 0o600 });
    expect(readKeyFile(good)).toBe("fixture_key_ABCDEFGH12345");
    const multi = join(root, "multi.txt");
    writeFileSync(multi, "line one secretvalue\nline two", { mode: 0o600 });
    try { readKeyFile(multi); throw new Error("should fail"); } catch (err) {
      expect(err).toBeInstanceOf(SecretError);
      expect((err as Error).message).not.toContain("secretvalue");
    }
    expect(() => readKeyFile("relative/key.txt")).toThrow("absolute");
    expect(() => readKeyFile(join(root, "missing.txt"))).toThrow("not found");
    expect(() => readKeyFile(root)).toThrow("not a regular file");
  });
  test("stored secrets are 0600 in a 0700 dir and win over key_path", () => {
    const home = join(root, "home1");
    mkdirSync(home);
    storeSecret(home, "fireflies", "stored_key_1234567890");
    expect(statSync(join(home, "secrets")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "secrets", "fireflies")).mode & 0o777).toBe(0o600);
    const kp = join(root, "kp.txt");
    writeFileSync(kp, "file_key_1234567890", { mode: 0o600 });
    expect(resolveKey(home, "fireflies", kp)).toBe("stored_key_1234567890");
    expect(resolveKey(home, "linear", kp)).toBe("file_key_1234567890");
    expect(resolveKey(home, "linear", undefined)).toBeNull();
  });
  test("scrub removes the known key and secret-shaped strings and caps length", () => {
    const out = scrub(`denied for Bearer abcdefgh12345678 and lin_api_${"a".repeat(30)}${"x".repeat(400)}`, "abcdefgh12345678");
    expect(out).not.toContain("abcdefgh12345678");
    expect(out).not.toContain("lin_api_");
    expect(out.length).toBeLessThanOrEqual(300);
  });
  test("integrations.json is written 0600 atomically and validated on load", () => {
    const p = join(root, "integrations.json");
    saveIntegrations(p, { fireflies: { enabled: true, channel: "meetings", key_path: "~/keys/x.txt" } });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(loadIntegrations(p).fireflies?.channel).toBe("meetings");
    writeFileSync(p, JSON.stringify({ fireflies: { enabled: true, key: "inline-keys-are-not-a-setting" } }));
    expect(() => loadIntegrations(p)).toThrow("integrations.json invalid");
  });
});

describe("wispr meetings watcher", () => {
  const dir = join(root, "meetings");
  const now = Date.now();
  const minsAgo = (m: number) => new Date(now - m * 60_000);
  function meeting(id: string, refinedAgeMin: number, liveAgeMin: number | null, lines: unknown[]): void {
    const d = join(dir, id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "refined.ndjson"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    utimesSync(join(d, "refined.ndjson"), minsAgo(refinedAgeMin), minsAgo(refinedAgeMin));
    if (liveAgeMin !== null) {
      writeFileSync(join(d, "live.ndjson"), [
        JSON.stringify({ meta: { clock: "fixture", v: 1 } }),
        JSON.stringify({ id: "s1", segment: 0, text: "x", timestamp: null, startEpochMs: Date.UTC(2026, 8, 24, 16, 0), endEpochMs: Date.UTC(2026, 8, 24, 16, 1), startRecordingMs: 0, endRecordingMs: 1, speaker: { id: 0, name: "Maren Okafor", source: "fixture" } }),
      ].join("\n") + "\n");
      utimesSync(join(d, "live.ndjson"), minsAgo(liveAgeMin), minsAgo(liveAgeMin));
    }
  }
  const lines = [
    { id: "a", timestamp: "00:05", text: "Kicking off the billing review.", speaker: { id: 0, name: null, source: "fixture" } },
    { id: "b", timestamp: "01:40", text: "Staging snapshot is restored.", speaker: { id: 1, name: null, source: "fixture" } },
    { id: "c", timestamp: "1:02:10", text: "Wrap up.", speaker: { id: 1, name: "Tobias", source: "fixture" } },
    "not json at all",
  ];
  meeting("11111111-aaaa-4aaa-8aaa-111111111111", 30, 30, lines); // complete
  meeting("22222222-bbbb-4bbb-8bbb-222222222222", 30, 2, lines); // still recording (live is fresh)
  meeting("33333333-cccc-4ccc-8ccc-333333333333", 3, null, lines); // refined still settling
  meeting("44444444-dddd-4ddd-8ddd-444444444444", 60 * 48, null, lines); // older than the cursor
  mkdirSync(join(dir, ".observations-tmp"), { recursive: true });

  test("parseClock handles mm:ss and h:mm:ss", () => {
    expect(parseClock("00:05")).toBe(5);
    expect(parseClock("1:02:10")).toBe(3730);
    expect(parseClock(null)).toBeNull();
    expect(parseClock("5 min")).toBeNull();
  });
  test("only settled, not-recording meetings newer than the cursor are complete", () => {
    const got = completedMeetings(dir, now, 10 * 60_000, now - 24 * 3_600_000).map((m) => m.id);
    expect(got).toEqual(["11111111-aaaa-4aaa-8aaa-111111111111"]);
  });
  test("reads speakers (names from live.ndjson), duration from timestamps, start from live", () => {
    const m = readMeeting(join(dir, "11111111-aaaa-4aaa-8aaa-111111111111"), "11111111-aaaa-4aaa-8aaa-111111111111");
    expect(m?.segments.length).toBe(3);
    expect(m?.segments[0]?.speaker).toBe("Maren Okafor"); // id 0 named in live.ndjson
    expect(m?.segments[1]?.speaker).toBe("Speaker 2");
    expect(m?.segments[2]?.speaker).toBe("Tobias");
    expect(m?.durationS).toBe(3730 - 5);
    expect(m?.startedAt).toBe(Date.UTC(2026, 8, 24, 16, 0));
  });
});

describe("claude summarizer (fake CLI)", () => {
  function fakeBin(name: string, script: string): string {
    const p = join(root, name);
    writeFileSync(p, `#!/bin/sh\n${script}\n`);
    chmodSync(p, 0o755);
    return p;
  }
  test("passes no-tools flags, reads the transcript on stdin, returns stdout", async () => {
    const argsFile = join(root, "args.txt");
    const bin = fakeBin("claude-ok", `printf '%s\\n' "$@" > ${argsFile}; printf 'Summary:\\n- got %s bytes\\n' "$(wc -c | tr -d ' ')"; test -z "$WALKIE_AGENT" || exit 9`);
    const out = await summarizeWithClaude("Maren: hello\n", { bin });
    expect(out).toContain("Summary:");
    expect(out).toContain("got 13 bytes");
    const args = readFileSync(argsFile, "utf8").split("\n");
    expect(args).toContain("-p");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
  });
  test("failure, missing CLI and timeout all yield null", async () => {
    expect(await summarizeWithClaude("x", { bin: fakeBin("claude-fail", "exit 3") })).toBeNull();
    expect(await summarizeWithClaude("x", { bin: null })).toBeNull();
    expect(await summarizeWithClaude("x", { bin: join(root, "does-not-exist") })).toBeNull();
    const t0 = Date.now();
    expect(await summarizeWithClaude("x", { bin: fakeBin("claude-slow", "sleep 5; echo late"), timeoutMs: 300 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});

describe("wispr share links", () => {
  test("finds share links only on the exact host and path", () => {
    const links = shareLinks("see https://notes.wisprflow.ai/shared/Ab_12-xyZ and https://notes.wisprflow.ai.evil.example/shared/abcd and http://notes.wisprflow.ai/shared/plain https://notes.wisprflow.ai/shared/Ab_12-xyZ again");
    expect(links).toEqual([{ slug: "Ab_12-xyZ", url: "https://notes.wisprflow.ai/shared/Ab_12-xyZ" }]);
  });
  test("parses a server-rendered share page: og title, main text, no scripts", () => {
    const note = parseSharePage(readFileSync(join(FIXTURES, "wispr-share.html"), "utf8"));
    expect(note?.title).toBe("Kestrel standup & billing plan");
    expect(note?.text).toContain("Maren confirmed the invoice totals move to integer cents this sprint.");
    expect(note?.text).toContain("- Ines reviews the checkout summary copy — due Friday.");
    expect(note?.text).not.toContain("script");
    expect(note?.text).not.toContain("Sign in"); // outside <main>
  });
  test("a JS-only page yields nothing", () => {
    expect(parseSharePage(readFileSync(join(FIXTURES, "wispr-share-jsonly.html"), "utf8"))).toBeNull();
  });
  test("share JSON fallback: title + summary/notes strings", () => {
    expect(parseShareJson({ title: "Plan", summary: "Decided to ship on Friday after review.", notes: { blocks: ["Owner: Tobias"] } }))
      .toEqual({ title: "Plan", text: "Decided to ship on Friday after review.\n\nOwner: Tobias" });
    expect(parseShareJson({ title: "Empty", summary: null, notes: null })).toBeNull();
  });
});

describe("linear", () => {
  test("issue keys in text", () => {
    expect(issueKeysIn("fixing ALE-5156 and KST-1, not ALE-0 or x-ALE-2 or ALE-12a")).toEqual(["ALE-5156", "KST-1"]);
  });
  const base: LinearIssue = {
    id: "u1", identifier: "KST-1", title: "t", url: "https://linear.app/k/issue/kst-1", updatedAt: "2026-09-25T10:00:00.000Z",
    state: { id: "st-done", name: "Done", type: "completed" }, history: { nodes: [] },
  };
  test("history entries after the snapshot become transitions, oldest first", () => {
    const issue: LinearIssue = { ...base, history: { nodes: [
      { id: "h2", createdAt: "2026-09-25T10:00:00.000Z", fromState: { name: "In Progress" }, toState: { id: "st-done", name: "Done" }, actor: { name: "Kira" } },
      { id: "h1", createdAt: "2026-09-25T09:00:00.000Z", fromState: { name: "Todo" }, toState: { id: "st-ip", name: "In Progress" }, actor: null },
      { id: "h0", createdAt: "2026-09-20T09:00:00.000Z", fromState: null, toState: { id: "st-todo", name: "Todo" }, actor: null },
    ] } };
    const t = transitionsOf(issue, { state_id: "st-todo", state_name: "Todo", updated_at: "2026-09-24T00:00:00.000Z" }, 0);
    expect(t.map((x) => `${x.ext} ${x.from}->${x.to}`)).toEqual(["h:h1 Todo->In Progress", "h:h2 In Progress->Done"]);
  });
  test("without history, a changed snapshot state is one transition; an unseen issue is a silent baseline", () => {
    expect(transitionsOf(base, { state_id: "st-ip", state_name: "In Progress", updated_at: "2026-09-24T00:00:00.000Z" }, 0).map((x) => `${x.from}->${x.to}`)).toEqual(["In Progress->Done"]);
    expect(transitionsOf(base, null, 0)).toEqual([]);
  });
});
