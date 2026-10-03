// WALK-70 phase 0: a read-only merge of this machine's admin audit and guest audit.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, UsageError } from "../../src/cli/args.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import { formatHistory, historyCommand } from "../../src/cli/commands/history.ts";
import { COMMANDS, USAGE } from "../../src/cli/main.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { auditPath } from "../../src/daemon/admin/audit.ts";
import { writeSwitch } from "../../src/daemon/admin/switches.ts";
import "../../src/daemon/history-routes.ts";
import { dispatch, hasRoute, validAgentHeader, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { dashboardRoute } from "../../src/daemon/local-api.ts";
import { HttpError } from "../../src/daemon/http.ts";
import { mobileRoute } from "../../src/daemon/mobile/tunnel.ts";
import { GuestRegistry } from "../../src/mcp/guest-registry.ts";
import { registerGuests } from "../../src/mcp/guest-routes.ts";
import type { GuestData } from "../../src/mcp/guest-scope.ts";
import { remoteArgvProblem } from "../../src/protocol/admin.ts";
import {
  HISTORY_COVERAGE, HISTORY_MAX_LIMIT, HistoryQueryError, historyPath, mergeHistory, parseHistoryQuery,
  type HistoryView,
} from "../../src/history/facade.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, tnode } from "../helpers/events.ts";

const SECRET = "sk" + "-ant-api03-" + "A".repeat(24);
const EXTRA = "supersecretvalue1xx";

/** A high or low surrogate with no pair. Strict JSON parsers reject this; paired emoji are not it. */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const next = text.charCodeAt(i + 1);
      if (next < 0xDC00 || next > 0xDFFF) return true;
      i++;
    } else if (c >= 0xDC00 && c <= 0xDFFF) return true;
  }
  return false;
}

/** JSON.stringify writes an unpaired surrogate as `\uD83D` and leaves a real emoji as the character. */
function jsonHasLoneSurrogate(json: string): boolean {
  return /\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][cdefCDEF][0-9a-fA-F]{2})/.test(json) || hasLoneSurrogate(json);
}
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const guestData = { card: () => null, project: () => null } as unknown as GuestData;

function adminLine(row: Record<string, unknown>): string {
  return JSON.stringify(row);
}

function setup(o: { team?: boolean; seed?: boolean } = {}) {
  const alex = tnode("alex");
  const { team, create } = createTeam(alex);
  const core = makeCore(alex, team, cleanups);
  if (o.team !== false) core.ingest(create, "local");
  const registry = new GuestRegistry(core.store, () => 20);
  registerGuests(core, registry, guestData);
  if (o.seed !== false) {
    writeFileSync(auditPath(core.paths.home), [
      "{\"ts\":",
      adminLine({
        ts: 10, actor: "@alex/alex-mbp", action: `did ${SECRET}`, machine: "alex-mbp", via: "local",
        token: SECRET, password: `password=${EXTRA}`,
      }),
      adminLine({
        ts: 30, actor: "@alex/alex-mbp", action: "second step", machine: "alex-mbp", via: "remote", refused: "nope",
      }),
      "",
    ].join("\n"));
    registry.record({
      kind: "accepted", tool: "walkie_task", guest: "0123456789abcdef/dots-olive",
      object: "aaaaaaaaaaaaaaaa:1", event: "0123456789abcdef:4", digest: "ab".repeat(32), source: "abcdef0123456789",
    });
  }
  return { core, registry };
}

async function call(core: ReturnType<typeof setup>["core"], path: string, opts: { method?: string; agent?: string; underAgent?: boolean; via?: "cli" | "dashboard" | "phone"; headers?: Record<string, string> } = {}) {
  const req = new Request(`http://127.0.0.1${path}`, { method: opts.method ?? "GET", ...(opts.headers ? { headers: opts.headers } : {}) });
  const ctx = {
    core, req, url: new URL(req.url), agent: opts.agent, underAgent: opts.underAgent,
    via: opts.via ?? "cli", ...(opts.via === "phone" ? {} : { listener: "unix" as const }), noTimeout: () => {},
  } as unknown as RouteCtx;
  try {
    const res = await dispatch(ctx);
    return { status: res.status, body: await res.json() as HistoryView & { error?: { code: string; message: string } }, message: "" };
  } catch (err) {
    const e = err as HttpError;
    return { status: e.status ?? 500, body: { entries: [], omitted: [], truncated: false, coverage: "", error: { code: e.code, message: e.message } }, message: e.message };
  }
}

