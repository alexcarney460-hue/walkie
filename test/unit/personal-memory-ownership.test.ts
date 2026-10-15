import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { DEFAULT_LIMITS, RateLimiter } from "../../src/daemon/ratelimit.ts";
import { applyRosterEvent, EMPTY_ROSTER } from "../../src/daemon/roster.ts";
import { legacyOwner, personKey, recordStartupDecision, startupAdmits } from "../../src/daemon/memory/ownership.ts";
import { MemoryStore } from "../../src/daemon/memory/store.ts";
import { createTeam, memberEv, nodeEv, tnode } from "../helpers/events.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import "../../src/daemon/memory/routes.ts";

const alex = tnode("alex");
const { create } = createTeam(alex);

function core(events: Event[] | null, nodeId = alex.keys.nodeId, handle?: string) {
  const roster = (events ?? [create]).reduce(applyRosterEvent, EMPTY_ROSTER);
  return { nodeId, teamId: roster.team?.id ?? null, roster, rosterEntries: () => {
    if (!events) throw new Error("history unavailable");
    return events;
  }, myHandle: () => handle ?? roster.members.get(roster.nodes.get(nodeId)?.login ?? "")?.handle ?? null };
}

function legacyHome(createdAt = 1): string {
  const dir = mkdtempSync(join(tmpdir(), "walkie-owner-"));
  const db = new Database(join(dir, "memory.db"), { create: true });
  db.exec(`CREATE TABLE memory (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL,
    sources TEXT NOT NULL, created_at INTEGER NOT NULL, retracted INTEGER NOT NULL,
    retracted_at INTEGER, actor TEXT NOT NULL, redactions TEXT NOT NULL)`);
  db.query("INSERT INTO memory VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "m-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "decision", "private legacy note", "[]", createdAt, 0, null, "person", "[]");
  db.close();
  return dir;
}

function startMemory(dir: string, ownerCore: ReturnType<typeof core>): void {
  const store = MemoryStore.open(dir, { fts: false });
  try {
    const proof = legacyOwner(ownerCore);
    recordStartupDecision(dir, store, proof);
    store.resolveLegacy(proof, startupAdmits(dir, store, proof));
  } finally { store.close(); }
}

