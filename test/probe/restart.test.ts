// PROBE (reviewer): daemon restart mid-queue. Ledger rows left as a killed daemon/helper leaves them: one `destroying` held by a DEAD op,
// one `created`, one `reserved` by a dead create. Does the next daemon finish them all, and do they stop holding slots?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdminVerb } from "../../src/daemon/seats/admin.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, signInCodex, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";
const FIXTURES = join(import.meta.dir, "..", "fixtures");
let c: Cluster; let arvid: TestNode; let world: FakeSeatWorld; const calls: string[] = [];
beforeAll(async () => {
  c = new Cluster();
  const personHome = join(c.root, "arvid-home"); mkdirSync(join(personHome, ".claude"), { recursive: true }); chmodSync(personHome, 0o700); signInCodex(personHome);
  const walkieHome = join(c.root, "arvid"); world = fakeSeatWorld(c.root, walkieHome); world.sys.acl = () => "";
  for (const n of [1, 2, 3]) await world.admin("create", n);
  const ledger: any = world.sys.ledger(); const dead = { pid: 99_991, start: "gone" }; const caller = world.sys.caller();
  ledger.takeForDestroy(1, caller, dead);                 // 1: destroy started, its helper died
  ledger.reserve(9, caller, dead);                        // 9: a create that died right after reserving (nothing made)
  mkdirSync(walkieHome, { recursive: true });
  arvid = await c.add({ name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: { flushMs: 100, userSwitch: world.userSwitch, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
      admin: async (verb: AdminVerb, n: number) => { calls.push(verb === "pending" ? "pending" : `${verb}${n}`); return world.admin(verb, n); },
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: personHome } } });
}, 120_000);
afterAll(async () => { try { await c.close(); } catch { /* */ } });
test("restart recovery of half-finished rows", async () => {
  const ledger: any = world.sys.ledger();
  for (let i = 0; i < 100 && ledger.pending(world.sys.caller()).length; i++) await Bun.sleep(100);
  const local = (await arvid.client("").seats()).local;
  console.log("RESTART_RESULT " + JSON.stringify({ calls, pendingAfter: ledger.pending(world.sys.caller()), states: [1, 2, 3, 9].map((n) => `${n}:${ledger.state(n)}`), usersLeft: [...world.users.keys()], quarantined: local.quarantined ?? [] }));
  expect(ledger.pending(world.sys.caller())).toEqual([]);
  expect([1, 2, 3].map((n) => ledger.state(n))).toEqual(["destroyed", "destroyed", "destroyed"]);
  expect(ledger.state(9)).toBe("cancelled");
}, 60_000);
