// ROUND 5 (Opus round-4 MED): the crash restart runs inside the lifecycle queue, and so do Stop, daemon shutdown and a
// uid-monitor failure. None of them may wait for a restart that sits in the privileged helper (its own bound is 180 s).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rig, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";

let r: Rig;
let closer: Rig;
beforeAll(async () => { r = await rig(); closer = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); await closer.c.close(); });

const BOUND_MS = 5_000;
const within = <T>(work: Promise<T>) => Promise.race([work, Bun.sleep(BOUND_MS).then(() => { throw new Error("timed out behind the restart"); })]);

/** A shell run whose Claude crashed and whose restart is now inside a helper create that never answers. */
async function restartStuckInHelper(rg: Rig) {
  await rg.alex.client("").orchestratorStart({ access: "full" });
  const host = rg.host();
  await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
  const spawns: number[] = [];
  const spawn = host.spawn.bind(host);
  host.spawn = (session: string, resume: boolean) => { spawns.push(Date.now()); return spawn(session, resume); };
  // Force a fresh prepare on the restart (as a crash plus a lease blip would), then hang the create.
  await host.shellUser.destroy();
  let creating = false;
  rg.hook.fn = async (verb) => { if (verb === "talkie-create") { creating = true; return new Promise<never>(() => undefined); } };
  host.child.terminate();
  await waitFor(() => creating, { what: "the restart inside the helper create", timeoutMs: 10_000 });
  return { host, spawns };
}

const settled = async (host: any) => {
  expect(host.child).toBeNull();
  expect(host.phase).toBe("stopped");
  expect(host.shellUser.active).toBe(false);
  expect(host.shellUser.generation === null || host.shellUser.pendingCleanup !== null).toBe(true);
};

test("stop does not wait behind a restart stuck in the helper", async () => {
  const { host, spawns } = await restartStuckInHelper(r);
  const started = Date.now();
  await within(r.alex.client("").orchestratorStop());
  expect(Date.now() - started).toBeLessThan(BOUND_MS);
  await settled(host);
  expect(spawns).toEqual([]);
  // The uid the interrupted create may have made is reconciled by the recorded obligation, not lost.
  r.hook.fn = null;
  await waitFor(() => host.shellUser.generation === null && host.shellUser.pendingCleanup === null, { what: "obligation reconciled", timeoutMs: 15_000 });
}, 60_000);

test("a uid monitor failure stops the run without waiting behind a restart stuck in the helper", async () => {
  const { host, spawns } = await restartStuckInHelper(r);
  host.monitorFailed("probe: uid monitor failed");
  await within(waitFor(() => host.phase === "stopped", { what: "stopped after the monitor failure", timeoutMs: BOUND_MS }));
  await settled(host);
  expect(spawns).toEqual([]);
  expect(host.monitorFault).toBe(true);
  r.hook.fn = null;
}, 60_000);

test("daemon shutdown does not wait behind a restart stuck in the helper", async () => {
  const { host, spawns } = await restartStuckInHelper(closer);
  const started = Date.now();
  await within(host.close());
  expect(Date.now() - started).toBeLessThan(BOUND_MS);
  expect(spawns).toEqual([]);
  expect(host.child).toBeNull();
  closer.hook.fn = null;
}, 60_000);
