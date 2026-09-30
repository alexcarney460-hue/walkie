import { tmpdir } from "node:os";
// R9 probe Q3: monitor exit 0 that is NOT durably verified (completed(run) false), for a handed-off generation. The monitor's own
// record() can throw (SQLITE_BUSY past busy_timeout, disk full) while its helper call still succeeds: uid-monitor.ts then returns 0
// without a durable clear (registered=false). What does the daemon do? (os-user.ts monitorExited: verified=false, handedOff=true.)
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const WT = `${import.meta.dir}/../../`;
const OUT = tmpdir();
const { TalkieOsUser } = await import(`${WT}src/daemon/orchestrator/os-user.ts`);
const { CleanupObligation } = await import(`${WT}src/daemon/orchestrator/cleanup-obligation.ts`);
const { selfOp } = await import(`${WT}src/daemon/seats/admin-ledger.ts`);
const { monitorUid } = await import(`${WT}src/daemon/orchestrator/uid-monitor.ts`);

test("Q3a: the monitor returns 0 with no durable clear when its store is unusable but the helper call succeeded", async () => {
  const root = mkdtempSync(join(OUT, "tmp-q3a-"));
  try {
    // A cleanup file under a directory that does not exist: every CleanupObligation call throws (as SQLITE_BUSY/disk full would).
    const bad = join(root, "missing-dir", "cleanup.sqlite");
    let destroys = 0;
    const code = await monitorUid(join(root, "missing-lease"), "G1", bad, {
      destroy: async () => { destroys++; return true; }, report: () => undefined, sleep: async () => undefined, helperPresent: () => true,
    });
    console.log("Q3a", JSON.stringify({ monitorReturned: code, helperDestroyCalls: destroys }));
    expect(code).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Q3b: daemon side: exit 0, handedOff, completed(run) false -> nobody retries", async () => {
  const root = mkdtempSync(join(OUT, "tmp-q3b-"));
  try {
    const cleanupFile = join(root, "cleanup.sqlite");
    const ob = new CleanupObligation(cleanupFile);
    expect(ob.record("G1", selfOp(), 3_000)).toBe(true);
    ob.failure("G1", "helper did not answer");
    ob.releaseOwner("G1", selfOp()); // destroyOnce released the row on handoff
    const faults: string[] = []; const retryCalls: number[] = [];
    const user: any = new TalkieOsUser(join(root, "daemon.sock"), () => false, {
      ready: () => true, privateHome: () => null, socketRoot: root, cleanupFile,
      monitorFailure: (r: string) => faults.push(r),
      retrySleep: async (ms: number) => { retryCalls.push(ms); await new Promise<void>(() => undefined); },
      admin: async () => ({ ok: true }),
    });
    const monitor = { kill: () => undefined };
    Object.assign(user, { monitor, monitorFile: join(root, "lease.json"), monitorCanRun: true, generation: "G1", monitorHandoffGeneration: "G1",
      volatilePending: { generation: "G1", attempts: 1, diagnostic: "helper did not answer" } });
    user.monitorExited(monitor, join(root, "lease.json"), "G1", 0); // separate monitor destroyed the uid (helper ok) but could not record a clear
    await Bun.sleep(200);
    const out = { faults, retryTimerArmedCalls: retryCalls, retryArmedFlag: user.retryArmed, retrying: user.retrying, monitorHandle: !!user.monitor,
      pending: user.pendingCleanup, durable: ob.read(), completed: ob.completed("G1") };
    console.log("Q3b", JSON.stringify(out));
    // A correct implementation would arm a qualified retry (the idempotent destroy verifies and clears). Finding if none is armed:
    expect(retryCalls.length + (user.retryArmed ? 1 : 0)).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
