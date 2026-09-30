// Real monitorUid in its own process. With GAP=1 the probe injects exactly one interleaving: right after the monitor's
// record() is refused (the daemon still owned the retry), the daemon's releaseOwner() lands (as destroyOnce does after a
// failed attempt), BEFORE the monitor's daemonOwnsRetry() reads the owner row. Nothing else in monitorUid is changed.
const [wt, file, run, cleanupFile, port, gap] = process.argv.slice(2);
const { CleanupObligation } = await import(`${wt}/src/daemon/orchestrator/cleanup-obligation.ts`);
if (gap === "1") {
  const original = CleanupObligation.prototype.record;
  let injected = false;
  CleanupObligation.prototype.record = function (this: any, generation: string, claimant?: unknown, interval?: number) {
    const result = original.call(this, generation, claimant, interval);
    if (!result && !injected) {
      injected = true;
      const owner = this.monitorOwner(generation);
      if (owner) this.releaseOwner(generation, owner); // the daemon's handoff, landing in the gap
      process.stderr.write(`gap injected (owner pid ${owner?.pid})\n`);
    }
    return result;
  };
}
const { monitorUid } = await import(`${wt}/src/daemon/orchestrator/uid-monitor.ts`);
const code: number = await monitorUid(file, run, cleanupFile, {
  destroy: async () => (await (await fetch(`http://127.0.0.1:${port}/destroy`)).json() as { result: boolean }).result,
  report: (line: string) => { process.stderr.write(`monitor report: ${line}\n`); },
});
process.stderr.write(`monitor exit ${code}\n`);
process.exit(code);
export {};
