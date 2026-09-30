// X4 (attack 1/5): Stop answered at 2 s while the old generation's helper destroy (DESTROY_MS) still runs. A platform
// Start is then queued; its startNow() -> halt() has NO wait bound and joins the old cleanup. The person presses Stop
// again while that Start waits. How long does the second Stop take, and does anything spawn after it?
import { afterAll, beforeAll, expect, test } from "bun:test";
import { ev, events, facts, rig6, teardown, waitFor, type Rig6 } from "./orchestrator-merge7-setup.ts";
const DESTROY_MS = Number(process.env.DESTROY_MS ?? 10_000);
let r: Rig6;
beforeAll(async () => { r = await rig6({ destroyMs: DESTROY_MS }); }, 60_000);
afterAll(async () => { await teardown(r); });

test(`second Stop behind a platform Start that waits for a ${DESTROY_MS} ms destroy`, async () => {
  await r.alex.client("").orchestratorStart({ access: "full" });
  const host = r.host();
  await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
  await Bun.sleep(600);
  const spawns: number[] = [];
  const spawn = host.spawn.bind(host);
  host.spawn = (a: string, b: boolean) => { spawns.push(Date.now()); ev("spawn"); return spawn(a, b); };
  ev("POST stop #1");
  const stop1 = await r.alex.client("").orchestratorStop().then((v: any) => `ok ${v.local?.state}`, (e: any) => `rejected ${e.message}`);
  ev(`stop #1 answered ${stop1}; POST start platform`);
  const start = r.alex.client("").orchestratorStart({ access: "platform" }).then((v: any) => `ok ${v.local?.state ?? ""}`, (e: any) => `rejected ${e.status ?? ""} ${e.message}`);
  await Bun.sleep(500);
  ev("POST stop #2");
  const t2 = Date.now();
  const stop2 = await r.alex.client("").orchestratorStop().then((v: any) => `ok ${v.local?.state}`, (e: any) => `rejected ${e.message}`);
  const stop2Ms = Date.now() - t2;
  ev(`stop #2 answered ${stop2} after ${stop2Ms} ms`);
  const startRes = await start;
  await Bun.sleep(500);
  const end = facts(host);
  console.log("X4", JSON.stringify({ DESTROY_MS, stop1, startRes, stop2, stop2Ms, spawnsAfterStop2: spawns.filter((t) => t >= t2).length, end, events }, null, 1));
  expect(stop2Ms).toBeLessThan(3_000);
  expect(startRes.startsWith("ok ")).toBe(true);
  expect(end.monitorFault).toBe(false);
  expect(spawns.filter((t) => t >= t2)).toHaveLength(0);
}, 60_000);
