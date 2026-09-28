// INTEGRATIONS-FIX-2: regression tests for the Codex re-audit
// (docs/audits/2026-09-26-hestia-codex-integrations-fix1.md). Unit level: a Core over a throwaway store.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS, Store } from "../../src/daemon/store.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { slug } from "../../src/integrations/fireflies.ts";
import { issuesByKeys, toInfo } from "../../src/integrations/linear.ts";
import { scrubDeep, scrubSecrets } from "../../src/integrations/scrub.ts";
import { macAclRefusal, posixAclRefusal, readKeyFile } from "../../src/integrations/secrets.ts";
import type { FetchLike } from "../../src/integrations/types.ts";
import { formatWisprMeeting, readMeeting } from "../../src/integrations/wispr.ts";
import { excerpt, parseSharePage, parseShareJson } from "../../src/integrations/wispr-unfurl.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function authority() {
  const a = tnode("alex");
  const { team, create } = createTeam(a);
  const core = makeCore(a, team, cleanups);
  core.ingest(create, "local");
  core.emit("channel.upsert", { name: "general" });
  return { a, team, core };
}

/** Frames an SSE client of the hub receives (the dashboard's /v1/stream). */
async function sseClient(core: ReturnType<typeof authority>["core"]): Promise<{ frames: () => string; close: () => void }> {
  const ctrl = new AbortController();
  const res = core.hub.open(null, [], ctrl.signal);
  if (!res?.body) throw new Error("no SSE stream");
  const reader = res.body.getReader();
  let text = "";
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += new TextDecoder().decode(value);
    }
  })();
  await Bun.sleep(5);
  return { frames: () => text, close: () => ctrl.abort() };
}

// ---- #1 rolled-back emits never escape ----------------------------------------------------------------

describe("#1 an emit inside a transaction that rolls back", () => {
  test("publishes nothing (no listener, no SSE, no push); the seq is reused by a new event whose content is what escapes", async () => {
    const { core } = authority();
    const seen: Event[] = [];
    const pushed: Event[] = [];
    core.hub.subscribe((ev) => seen.push(ev));
    core.onLocalEvent = (ev) => pushed.push(ev);
    const sse = await sseClient(core);
    const seqBefore = core.store.allocatedSelfSeq(core.nodeId);
    let rolledBackId = "";
    expect(() => core.store.transaction(() => {
      const ev = core.emit("msg.post", { text: "SECRET-ROLLED-BACK" }, { channel: "general" });
      rolledBackId = ev.id;
      throw new Error("ledger write failed");
    })).toThrow("ledger write failed");
    await Bun.sleep(20);
    expect(core.store.getRow(rolledBackId)).toBeNull();
    expect(core.store.allocatedSelfSeq(core.nodeId)).toBe(seqBefore);
    expect(seen.map((e) => e.id)).toEqual([]);
    expect(pushed).toEqual([]);
    expect(sse.frames()).not.toContain("SECRET-ROLLED-BACK");
    // The next emit takes that seq again, with different content: the only copy anyone ever sees.
    const next = core.emit("msg.post", { text: "the real one" }, { channel: "general" });
    await Bun.sleep(20);
    expect(next.id).toBe(rolledBackId);
    expect(seen.map((e) => e.id)).toEqual([next.id]);
    expect(pushed.map((e) => e.id)).toEqual([next.id]);
    expect(sse.frames()).toContain("the real one");
    expect(sse.frames()).not.toContain("SECRET-ROLLED-BACK");
    sse.close();
  });

  test("effects of a committed transaction fire once, after the commit, in order; a nested rollback drops only its own", async () => {
    const { core } = authority();
    const order: string[] = [];
    core.hub.subscribe((ev) => order.push(`pub:${String((ev.body as { text?: string }).text)}`));
    core.onLocalEvent = (ev) => order.push(`push:${String((ev.body as { text?: string }).text)}`);
    core.store.transaction(() => {
      core.emit("msg.post", { text: "a" }, { channel: "general" });
      order.push("in-tx");
      try {
        core.store.transaction(() => {
          core.emit("msg.post", { text: "b" }, { channel: "general" });
          throw new Error("inner");
        });
      } catch { /* the savepoint rolled back */ }
      core.emit("msg.post", { text: "c" }, { channel: "general" });
    });
    expect(order).toEqual(["in-tx", "pub:a", "push:a", "pub:c", "push:c"]);
    const texts = core.store.queryEvents({ kinds: ["msg.post"], limit: 10 }).map((r) => (JSON.parse(r.json) as Event).body.text);
    expect(texts.sort()).toEqual(["a", "c"]);
  });
});

