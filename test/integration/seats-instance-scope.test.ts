// WALK-103 (pre.12 release dry run): a Walkie daemon started with a fresh home (a smoke test, a second daemon, a copy
// of ~/.walkie) asked the seat helper for this person's held seat users and destroyed every one, since none was in
// its own records. Now the root-owned record of which Walkie owns the seat users decides: a daemon it doesn't name
// never asks the helper at all; the registered one still removes its own leftovers (only while idle); with no record
// (a setup from before) nothing found only in the helper's list is removed. And (review) each seat user in seats.json
// is stamped with the socket of the daemon that made it: without the record, a copied seats.json (or one from before
// the stamps) never makes a daemon destroy a seat user it didn't make.
// The helper here is a recording fake over a real id ledger (no OS users, no sudo, no real helper).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Ledger } from "../../src/daemon/seats/admin-ledger.ts";
import type { AdminResult, AdminVerb } from "../../src/daemon/seats/admin.ts";
import type { RegistrationRead } from "../../src/daemon/seats/instance.ts";
import type { BodyOf, Event } from "../../src/protocol/schemas.ts";
import { seatAgentName, seatOf, seatsChannel, type SeatState } from "../../src/protocol/seats.ts";
import { Cluster, TestNode, waitFor } from "../helpers/cluster.ts";
import { noKeychainSeats } from "../helpers/no-keychain.ts";

const ME = process.getuid?.() ?? 501;
let c: Cluster;
beforeAll(() => { c = new Cluster(); });
afterAll(async () => { await c.close(); });

type Call = { verb: AdminVerb; n: number; idle: boolean };

/** A helper over a real ledger at `path` that records every call; `held` ids exist (made by "the real daemon"). */
function fakeHelper(path: string, held: number[]): { calls: Call[]; admin: (verb: AdminVerb, n: number, o?: { idle?: boolean }) => Promise<AdminResult> } {
  const seed = new Ledger(path);
  const op = { pid: process.pid, start: "the-real-daemon" };
  for (const n of held) {
    expect(seed.reserve(n, ME, op).ok).toBe(true);
    expect(seed.advance(n, op, "reserved", "making")).toBe(true);
    seed.finish(n, op, "created");
  }
  seed.close();
  const calls: Call[] = [];
  return {
    calls,
    admin: async (verb, n, o) => {
      calls.push({ verb, n, idle: o?.idle === true });
      const ledger = new Ledger(path);
      try {
        if (verb === "pending") { const ids = ledger.pending(ME); return { ok: true, ids, idleIds: ids }; }
        if (verb === "destroy") {
          const destroy = { pid: process.pid, start: `destroy-${n}-${calls.length}` };
          const taken = ledger.takeForDestroy(n, ME, destroy);
          if (!taken.ok) return { ok: false, why: "not held" };
          if (taken.state !== "cancelled") ledger.finish(n, destroy, "destroyed");
          return { ok: true };
        }
        return { ok: false, code: "refused", why: "no seat users are made in this test" };
      } finally { ledger.close(); }
    },
  };
}