describe("merge, filters, redaction", () => {
  const admin = (ts: number, action: string, extra: Record<string, unknown> = {}) => ({
    ts, actor: "@alex/alex-mbp", action, machine: "alex-mbp", via: "local", ...extra,
  });

  test("merges admin and guest rows oldest first, with file order on equal timestamps", () => {
    const view = mergeHistory({
      // readAudit is newest-first. The file was appended: first, second-same-ts, third.
      admin: [admin(30, "third"), admin(10, "second-same-ts"), admin(10, "first")],
      // registry.audit() is oldest-first.
      guest: [
        { at: 10, kind: "revoke", guest: "0123456789abcdef/dots-olive" },
        { at: 20, kind: "accepted", tool: "walkie_task", guest: "0123456789abcdef/dots-olive" },
      ],
    });
    expect(view.truncated).toBe(false);
    expect(view.omitted).toEqual([]);
    expect(view.coverage).toBe(HISTORY_COVERAGE);
    expect(view.entries.map((e) => `${e.ts}:${e.source}:${e.action ?? e.kind}`)).toEqual([
      "10:admin:first",
      "10:admin:second-same-ts",
      "10:guest:revoke",
      "20:guest:accepted",
      "30:admin:third",
    ]);
  });

  test("filters by since, exact tool and a literal query, after redaction", () => {
    const rows = {
      admin: [admin(30, "second step"), admin(10, `did ${SECRET}`)],
      guest: [
        { at: 20, kind: "accepted", tool: "walkie_task", guest: "0123456789abcdef/dots-olive", object: "not-a-card" },
        { at: 25, kind: "accepted", tool: "walkie_post", guest: "0123456789abcdef/dots-olive" },
      ],
    };
    expect(mergeHistory({ ...rows, query: { since: 20 } }).entries.map((e) => e.ts)).toEqual([20, 25, 30]);
    expect(mergeHistory({ ...rows, query: { since: 20 } }).entries.some((e) => e.ts === 10)).toBe(false);
    const tooled = mergeHistory({ ...rows, query: { tool: "walkie_task" } });
    expect(tooled.entries.map((e) => e.tool)).toEqual(["walkie_task"]);
    expect(tooled.entries[0]?.object).toBeUndefined();
    expect(mergeHistory({ ...rows, query: { q: "SECOND" } }).entries.map((e) => e.action)).toEqual(["second step"]);
    expect(mergeHistory({ ...rows, query: { q: "a.b" } }).entries).toEqual([]);
    const hidden = mergeHistory({ ...rows, query: { q: SECRET } });
    expect(hidden.entries).toEqual([]);
    expect(JSON.stringify(mergeHistory(rows))).not.toContain(SECRET);
    expect(JSON.stringify(mergeHistory(rows))).toContain("[REDACTED:anthropic_key]");
  });

  test("drops fields the audits do not store and refuses a secret stuffed into an id", () => {
    const view = mergeHistory({
      admin: [admin(1, "ok", { token: SECRET, password: `password=${EXTRA}`, via: "local" })],
      guest: [{
        at: 2, kind: "accepted", tool: "walkie_task", guest: "0123456789abcdef/dots-olive",
        tokenHash: SECRET, digest: SECRET, source: `leak-${SECRET}`, object: SECRET, event: SECRET,
      }],
    });
    const text = JSON.stringify(view);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(EXTRA);
    expect(text).not.toContain("tokenHash");
    expect(view.entries[1]?.digest).toBeUndefined();
    expect(view.entries[1]?.caller).toBeUndefined();
    expect(view.entries[1]?.object).toBeUndefined();
    expect(view.entries[1]?.event).toBeUndefined();
    const allowed = new Set(["ts", "source", "summary", "actor", "action", "machine", "via", "refused", "kind", "guest", "tool", "object", "event", "digest", "caller", "status", "count"]);
    for (const entry of view.entries) for (const key of Object.keys(entry)) expect(allowed.has(key)).toBe(true);
    expect(mergeHistory({
      admin: [{ ts: 1, actor: "@alex/alex-mbp", action: "x".repeat(8193) + SECRET, machine: "alex-mbp", via: "local" }],
      guest: [],
    }).entries[0]?.action).toBe("[omitted: too long]");
    expect(JSON.stringify(mergeHistory({
      admin: [{ ts: 1, actor: "@alex/alex-mbp", action: "x".repeat(8193) + SECRET, machine: "alex-mbp", via: "local" }],
      guest: [],
    }))).not.toContain(SECRET);
  });

  test("8 KiB is UTF-8 bytes, so multibyte text is omitted before it reaches 8192 characters", () => {
    expect(Buffer.byteLength("你")).toBe(3);
    expect("你".length).toBe(1);
    const under = "你".repeat(2730);
    expect(Buffer.byteLength(under)).toBe(8190);
    const kept = mergeHistory({ admin: [admin(1, under)], guest: [] });
    expect(kept.entries[0]?.action).not.toBe("[omitted: too long]");
    expect(kept.entries[0]?.action?.startsWith("你")).toBe(true);
    expect(mergeHistory({ admin: [admin(2, "x".repeat(8192))], guest: [] }).entries[0]?.action).not.toBe("[omitted: too long]");
    const over = "你".repeat(2731);
    expect(Buffer.byteLength(over)).toBe(8193);
    expect(over.length).toBeLessThan(8192);
    const hidden = mergeHistory({ admin: [admin(3, over + SECRET)], guest: [] });
    expect(hidden.entries[0]?.action).toBe("[omitted: too long]");
    expect(JSON.stringify(hidden)).not.toContain(SECRET);
    expect(JSON.stringify(hidden)).not.toContain("你");
  });

  test("a 600-character cut stops before a high surrogate, in the action and the summary", () => {
    const emoji = "\u{1F600}";
    expect(emoji.length).toBe(2);
    expect(emoji.charCodeAt(0)).toBe(0xD83D);
    const raw = emoji.repeat(400);
    expect(raw.length).toBe(800);
    expect(raw.charCodeAt(598)).toBe(0xD83D);
    const view = mergeHistory({ admin: [admin(1, raw)], guest: [] });
    const entry = view.entries[0];
    // 599 UTF-16 units would keep the high surrogate and drop its pair. Step back one unit.
    expect(entry?.action).toBe(`${emoji.repeat(299)}…`);
    expect(hasLoneSurrogate(entry?.action ?? "\uD83D")).toBe(false);
    const prefix = "@alex/alex-mbp on alex-mbp: ";
    const composed = `${prefix}${entry?.action}`;
    expect(composed.length).toBeGreaterThan(600);
    expect(composed.charCodeAt(598)).toBe(0xD83D);
    expect(entry?.summary).toBe(`${composed.slice(0, 598)}…`);
    expect(hasLoneSurrogate(entry?.summary ?? "\uD83D")).toBe(false);
    expect(jsonHasLoneSurrogate(JSON.stringify(view))).toBe(false);
    // A boundary that already ends on a low surrogate stays at 599 units. ASCII does too.
    const mixed = `x${emoji.repeat(300)}`;
    expect(mixed.length).toBe(601);
    expect(mixed.charCodeAt(598)).toBe(0xDE00);
    const aligned = mergeHistory({ admin: [admin(2, mixed), admin(3, "x".repeat(700))], guest: [] });
    expect(aligned.entries[0]?.action).toBe(`${mixed.slice(0, 599)}…`);
    expect(aligned.entries[1]?.action).toBe(`${"x".repeat(599)}…`);
    expect(hasLoneSurrogate(aligned.entries[0]?.action ?? "")).toBe(false);
    expect(hasLoneSurrogate(aligned.entries[0]?.summary ?? "")).toBe(false);
    expect(hasLoneSurrogate(aligned.entries[1]?.summary ?? "")).toBe(false);
    expect(jsonHasLoneSurrogate(JSON.stringify(aligned))).toBe(false);
  });

  test("a row that is not a plain object is skipped, and valid admin and guest rows still show", () => {
    const view = mergeHistory({
      admin: [null, [], 1, "str", true, false, admin(10, "kept-admin")],
      guest: [null, [], 1, "str", true, false, { at: 20, kind: "revoke", guest: "0123456789abcdef/dots-olive" }],
    });
    expect(view.entries.map((e) => `${e.ts}:${e.source}:${e.action ?? e.kind}`)).toEqual(["10:admin:kept-admin", "20:guest:revoke"]);
    expect(view.entries[1]?.guest).toBe("0123456789abcdef/dots-olive");
  });

  test("skips torn rows, keeps a sha256 digest, and caps to the newest matches", () => {
    const view = mergeHistory({
      admin: [admin(3, "c"), { ts: 1 }, admin(1, "a\u0007b")],
      guest: [{ at: 2, kind: "accepted", digest: "ab".repeat(32), status: 200, count: 3 }, { at: 4, kind: "nope secret" }],
    });
    expect(view.entries.map((e) => e.ts)).toEqual([1, 2, 3]);
    expect(view.entries[0]?.summary).not.toContain("\u0007");
    expect(view.entries[1]?.digest).toBe("ab".repeat(32));
    expect(view.entries[1]?.status).toBe(200);
    expect(view.entries[1]?.count).toBe(3);
    const capped = mergeHistory({
      admin: [admin(1, "a"), admin(2, "b"), admin(3, "c")],
      guest: [],
      query: { limit: 2 },
    });
    expect(capped.truncated).toBe(true);
    expect(capped.entries.map((e) => e.action)).toEqual(["b", "c"]);
    expect(mergeHistory({ admin: [admin(1, "a"), admin(2, "b")], guest: [] }).truncated).toBe(false);
  });

  test("query parsing accepts epoch ms and ISO dates and rejects everything else", () => {
    expect(parseHistoryQuery({ since: "1700000000000" }).since).toBe(1_700_000_000_000);
    expect(parseHistoryQuery({ since: "2026-10-02" }).since).toBe(Date.UTC(2026, 9, 2));
    expect(parseHistoryQuery({ since: "2026-10-02T01:02:03Z" }).since).toBe(Date.UTC(2026, 9, 2, 1, 2, 3));
    expect(parseHistoryQuery({ since: "2026-10-02T01:00:00+01:00" }).since).toBe(Date.UTC(2026, 9, 2));
    expect(parseHistoryQuery({ tool: "tools/list", q: "a.b", limit: "2" })).toEqual({ tool: "tools/list", q: "a.b", limit: 2 });
    expect(parseHistoryQuery({}).limit).toBeUndefined();
    for (const since of ["yesterday", "2026-02-31", "1.5", "-1", "2026-10-02T25:00:00Z"]) {
      expect(() => parseHistoryQuery({ since })).toThrow(HistoryQueryError);
    }
    expect(() => parseHistoryQuery({ tool: "walkie task" })).toThrow(HistoryQueryError);
    expect(() => parseHistoryQuery({ tool: "t".repeat(65) })).toThrow(HistoryQueryError);
    expect(() => parseHistoryQuery({ q: "a\nb" })).toThrow(HistoryQueryError);
    expect(() => parseHistoryQuery({ q: "q".repeat(201) })).toThrow(HistoryQueryError);
    expect(() => parseHistoryQuery({ limit: "0" })).toThrow(HistoryQueryError);
    expect(() => parseHistoryQuery({ limit: String(HISTORY_MAX_LIMIT + 1) })).toThrow(HistoryQueryError);
    const path = historyPath({ since: 5, tool: "tools/list", q: "a b", limit: 2 });
    const url = new URL(`http://127.0.0.1${path}`);
    expect(url.pathname).toBe("/v1/history");
    expect(url.searchParams.get("tool")).toBe("tools/list");
    expect(url.searchParams.get("q")).toBe("a b");
    expect(historyPath({})).toBe("/v1/history");
  });
});

