import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { DEFAULT_LIMITS, RateLimiter } from "../../src/daemon/ratelimit.ts";
import { MemoryStore } from "../../src/daemon/memory/store.ts";
import { sessionMemoryContext } from "../../src/daemon/memory/primer.ts";
import { memory } from "../../src/cli/commands/memory.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { applyRosterEvent, EMPTY_ROSTER } from "../../src/daemon/roster.ts";
import { createTeam, tnode } from "../helpers/events.ts";
import "../../src/daemon/memory/routes.ts";

const member = tnode("sam");
const { create } = createTeam(member);
const roster = applyRosterEvent(EMPTY_ROSTER, create);

function legacyHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "walkie-legacy-"));
  const db = new Database(join(dir, "memory.db"), { create: true });
  db.exec(`CREATE TABLE memory (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL, sources TEXT NOT NULL,
    created_at INTEGER NOT NULL, retracted INTEGER NOT NULL, retracted_at INTEGER,
    actor TEXT NOT NULL, redactions TEXT NOT NULL
  )`);
  db.query("INSERT INTO memory VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "m-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "decision", "Alex private recovery note", "[]",
    1, 0, null, "person", "[]",
  );
  db.close();
  return dir;
}

async function request(dir: string, handle: string | null, method: string, path: string,
  caller: { agent?: string; underAgent?: boolean; listener?: "unix" | "tcp"; dashboard?: boolean; via?: "cli" | "dashboard"; credentialExpiresAt?: number } = {}, body?: unknown): Promise<Response> {
  const req = new Request(`http://walkie${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  return dispatch({ req, url: new URL(req.url), via: caller.via ?? "cli", listener: caller.listener ?? "unix",
    dashboard: caller.dashboard, credentialExpiresAt: caller.credentialExpiresAt,
    agent: caller.agent, underAgent: caller.underAgent, noTimeout: () => {},
    core: { paths: { home: dir }, myHandle: () => handle, teamId: handle ? create.team : null,
      nodeId: member.keys.nodeId, roster, limits: DEFAULT_LIMITS,
      limiter: new RateLimiter() } } as unknown as RouteCtx);
}

test("legacy notes stay quarantined when this node's roster history cannot be read", async () => {
  const dir = legacyHome();
  try {
    const before = await request(dir, "sam", "GET", "/v1/recall?q=recovery");
    expect(before.status).toBe(200);
    expect(JSON.stringify(await before.json())).not.toContain("Alex private recovery note");
    const store = MemoryStore.open(dir, { fts: false });
    expect(store.recallEntries("sam")).toEqual([]);
    expect(store.recallEntries("")).toEqual([]);
    store.close();
    const migrated = new Database(join(dir, "memory.db"));
    expect(migrated.query<{ owner: string }, []>("SELECT owner FROM memory").get()?.owner).toBe("!legacy-quarantined");
    migrated.close();

    for (const caller of [{ agent: "claude" }, { underAgent: true }, { listener: "tcp" as const }]) {
      await expect(request(dir, "sam", "POST", "/v1/memory/delete-legacy", caller)).rejects.toMatchObject({ status: 403 });
    }
    await expect(request(dir, null, "POST", "/v1/memory/delete-legacy")).rejects.toMatchObject({ status: 403 });
    await expect(request(dir, "sam", "POST", "/v1/memory/delete-legacy")).rejects.toMatchObject({ status: 403 });
    const session = { dashboard: true, via: "dashboard" as const, listener: "tcp" as const, credentialExpiresAt: Date.now() + 60_000 };
    const confirm = { confirm: "delete legacy memory" };
    const deleted = await request(dir, "alex", "POST", "/v1/memory/delete-legacy", session, confirm);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: 1 });
    expect(await (await request(dir, "alex", "POST", "/v1/memory/delete-legacy", session, confirm)).json()).toEqual({ deleted: 0 });
    expect(JSON.stringify(await (await request(dir, "sam", "GET", "/v1/recall?q=recovery")).json())).not.toContain("Alex private recovery note");
    expect(JSON.stringify(await (await request(dir, "alex", "GET", "/v1/recall?q=recovery")).json())).not.toContain("Alex private recovery note");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("empty or unavailable memory produces no session context", () => {
  expect(sessionMemoryContext(null, { status: "empty", items: [] })).toBe("");
  expect(sessionMemoryContext(null, { status: "unavailable", items: [] }, true)).toBe("");
});

test("legacy claim CLI is removed", async () => {
  const calls: string[] = [];
  const lines: string[] = [];
  const ctx = { args: { pos: ["claim-legacy"], flags: new Map() }, json: false,
    agentMarker: () => null, agentSignals: () => ({ marker: null, inspection: "ok" }),
    person: { interactive: () => true, ask: async () => "yes", note: () => {} },
    client: () => ({ request: async (_method: string, path: string) => { calls.push(path); return { person: "alex", claimed: 1 }; } }),
    out: (line: string) => lines.push(line),
  } as unknown as Ctx;
  let refusal = "";
  try { await memory(ctx); } catch (error) { refusal = String(error); }
  expect(refusal).toMatch(/memory command must be/);
  for (const command of ["add", "list", "search", "retract", "gbrain", "semantic", "claude-mem"]) expect(refusal).toContain(command);
  expect(calls).toEqual([]);
  expect(lines).toEqual([]);
});
