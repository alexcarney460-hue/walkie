import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memory } from "../../src/cli/commands/memory.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { MemoryStore } from "../../src/daemon/memory/store.ts";
import { DEFAULT_LIMITS, RateLimiter } from "../../src/daemon/ratelimit.ts";
import { dashboardRoute } from "../../src/daemon/local-api.ts";
import { applyRosterEvent, EMPTY_ROSTER } from "../../src/daemon/roster.ts";
import { personKey } from "../../src/daemon/memory/ownership.ts";
import { createTeam, tnode } from "../helpers/events.ts";
import "../../src/daemon/memory/routes.ts";

const identities = Object.fromEntries(["alex", "sam"].map((handle) => {
  const node = tnode(handle);
  const { create } = createTeam(node);
  const roster = applyRosterEvent(EMPTY_ROSTER, create);
  return [handle, { roster, teamId: create.team, nodeId: node.keys.nodeId }];
})) as Record<string, { roster: ReturnType<typeof applyRosterEvent>; teamId: string; nodeId: string }>;
const owner = (handle: string) => personKey(identities[handle]!)!;

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "walkie-memory-privacy-"));
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
  opts: { dashboard?: boolean; credentialExpiresAt?: number; agent?: string; underAgent?: boolean; listener?: "unix" | "tcp"; via?: "cli" | "dashboard" | "phone"; body?: unknown } = {}): Promise<Response> {
  const req = new Request(`http://walkie${path}`, { method, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  return dispatch({ req, url: new URL(req.url), via: opts.via ?? "cli", listener: opts.listener ?? "unix",
    dashboard: opts.dashboard, credentialExpiresAt: opts.credentialExpiresAt,
    agent: opts.agent, underAgent: opts.underAgent, noTimeout: () => {},
    core: { paths: { home: dir }, myHandle: () => handle, ...(handle ? identities[handle] : { teamId: null }), limits: DEFAULT_LIMITS,
      limiter: new RateLimiter() } } as unknown as RouteCtx);
}

test("every memory read is owner scoped, including legacy, retracted, FTS, and CLI list/search", async () => {
  const dir = home();
  try {
    const store = MemoryStore.open(dir);
    const alex = store.add({ kind: "fact", text: "needle alex", actor: "person", owner: owner("alex") });
    const sam = store.add({ kind: "fact", text: "needle sam", actor: "person", owner: owner("sam") });
    store.close();
    for (const [handle, own, foreign] of [["sam", sam.id, alex.id], ["alex", alex.id, sam.id]] as const) {
      for (const path of ["/v1/memory", "/v1/memory?all=1", "/v1/memory?q=needle"]) {
        const res = await request(dir, handle, "GET", path);
        const ids = (await res.json() as { entries: { id: string }[] }).entries.map((entry) => entry.id);
        expect(ids).toContain(own);
        expect(ids).not.toContain(foreign);
        expect(ids).not.toContain("m-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      }
      const lines: string[] = [];
      for (const pos of [["list"], ["search", "needle"]]) {
        const ctx = { args: { pos, flags: new Map() }, json: true, out: (line: string) => lines.push(line),
          client: () => ({ request: (method: string, path: string) => request(dir, handle, method, path).then((res) => res.json()) }),
        } as unknown as Ctx;
        expect(await memory(ctx)).toBe(0);
      }
      for (const line of lines) {
        expect(line).toContain(own);
        expect(line).not.toContain(foreign);
        expect(line).not.toContain("Alex private recovery note");
      }
    }
    await expect(request(dir, "sam", "POST", "/v1/memory/retract", { body: { id: alex.id } }))
      .rejects.toMatchObject({ status: 404 });
    const after = await request(dir, "alex", "GET", "/v1/memory?q=alex");
    expect(JSON.stringify(await after.json())).toContain(alex.id);
    const db = new Database(join(dir, "memory.db"));
    expect(db.query<{ owner: string }, []>("SELECT owner FROM memory WHERE id = 'm-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'").get()?.owner).toBe("!legacy-quarantined");
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy deletion needs an authenticated dashboard session; every refusal preserves quarantine", async () => {
  const dir = home();
  try {
    MemoryStore.open(dir, { fts: false }).close();
    expect(dashboardRoute("POST", "/v1/memory/delete-legacy")).toBe(true);
    expect(dashboardRoute("POST", "/v1/memory/claim-legacy")).toBe(false);
    for (const opts of [{}, { agent: "codex" }, { underAgent: true },
      { listener: "tcp" as const }, { via: "phone" as const },
      { dashboard: true, credentialExpiresAt: Date.now() + 60_000, via: "dashboard" as const, listener: "tcp" as const, agent: "codex" }]) {
      await expect(request(dir, "sam", "POST", "/v1/memory/delete-legacy", opts)).rejects.toMatchObject({ status: 403 });
      const db = new Database(join(dir, "memory.db"));
      expect(db.query<{ owner: string }, []>("SELECT owner FROM memory").get()?.owner).toBe("");
      db.close();
    }
    const proof = { dashboard: true, credentialExpiresAt: Date.now() + 60_000, via: "dashboard" as const,
      listener: "tcp" as const, body: { confirm: "delete legacy memory" } };
    await expect(request(dir, "alex", "POST", "/v1/memory/delete-legacy", { ...proof, body: {} }))
      .rejects.toMatchObject({ status: 400 });
    await expect(request(dir, null, "POST", "/v1/memory/delete-legacy", proof))
      .rejects.toMatchObject({ status: 409 });
    const before = new Database(join(dir, "memory.db"));
    expect(before.query<{ owner: string }, []>("SELECT owner FROM memory").get()?.owner).toBe("");
    before.close();
    const accepted = await request(dir, "alex", "POST", "/v1/memory/delete-legacy", proof);
    expect(await accepted.json()).toEqual({ deleted: 1 });
    expect(await (await request(dir, "alex", "POST", "/v1/memory/delete-legacy", proof)).json()).toEqual({ deleted: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("owner filter runs before limits for full-text and substring search; missing owner cannot create notes", async () => {
  for (const fts of [false, true]) {
    const dir = home();
    try {
      const store = MemoryStore.open(dir, { fts });
      const own = store.add({ kind: "fact", text: "needle own", actor: "person", owner: "alex" });
      for (let i = 0; i < 3; i++) store.add({ kind: "fact", text: `needle foreign ${i}`, actor: "person", owner: "sam" });
      expect(store.search("needle", 1, "alex").map((entry) => entry.id)).toEqual([own.id]);
      expect(store.list({ limit: 1, includeRetracted: false, owner: "alex" }).map((entry) => entry.id)).toEqual([own.id]);
      expect(store.search("needle", 1, "")).toEqual([]);
      expect(store.list({ limit: 1, includeRetracted: true, owner: "" })).toEqual([]);
      store.close();
      await expect(request(dir, null, "POST", "/v1/memory", { body: { text: "unowned", kind: "fact" } }))
        .rejects.toMatchObject({ status: 409 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