describe("local route", () => {
  test("GET /v1/history is local, and a dashboard session or a phone cannot call it", () => {
    expect(hasRoute("GET", "/v1/history")).toBe(true);
    expect(hasRoute("POST", "/v1/history")).toBe(false);
    expect(dashboardRoute("GET", "/v1/history")).toBe(false);
    expect(dashboardRoute("POST", "/v1/history")).toBe(false);
    expect(mobileRoute("GET", "/v1/history")).toBe(false);
    expect(readFileSync(new URL("../../src/daemon/main.ts", import.meta.url), "utf8")).toContain('import "./history-routes.ts"');
    expect(remoteArgvProblem(["history"])).toContain("can't run remotely");
    expect(remoteArgvProblem(["history", "--json"])).toContain("can't run remotely");
    const protocol = readFileSync(new URL("../../docs/PROTOCOL.md", import.meta.url), "utf8");
    expect(protocol).toContain("/v1/history");
    expect(protocol).not.toMatch(/\/peer\/v1\/history/);
    expect(protocol).toContain("newest 200");
    expect(protocol).toContain("8192 UTF-8 bytes");
    expect(protocol).toContain("valid `X-Walkie-Agent` name");
    expect(protocol).toContain("code-point boundary");
    expect(protocol).not.toContain("any presence of `X-Walkie-Agent`");
    const security = readFileSync(new URL("../../docs/SECURITY.md", import.meta.url), "utf8");
    expect(security).toContain("walkie history");
    expect(security).toContain("8192 UTF-8 bytes");
    expect(security).toContain("valid `X-Walkie-Agent` name");
    expect(security).not.toContain("Any `X-Walkie-Agent` or `X-Walkie-Under-Agent` header counts as an agent, whatever");
    const gateway = readFileSync(new URL("../../docs/GUEST-GATEWAY.md", import.meta.url), "utf8");
    expect(gateway).toContain("valid `X-Walkie-Agent` name");
    expect(gateway).not.toContain("any `X-Walkie-Agent` or `X-Walkie-Under-Agent` header, whatever its value");
    const changelog = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
    const releaseNotes = changelog.slice(changelog.indexOf("## v0.2.0-pre.13"), changelog.indexOf("## v0.2.0-pre.12"));
    expect(releaseNotes).toContain("--limit");
    expect(releaseNotes).toContain("8192 UTF-8 bytes");
    expect(releaseNotes).toContain("valid `X-Walkie-Agent` name");
    expect(releaseNotes).toContain("lone surrogate");
    expect(releaseNotes).not.toContain("any `X-Walkie-Agent` or `X-Walkie-Under-Agent` value");
  });

  test("a person sees both audits, oldest first, with secrets removed", async () => {
    const { core } = setup();
    expect(core.myHandle()).toBe("alex");
    const res = await call(core, "/v1/history");
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e) => e.ts)).toEqual([10, 20, 30]);
    expect(res.body.entries.map((e) => e.source)).toEqual(["admin", "guest", "admin"]);
    expect(res.body.entries[1]?.guest).toBe("0123456789abcdef/dots-olive");
    expect(res.body.entries[1]?.digest).toBe("ab".repeat(32));
    expect(res.body.entries[2]?.via).toBe("remote");
    expect(res.body.entries[2]?.refused).toBe("nope");
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(EXTRA);
    expect(text).toContain("[REDACTED:anthropic_key]");
    expect(res.body.omitted).toEqual([]);
    const filtered = await call(core, "/v1/history?since=20&tool=walkie_task&q=olive");
    expect(filtered.body.entries.map((e) => e.guest)).toEqual(["0123456789abcdef/dots-olive"]);
  });

  test("an agent sees the admin audit only, even when agent admin is off", async () => {
    const { core } = setup();
    writeSwitch(core.paths.config, "agent_admin", false);
    for (const opts of [{ agent: "claude" }, { underAgent: true }]) {
      const res = await call(core, "/v1/history?tool=walkie_task&q=olive", opts);
      expect(res.status).toBe(200);
      expect(res.body.omitted).toEqual([{ source: "guest", reason: "person_only" }]);
      expect(res.body.entries).toEqual([]);
      const all = await call(core, "/v1/history", opts);
      expect(all.body.entries.map((e) => e.source)).toEqual(["admin", "admin"]);
      expect(JSON.stringify(all.body)).not.toContain("dots-olive");
    }
    // The listener refuses a dashboard session before dispatch (not on the allow-list).
    // This route is not what a session sees: local-api answers 403 first.
    expect(dashboardRoute("GET", "/v1/history")).toBe(false);
  });

  test("any X-Walkie-Under-Agent value is an agent, including 0, true and 1", async () => {
    const { core } = setup();
    writeSwitch(core.paths.config, "agent_admin", false);
    for (const value of ["0", "true", "1"]) {
      const res = await call(core, "/v1/history", { headers: { "X-Walkie-Under-Agent": value } });
      expect(res.status).toBe(200);
      expect(res.body.omitted).toEqual([{ source: "guest", reason: "person_only" }]);
      expect(res.body.entries.map((e) => e.source)).toEqual(["admin", "admin"]);
      expect(JSON.stringify(res.body)).not.toContain("dots-olive");
    }
    // Below the listener, a header that arrived still counts. The listener itself rejects it first.
    expect(() => validAgentHeader("")).toThrow(/empty/);
    expect(() => validAgentHeader("not a name")).toThrow(/not a valid agent name/);
    const invalidName = await call(core, "/v1/history", { headers: { "X-Walkie-Agent": "not a name" } });
    expect(invalidName.status).toBe(200);
    expect(invalidName.body.omitted).toEqual([{ source: "guest", reason: "person_only" }]);
    expect(JSON.stringify(invalidName.body)).not.toContain("dots-olive");
  });

  test("an agent sees at most the newest 200 admin rows and a person sees the tail", async () => {
    const { core } = setup({ seed: false });
    const lines: string[] = [];
    for (let i = 1; i <= 201; i++) {
      lines.push(adminLine({ ts: i, actor: "@alex/alex-mbp", action: `step-${i}`, machine: "alex-mbp", via: "local" }));
    }
    writeFileSync(auditPath(core.paths.home), lines.join("\n") + "\n");
    const person = await call(core, "/v1/history");
    expect(person.status).toBe(200);
    expect(person.body.truncated).toBe(false);
    expect(person.body.entries).toHaveLength(201);
    expect(person.body.entries[0]?.action).toBe("step-1");
    expect(person.body.entries[200]?.action).toBe("step-201");
    for (const opts of [{ underAgent: true }, { headers: { "X-Walkie-Under-Agent": "0" } }]) {
      const agent = await call(core, "/v1/history", opts);
      expect(agent.status).toBe(200);
      expect(agent.body.omitted).toEqual([{ source: "guest", reason: "person_only" }]);
      expect(agent.body.truncated).toBe(false);
      expect(agent.body.entries).toHaveLength(200);
      expect(agent.body.entries[0]?.action).toBe("step-2");
      expect(agent.body.entries[199]?.action).toBe("step-201");
      expect(agent.body.entries.some((e) => e.action === "step-1")).toBe(false);
    }
    const limited = await call(core, "/v1/history?limit=2", { underAgent: true });
    expect(limited.body.truncated).toBe(true);
    expect(limited.body.entries.map((e) => e.action)).toEqual(["step-200", "step-201"]);
    // The 200 is readAudit's window, the same one GET /v1/admin uses, so a non-object line counts.
    const windowed = setup({ seed: false });
    const mixed = [adminLine({ ts: 1, actor: "@alex/alex-mbp", action: "too-old", machine: "alex-mbp", via: "local" })];
    for (let i = 0; i < 199; i++) mixed.push("null");
    mixed.push(adminLine({ ts: 2, actor: "@alex/alex-mbp", action: "kept", machine: "alex-mbp", via: "local" }));
    writeFileSync(auditPath(windowed.core.paths.home), mixed.join("\n") + "\n");
    const capped = await call(windowed.core, "/v1/history", { underAgent: true });
    expect(capped.status).toBe(200);
    expect(capped.body.entries.map((e) => e.action)).toEqual(["kept"]);
    const full = await call(windowed.core, "/v1/history");
    expect(full.body.entries.map((e) => e.action)).toEqual(["too-old", "kept"]);
  });

  test("null, array, number and string lines in the admin audit do not fail the read", async () => {
    const { core } = setup({ seed: false });
    const junk = [null, [], 1, "str", true, false].map((value) => JSON.stringify(value));
    writeFileSync(auditPath(core.paths.home), [
      adminLine({ ts: 5, actor: "@alex/alex-mbp", action: "kept-first", machine: "alex-mbp", via: "local" }),
      ...junk,
      adminLine({ ts: 15, actor: "@alex/alex-mbp", action: "kept-second", machine: "alex-mbp", via: "remote" }),
      "",
    ].join("\n"));
    const res = await call(core, "/v1/history");
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e) => e.action)).toEqual(["kept-first", "kept-second"]);
    expect(res.body.entries[1]?.via).toBe("remote");
    const agent = await call(core, "/v1/history", { headers: { "X-Walkie-Under-Agent": "true" } });
    expect(agent.status).toBe(200);
    expect(agent.body.entries.map((e) => e.action)).toEqual(["kept-first", "kept-second"]);
  });

  test("a phone is refused and a person without a team does not receive the guest audit", async () => {
    const phone = await call(setup().core, "/v1/history", { via: "phone" });
    expect(phone.status).toBe(403);
    expect(phone.message).not.toContain(SECRET);
    expect(phone.message).not.toContain("dots-olive");
    const { core } = setup({ team: false });
    expect(core.myHandle()).toBeNull();
    const res = await call(core, "/v1/history");
    expect(res.status).toBe(200);
    expect(res.body.omitted).toEqual([{ source: "guest", reason: "no_team" }]);
    expect(res.body.entries.map((e) => e.source)).toEqual(["admin", "admin"]);
    expect(JSON.stringify(res.body)).not.toContain("dots-olive");
  });

  test("missing and empty files yield no admin rows, and the rotated file is not read", async () => {
    const missing = setup({ seed: false });
    expect((await call(missing.core, "/v1/history")).body.entries).toEqual([]);
    writeFileSync(auditPath(missing.core.paths.home), "\n");
    missing.registry.record({ kind: "revoke", guest: "0123456789abcdef/dots-olive" });
    const onlyGuest = await call(missing.core, "/v1/history");
    expect(onlyGuest.body.entries.map((e) => e.kind)).toEqual(["revoke"]);
    const rotated = setup({ seed: false });
    writeFileSync(auditPath(rotated.core.paths.home) + ".1", adminLine({
      ts: 1, actor: "@alex/alex-mbp", action: "rotated-marker-olive", machine: "alex-mbp", via: "local",
    }) + "\n");
    writeFileSync(auditPath(rotated.core.paths.home), adminLine({
      ts: 2, actor: "@alex/alex-mbp", action: "current-marker", machine: "alex-mbp", via: "local",
    }) + "\n");
    const current = JSON.stringify((await call(rotated.core, "/v1/history")).body);
    expect(current).toContain("current-marker");
    expect(current).not.toContain("rotated-marker-olive");
  });

  test("unreadable or corrupt audits fail closed without echoing stored text", async () => {
    const { core } = setup();
    core.store.setMeta("guest_registry_v1", `{"nope":"${SECRET}"`);
    const corrupt = await call(core, "/v1/history");
    expect(corrupt.status).toBe(503);
    expect(corrupt.message).toBe("the guest audit on this machine could not be read");
    expect(corrupt.message).not.toContain(SECRET);
    const blocked = setup();
    chmodSync(auditPath(blocked.core.paths.home), 0o000);
    try {
      const denied = await call(blocked.core, "/v1/history");
      expect(denied.status).toBe(503);
      expect(denied.message).toBe("the admin audit on this machine could not be read");
      expect(denied.message).not.toContain(SECRET);
    } finally {
      chmodSync(auditPath(blocked.core.paths.home), 0o600);
    }
    const dir = setup({ seed: false });
    mkdirSync(auditPath(dir.core.paths.home));
    const notFile = await call(dir.core, "/v1/history");
    expect(notFile.status).toBe(503);
    expect(notFile.message).toBe("the admin audit on this machine could not be read");
  });

  test("unknown filters are rejected and POST records nothing", async () => {
    const { core, registry } = setup();
    const before = readFileSync(auditPath(core.paths.home));
    const guestBefore = registry.audit().length;
    for (const path of ["/v1/history?principal=alex", "/v1/history?since=1&since=2", "/v1/history?project=web"]) {
      const res = await call(core, path);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain("dots-olive");
    }
    const posted = await call(core, "/v1/history", { method: "POST" });
    expect(posted.status).toBe(405);
    expect(readFileSync(auditPath(core.paths.home))).toEqual(before);
    expect(registry.audit().length).toBe(guestBefore);
  });

  test("the live guest count is the registry's, not the last durable checkpoint", async () => {
    const { core, registry } = setup({ seed: false });
    const source = "abcdef0123456789";
    registry.recordEarly("rejected", 429, source);
    registry.recordEarly("rejected", 429, source);
    registry.recordEarly("rejected", 429, source);
    const res = await call(core, "/v1/history");
    expect(res.body.entries).toEqual([expect.objectContaining({ kind: "rejected", count: 3, caller: source, status: 429 })]);
  });

  test("a person with no registered guest registry still sees the admin audit", async () => {
    const alex = tnode("alex");
    const { team, create } = createTeam(alex);
    const core = makeCore(alex, team, cleanups);
    core.ingest(create, "local");
    writeFileSync(auditPath(core.paths.home), adminLine({
      ts: 5, actor: "@alex/alex-mbp", action: "only admin", machine: "alex-mbp", via: "local",
    }) + "\n");
    const res = await call(core, "/v1/history");
    expect(res.body.omitted).toEqual([{ source: "guest", reason: "unavailable" }]);
    expect(res.body.entries.map((e) => e.action)).toEqual(["only admin"]);
  });
});

