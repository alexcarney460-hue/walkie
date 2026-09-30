// PROBE (reviewer): with a restart backlog of process-free users and hostMax=2, are more than 2 seats ever admitted (4 launched at once)?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AdminVerb } from "../../src/daemon/seats/admin.ts";
import type { SeatView } from "../../src/protocol/seats.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";
import { fakeSeatWorld, signInCodex, type FakeSeatWorld } from "../helpers/fake-seat-users.ts";
const FIXTURES = join(import.meta.dir, "..", "fixtures");
const N = 10; const MAX = 2;
let c: Cluster; let alex: TestNode; let arvid: TestNode; let world: FakeSeatWorld;
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
      admin: async (verb: AdminVerb, n: number) => { if (verb === "destroy") await Bun.sleep(400); return world.admin(verb, n); },
      env: { PATH: `${join(FIXTURES, "fake-codex")}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: personHome } } });
  await alex.client().init("aka", "alex");
  await alex.client().invite("arvid@example.com", "arvid", "member");
  expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
}, 120_000);
afterAll(async () => { try { await c.close(); } catch { /* */ } });
test("admission never exceeds hostMax with a process-free backlog", async () => {
  await arvid.client("").seatsConfig({ allow: true, ephemeral: true, max: MAX });
  await Bun.sleep(200);
  const runs = await Promise.all([1, 2, 3, 4].map((i) => alex.client().seatRun({ machine: "arvid-mac", runtime: "codex", prompt: `ticker 600 cap ${i}`, max_concurrent: 10 }).then((r) => r.seat, (e: Error) => `ERR:${e.message}`)));
  await Bun.sleep(4000);
  const states: string[] = [];
  let peakRunning = 0;
  for (const s of runs) { if (s.startsWith("ERR")) { states.push(s.slice(0, 80)); continue; } const v = ((await alex.client().seats(s)).seats[0] as SeatView | undefined); states.push(`${v?.state}${v?.state === "refused" ? ": " + String((v as any).reason).slice(0, 60) : ""}`); }
  peakRunning = (await arvid.client("").seats()).local.running;
  console.log("CAP_RESULT " + JSON.stringify({ hostMax: MAX, launched: 4, states, runningOnHost: peakRunning, quarantined: (await arvid.client("").seats()).local.quarantined?.length }));
  for (const s of runs) if (!s.startsWith("ERR")) await alex.client().seatStop(s).catch(() => undefined);
  expect(peakRunning).toBeLessThanOrEqual(MAX);
}, 120_000);