/** A node whose home is prepared first (seats.json), started with the fake helper and this registration. */
async function node(name: string, admin: ReturnType<typeof fakeHelper>["admin"], registration: (socket: string) => RegistrationRead,
  seatsJson?: (socket: string) => object): Promise<TestNode> {
  const home = join(c.root, name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const socket = join(home, "walkie.sock");
  if (seatsJson) writeFileSync(join(home, "seats.json"), JSON.stringify(seatsJson(socket)), { mode: 0o600 });
  const n = new TestNode(c, {
    name, login: `${name}@example.com`, hostname: `${name}-box`,
    seats: noKeychainSeats(home, {
      admin, seatRegistration: () => registration(socket), reconcileRetryMs: 100, cleanupRetryMs: 100,
      env: { PATH: "/usr/bin:/bin" },
    }),
  }, home, 0);
  c.nodes.push(n);
  return n.start();
}

// As setup-user records it (instance.ts canonicalPath; written out so this file also runs against the tree before WALK-103).
const canonical = (p: string): string => { try { return join(realpathSync(dirname(p)), basename(p)); } catch { return p; } };
const present = (socket: string): RegistrationRead =>
  ({ state: "present", registration: { v: 1, user: "arvid", uid: ME, home: "/home/arvid/.walkie", socket: canonical(socket) } });

const madeBy = (socket: string, ids: number[]) => Object.fromEntries(ids.map((n) => [String(n), canonical(socket)]));
const destroys = (calls: Call[]) => calls.filter((call) => call.verb === "destroy").sort((a, b) => a.n - b.n);

test("a fresh-home daemon never asks the helper to list or remove the registered Walkie's seat users", async () => {
  const ledger = join(c.root, "fresh-ledger.sqlite");
  const helper = fakeHelper(ledger, [5, 6, 7]);
  const real = join(c.root, "real", "walkie.sock");
  // Its seats.json even names one of them, with a seat that ran (a copied ~/.walkie): still never removed by it.
  const fresh = await node("fresh", helper.admin, () => present(real), () => ({ handled: {}, user_high: 7, users: [7], made_by: madeBy(real, [7]),
    running: [{ id: "abcd", dir: join(c.root, "real-seat"), runner: true, user: 7, instance: canonical(real) }] }));
  await waitFor(async () => helper.calls.length > 0 || (await fresh.client().seats()).local.reconcile_error, { what: "the fresh daemon's start" });
  await Bun.sleep(500); // a cleanup retry (100 ms) would have come by now
  expect(helper.calls).toEqual([]);
  const local = (await fresh.client().seats()).local;
  expect(local.foreign_users).toEqual(["walkie-s7"]);
  expect(local.reconcile_error).toContain("managed by another Walkie");
  expect(local.seat_scope).toMatchObject({ state: "other", why: expect.stringContaining("managed by another Walkie") });
  const after = new Ledger(ledger);
  try { expect(after.pending(ME)).toEqual([5, 6, 7]); } finally { after.close(); }
}, 60_000);

test("the registered daemon removes its own seat users, and any other it holds only while idle", async () => {
  const ledger = join(c.root, "own-ledger.sqlite");
  const helper = fakeHelper(ledger, [3, 4, 5]);
  // 5: made by this daemon (stamped); 4: from before the stamps; 3: only in the helper's list.
  const own = await node("own", helper.admin, (s) => present(s), (socket) => ({ handled: {}, running: [], users: [4, 5], user_high: 5, made_by: madeBy(socket, [5]) }));
  await waitFor(() => destroys(helper.calls).length >= 3, { what: "the three seat users removed" });
  expect(destroys(helper.calls)).toEqual([{ verb: "destroy", n: 3, idle: true }, { verb: "destroy", n: 4, idle: true }, { verb: "destroy", n: 5, idle: false }]);
  const view = (await own.client().seats()).local;
  expect(view.seat_scope).toBeUndefined();
  expect(view.reconcile_error).toBeUndefined();
  expect(view.foreign_users).toBeUndefined();
  const after = new Ledger(ledger);
  try { expect(after.pending(ME)).toEqual([]); } finally { after.close(); }
}, 60_000);

test("review probe: no record, and a seats.json naming the real daemon's users 6 and 7: neither is destroyed", async () => {
  const ledger = join(c.root, "probe-ledger.sqlite");
  const helper = fakeHelper(ledger, [6, 7]);
  // A copy of the real daemon's ~/.walkie from before the stamps, its seat 7 running when it was copied.
  const copy = await node("copy", helper.admin, () => ({ state: "absent" }), () => ({ handled: {}, users: [6, 7], user_high: 7,
    running: [{ id: "beef", dir: join(c.root, "real-seat-7"), runner: true, user: 7 }] }));
  await waitFor(() => helper.calls.some((call) => call.verb === "pending"), { what: "the copy's start" });
  await Bun.sleep(500);
  expect(destroys(helper.calls)).toEqual([]);
  const view = (await copy.client().seats()).local;
  expect(view.foreign_users).toEqual(["walkie-s6", "walkie-s7"]);
  // Its seat stays the original's: not posted as failed or ended from the copy, which shares the original's node key.
  const log = readFileSync(join(copy.home, "logs", "daemon.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { msg: string; id?: string; thread?: string });
  expect(log.some((l) => l.msg === "seats_leftover_kept" && l.id === "beef")).toBe(true);
  expect(log.some((l) => l.msg === "seats_leftover")).toBe(false);
  expect(log.some((l) => l.msg.startsWith("seats_post") && l.thread === "beef")).toBe(false);
  expect(view.seat_scope).toMatchObject({ state: "legacy", why: expect.stringContaining("setup-user --apply") });
  expect(view.reconcile_error).toBeUndefined();
  const after = new Ledger(ledger);
  try { expect(after.pending(ME)).toEqual([6, 7]); } finally { after.close(); }
}, 60_000);

test("with no record, a daemon still removes the seat users it made itself, and nothing another Walkie made", async () => {
  const ledger = join(c.root, "legacy-ledger.sqlite");
  const helper = fakeHelper(ledger, [5, 8, 9]);
  // 9: made by this daemon; 5: made by another Walkie here (a copy of its stamped seats.json); 8: only in the helper's list.
  const legacy = await node("legacy", helper.admin, () => ({ state: "absent" }), (socket) => ({ handled: {}, running: [], users: [5, 9], user_high: 9,
    made_by: { ...madeBy(join(c.root, "elsewhere", "walkie.sock"), [5]), ...madeBy(socket, [9]) } }));
  await waitFor(() => destroys(helper.calls).length > 0 && helper.calls.some((call) => call.verb === "pending"), { what: "the legacy daemon's start" });
  await Bun.sleep(300);
  expect(destroys(helper.calls)).toEqual([{ verb: "destroy", n: 9, idle: false }]);
  const view = (await legacy.client().seats()).local;
  expect(view.foreign_users).toEqual(["walkie-s5", "walkie-s8"]);
  expect(view.seat_scope).toMatchObject({ state: "legacy", why: expect.stringContaining("setup-user --apply") });
  const after = new Ledger(ledger);
  try { expect(after.pending(ME)).toEqual([5, 8]); } finally { after.close(); }
}, 60_000);

test("a leftover the helper won't remove while it runs is shown as such and keeps its slot; only its own users carry its stamp", async () => {
  const ledger = join(c.root, "busy-ledger.sqlite");
  const helper = fakeHelper(ledger, [2, 6]);
  // 2: only in the helper's list, still running something; 6: made by this daemon, its cleanup not verified yet.
  const admin: typeof helper.admin = async (verb, n, o) => {
    if (verb === "destroy") {
      helper.calls.push({ verb, n, idle: o?.idle === true });
      return o?.idle
        ? { ok: false, code: "running", processesGone: false, name: `walkie-s${n}`, why: `walkie-s${n} still has 1 running process and isn't one of this Walkie's current seats: not removed while it runs (checked again later)` }
        : { ok: false, name: `walkie-s${n}`, why: "services: launchctl bootout failed" };
    }
    return helper.admin(verb, n, o);
  };
  const busy = await node("busy", admin, (s) => present(s), (socket) => ({ handled: {}, running: [], users: [6], user_high: 6, made_by: madeBy(socket, [6]) }));
  const view = await waitFor(async () => { const v = (await busy.client().seats()).local; return v.leftovers_running ? v : null; }, { what: "the running leftover in the view" });
  expect(view.leftovers_running).toEqual(["walkie-s2"]);
  expect(view.quarantined).toEqual(["walkie-s2", "walkie-s6"]);
  expect(destroys(helper.calls).filter((call) => call.n === 2).every((call) => call.idle)).toBe(true);
  expect(destroys(helper.calls).filter((call) => call.n === 6).every((call) => !call.idle)).toBe(true);
  // The record claims only what this daemon made: 6 keeps its stamp, the recovered 2 has none (and stays idle-only).
  const saved = JSON.parse(readFileSync(join(busy.home, "seats.json"), "utf8")) as { users: number[]; recovered?: number[]; made_by?: Record<string, string> };
  expect([...saved.users].sort((a, b) => a - b)).toEqual([2, 6]);
  expect(saved.recovered).toEqual([2]);
  expect(saved.made_by).toEqual(madeBy(join(busy.home, "walkie.sock"), [6]));
}, 60_000);

// A real seat id (msg.post thread and SeatState.seat are event ids; "beef" would be rejected).
const UPGRADE_SEAT = "0123456789abcdef:3";
const UPGRADE_REASON = "ended after an upgrade; its machine restarted";

interface SavedRunning { id: string; dir?: string; runner?: true; user?: number; instance?: string; kept?: string }
interface SavedFile { running?: SavedRunning[]; users?: number[] }

function readSeats(home: string): SavedFile {
  return JSON.parse(readFileSync(join(home, "seats.json"), "utf8")) as SavedFile;
}

function daemonLog(home: string): { msg: string; id?: string; thread?: string; why?: string; dropped?: boolean; user?: string }[] {
  return readFileSync(join(home, "logs", "daemon.log"), "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as { msg: string; id?: string; thread?: string; why?: string; dropped?: boolean });
}

/** Failed state posts for a seat (the reason the team reads; the card activity is a fixed phrase). */
function failedStates(n: TestNode, seatId = UPGRADE_SEAT): SeatState[] {
  const rows = n.d.core.store.queryEvents({ channel: seatsChannel(n.d.nodeId), thread: seatId, kinds: ["msg.post"], limit: 50 });
  const out: SeatState[] = [];
  for (const row of rows) {
    const seat = seatOf((JSON.parse(row.json) as Event).body);
    if (seat?.op === "state" && seat.state === "failed" && seat.seat === seatId) out.push(seat);
  }
  return out;
}

/** Offline cards for that seat. One submit is one event; a second end would add another. */
function offlineCards(n: TestNode, seatId = UPGRADE_SEAT): { state?: string }[] {
  const agent = seatAgentName(seatId);
  return n.d.core.store.queryEvents({ kinds: ["agent.status"], agents: [agent], limit: 20 }).flatMap((row) => {
    const body = (JSON.parse(row.json) as Event).body as { agent?: string; state?: string };
    return body.agent === agent && body.state === "offline" ? [body] : [];
  });
}

test("an unstamped running seat from the first upgrade is kept, and ended once only after this Walkie is registered and its user is idle", async () => {
  const ledger = join(c.root, "upgrade-ledger.sqlite");
  const helper = fakeHelper(ledger, [7]);
  let mode: "legacy" | "copy" | "own" = "legacy";
  let userBusy = false;
  const elsewhere = join(c.root, "elsewhere", "walkie.sock");
  const admin: typeof helper.admin = async (verb, n, o) => {
    if (verb === "pending") {
      const r = await helper.admin(verb, n, o);
      if (!userBusy || !r.ok || !Array.isArray(r.ids)) return r;
      return { ...r, idleIds: (r.idleIds ?? []).filter((id) => id !== 7) };
    }
    if (verb === "destroy" && n === 7 && userBusy) {
      helper.calls.push({ verb, n, idle: o?.idle === true });
      return { ok: false, code: "running", processesGone: false, name: "walkie-s7", why: "walkie-s7 still has 1 running process and isn't one of this Walkie's current seats: not removed while it runs (checked again later)" };
    }
    return helper.admin(verb, n, o);
  };
  const home = join(c.root, "upgrade");
  const marker = join(home, ".walkie-workers", "seat-0123456789abcdef-3", "marker");
  mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
  writeFileSync(marker, "keep\n", { mode: 0o600 });
  const upgrade = await node("upgrade", admin, (socket) => (
    mode === "copy" ? present(elsewhere) : mode === "own" ? present(socket) : { state: "absent" }
  ), () => ({ handled: {}, users: [7], user_high: 7, running: [{ id: UPGRADE_SEAT, dir: join(c.root, "s"), runner: true, user: 7 }] }));

  // Legacy start (no seat-instance record): the entry stays, nothing is destroyed or posted, its worker root stays.
  await waitFor(() => helper.calls.some((call) => call.verb === "pending"), { what: "the legacy start's pending list" });
  await Bun.sleep(200);
  const kept = readSeats(upgrade.home).running?.find((r) => r.id === UPGRADE_SEAT);
  expect(kept?.kept).toBe("foreign");
  expect(kept?.user).toBe(7);
  expect(kept?.runner).toBe(true);
  expect(kept?.instance).toBeUndefined();
  expect(destroys(helper.calls)).toEqual([]);
  const legacyLog = daemonLog(upgrade.home);
  expect(legacyLog.some((l) => l.msg === "seats_leftover_kept" && l.id === UPGRADE_SEAT)).toBe(true);
  expect(legacyLog.some((l) => l.msg === "seats_leftover" && l.id === UPGRADE_SEAT)).toBe(false);
  expect(legacyLog.some((l) => l.msg.startsWith("seats_post") && l.thread === UPGRADE_SEAT)).toBe(false);
  expect(existsSync(marker)).toBe(true);
  const ledger1 = new Ledger(ledger);
  try { expect(ledger1.pending(ME)).toEqual([7]); } finally { ledger1.close(); }

  // Still legacy, but the seats channel is fit and the helper calls the user idle. A non-registered daemon must not end the card.
  await upgrade.client().init("acme", "alex");
  await upgrade.client("").seatsConfig({ allow: true, same_user: true });
  await waitFor(async () => ((await upgrade.client().seats()).local.channel_ok ? true : null), { what: "the seats channel" });
  await Bun.sleep(300);
  expect(failedStates(upgrade)).toEqual([]);
  expect(offlineCards(upgrade)).toEqual([]);
  const afterAllow = readSeats(upgrade.home).running?.find((r) => r.id === UPGRADE_SEAT);
  expect(afterAllow?.kept).toBe("foreign");
  expect(afterAllow?.instance).toBeUndefined();
  expect(destroys(helper.calls)).toEqual([]);
  expect(existsSync(marker)).toBe(true);

  // A copy (the record names another socket) shares this node's key and must not end the card either.
  const callsAtCopy = helper.calls.length;
  mode = "copy";
  await upgrade.restart();
  await Bun.sleep(400);
  expect(helper.calls.length).toBe(callsAtCopy);
  expect(destroys(helper.calls)).toEqual([]);
  expect(failedStates(upgrade)).toEqual([]);
  expect(offlineCards(upgrade)).toEqual([]);
  const copied = readSeats(upgrade.home).running?.find((r) => r.id === UPGRADE_SEAT);
  expect(copied?.kept).toBe("foreign");
  expect(copied?.user).toBe(7);
  expect(copied?.runner).toBe(true);
  expect(copied?.instance).toBeUndefined();
  const copyView = (await upgrade.client().seats()).local;
  expect(copyView.foreign_users).toContain("walkie-s7");
  expect(copyView.seat_scope).toMatchObject({ state: "other" });
  expect(existsSync(marker)).toBe(true);

  // Registered, while the seat user still has a process: keep the entry, never kill it, never post.
  userBusy = true;
  mode = "own";
  await upgrade.restart();
  await waitFor(() => destroys(helper.calls).some((call) => call.n === 7), { what: "an idle destroy of the leftover user" });
  await Bun.sleep(400);
  const busyDestroys = destroys(helper.calls).filter((call) => call.n === 7);
  expect(busyDestroys.length).toBeGreaterThan(0);
  expect(busyDestroys.every((call) => call.idle)).toBe(true);
  expect(failedStates(upgrade)).toEqual([]);
  expect(offlineCards(upgrade)).toEqual([]);
  const busySaved = readSeats(upgrade.home).running?.find((r) => r.id === UPGRADE_SEAT);
  expect(busySaved?.kept).toBe("foreign");
  expect(busySaved?.user).toBe(7);
  expect(busySaved?.instance).toBeUndefined();
  expect(daemonLog(upgrade.home).some((l) => l.msg === "seats_leftover" && l.id === UPGRADE_SEAT)).toBe(false);
  expect((await upgrade.client().seats()).local.foreign_users ?? []).not.toContain("walkie-s7");
  const held = new Ledger(ledger);
  try { expect(held.pending(ME)).toEqual([7]); } finally { held.close(); }
  expect(existsSync(marker)).toBe(true);

  // The user is idle (the cleanup retry's destroy succeeds): one failed state, one offline card, then the entry is gone.
  userBusy = false;
  await waitFor(() => failedStates(upgrade).length === 1, { timeoutMs: 8_000, what: "the leftover seat posted failed" });
  expect(failedStates(upgrade)).toEqual([{ op: "state", v: 1, seat: UPGRADE_SEAT, state: "failed", reason: UPGRADE_REASON, dir: join(c.root, "s") }]);
  const cards = offlineCards(upgrade);
  expect(cards).toHaveLength(1);
  expect(cards[0]?.state).toBe("offline");
  expect(readSeats(upgrade.home).running?.some((r) => r.id === UPGRADE_SEAT)).toBe(false);
  const gone = new Ledger(ledger);
  try { expect(gone.pending(ME)).toEqual([]); } finally { gone.close(); }
  expect(existsSync(marker)).toBe(true);

  // The next start of the registered daemon does not post the end again.
  await upgrade.restart();
  await Bun.sleep(500);
  expect(failedStates(upgrade)).toHaveLength(1);
  expect(offlineCards(upgrade)).toHaveLength(1);

  // Crash between the post and the seats.json write: the store has the end, the file is still the kept entry.
  await upgrade.stop();
  writeFileSync(join(upgrade.home, "seats.json"), JSON.stringify({
    handled: {}, users: [7], user_high: 7,
    running: [{ id: UPGRADE_SEAT, dir: join(c.root, "s"), runner: true, user: 7, kept: "foreign" }],
  }), { mode: 0o600 });
  await upgrade.start();
  await waitFor(() => (readSeats(upgrade.home).running ?? []).some((r) => r.id === UPGRADE_SEAT) ? null : true, {
    timeoutMs: 8_000, what: "the restored leftover entry dropped without a second end",
  });
  await Bun.sleep(400);
  expect(failedStates(upgrade)).toHaveLength(1);
  expect(offlineCards(upgrade)).toHaveLength(1);
  expect(daemonLog(upgrade.home).some((l) => l.msg === "seats_leftover_end_skipped" && l.id === UPGRADE_SEAT)).toBe(true);
}, 30_000);

test("a kept seat the helper never made is dropped, and its idle destroy is not retried", async () => {
  const ledger = join(c.root, "never-made-ledger.sqlite");
  const helper = fakeHelper(ledger, []);
  const seatId = "0123456789abcdef:4";
  const neverMade = "walkie-s12: never made by this helper: not destroyed";
  let mode: "legacy" | "own" = "legacy";
  const admin: typeof helper.admin = async (verb, n, o) => {
    if (verb === "destroy") {
      helper.calls.push({ verb, n, idle: o?.idle === true });
      return { ok: false, name: `walkie-s${n}`, why: neverMade };
    }
    return helper.admin(verb, n, o);
  };
  const home = join(c.root, "unmade");
  const nodeUnder = await node("unmade", admin, (socket) => (
    mode === "own" ? present(socket) : { state: "absent" }
  ), () => ({ handled: {}, users: [12], user_high: 12, running: [{ id: seatId, dir: join(c.root, "unmade-seat"), runner: true, user: 12 }] }));

  await waitFor(() => helper.calls.some((call) => call.verb === "pending"), { what: "the legacy start's pending list" });
  await Bun.sleep(300);
  expect(destroys(helper.calls)).toEqual([]);
  expect(readSeats(home).running?.find((r) => r.id === seatId)?.kept).toBe("foreign");
  expect(failedStates(nodeUnder, seatId)).toEqual([]);

  await nodeUnder.client().init("acme", "maren");
  await nodeUnder.client("").seatsConfig({ allow: true, same_user: true });
  await waitFor(async () => ((await nodeUnder.client().seats()).local.channel_ok ? true : null), { what: "the seats channel" });
  expect(failedStates(nodeUnder, seatId)).toEqual([]);
  expect(destroys(helper.calls)).toEqual([]);

  mode = "own";
  await nodeUnder.restart();
  await waitFor(() => failedStates(nodeUnder, seatId).length === 1, { timeoutMs: 8_000, what: "the never-made leftover posted failed once" });
  await Bun.sleep(500);
  const ends = destroys(helper.calls).filter((call) => call.n === 12);
  expect(ends).toEqual([{ verb: "destroy", n: 12, idle: true }]);
  expect(failedStates(nodeUnder, seatId).map((s) => s.reason)).toEqual([UPGRADE_REASON]);
  expect(offlineCards(nodeUnder, seatId)).toHaveLength(1);
  expect(readSeats(nodeUnder.home).running?.some((r) => r.id === seatId)).toBe(false);
  const logged = daemonLog(nodeUnder.home).filter((l) => l.msg === "seats_leftover_never_made");
  expect(logged.length).toBeGreaterThan(0);
  expect(logged.every((l) => l.dropped === true && (l.why ?? "").includes("not retried") && (l.why ?? "").includes("dropped"))).toBe(true);
  await Bun.sleep(400);
  expect(destroys(helper.calls).filter((call) => call.n === 12)).toHaveLength(1);
  expect(failedStates(nodeUnder, seatId)).toHaveLength(1);
  expect(offlineCards(nodeUnder, seatId)).toHaveLength(1);
}, 30_000);

async function fitChannel(n: TestNode): Promise<void> {
  await n.client().init("acme", "maren");
  await n.client("").seatsConfig({ allow: true, same_user: true });
  await waitFor(async () => ((await n.client().seats()).local.channel_ok ? true : null), { what: "the seats channel" });
  await Bun.sleep(200);
}

const destroyCount = (calls: Call[], n: number) => calls.filter((call) => call.verb === "destroy" && call.n === n).length;

test("a failure whose text merely contains the never-made words keeps retrying a user the ledger still holds", async () => {
  const seats = [9, 10, 11].map((n) => ({ id: `0123456789abcdef:${40 + n}`, user: n }));
  const ledger = join(c.root, "forged-never-made.sqlite");
  const helper = fakeHelper(ledger, seats.map((s) => s.user));
  let mode: "legacy" | "own" = "legacy";
  const admin: typeof helper.admin = async (verb, n, o) => {
    if (verb === "pending") {
      const r = await helper.admin(verb, n, o);
      // Held, and not idle: the card stays up, so every destroy is judged while the kept entry exists.
      return r.ok ? { ...r, idleIds: [] } : r;
    }
    if (verb === "destroy") {
      helper.calls.push({ verb, n, idle: o?.idle === true });
      const name = `walkie-s${n}`;
      if (n === 9) {
        const why = "mounts of it remain: /tmp/never made by this helper";
        return { ok: false, name, left: [why], why };
      }
      if (n === 10) return { ok: false, name, left: ["/tmp/kept"], why: `${name}: never made by this helper: not destroyed` };
      return { ok: false, name, code: "failed", why: `${name}: never made by this helper: not destroyed` };
    }
    return helper.admin(verb, n, o);
  };
  const nodeUnder = await node("forged", admin, (socket) => (
    mode === "own" ? present(socket) : { state: "absent" }
  ), () => ({
    handled: {}, users: seats.map((s) => s.user), user_high: 11,
    running: seats.map((s) => ({ id: s.id, dir: join(c.root, `forged-${s.user}`), runner: true, user: s.user })),
  }));
  await waitFor(() => helper.calls.some((call) => call.verb === "pending"), { what: "the legacy pending list" });
  mode = "own";
  await nodeUnder.restart();
  await waitFor(() => seats.every((s) => destroyCount(helper.calls, s.user) >= 2), { timeoutMs: 8_000, what: "each forged destroy retried" });
  const held = new Ledger(ledger);
  try { expect(held.pending(ME).sort((a, b) => a - b)).toEqual([9, 10, 11]); } finally { held.close(); }
  const view = (await nodeUnder.client().seats()).local;
  for (const n of [9, 10, 11]) expect(view.quarantined ?? []).toContain(`walkie-s${n}`);
  expect(daemonLog(nodeUnder.home).some((l) => l.msg === "seats_leftover_never_made")).toBe(false);
  for (const s of seats) expect(readSeats(nodeUnder.home).running?.some((r) => r.id === s.id)).toBe(true);
}, 30_000);

test("a never-made answer still drops the user when the pending list already ended the card", async () => {
  const seatA = "0123456789abcdef:35";
  const seatB = "0123456789abcdef:36";
  const home = join(c.root, "ended-first");
  const ledger = join(c.root, "ended-first.sqlite");
  const helper = fakeHelper(ledger, []);
  let mode: "legacy" | "own" = "legacy";
  let sawCardsGone = false;
  const admin: typeof helper.admin = async (verb, n, o) => {
    if (verb === "destroy" && n === 12 && destroyCount(helper.calls, 12) === 0) {
      helper.calls.push({ verb, n, idle: o?.idle === true });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const running = readSeats(home).running ?? [];
        if (!running.some((r) => r.id === seatA || r.id === seatB)) { sawCardsGone = true; break; }
        await Bun.sleep(20);
      }
      return { ok: false, name: "walkie-s12", why: "walkie-s12: never made by this helper: not destroyed" };
    }
    if (verb === "destroy") {
      helper.calls.push({ verb, n, idle: o?.idle === true });
      return { ok: false, name: `walkie-s${n}`, why: `walkie-s${n}: never made by this helper: not destroyed` };
    }
    return helper.admin(verb, n, o);
  };
  const nodeUnder = await node("ended-first", admin, (socket) => (
    mode === "own" ? present(socket) : { state: "absent" }
  ), () => ({
    handled: {}, users: [12, 13], user_high: 13, running: [
      { id: seatA, dir: join(c.root, "ended-a"), runner: true, user: 12 },
      { id: seatB, dir: join(c.root, "ended-b"), runner: true, user: 13 },
    ],
  }));
  await fitChannel(nodeUnder);
  expect(destroys(helper.calls)).toEqual([]);
  mode = "own";
  await nodeUnder.restart();
  await waitFor(() => destroyCount(helper.calls, 12) >= 1 && destroyCount(helper.calls, 13) >= 1, {
    timeoutMs: 8_000, what: "both never-made destroys answered",
  });
  await Bun.sleep(500);
  expect(sawCardsGone).toBe(true);
  expect(destroyCount(helper.calls, 12)).toBe(1);
  expect(destroyCount(helper.calls, 13)).toBe(1);
  expect(failedStates(nodeUnder, seatA)).toHaveLength(1);
  expect(failedStates(nodeUnder, seatB)).toHaveLength(1);
  expect(offlineCards(nodeUnder, seatA)).toHaveLength(1);
  expect(offlineCards(nodeUnder, seatB)).toHaveLength(1);
  const view = (await nodeUnder.client().seats()).local;
  expect(view.quarantined ?? []).not.toContain("walkie-s12");
  expect(view.quarantined ?? []).not.toContain("walkie-s13");
  const logged = daemonLog(nodeUnder.home).filter((l) => l.msg === "seats_leftover_never_made");
  expect(logged.map((l) => l.user).sort()).toEqual(["walkie-s12", "walkie-s13"]);
  expect(readSeats(nodeUnder.home).users ?? []).not.toContain(12);
  expect(readSeats(nodeUnder.home).users ?? []).not.toContain(13);
}, 30_000);

test("a planted terminal state retries the card end and does not log it as skipped", async () => {
  const seatId = "0123456789abcdef:32";
  const ledger = join(c.root, "retry-end.sqlite");
  const helper = fakeHelper(ledger, []);
  let mode: "legacy" | "own" = "legacy";
  const admin: typeof helper.admin = async (verb, n, o) => {
    if (verb === "destroy") {
      helper.calls.push({ verb, n, idle: o?.idle === true });
      return { ok: true };
    }
    return helper.admin(verb, n, o);
  };
  const nodeUnder = await node("retry-end", admin, (socket) => (
    mode === "own" ? present(socket) : { state: "absent" }
  ), () => ({ handled: {}, users: [8], user_high: 8, running: [{ id: seatId, dir: join(c.root, "retry-seat"), runner: true, user: 8 }] }));
  await fitChannel(nodeUnder);
  nodeUnder.d.core.emit("msg.post", {
    text: "planted failed", thread: seatId,
    seat: { op: "state", v: 1, seat: seatId, state: "failed", reason: "planted" },
  } as BodyOf<"msg.post">, { channel: seatsChannel(nodeUnder.d.nodeId), agent: "seats" });
  expect(failedStates(nodeUnder, seatId)).toHaveLength(1);
  expect(offlineCards(nodeUnder, seatId)).toHaveLength(0);
  mode = "own";
  await nodeUnder.restart();
  await waitFor(() => (readSeats(nodeUnder.home).running ?? []).some((r) => r.id === seatId) ? null : true, {
    timeoutMs: 8_000, what: "the planted seat's entry dropped",
  });
  await Bun.sleep(300);
  const log = daemonLog(nodeUnder.home);
  expect(failedStates(nodeUnder, seatId)).toHaveLength(1);
  expect(offlineCards(nodeUnder, seatId)).toHaveLength(1);
  expect(log.some((l) => l.msg === "seats_leftover_end_retry" && l.id === seatId)).toBe(true);
  expect(log.some((l) => l.msg === "seats_leftover_ended" && l.id === seatId)).toBe(true);
  expect(log.some((l) => l.msg === "seats_leftover_end_skipped" && l.id === seatId)).toBe(false);
}, 30_000);

test("an agent row that is not offline is ended even when an older status event is offline", async () => {
  const seatId = "0123456789abcdef:41";
  const ledger = join(c.root, "row-offline.sqlite");
  const helper = fakeHelper(ledger, [7]);
  let mode: "legacy" | "own" = "legacy";
  const nodeUnder = await node("row-offline", helper.admin, (socket) => (
    mode === "own" ? present(socket) : { state: "absent" }
  ), () => ({ handled: {}, users: [7], user_high: 7, running: [{ id: seatId, dir: join(c.root, "row-seat"), runner: true, user: 7 }] }));
  await fitChannel(nodeUnder);
  mode = "own";
  await nodeUnder.restart();
  await waitFor(() => offlineCards(nodeUnder, seatId).length === 1 && !(readSeats(nodeUnder.home).running ?? []).some((r) => r.id === seatId), {
    timeoutMs: 8_000, what: "the first end",
  });
  const agent = seatAgentName(seatId);
  nodeUnder.d.core.emit("agent.status", { agent, state: "working", runtime: "other", activity: "Seat running", parent: "seats" }, { agent });
  const row = () => {
    const stored = nodeUnder.d.core.store.agent(nodeUnder.d.nodeId, agent);
    return stored ? (JSON.parse(stored.body) as { state?: string }).state ?? null : null;
  };
  expect(row()).toBe("working");
  expect(offlineCards(nodeUnder, seatId)).toHaveLength(1);
  await nodeUnder.stop();
  writeFileSync(join(nodeUnder.home, "seats.json"), JSON.stringify({
    handled: {}, users: [7], user_high: 7,
    running: [{ id: seatId, dir: join(c.root, "row-seat"), runner: true, user: 7, kept: "foreign" }],
  }), { mode: 0o600 });
  await nodeUnder.start();
  await waitFor(() => (readSeats(nodeUnder.home).running ?? []).some((r) => r.id === seatId) ? null : true, {
    timeoutMs: 8_000, what: "the restored entry dropped",
  });
  await Bun.sleep(300);
  expect(failedStates(nodeUnder, seatId)).toHaveLength(1);
  expect(offlineCards(nodeUnder, seatId)).toHaveLength(2);
  expect(row()).toBe("offline");
  const log = daemonLog(nodeUnder.home);
  expect(log.some((l) => l.msg === "seats_leftover_end_skipped" && l.id === seatId)).toBe(false);
  expect(log.some((l) => l.msg === "seats_leftover_end_retry" && l.id === seatId)).toBe(true);
}, 30_000);