describe("walkie history", () => {
  test("help lists the command and remote admin cannot run it", () => {
    expect(typeof COMMANDS.history).toBe("function");
    expect(USAGE).toContain("history [--since");
  });

  test("text output is oldest first and says when guest rows or the tail were left out", () => {
    const view: HistoryView = {
      coverage: HISTORY_COVERAGE,
      truncated: true,
      omitted: [{ source: "guest", reason: "person_only" }],
      entries: [
        { ts: 10, source: "admin", summary: "a\u0007b" },
        { ts: 20, source: "guest", summary: "accepted walkie_task" },
      ],
    };
    expect(formatHistory(view)).toEqual([
      "this machine only — admin audit tail and guest audit, oldest first",
      `${new Date(10).toISOString()}  admin  ab`,
      `${new Date(20).toISOString()}  guest  accepted walkie_task`,
      "guest audit not included (person_only)",
      "showing the newest 2 matching rows; more matched",
    ]);
    expect(formatHistory({ coverage: HISTORY_COVERAGE, truncated: false, omitted: [], entries: [] })).toContain("no matching history on this machine");
  });

  test("the command passes only its own filters and prints the daemon's view", async () => {
    const lines: string[] = [];
    let query: unknown;
    const view: HistoryView = {
      coverage: HISTORY_COVERAGE, truncated: false, omitted: [],
      entries: [{ ts: 10, source: "admin", summary: "enabled seats" }],
    };
    const ctx = {
      args: parseArgs(["--since", "2026-10-02", "--tool", "walkie_task", "--q", "olive", "--limit", "4", "--json"], CLI_BOOLEANS),
      json: true,
      forAgent: false,
      agentMarker: () => null,
      client: () => ({ history: async (q: unknown) => { query = q; return view; } }),
      out: (s: string) => { lines.push(s); },
      err: () => {},
    } as unknown as Ctx;
    expect(await historyCommand(ctx)).toBe(0);
    expect(query).toEqual({ since: Date.UTC(2026, 9, 2), tool: "walkie_task", q: "olive", limit: 4 });
    expect(JSON.parse(lines[0] ?? "")).toEqual(view);
    const refused = {
      ...ctx,
      json: false,
      args: parseArgs(["export"], CLI_BOOLEANS),
      client: () => ({ history: async () => { throw new Error("called"); } }),
    } as unknown as Ctx;
    await expect(historyCommand(refused)).rejects.toThrow(UsageError);
    const unknown = { ...ctx, args: parseArgs(["--principal", "alex"], CLI_BOOLEANS) } as unknown as Ctx;
    await expect(historyCommand(unknown)).rejects.toThrow(/unknown flag --principal/);
  });
});
