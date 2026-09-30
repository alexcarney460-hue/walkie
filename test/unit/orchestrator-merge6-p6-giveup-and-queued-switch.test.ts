// P6a: a give-up (five rapid failures) on a live platform run, then a person's Start and a person's Resume (auto):
// stopRequests must not suppress them; the give-up must have closed the child.
// P6b: Stop while a model switch and an access switch are queued behind blocked lifecycle work: after the child is
// terminated outside the queue, the queued switches run (after the fence, before stopNow). Anything spawned?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rig, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";
let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

test("P6a give-up then Start by hand, then give-up then resumeAuto", async () => {
  await r.alex.client("").orchestratorStart({ access: "platform" });
  const host = r.host();
  await waitFor(() => host.child?.alive, { what: "platform child" });
  const child0 = host.child;
  host.attempt = 4;
  host.scheduleRestart();
  await waitFor(() => !child0.alive || null, { what: "give-up closes child", timeoutMs: 5_000 }).catch(() => undefined);
  const afterGiveUp = { phase: host.phase, gave_up: host.state?.gave_up ?? null, child0Alive: !!child0.alive, hostChild: !!host.child, view: host.view().state, stopRequests: host.stopRequests };
  const startRes = await r.alex.client("").orchestratorStart({ access: "platform" }).then(() => "ok", (e: any) => `rejected ${e.status} ${e.message}`);
  const up = await waitFor(() => host.child?.alive || null, { what: "restart by hand", timeoutMs: 5_000 }).then(() => true, () => false);
  const afterStart = { phase: host.phase, gave_up: host.state?.gave_up ?? null, view: host.view().state, stopping: host.stopping };
  const child1 = host.child;
  host.attempt = 4;
  host.scheduleRestart();
  await waitFor(() => !child1?.alive || null, { what: "second give-up", timeoutMs: 5_000 }).catch(() => undefined);
  const resumed = await host.resumeAuto().then((v: any) => v.state, (e: any) => `rejected ${e.message}`);
  const up2 = await waitFor(() => host.child?.alive || null, { what: "resume auto", timeoutMs: 5_000 }).then(() => true, () => false);
  console.log("P6a", JSON.stringify({ afterGiveUp, startRes, up, afterStart, resumed, up2, end: { phase: host.phase, view: host.view().state, stopping: host.stopping } }));
  expect(afterGiveUp.child0Alive).toBe(false);
  expect(up).toBe(true);
  expect(up2).toBe(true);
}, 60_000);

test("P6b queued model and access switches after Stop", async () => {
  const host = r.host();
  if (!host.child?.alive) {
    await r.alex.client("").orchestratorStart({ access: "platform" });
    await waitFor(() => host.child?.alive, { what: "platform child" });
  }
  const spawns: number[] = [];
  const spawn = host.spawn.bind(host);
  host.spawn = (a: string, b: boolean) => { spawns.push(Date.now()); return spawn(a, b); };
  const creates0 = r.count("talkie-create");
  let release!: () => void;
  const blocker = host.serial(() => new Promise<void>((resolve) => { release = resolve; }));
  const model = host.setModel("sonnet").then((v: any) => `ok ${v.state}`, (e: any) => `rejected ${e.code ?? e.message}`);
  const access = host.setAccess("full").then((v: any) => `ok ${v.state}`, (e: any) => `rejected ${e.code ?? e.message}`);
  const t0 = Date.now();
  const stop = host.stopByHand().then(() => "ok", (e: any) => `rejected ${e.message}`);
  await Bun.sleep(200);
  release();
  await blocker;
  const [m, a, s] = await Promise.all([model, access, stop]);
  await Bun.sleep(500);
  const out = { model: m, access: a, stop: s, spawnsAfterStop: spawns.filter((t) => t >= t0).length, createsAfterStop: r.count("talkie-create") - creates0,
    phase: host.phase, child: !!host.child?.alive, view: host.view().state, savedModel: host.state?.model ?? null, savedAccess: host.state?.access, suActive: host.shellUser.active };
  console.log("P6b", JSON.stringify(out));
  expect(out.spawnsAfterStop).toBe(0);
  expect(out.createsAfterStop).toBe(0);
}, 60_000);
