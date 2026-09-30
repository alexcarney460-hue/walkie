// R3 (attack 1/2): deterministic check of the record()/daemonOwnsRetry() gap in the real monitorUid, cross-process.
// The probe process is "the daemon": it records itself as retry owner (as attemptCleanup does), the uid lease file is
// absent (invalid), and the monitor child is its child (parentPid === daemonPid).
//  control (GAP=0): the monitor defers while the daemon owns the retry, then takes over after the daemon releases.
//  gap     (GAP=1): the daemon's release lands between the refused record() and daemonOwnsRetry(): the monitor exits 3.
//  host    : TalkieOsUser.monitorExited(code 3) for a handed-off generation whose owner row is gone -> monitor fault?
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const WT = new URL("../..", import.meta.url).pathname;
const { CleanupObligation } = await import(`${WT}/src/daemon/orchestrator/cleanup-obligation.ts`);
const { TalkieOsUser } = await import(`${WT}/src/daemon/orchestrator/os-user.ts`);
const { selfOp } = await import(`${WT}/src/daemon/seats/admin-ledger.ts`);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ result: true }) });

async function runCase(gap: "0" | "1") {
  const dir = mkdtempSync(join(tmpdir(), `walkie-r3-${gap}-`));
  try {
    const run = `gen-${gap}`;
    const cleanupFile = join(dir, "cleanup.sqlite");
    const ob = new CleanupObligation(cleanupFile);
    expect(ob.record(run, selfOp(), 180_000)).toBe(true); // the daemon owns the retry
    let stderr = "";
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "orchestrator-merge8-monitor-gap-child.ts"), WT, join(dir, "uid-lease.json"), run, cleanupFile, String(server.port), gap],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    void new Response(proc.stderr).text().then((t) => { stderr = t; });
    const t0 = Date.now();
    const early = await Promise.race([proc.exited, Bun.sleep(1_500).then(() => "still running" as const)]);
    const deferredMs = Date.now() - t0;
    if (early === "still running") ob.releaseOwner(run, selfOp()); // the daemon's failed attempt hands off normally
    const code = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => "timeout" as const)]);
    if (code === "timeout") proc.kill("SIGKILL");
    await Bun.sleep(50);
    return { gap, early, deferredMs, code, durable: ob.read(), stderr: stderr.trim().split("\n") };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("record/daemonOwnsRetry gap", async () => {
  const control = await runCase("0");
  const gapped = await runCase("1");
  // Host side of the gapped outcome: the daemon had handed the generation off (destroyOnce) and its owner row is gone.
  const dir = mkdtempSync(join(tmpdir(), "walkie-r3-host-"));
  const faults: string[] = [];
  try {
    const cleanupFile = join(dir, "cleanup.sqlite");
    const ob = new CleanupObligation(cleanupFile);
    ob.record("handed", selfOp(), 180_000); ob.releaseOwner("handed", selfOp());
    const user = new TalkieOsUser("/not-a-socket", () => false, { cleanupFile, monitorFailure: (r: string) => faults.push(r), retrySleep: () => new Promise<void>(() => undefined) });
    const monitor = { kill: () => undefined };
    Object.assign(user, { monitor, monitorFile: join(dir, "uid-lease.json"), generation: "handed", monitorHandoffGeneration: "handed" });
    (user as any).monitorExited(monitor, join(dir, "uid-lease.json"), "handed", 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  server.stop(true);
  console.log("R3", JSON.stringify({ control, gapped, hostFaultsForHandedOffExit3: faults }, null, 1));
  expect(control.early).toBe("still running");
  expect(control.code).toBe(0);
  expect(gapped.code).not.toBe(3);
  expect(faults).toEqual([]);
}, 60_000);
