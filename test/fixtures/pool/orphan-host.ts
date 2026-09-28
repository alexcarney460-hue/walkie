// A daemon host for the orphan test (WALKIE-POOL-3): two daemons in THIS process, a stage (fake: the echo stand-in;
// real: a real split run with llama.cpp), then it prints the child PIDs and waits to be SIGKILLed.
//   bun orphan-host.ts fake <fake-runtime-dir>
//   bun orphan-host.ts real <llama-dir> <gguf>
import { Cluster, waitFor } from "../../helpers/cluster.ts";

const [mode, dir, gguf] = process.argv.slice(2);
const pool = { llamaDir: dir!, rpcArgs: mode === "real" ? ["-d", "CPU", "-t", "2"] : [], freeMemory: async () => 8 * 1024 ** 3, ...(mode === "real" ? {} : { verifyRuntime: () => null }) };
const c = new Cluster();
const head = await c.add({ name: "h", login: "alex@example.com", hostname: "alex-h", pool });
const worker = await c.add({ name: "w", login: "kira@example.com", hostname: "kira-w", pool });
await head.client().init("team-o", "alex");
await head.client().invite("kira@example.com", "kira", "member");
await worker.client().join(head.peerAddr);
await worker.client().poolShare(true, 4);
let serverPid: number | null = null;
if (mode === "real") {
  await waitFor(async () => (await head.client().team()).nodes.find((n) => n.hostname === "kira-w")?.pool?.share, { timeoutMs: 15_000, what: "share seen" });
  await head.client().poolRun({ file: gguf!, machines: ["kira-w"] });
  const r = await waitFor(async () => { const x = (await head.client().pool()).run; return x && ["serving", "failed", "stopped"].includes(x.state) ? x : null; }, { timeoutMs: 120_000, intervalMs: 250, what: "serving" });
  if (r.state !== "serving") throw new Error(`run ${r.state}: ${r.error}`);
  serverPid = r.server_pid;
} else {
  const addr = head.d.client.addrOf(head.d.core.roster.nodes.get(worker.d.nodeId)!)!;
  await head.d.client.stage(addr, { action: "start", run: "a".repeat(32), bytes: 1024, model: "x" });
}
const st = (await worker.client().pool()).stage;
console.log(`HOST ${JSON.stringify({ stage_pid: st?.pid ?? null, server_pid: serverPid, worker_home: worker.home, head_home: head.home })}`);
await Bun.sleep(600_000);
