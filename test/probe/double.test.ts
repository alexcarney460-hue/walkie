// PROBE (reviewer): while an ended seat waits in the cleanup queue (behind a backlog), does it hold TWO slots (seats map + its blocking quarantine user)?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdminVerb } from "../../src/daemon/seats/admin.ts";
import type { SeatView } from "../../src/protocol/seats.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, signInCodex, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";
const FIXTURES = join(import.meta.dir, "..", "fixtures");
const N = 10; const D = 400; const MAX = Number(process.env.HOSTMAX ?? 2); const TREE = process.env.TREE_LABEL ?? "?";
let c: Cluster; let alex: TestNode; let arvid: TestNode; let world: FakeSeatWorld;
const t00 = Date.now(); const now = () => Date.now() - t00;
beforeAll(async () => {
  c = new Cluster();
  const personHome = join(c.root, "arvid-home");
  mkdirSync(join(personHome, ".claude"), { recursive: true }); chmodSync(personHome, 0o700);
  writeFileSync(join(personHome, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "access-token", refreshToken: "rt", expiresAt: Date.now() + 8 * 3_600_000, scopes: ["user:inference"] } }), { mode: 0o600 });
  signInCodex(personHome);
  const walkieHome = join(c.root, "arvid");
  world = fakeSeatWorld(c.root, walkieHome); world.sys.acl = () => "";
  for (let n = 1; n <= N; n++) await world.admin("create", n);
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  mkdirSync(walkieHome, { recursive: true });
  arvid = await c.add({ name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: { flushMs: 100, launchesPerMinute: 100, userSwitch: world.userSwitch, lookupUser: world.lookup, schedulerFiles: world.schedulerFiles,
      admin: async (verb: AdminVerb, n: number) => { if (verb === "destroy") await Bun.sleep(D); return world.admin(verb, n); },
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: personHome } } });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
}, 120_000);
afterAll(async () => { try { await c.close(); } catch { /* */ } });
const st = async (id: string) => ((await alex.client().seats(id)).seats[0] as (SeatView & { reason?: string }) | undefined);
test(`double count ${TREE}`, async () => {
  await arvid.client("").seatsConfig({ allow: true, ephemeral: true, max: MAX });
  await Bun.sleep(200);
  const s1 = (await alex.client().seatRun({ machine: "arvid-mac", runtime: "codex", prompt: "ticker 3 one", max_concurrent: 10 })).seat;
  for (let i = 0; i < 200; i++) { if ((await st(s1))?.state === "running") break; await Bun.sleep(50); }
  await Bun.sleep(1500); // the ticker (0.3 s) is long over; the seat is concluding: waiting for its user's destroy in the queue
  const local = (await arvid.client("").seats()).local;
  const s2 = await alex.client().seatRun({ machine: "arvid-mac", runtime: "codex", prompt: "ticker 3 two", max_concurrent: 10 }).then((r) => r.seat, (e: Error) => `ERR:${e.message}`);
  await Bun.sleep(500);
  const v2 = s2.startsWith("ERR") ? { state: s2 } : await st(s2);
  console.log("DOUBLE_RESULT " + JSON.stringify({ tree: TREE, hostMax: MAX, atMs: now(), seat1: (await st(s1))?.state, hostRunningCount: local.running, quarantined: local.quarantined?.length, second: { state: v2?.state, reason: (v2 as any)?.reason?.slice(0, 140) } }));
  if (MAX > N + 1) expect(v2?.state).not.toBe("refused");
  else expect((await arvid.client("").seats()).local.running).toBeLessThanOrEqual(MAX);
}, 120_000);
