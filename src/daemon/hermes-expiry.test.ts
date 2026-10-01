// Round 12, finding 2: where no census runs (`discover_agents: false`, a daemon with no process provider such as Windows, a scan
// that keeps failing), nothing but a hook can end a session that died while it worked, and without that its working row decides
// its profile's card for as long as the row lasts. So a hook retires the working rows silent for more than twice the TTL when no
// census was captured in that long, and posts the cards it moved. While a census runs, the sweep stays the only remover.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { applyHermesStatus, hermesProfileStatus, noteHermesCensus } from "./hermes-status.ts";
import { dispatch, type RouteCtx } from "./local-routes.ts";
import { status, world, ME } from "../../test/helpers/discovery-world.ts";
import { hermesHook, launchd, offlineEvents, rowState } from "../../test/helpers/hermes-world.ts";

const TTL = 10 * 60_000;
const key = (name: string) => createHash("sha256").update(name).digest("hex");
type Level = "working" | "idle" | "offline";

/** A store of its own, closed and removed afterwards. */
function withStore<T>(body: (store: Store) => T): T {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-expiry-"));
  const store = new Store(join(root, "test.db"));
  try { return body(store); } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
}
/** A hook as the daemon route applies it (the receipt time is the hook's own). */
const hookOf = (store: Store, profile: string, name: string, state: Level, fallback: Level, at: number) =>
  applyHermesStatus(store, { profile, session: key(name), at, sequence: 0, state, fallback }, at);
const rowOf = (store: Store, name: string) => store.db.query<{ state: string; fallback: string; activity: string | null; source: string | null }, [string]>(
  "SELECT state, fallback, activity, source FROM hermes_sessions WHERE session = ?").get(key(name));
const cardsOf = (update: ReturnType<typeof applyHermesStatus>) => update.recomputed.map((card) => [card.body.agent, card.body.state]);

test("with no census running, a hook retires the working rows silent for more than twice the TTL, only those, and hands back the cards it moved", () => withStore((store) => {
  const t0 = 1_000_000;
  hookOf(store, "a", "stale", "working", "working", t0);
  hookOf(store, "a", "prompt", "offline", "idle", t0); // a session at its prompt: not working, so no hook retires it
  hookOf(store, "b", "idle", "idle", "idle", t0);
  hookOf(store, "c", "young", "working", "working", t0 + 12 * 60_000);
  hookOf(store, "e", "lone", "working", "working", t0);
  // exactly twice the TTL is not yet "more than": nothing is retired, and no card is handed back
  expect(cardsOf(hookOf(store, "d", "now", "idle", "idle", t0 + 2 * TTL))).toEqual([]);
  expect(rowOf(store, "stale")?.state).toBe("working");
  // one millisecond later the rows silent that long are retired: `a` keeps its session at its prompt (idle), `e` has nothing left
  expect(cardsOf(hookOf(store, "d", "now", "idle", "idle", t0 + 2 * TTL + 1))).toEqual([["hermes-a", "idle"], ["hermes-e", "offline"]]);
  expect(rowOf(store, "stale")).toEqual({ state: "offline", fallback: "offline", activity: null, source: "retired" }); // as the sweep retires a row
  expect([rowOf(store, "prompt")?.state, rowOf(store, "idle")?.state, rowOf(store, "young")?.state]).toEqual(["offline", "idle", "working"]);
  // the young row (hooked at +12 min) goes once it is that old, and nothing already retired is handed back again
  expect(cardsOf(hookOf(store, "d", "now", "idle", "idle", t0 + 12 * 60_000 + 2 * TTL + 1))).toEqual([["hermes-c", "offline"]]);
  expect(cardsOf(hookOf(store, "d", "now", "idle", "idle", t0 + 13 * 60_000 + 2 * TTL))).toEqual([]);
}));

