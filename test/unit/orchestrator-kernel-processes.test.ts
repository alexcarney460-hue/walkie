import { expect, test } from "bun:test";
import { rememberDescendants, type ProcessLedger } from "../../src/daemon/orchestrator/marked-processes.ts";

test("kernel poll records a live descendant with its group and start identity", async () => {
  const child = Bun.spawn(["/bin/sleep", "3"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const ledger: ProcessLedger = new Map();
  try {
    const until = Date.now() + 1000;
    while (!ledger.has(child.pid) && Date.now() < until) {
      rememberDescendants(process.pid, "", ledger);
      await Bun.sleep(10);
    }
    expect(ledger.get(child.pid)?.started).toMatch(/^[0-9]+[.]?[0-9]*$/);
    expect(ledger.get(child.pid)?.pgid).toBeGreaterThan(0);
  } finally { child.kill("SIGKILL"); await child.exited; }
});