async function request(dir: string, ownerCore: ReturnType<typeof core>, method: string, path: string, body?: unknown,
  proof = false): Promise<Response> {
  const req = new Request(`http://walkie${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  return dispatch({ req, url: new URL(req.url), via: proof ? "dashboard" : "cli", listener: proof ? "tcp" : "unix",
    dashboard: proof, credentialExpiresAt: proof ? Date.now() + 60_000 : undefined, noTimeout: () => {},
    core: { ...ownerCore, paths: { home: dir }, limits: DEFAULT_LIMITS, limiter: new RateLimiter() } } as unknown as RouteCtx);
}

test("one historical holder owns legacy rows automatically and no other person reads them", async () => {
  const dir = legacyHome(1);
  try {
    expect(legacyOwner(core([create]))).toEqual({ team: create.team, node: alex.keys.nodeId, person: "alex",
      identity: personKey(core([create]))! });
    startMemory(dir, core([create]));
    expect(JSON.stringify(await (await request(dir, core([create]), "GET", "/v1/recall?q=legacy")).json())).toContain("private legacy note");
    expect(JSON.stringify(await (await request(dir, core([create]), "GET", "/v1/memory?q=legacy")).json())).toContain("private legacy note");
    const nextTeam = createTeam({ ...alex, handle: "sam", login: "sam@example.com", seq: 0 }, "next-team").create;
    expect(JSON.stringify(await (await request(dir, core([nextTeam]), "GET", "/v1/recall?q=legacy")).json())).not.toContain("private legacy note");
    expect(JSON.stringify(await (await request(dir, core([nextTeam]), "GET", "/v1/memory?q=legacy")).json())).not.toContain("private legacy note");
    const db = new Database(join(dir, "memory.db"));
    expect(db.query<{ owner: string }, []>("SELECT owner FROM memory").get()?.owner).toBe(personKey(core([create]))!);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("clock order does not change the single holder decision", async () => {
  const dir = legacyHome();
  try {
    startMemory(dir, core([create]));
    expect(JSON.stringify(await (await request(dir, core([create]), "GET", "/v1/recall?q=legacy")).json())).toContain("private legacy note");
    const db = new Database(join(dir, "memory.db"));
    expect(db.query<{ owner: string }, []>("SELECT owner FROM memory").get()?.owner).toBe(personKey(core([create]))!);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unreadable first history keeps a newer row quarantined after history recovers", async () => {
  const dir = legacyHome(create.ts + 1);
  try {
    startMemory(dir, core(null));
    await request(dir, core(null), "GET", "/v1/recall?q=legacy");
    expect(JSON.stringify(await (await request(dir, core([create]), "GET", "/v1/recall?q=legacy")).json())).not.toContain("private legacy note");
    const db = new Database(join(dir, "memory.db"));
    expect(db.query<{ owner: string }, []>("SELECT owner FROM memory").get()?.owner).toBe("!legacy-quarantined");
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a second holder or unreadable history never assigns legacy rows", async () => {
  // Synthetic retained cross-team history for one node; a current team chain alone cannot contain two founders.
  const second = createTeam({ ...alex, handle: "sam", login: "sam@example.com", seq: 0 });
  const reassigned = [create, second.create];
  expect(legacyOwner(core(reassigned))).toBeNull();
  expect(legacyOwner(core(null))).toBeNull();
  for (const history of [reassigned, null]) {
    const dir = legacyHome();
    try {
      const ownerCore = core(history);
      startMemory(dir, ownerCore);
      expect(JSON.stringify(await (await request(dir, ownerCore, "GET", "/v1/recall?q=legacy")).json())).not.toContain("private legacy note");
      expect(JSON.stringify(await (await request(dir, core(history, alex.keys.nodeId, "alex"), "GET", "/v1/recall?q=legacy")).json())).not.toContain("private legacy note");
      const db = new Database(join(dir, "memory.db"));
      expect(db.query<{ owner: string }, []>("SELECT owner FROM memory").get()?.owner).toBe("!legacy-quarantined");
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("later team or holder cannot read migrated rows", async () => {
  const changedTeam = createTeam(alex, "another-team").create;
  const otherHolder = createTeam({ ...alex, handle: "sam", login: "sam@example.com", seq: 0 }).create;
  for (const later of [[changedTeam], [create, otherHolder]]) {
    const dir = legacyHome();
    try {
      startMemory(dir, core([create]));
      await request(dir, core([create]), "GET", "/v1/recall?q=legacy");
      const store = MemoryStore.open(dir, { fts: false });
      store.add({ kind: "fact", text: "new owned note", actor: "person", owner: "alex" });
      store.close();
      expect(JSON.stringify(await (await request(dir, core(later), "GET", "/v1/recall?q=legacy")).json()))
        .not.toContain("private legacy note");
      await request(dir, core([create]), "GET", "/v1/recall?q=legacy");
      const db = new Database(join(dir, "memory.db"));
      expect(db.query<{ owner: string }, []>("SELECT owner FROM memory WHERE body = 'private legacy note'").get()?.owner)
        .toBe(personKey(core([create]))!);
      expect(db.query<{ owner: string }, []>("SELECT owner FROM memory WHERE body = 'new owned note'").get()?.owner).toBe("alex");
      expect(db.query<{ team: string; node: string; person: string }, []>(
        "SELECT team, node, person FROM memory_legacy_decision WHERE id = 1").get())
        .toEqual({ team: create.team, node: alex.keys.nodeId, person: "alex" });
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("no memory route edits the stored legacy decision", async () => {
  const dir = legacyHome();
  try {
    startMemory(dir, core([create]));
    await request(dir, core([create]), "GET", "/v1/recall?q=legacy");
    for (const path of ["/v1/memory/legacy-decision", "/v1/memory/claim-legacy"]) {
      await expect(request(dir, core([create]), "POST", path, { team: "other", node: "other", person: "sam" }))
        .rejects.toMatchObject({ status: 404 });
    }
    await expect(request(dir, core([create]), "POST", "/v1/memory", {
      kind: "fact", text: "attempt", team: "other", node: "other", person: "sam",
    })).rejects.toMatchObject({ status: 400 });
    const db = new Database(join(dir, "memory.db"));
    expect(db.query<{ team: string; node: string; person: string }, []>(
      "SELECT team, node, person FROM memory_legacy_decision WHERE id = 1").get())
      .toEqual({ team: create.team, node: alex.keys.nodeId, person: "alex" });
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("quarantined legacy rows can only be deleted with person dashboard proof", async () => {
  const dir = legacyHome();
  try {
    const ownerCore = core(null);
    startMemory(dir, ownerCore);
    await expect(request(dir, ownerCore, "POST", "/v1/memory/delete-legacy", { confirm: "delete legacy memory" }))
      .rejects.toMatchObject({ status: 403 });
    expect(await (await request(dir, ownerCore, "POST", "/v1/memory/delete-legacy", { confirm: "delete legacy memory" }, true)).json())
      .toEqual({ deleted: 1 });
    const db = new Database(join(dir, "memory.db"));
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory").get()?.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH 'legacy'").get()?.n).toBe(0);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rounds 1-5 handle-owned notes and primers migrate only to the original team member", async () => {
  const dir = legacyHome();
  try {
    const old = new Database(join(dir, "memory.db"));
    old.exec("ALTER TABLE memory ADD COLUMN owner TEXT NOT NULL DEFAULT ''");
    old.exec("ALTER TABLE memory ADD COLUMN confidence REAL NOT NULL DEFAULT 0.7");
    old.exec("ALTER TABLE memory ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0");
    old.exec("CREATE TABLE memory_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    old.exec("INSERT INTO memory_migrations VALUES(1, 1), (2, 2)");
    old.exec(`CREATE TABLE personal_primers(person TEXT NOT NULL, project TEXT NOT NULL,
      in_progress TEXT NOT NULL, next_step TEXT NOT NULL, blockers TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(person, project))`);
    old.exec("CREATE TABLE memory_legacy_decision(id INTEGER PRIMARY KEY, team TEXT NOT NULL, node TEXT NOT NULL, person TEXT NOT NULL)");
    old.query("INSERT INTO memory_legacy_decision VALUES(1, ?, ?, ?)").run(create.team, alex.keys.nodeId, "alex");
    old.query("INSERT INTO memory(id, kind, body, sources, created_at, retracted, actor, redactions, owner) VALUES(?, 'fact', ?, '[]', 2, 0, 'person', '[]', 'alex')")
      .run("m-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "old handle owned note");
    old.query("INSERT INTO personal_primers VALUES('alex', 'global', 'work', 'old handle next step', '[]', 2)").run();
    old.query("INSERT INTO personal_primers VALUES('sam', 'global', 'other work', 'Sam private next step', '[]', 2)").run();
    old.close();
    startMemory(dir, core([create]));
    expect(JSON.stringify(await (await request(dir, core([create]), "GET", "/v1/recall?q=handle")).json()))
      .toContain("old handle owned note");
    expect(JSON.stringify(await (await request(dir, core([create]), "GET", "/v1/primer?project=global")).json()))
      .toContain("old handle next step");
    const other = createTeam({ ...alex, handle: "alex", login: "sam@example.com", seq: 0 }, "another-team").create;
    expect(JSON.stringify(await (await request(dir, core([other]), "GET", "/v1/recall?q=handle")).json()))
      .not.toContain("old handle owned note");
    expect(JSON.stringify(await (await request(dir, core([other]), "GET", "/v1/primer?project=global")).json()))
      .not.toContain("old handle next step");
    expect(JSON.stringify(await (await request(dir, core([other]), "GET", "/v1/primer?project=global")).json()))
      .not.toContain("Sam private next step");
    expect(await (await request(dir, core([create]), "POST", "/v1/memory/delete-legacy",
      { confirm: "delete legacy memory" }, true)).json()).toEqual({ deleted: 1 });
    expect(JSON.stringify(await (await request(dir, core([create]), "GET", "/v1/primer?project=global")).json()))
      .toContain("old handle next step");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("removing and re-adding the same login gives the person a new memory key", () => {
  const sam = tnode("shared", "sam@example.com");
  const joined = [create, memberEv(create.team, alex, sam, "member"), nodeEv(create.team, alex, sam)];
  const first = personKey(core(joined, sam.keys.nodeId));
  const removed = memberEv(create.team, alex, sam, "removed");
  const readded = memberEv(create.team, alex, sam, "member");
  const admitted = nodeEv(create.team, alex, sam);
  const history = [...joined, removed, readded, admitted];
  const second = personKey(core(history, sam.keys.nodeId));
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(second).not.toBe(first);
  expect(legacyOwner(core(history, sam.keys.nodeId))).toBeNull();
});

test("a restored database copy with the same random id is not the startup-judged file", () => {
  const dir = legacyHome();
  try {
    const first = MemoryStore.open(dir, { fts: false });
    recordStartupDecision(dir, first, legacyOwner(core([create])));
    first.close();
    copyFileSync(join(dir, "memory.db"), join(dir, "restored.db"));
    renameSync(join(dir, "restored.db"), join(dir, "memory.db"));
    const restored = MemoryStore.open(dir, { fts: false });
    const proof = legacyOwner(core([create]));
    expect(startupAdmits(dir, restored, proof)).toBe(false);
    restored.resolveLegacy(proof, startupAdmits(dir, restored, proof));
    expect(restored.recallEntries(personKey(core([create]))!)).toEqual([]);
    restored.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
