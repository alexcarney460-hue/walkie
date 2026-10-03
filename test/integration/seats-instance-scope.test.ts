// WALK-103 (pre.12 release dry run): a Walkie daemon started with a fresh home (a smoke test, a second daemon, a copy
// of ~/.walkie) asked the seat helper for this person's held seat users and destroyed every one, since none was in
// its own records. Now the root-owned record of which Walkie owns the seat users decides: a daemon it doesn't name
// never asks the helper at all; the registered one still removes its own leftovers (only while idle); with no record
// (a setup from before) nothing found only in the helper's list is removed. And (review) each seat user in seats.json
// is stamped with the socket of the daemon that made it: without the record, a copied seats.json (or one from before
// the stamps) never makes a daemon destroy a seat user it didn't make.
// The helper here is a recording fake over a real id ledger (no OS users, no sudo, no real helper).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Ledger } from "../../src/daemon/seats/admin-ledger.ts";
import type { AdminResult, AdminVerb } from "../../src/daemon/seats/admin.ts";
import type { RegistrationRead } from "../../src/daemon/seats/instance.ts";
import { Cluster, TestNode, waitFor } from "../helpers/cluster.ts";

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
    seats: { admin, seatRegistration: () => registration(socket), reconcileRetryMs: 100, cleanupRetryMs: 100 },
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
