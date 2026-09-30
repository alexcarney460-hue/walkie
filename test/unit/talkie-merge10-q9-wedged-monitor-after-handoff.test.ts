import { tmpdir } from "node:os";
// R9 probe Q9: after a handoff the daemon leaves cleanup to the separate monitor and arms no timer of its own (destroyOnce: monitorCanRun &&
// monitor present). The monitor's ownership row now expires in ~9 s if it stops renewing. Does ANYTHING then take the cleanup over while the
// monitor process is alive but wedged (SIGSTOP), or does the uid stay pending until the process dies / the daemon restarts?
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const WT = `${import.meta.dir}/../../`;
const OUT = tmpdir();
const { TalkieOsUser } = await import(`${WT}src/daemon/orchestrator/os-user.ts`);
const { CleanupObligation } = await import(`${WT}src/daemon/orchestrator/cleanup-obligation.ts`);
const CHILD = `${WT}test/unit/orchestrator-merge7-monitor-child.ts`;

test("wedged (SIGSTOP) monitor holding a handed-off cleanup; the helper is healthy again", async () => {
  const root = mkdtempSync(join(OUT, "tmp-q9-"));
  const dir = join(root, "d"); mkdirSync(join(dir, "walkie-talkie"), { recursive: true });
  const cleanupFile = join(dir, "cleanup.sqlite");
  let helperOk = false; let daemonDestroyCalls = 0; let monitorCalls = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: async () => { monitorCalls++; return Response.json({ result: helperOk }); } });
  const procs: Array<ReturnType<typeof Bun.spawn>> = []; const faults: string[] = [];
  const user: any = new TalkieOsUser(join(dir, "daemon.sock"), () => false, {
    ready: () => true, privateHome: () => null, socketRoot: dir, cleanupFile,
    leaseExpires: () => Date.now() + 1_000,
    monitorFailure: (r: string) => faults.push(r),
    monitor: (file: string, run: string, c: string) => {
      const p = Bun.spawn([process.execPath, CHILD, WT, file, run, c, String(server.port)], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      procs.push(p); return { kill: () => p.kill("SIGKILL"), exited: p.exited };
    },
    admin: async (verb: string, generation?: string) => {
      if (verb === "talkie-destroy") { daemonDestroyCalls++; return helperOk ? { ok: true } : { ok: false, why: "1 process survived SIGKILL" }; }
      return { ok: true, name: "walkie-talkie", uid: 550_000, home: join(dir, "walkie-talkie"), ...(generation ? { generation } : {}) };
    },
  });
  const owner = () => { const db = new Database(cleanupFile, { readonly: true }); try { return db.query("SELECT pid, heartbeat FROM retry_owner").get() as { pid: number; heartbeat: number } | null; } catch { return null; } finally { db.close(); } };
  try {
    await user.prepare();
    const run = user.generation as string;
    await Bun.sleep(300);
    await user.destroy().then(() => "cleaned", () => "not verified");
    for (let i = 0; i < 40 && !(owner() && owner()!.pid === procs[0]!.pid); i++) await Bun.sleep(100); // the monitor is now the owner
    const ownedByMonitor = owner()?.pid === procs[0]!.pid;
    process.kill(procs[0]!.pid, "SIGSTOP"); // the monitor wedges
    helperOk = true; // the helper is healthy again: any live retrier would now succeed
    const t0 = Date.now(); const rows: string[] = [];
    for (let i = 0; i < 14; i++) {
      await Bun.sleep(2_000);
      const ob = new CleanupObligation(cleanupFile);
      if (i % 3 === 0) rows.push(`${Date.now() - t0}ms pending=${!!user.pendingCleanup} ownerActive=${ob.ownerActive(run)} daemonCalls=${daemonDestroyCalls} retryArmed=${user.retryArmed} retrying=${user.retrying}`);
    }
    const stuck = !!user.pendingCleanup;
    console.log("Q9", JSON.stringify({ ownedByMonitorBeforeWedge: ownedByMonitor, rows, stuckAfter28s: stuck, daemonDestroyCallsAfterWedge: daemonDestroyCalls, monitorCalls, ownerActiveNow: new CleanupObligation(cleanupFile).ownerActive(run), faults }));
    expect(stuck).toBe(false); // <-- a live retrier (daemon takeover after the owner row expired) would clear it; FAIL here is the finding
  } finally {
    Object.assign(user, { monitorRestarts: 3, monitorFile: null }); // no restart of a monitor we are about to kill
    if (user.monitorTimer) clearInterval(user.monitorTimer);
    for (const p of procs) { try { process.kill(p.pid, "SIGCONT"); } catch { /* gone */ } try { p.kill("SIGKILL"); } catch { /* gone */ } }
    await Promise.all(procs.map((p) => p.exited));
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
    for (const p of procs) expect(() => process.kill(p.pid, 0)).toThrow();
  }
}, 60_000);
