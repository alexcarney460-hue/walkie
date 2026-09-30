// A REAL uid monitor in its OWN process (as production: `walkie --internal-orchestrator-uid-monitor`), so its
// CleanupObligation claimant (selfOp: pid + start time) differs from the daemon's. Only the privileged helper call
// is replaced: destroy() asks the parent's helper emulator over HTTP (same lock as the daemon's admin calls).
// daemonPid/parentPid are the production defaults (process.ppid = the test process standing in for the daemon).
const [wt, file, run, cleanupFile, port] = process.argv.slice(2);
if (!wt || !file || !run || !cleanupFile || !port || !/^\d+$/.test(port)) throw new Error("invalid uid monitor test arguments");
const { monitorUid } = await import(`${wt}/src/daemon/orchestrator/uid-monitor.ts`);
let unavailable: ReturnType<typeof setTimeout> | null = null;
const code: number = await monitorUid(file, run, cleanupFile, {
  destroy: async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/destroy?run=${encodeURIComponent(run)}`, { signal: AbortSignal.timeout(10_000) });
      const result = (await res.json() as { result: boolean | "newer" }).result;
      if (unavailable) clearTimeout(unavailable);
      unavailable = null;
      return result;
    } catch (err) {
      unavailable ??= setTimeout(() => process.exit(4), 2_000);
      unavailable.unref?.();
      throw err;
    }
  },
  report: (line: string) => { process.stderr.write(`monitor report: ${line}\n`); },
});
process.stderr.write(`monitor ${run.slice(0, 8)} exit ${code}\n`);
process.exit(code);
export {};
