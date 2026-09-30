import { tmpdir } from "node:os";
// R9 probe Q2: a REAL separate-process uid monitor. The daemon's cleanup fails, so it hands the generation off to the monitor
// (monitorHandoffGeneration = run). The monitor process then DIES (SIGKILL, e.g. OOM-killed); TalkieOsUser restarts it
// (monitorRestarts < 3). The restarted monitor finishes the cleanup and exits 0. Does the daemon report a FALSE fault
// ("cleaned the shell user while it was running"), which sets monitorFault and blocks auto-start?
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const WT = `${import.meta.dir}/../../`;
const OUT = tmpdir();
const { TalkieOsUser } = await import(`${WT}src/daemon/orchestrator/os-user.ts`);
const { CleanupObligation } = await import(`${WT}src/daemon/orchestrator/cleanup-obligation.ts`);
const CHILD = `${WT}test/unit/orchestrator-merge7-monitor-child.ts`;

test("monitor crash after a handoff, then a successful cleanup by the restarted monitor", async () => {
  const root = mkdtempSync(join(OUT, "tmp-q2-"));
  const dir = join(root, "d"); mkdirSync(join(dir, "walkie-talkie"), { recursive: true });
  let monitorCalls = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: async () => {
    monitorCalls++;
    if (monitorCalls === 1) { await Bun.sleep(8_000); return Response.json({ result: false }); } // M1 is stuck inside its helper call
    return Response.json({ result: true }); // M2's helper call verifies removal
  } });
  const procs: Array<ReturnType<typeof Bun.spawn>> = []; const faults: string[] = [];
  const user: any = new TalkieOsUser(join(dir, "daemon.sock"), () => false, {
    ready: () => true, privateHome: () => null, socketRoot: dir, cleanupFile: join(dir, "cleanup.sqlite"),
    leaseExpires: () => Date.now() + 1_000,
    monitorFailure: (r: string) => faults.push(r),
    retrySleep: () => new Promise<void>(() => undefined),
    monitor: (file: string, run: string, cleanupFile: string) => {
      const p = Bun.spawn([process.execPath, CHILD, WT, file, run, cleanupFile, String(server.port)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      procs.push(p);
      return { kill: () => p.kill("SIGKILL"), exited: p.exited };
    },
    admin: async (verb: string, generation?: string) => verb === "talkie-destroy" ? { ok: false, why: "1 process survived SIGKILL" }
      : { ok: true, name: "walkie-talkie", uid: 550_000, home: join(dir, "walkie-talkie"), ...(generation ? { generation } : {}) },
  });
  try {
    await user.prepare();
    const run = user.generation as string;
    await Bun.sleep(300);
    const destroyed = await user.destroy().then(() => "cleaned", (e: Error) => `not verified: ${e.message.slice(0, 60)}`);
    for (let i = 0; i < 40 && monitorCalls < 1; i++) await Bun.sleep(100); // M1 has taken over and is inside its (held) helper call
    const m1 = procs[0]!;
    const handoffMarker = user.monitorHandoffGeneration === run;
    m1.kill("SIGKILL");
    await m1.exited;
    for (let i = 0; i < 80 && (procs.length < 2 || new CleanupObligation(join(dir, "cleanup.sqlite")).read() !== null); i++) await Bun.sleep(100);
    await Bun.sleep(500);
    console.log("Q2", JSON.stringify({ destroyed, handoffMarkerBeforeCrash: handoffMarker, monitorsSpawned: procs.length, monitorCalls,
      obligationCleared: new CleanupObligation(join(dir, "cleanup.sqlite")).read() === null,
      completed: new CleanupObligation(join(dir, "cleanup.sqlite")).completed(run), pending: user.pendingCleanup, faults }));
    expect(procs.length).toBeGreaterThanOrEqual(2);
    expect(faults).toEqual([]); // <-- what a correct implementation would report; a FAIL here is the finding
  } finally {
    for (const p of procs) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
    await Promise.all(procs.map((p) => p.exited));
    Object.assign(user, { monitorRestarts: 3, monitorFile: null });
    if (user.monitorTimer) clearInterval(user.monitorTimer);
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
    for (const p of procs) expect(() => process.kill(p.pid, 0)).toThrow();
  }
}, 40_000);