test("the hook's own profile shows what its rows say once its silent working row is retired: a dead session no longer decides the card", () => withStore((store) => {
  const t0 = 50_000_000;
  expect(hookOf(store, "p", "A", "working", "working", t0).body.state).toBe("working"); // A works, then its process dies silently
  const t1 = t0 + 60 * 60_000; // an hour later another session of the same profile hooks
  const b = hookOf(store, "p", "B", "idle", "idle", t1);
  expect([b.body.state, b.recomputed]).toEqual(["idle", []]); // its own card is the update's, never one of the recomputed
  expect(hermesProfileStatus(store, "p").body.state).toBe("idle");
  const c = hookOf(store, "q", "C", "working", "working", t1 + 1_000); // another profile's hook finds nothing more to retire
  expect([c.body.state, c.recomputed]).toEqual(["working", []]);
}));

test("while a census runs, a hook retires nothing however old the working row: the sweep alone does, until it has not run for twice the TTL", () => withStore((store) => {
  const t0 = 1_000_000;
  hookOf(store, "a", "silent", "working", "working", t0);
  for (const age of [TTL - 1, TTL + 1, 2 * TTL + 1, 10 * TTL, 100 * TTL]) {
    noteHermesCensus(store, t0 + age - 15_000); // a scan 15 s ago
    expect(cardsOf(hookOf(store, "b", "trigger", "idle", "idle", t0 + age))).toEqual([]);
    expect(rowOf(store, "silent")?.state).toBe("working");
  }
  // the census stops: counted for twice the TTL after its capture, then the hook takes over
  const last = t0 + 100 * TTL - 15_000;
  expect(cardsOf(hookOf(store, "b", "trigger", "idle", "idle", last + 2 * TTL))).toEqual([]);
  expect(rowOf(store, "silent")?.state).toBe("working");
  expect(cardsOf(hookOf(store, "b", "trigger", "idle", "idle", last + 2 * TTL + 1))).toEqual([["hermes-a", "offline"]]);
  expect(rowOf(store, "silent")?.state).toBe("offline");
}));

test("while a census runs a hook does not even look for silent working rows; with none it looks once", () => {
  const queriesOf = (store: Store, run: () => void) => {
    const db = store.db as unknown as { query: (sql: string) => unknown };
    const original = db.query.bind(db);
    const seen: string[] = [];
    db.query = (sql: string) => { seen.push(sql); return original(sql); };
    try { run(); } finally { db.query = original; }
    return seen.filter((sql) => sql.startsWith("SELECT profile, session, pid, received_at FROM hermes_sessions WHERE state = 'working' AND received_at <"));
  };
  withStore((store) => {
    noteHermesCensus(store, 1_000_000 - 15_000);
    expect(queriesOf(store, () => hookOf(store, "a", "x", "working", "working", 1_000_000))).toEqual([]);
  });
  withStore((store) => expect(queriesOf(store, () => hookOf(store, "a", "x", "working", "working", 1_000_000))).toHaveLength(1));
});

