// ROUND 5 (Opus round-4 LOW): boot() reset `stopping` after startNow's own halt, so a Stop accepted while a Start was
// still acquiring the lease, halting the old run or waiting in the queue was erased, and a full-access Claude spawned
// after the person had pressed Stop.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rig, waitFor, type Rig } from "./orchestrator-merge4-setup.ts";

let r: Rig;
beforeAll(async () => { r = await rig(); }, 60_000);
afterAll(async () => { await r.c.close(); });

const bypassLaunches = () => r.rows().filter((x: any) => x.argv.includes("bypassPermissions")).length;

async function runningFull() {
  r.hook.fn = null;
  await r.alex.client("").orchestratorStart({ access: "full" });
  const host = r.host();
  await waitFor(() => host.child?.alive && host.shellUser.active, { what: "shell child" });
  const spawns: number[] = [];
  const spawn = host.spawn.bind(host);
  host.spawn = (session: string, resume: boolean) => { spawns.push(Date.now()); return spawn(session, resume); };
  return { host, spawns, launches: bypassLaunches(), creates: r.count("talkie-create") };
}

const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => `rejected: ${e.message}`);

test("a Stop pressed while a Start halts the old run is not erased", async () => {
  const { host, spawns, launches, creates } = await runningFull();
  let slow = true;
  r.hook.fn = async (verb) => { if (verb === "talkie-destroy" && slow) { slow = false; await Bun.sleep(1_000); } };
  const destroys = r.count("talkie-destroy");
  const start = outcome(r.alex.client("").orchestratorStart({ access: "full" }));
  await waitFor(() => r.count("talkie-destroy") > destroys, { what: "the Start halting the old uid" });
  const stop = outcome(r.alex.client("").orchestratorStop());
  await Promise.all([start, stop]);
  await Bun.sleep(300);
  expect(spawns).toEqual([]);
  expect(r.count("talkie-create")).toBe(creates);
  expect(bypassLaunches()).toBe(launches);
  expect(host.child).toBeNull();
  expect(host.phase).toBe("stopped");
  expect(host.shellUser.active).toBe(false);
  expect(host.state.active).toBe(false);
}, 60_000);

test("a Stop pressed while a Start acquires the lease is not erased", async () => {
  const { host, spawns, launches, creates } = await runningFull();
  const acquire = host.leadership.acquire.bind(host.leadership);
  let acquiring = false;
  host.leadership.acquire = async () => { acquiring = true; await Bun.sleep(800); return acquire(); };
  try {
    const start = outcome(r.alex.client("").orchestratorStart({ access: "full" }));
    await waitFor(() => acquiring, { what: "the Start acquiring the lease" });
    const stop = outcome(r.alex.client("").orchestratorStop());
    await Promise.all([start, stop]);
    await Bun.sleep(300);
  } finally { host.leadership.acquire = acquire; }
  expect(spawns).toEqual([]);
  expect(r.count("talkie-create")).toBe(creates);
  expect(bypassLaunches()).toBe(launches);
  expect(host.child).toBeNull();
  expect(host.phase).toBe("stopped");
  expect(host.state.active).toBe(false);
}, 60_000);

test("a Stop pressed while a Start waits in the queue stops the Start too", async () => {
  const { host, spawns, launches, creates } = await runningFull();
  let release!: () => void;
  const blocker = host.serial(() => new Promise<void>((resolve) => { release = resolve; }));
  const start = outcome(r.alex.client("").orchestratorStart({ access: "full" }));
  await Bun.sleep(100); // the Start is queued behind the blocker
  const stop = outcome(host.stopByHand());
  await Bun.sleep(100);
  release();
  await Promise.all([blocker, start, stop]);
  await Bun.sleep(300);
  expect(spawns).toEqual([]);
  expect(r.count("talkie-create")).toBe(creates);
  expect(bypassLaunches()).toBe(launches);
  expect(host.child).toBeNull();
  expect(host.phase).toBe("stopped");
  expect(host.state.stopped_by_hand).toBe(true);
}, 60_000);

test("a Start pressed after a Stop still runs", async () => {
  const { host } = await runningFull();
  await r.alex.client("").orchestratorStop();
  expect(host.phase).toBe("stopped");
  await r.alex.client("").orchestratorStart({ access: "platform" });
  await waitFor(() => host.child?.alive, { what: "the later Start's child" });
  expect(host.phase).toBe("idle");
  expect(host.state.access).toBe("platform");
}, 60_000);
