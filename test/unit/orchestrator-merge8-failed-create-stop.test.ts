// R4 (attack 5 / round-6 x4 class): 2c2428c now keeps the generation of a create answered { ok:false, code:"failed" } and
// runs destroy() in the background. startNow's boot catch then calls stopNow("Shell user unavailable") with NO wait
// bound, so it joins that destroy. A person's Stop pressed meanwhile is queued behind it in serial().
// Measures the Start's and the Stop's answer times with a DESTROY_MS helper destroy; nothing ever ran as the uid.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { ev, events, facts, rig6, teardown, type Rig6 } from "./orchestrator-merge7-setup.ts";
const DESTROY_MS = 5_000;
let r: Rig6;
beforeAll(async () => { r = await rig6({ destroyMs: DESTROY_MS }); }, 60_000);
afterAll(async () => { await teardown(r); });

test(`Stop during a failed-create cleanup (${DESTROY_MS} ms destroy)`, async () => {
  const host = r.host();
  const deps = (host.shellUser as any).deps;
  const calls: string[] = [];
  deps.admin = async (verb: string, generation?: string) => {
    calls.push(`${Date.now() - Number(process.env.T0 ?? 0)} ${verb}`);
    if (verb === "talkie-create") { await Bun.sleep(50); return { ok: false, code: "failed", why: "could not create walkie-talkie: dscl failed; cleanup: 1 process of it survived SIGKILL for 5 s" }; }
    if (verb === "talkie-destroy") { ev("helper destroy begins"); await Bun.sleep(DESTROY_MS); ev("helper destroy ok"); return { ok: true, name: "walkie-talkie", uid: 550_000 }; }
    return { ok: true, name: "walkie-talkie", uid: 550_000 };
  };
  const tStart = Date.now();
  ev("POST start full");
  const start = r.alex.client("").orchestratorStart({ access: "full" }).then(
    (v: any) => `ok ${v.local?.state ?? ""}`, (e: any) => `rejected ${e.status ?? ""} ${e.code ?? ""} ${e.message}`);
  const startDone = start.then((s: string) => { ev(`start answered: ${s}`); return Date.now() - tStart; });
  await Bun.sleep(400);
  ev("POST stop");
  const tStop = Date.now();
  const stopRes = await r.alex.client("").orchestratorStop().then((v: any) => `ok ${v.local?.state}`, (e: any) => `rejected ${e.status ?? ""} ${e.message}`);
  const stopMs = Date.now() - tStop;
  ev(`stop answered: ${stopRes} after ${stopMs} ms`);
  const startMs = await startDone;
  const end = facts(host);
  console.log("R4", JSON.stringify({ DESTROY_MS, startMs, stopRes, stopMs, end: { phase: end.phase, child: end.child, pending: end.pending, view: end.view, lastError: end.lastError }, events }, null, 1));
  expect(stopMs).toBeLessThan(3_000);
}, 60_000);