test("the route posts the card of a profile whose silent working row the hook retired, then the hook's own", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-expiry-route-"));
  const store = new Store(join(root, "test.db"));
  const posted: Array<[string, string]> = [];
  try {
    const now = Date.now();
    const old = now - 3 * 60 * 60_000;
    store.db.query("INSERT INTO hermes_sessions(profile, session, at, seq, state, fallback, received_at) VALUES (?, ?, ?, 0, 'working', 'working', ?)")
      .run("lone", key("dead"), old, old);
    const core = { teamId: "fixture", me: () => ({ role: "member" }), store, config: { redact: false }, limiter: { take: () => true },
      hermesActivityProfiles: () => [],
      statuses: { submit: (agent: string, body: { state: string }) => { posted.push([agent, body.state]); return null; } } };
    const url = new URL("http://walkie/v1/hermes/status");
    const req = new Request(url, { method: "POST", body: JSON.stringify({ profile: "work", session: key("w"), at: now, sequence: 0, state: "working", fallback: "working" }) });
    const response = await dispatch({ core, req, url, agent: "hermes-work" } as unknown as RouteCtx);
    expect(response.status).toBe(202);
    expect(posted).toEqual([["hermes-lone", "offline"], ["hermes-work", "working"]]);
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

// ---- through the daemon's own pieces: the hooks' route helpers, discovery with a fixture process list and a moved clock -------

test("discovery off: a session that died while working no longer decides its profile's card, and the next hook of any profile posts it", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups); // no w.disc(): nothing ever scans, which is `discover_agents: false` (or a daemon with no process provider)
    hermesHook(w, "p", "A"); // A works, then its process dies silently
    hermesHook(w, "lone", "dead");
    w.clock.t += 60 * 60_000;
    hermesHook(w, "p", "B", "idle"); // an hour later another session of the same profile hooks
    expect([status(w.core, "hermes-p")?.state, rowState(w, "A")]).toEqual(["idle", "offline"]);
    expect(status(w.core, "hermes-lone")?.state).toBe("offline"); // the same hook retired the other profile's dead session and posted its card
    hermesHook(w, "q", "C");
    expect([status(w.core, "hermes-q")?.state, status(w.core, "hermes-p")?.state]).toEqual(["working", "idle"]);
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

test("a scan that keeps failing: after twice the TTL without a census, a hook retires a dead session once it too has been silent that long", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    w.fx.procs = [launchd(w)];
    const disc = w.disc();
    await disc.tick(); // a census is captured and swept at t0
    const t0 = w.clock.t;
    w.fx.failList = "null"; // from now on `ps` cannot be read
    w.clock.t = t0 + 14 * 60_000;
    hermesHook(w, "p", "A"); // works at +14 min; no process runs it, and no scan will say so
    for (const minute of [15, 19, 25]) { w.clock.t = t0 + minute * 60_000; await disc.tick(); hermesHook(w, "q", "other"); }
    expect(rowState(w, "A")).toBe("working"); // at +25 min the census is old enough to count as gone, but A has been silent for 11 minutes only
    w.clock.t = t0 + 35 * 60_000; // 21 minutes silent
    await disc.tick();
    hermesHook(w, "q", "other");
    expect([rowState(w, "A"), status(w.core, "hermes-p")?.state]).toEqual(["offline", "offline"]);
    expect(offlineEvents(w, "hermes-p")).toBe(1);
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});

test("with discovery running, the sweep stays the only remover: a working row its process keeps live is not retired by another profile's hooks", async () => {
  const cleanups: Array<() => void> = [];
  try {
    const w = world(cleanups);
    w.fx.procs = [launchd(w), { pid: 500, ppid: 1, uid: ME, startedAt: w.clock.t - 3_600_000, command: "hermes -p p chat", tty: "ttys001" },
      { pid: 501, ppid: 1, uid: ME, startedAt: w.clock.t - 3_600_000, command: "hermes -p q chat", tty: "ttys002" }];
    w.fx.cwds.set(500, w.cwd);
    w.fx.cwds.set(501, w.cwd);
    const disc = w.disc();
    await disc.tick();
    hermesHook(w, "p", "long", "working", 500); // a hook that names its pid: the sweep keeps the row for as long as that process runs
    for (let step = 1; step <= 360; step++) { // 30 minutes, with another profile hooking every 5 s and the census scanning every 15 s
      w.clock.t += 5_000;
      hermesHook(w, "q", "busy");
      if (step % 3 === 0) await disc.tick();
    }
    expect(rowState(w, "long")).toBe("working"); // older than twice the TTL, yet no hook retired it
    w.fx.procs = w.fx.procs.filter((p) => p.pid !== 500);
    w.clock.t += 15_000;
    await disc.tick();
    expect(rowState(w, "long")).toBe("offline"); // its process exited: the sweep retires it
  } finally { while (cleanups.length) cleanups.pop()?.(); }
});
