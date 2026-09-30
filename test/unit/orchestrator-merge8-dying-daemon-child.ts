import { CleanupObligation } from "../../src/daemon/orchestrator/cleanup-obligation.ts";
import { selfOp } from "../../src/daemon/seats/admin-ledger.ts";

const [wt, file, run, cleanupFile, port] = process.argv.slice(2);
if (!wt || !file || !run || !cleanupFile || !port) throw new Error("invalid dying daemon fixture arguments");
new CleanupObligation(cleanupFile).record(run, selfOp(), 3_000);
const child = Bun.spawn([process.execPath, `${import.meta.dir}/orchestrator-merge7-monitor-child.ts`,
  wt, file, run, cleanupFile, port], { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
child.unref();
await Bun.sleep(900);
process.stdout.write(JSON.stringify({ daemon: process.pid, monitor: child.pid }));
process.exit(0);
