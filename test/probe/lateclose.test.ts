// PROBE (reviewer): the helper's `pending` answer arrives AFTER the daemon started stopping (a slow first helper call).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdminVerb } from "../../src/daemon/seats/admin.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, signInCodex, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const TREE = process.env.TREE_LABEL ?? "?";
let c: Cluster; let arvid: TestNode; let world: FakeSeatWorld;
let pendingServedAt = 0; const t00 = Date.now();
beforeAll(async () => {
  c = new Cluster();
  const personHome = join(c.root, "arvid-home");
  mkdirSync(join(personHome, ".claude"), { recursive: true }); chmodSync(personHome, 0o700); signInCodex(personHome);
  const walkieHome = join(c.root, "arvid");
  world = fakeSeatWorld(c.root, walkieHome); world.sys.acl = () => "";
  for (let n = 1; n <= 3; n++) await world.admin("create", n);
  mkdirSync(walkieHome, { recursive: true });
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: { flushMs: 100, userSwitch: world.userSwitch, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
      admin: async (verb: AdminVerb, n: number) => { if (verb === "pending") { await Bun.sleep(1500); pendingServedAt = Date.now() - t00; } return world.admin(verb, n); },
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: personHome } },
  });
}, 120_000);
afterAll(async () => { try { await c.close(); } catch { /* stopped */ } });
test(`late helper answer after stop ${TREE}`, async () => {
  await Bun.sleep(200);
  const t = Date.now() - t00;
  await arvid.stop();
  console.log(`LATECLOSE stop returned at +${Date.now() - t00 - t}ms after ${t}ms; waiting for the late pending answer`);
  await Bun.sleep(2500);
  console.log(`LATECLOSE ${TREE}: pending served at ${pendingServedAt}ms; test process still alive`);
  expect(pendingServedAt).toBeGreaterThan(0);
}, 60_000);