// ---- #2/#3 structured fields are scrubbed before caching, formatting, truncation ------------------------

/** A configured key that no pattern recognises: only exact-match scrubbing can catch it. */
const OPAQUE = "q7Vw2xL9pRb4nTc8sHd1kYf6mZa3uEj0"; // 32 chars
const harmless = (n: number): string => "h".repeat(n);
const leaked = (s: string): boolean => s.includes(OPAQUE.slice(0, 8));
const scrub = (s: string): string => scrubSecrets(s, [OPAQUE]);

describe("#2 scrubDeep", () => {
  test("scrubs every string leaf (known keys and patterns), leaves numbers/booleans/nulls and shape alone", () => {
    const sk = `sk-${"a".repeat(26)}`;
    const out = scrubDeep({ t: `x ${OPAQUE} y`, n: 3, b: false, z: null, a: [`${sk}`, { d: OPAQUE }] }, [OPAQUE]);
    expect(out).toEqual({ t: "x [REDACTED:key] y", n: 3, b: false, z: null, a: ["[REDACTED:openai_key]", { d: "[REDACTED:key]" }] });
  });
});

describe("#3 the key is scrubbed before every truncation site (32-char opaque key after N harmless characters)", () => {
  test("Linear fields: title(300), state(60), assignee(80), priority label(30), state type(30) via issuesByKeys + toInfo", async () => {
    const issue = {
      id: "uuid-1", identifier: "KST-1", url: "https://linear.app/kestrel/issue/kst-1", priority: 2, updatedAt: new Date().toISOString(),
      title: harmless(269) + OPAQUE, priorityLabel: harmless(10) + OPAQUE, team: { key: "KST" },
      state: { id: "st", name: harmless(29) + OPAQUE, type: harmless(5) + OPAQUE },
      assignee: { name: null, displayName: harmless(49) + OPAQUE },
      history: { nodes: [{ id: "h1", createdAt: new Date().toISOString(), fromState: { name: harmless(3) + OPAQUE }, toState: { id: "s2", name: OPAQUE }, actor: { name: OPAQUE } }] },
    };
    const fetch: FetchLike = async () => Response.json({ data: { issues: { nodes: [issue] } } });
    const [got] = await issuesByKeys({ fetch, key: OPAQUE, secrets: () => [OPAQUE] }, ["KST-1"], true);
    expect(got).toBeDefined();
    expect(leaked(JSON.stringify(got))).toBe(false);
    const info = toInfo(got!);
    expect(leaked(JSON.stringify(info))).toBe(false);
    expect(info.title.length).toBeLessThanOrEqual(300);
    expect(info.title).toContain("[REDACTED:key]");
  });

  test("Wispr speaker names (80) from refined.ndjson and live.ndjson, and the excerpt line (199)", () => {
    const dir = mkdtempSync("/tmp/walkie-wispr-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const m = join(dir, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
    mkdirSync(m, { recursive: true });
    writeFileSync(join(m, "refined.ndjson"), [
      JSON.stringify({ id: "1", timestamp: "00:01", text: harmless(170) + OPAQUE + " end", speaker: { id: 0, name: harmless(49) + OPAQUE, source: "x" } }),
      JSON.stringify({ id: "2", timestamp: "00:02", text: "hello", speaker: { id: 1, name: null, source: "x" } }),
    ].join("\n") + "\n");
    writeFileSync(join(m, "live.ndjson"), JSON.stringify({ startEpochMs: 1, endEpochMs: 2, speaker: { id: 1, name: harmless(49) + OPAQUE } }) + "\n");
    const meeting = readMeeting(m, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", scrub);
    expect(meeting).not.toBeNull();
    const text = formatWisprMeeting(meeting!, null, []);
    expect(leaked(JSON.stringify(meeting))).toBe(false);
    expect(leaked(text)).toBe(false);
    expect(meeting!.speakers.every((s) => s.length <= 80)).toBe(true);
    expect(text).toContain("[REDACTED:key]");
  });

  test("Wispr share title (200) from the page and the JSON endpoint, and the reply excerpt (600)", () => {
    const html = `<html><head><meta property="og:title" content="${harmless(170)}${OPAQUE}"></head><body><article>${harmless(570)}${OPAQUE} and more words here to pass the minimum</article></body></html>`;
    const page = parseSharePage(html, scrub);
    expect(page).not.toBeNull();
    expect(leaked(JSON.stringify(page))).toBe(false);
    expect(page!.title.length).toBeLessThanOrEqual(200);
    expect(leaked(excerpt(page!.text))).toBe(false);
    const j = parseShareJson({ title: harmless(170) + OPAQUE, summary: harmless(570) + OPAQUE + " and more words here to pass the minimum", notes: [] }, scrub);
    expect(leaked(JSON.stringify(j))).toBe(false);
    expect(j!.title.length).toBeLessThanOrEqual(200);
  });

  test("Fireflies filename slug (60)", () => {
    expect(slug(scrub(harmless(30) + OPAQUE))).not.toContain(OPAQUE.slice(0, 8).toLowerCase());
    expect(slug(harmless(30) + OPAQUE)).toContain(OPAQUE.slice(0, 8).toLowerCase()); // the site relies on scrubbing first
  });
});

// ---- F5 migration: pre-fix deliberate skips never become retryable claims -------------------------------------

describe("F5 migration 9", () => {
  test("rows migration 8 turned into claims (event_id NULL, claimed_at 0) are posted (skipped) again; a released half-done row and a live claim are untouched", () => {
    const dir = mkdtempSync("/tmp/walkie-mig-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "walkie.db");
    const raw = new Database(path, { create: true, strict: true });
    raw.exec("CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (let i = 0; i < 8; i++) { // a store as INTEGRATIONS-FIX-1 left it (migration 8 applied)
      raw.exec(MIGRATIONS[i] as string);
      raw.query("INSERT INTO migrations(version, applied_at) VALUES (?, ?)").run(i + 1, 1);
    }
    const ins = raw.query("INSERT INTO integration_items(connector, external_id, event_id, created_at, state, claimed_at, share_id) VALUES (?,?,?,?,?,?,?)");
    ins.run("wispr", "skip-1", null, 1, "claimed", 0, null);          // a pre-fix deliberate skip, made a claim by migration 8
    ins.run("fireflies", "half-1", "0123456789abcdef:7", 1, "claimed", 0, null); // released after its post: completes its share
    ins.run("fireflies", "live-1", null, 1, "claimed", Date.now(), null);      // a live claim
    raw.close();
    const store = new Store(path);
    cleanups.push(() => store.close());
    const rows = store.db.query<{ external_id: string; state: string; claimed_at: number | null; event_id: string | null }, []>(
      "SELECT external_id, state, claimed_at, event_id FROM integration_items ORDER BY external_id").all();
    expect(rows).toEqual([
      { external_id: "half-1", state: "claimed", claimed_at: 0, event_id: "0123456789abcdef:7" },
      { external_id: "live-1", state: "claimed", claimed_at: expect.any(Number), event_id: null },
      { external_id: "skip-1", state: "posted", claimed_at: null, event_id: null },
    ]);
    expect((rows[1]?.claimed_at ?? 0) > 0).toBe(true);
  });
});

// ---- #9 / F6 ACLs on key files ------------------------------------------------------------------------------

describe("#9 key files with ACLs", () => {
  const darwin = process.platform === "darwin";
  const run = (cmd: string[]) => Bun.spawnSync(cmd);

  test.if(darwin)("macOS: an ACL entry granting another principal access is refused with the chmod -N hint; deny entries and a clean file pass", () => {
    const dir = mkdtempSync("/tmp/walkie-acl-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = join(dir, "key.txt");
    writeFileSync(f, "acl_key_0123456789abcdef\n", { mode: 0o600 });
    expect(readKeyFile(f)).toBe("acl_key_0123456789abcdef");
    expect(run(["chmod", "+a", "everyone allow read", f]).exitCode).toBe(0);
    expect(() => readKeyFile(f)).toThrow(/chmod -N \S*\/key\.txt/); // the fix names the file's real path (/tmp → /private/tmp on macOS)
    expect(() => readKeyFile(f)).toThrow(/ACL/);
    expect(run(["chmod", "-N", f]).exitCode).toBe(0);
    expect(readKeyFile(f)).toBe("acl_key_0123456789abcdef");
    expect(run(["chmod", "+a", "group:staff allow write", f]).exitCode).toBe(0);
    expect(() => readKeyFile(f)).toThrow("chmod -N");
    expect(run(["chmod", "-N", f]).exitCode).toBe(0);
    expect(run(["chmod", "+a", "group:staff deny write", f]).exitCode).toBe(0);
    expect(readKeyFile(f)).toBe("acl_key_0123456789abcdef"); // a deny grants nothing
    // The error names the file, never its content.
    expect(run(["chmod", "+a", "everyone allow read", f]).exitCode).toBe(0);
    let msg = "";
    try { readKeyFile(f); } catch (err) { msg = (err as Error).message; }
    expect(msg).not.toContain("acl_key_");
  });

  test.if(darwin)("the ACL verdict is re-checked when the file changes (ctime), not cached past a chmod", () => {
    const dir = mkdtempSync("/tmp/walkie-acl2-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = join(dir, "key.txt");
    writeFileSync(f, "acl_key_0123456789abcdef\n", { mode: 0o600 });
    expect(readKeyFile(f)).toBe("acl_key_0123456789abcdef");
    expect(run(["chmod", "+a", "everyone allow read", f]).exitCode).toBe(0);
    expect(() => readKeyFile(f)).toThrow("chmod -N");
  });

  test("parsers: macOS ls -le (owner's own allow passes, any other allow refuses, deny passes); Linux getfacl (named user/group with a bit refuses)", () => {
    const ls = (aces: string[]) => ["-rw-------+ 1 alex staff 33 Sep 25 10:00 key.txt", ...aces.map((a, i) => ` ${i}: ${a}`)].join("\n");
    expect(macAclRefusal(ls([]))).toBeNull();
    expect(macAclRefusal(ls(["user:alex allow read"]))).toBeNull();
    expect(macAclRefusal(ls(["group:everyone deny read"]))).toBeNull();
    expect(macAclRefusal(ls(["user:bob allow read"]))).toContain("user bob");
    expect(macAclRefusal(ls(["group:everyone deny write", "group:staff allow read,write"]))).toContain("group staff");
    expect(macAclRefusal(ls(["user:alex allow read", "group:everyone allow read"]))).toContain("group everyone");
    const facl = (lines: string[]) => ["user::rw-", "group::---", "other::---", ...lines].join("\n");
    expect(posixAclRefusal(facl([]))).toBeNull();
    expect(posixAclRefusal(facl(["mask::r--"]))).toBeNull();
    expect(posixAclRefusal(facl(["user:bob:---"]))).toBeNull();
    expect(posixAclRefusal(facl(["user:bob:r--"]))).toContain("user bob");
    expect(posixAclRefusal(facl(["group:wheel:-w-"]))).toContain("group wheel");
  });

  test("a file with no ACL support path (no getfacl on Linux, plain file on macOS) still passes on mode alone", () => {
    const dir = mkdtempSync("/tmp/walkie-acl3-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const f = join(dir, "key.txt");
    writeFileSync(f, "acl_key_0123456789abcdef\n", { mode: 0o600 });
    expect(readKeyFile(f)).toBe("acl_key_0123456789abcdef");
  });
});

