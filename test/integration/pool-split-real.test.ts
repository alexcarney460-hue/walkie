// WALKIE-POOL-2: a REAL split run with llama.cpp across isolated daemons on this machine, through Walkie's tunnels:
// the head's llama-server holds part of the model (its own device) and a worker's rpc-server the rest, reached only
// through the Walkie tunnel (Tailscale WebSocket in one team, a Walkie Direct QUIC stream in another). A completion
// through the head's OpenAI-compatible endpoint, then Stop. Nothing listens beyond 127.0.0.1.
//
// Needs the pinned llama.cpp build and a tiny GGUF; skipped otherwise:
//   WALKIE_TEST_LLAMA_DIR=<dir with llama-server + ggml-rpc-server>  WALKIE_TEST_GGUF=<small .gguf, e.g. stories15M-q8_0>
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { RunView } from "../../src/pool/run/runner.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const LLAMA = process.env.WALKIE_TEST_LLAMA_DIR ?? "";
const GGUF = process.env.WALKIE_TEST_GGUF ?? "";
const HAVE = !!LLAMA && !!GGUF && existsSync(`${LLAMA}/llama-server`) && existsSync(GGUF);
const POOL = { llamaDir: LLAMA, rpcArgs: ["-d", "CPU", "-t", "2"], leaseMs: 45_000 };

/** Every TCP listening socket of these PIDs (lsof), as "pid addr:port". */
function listening(pids: number[]): string[] {
  const r = Bun.spawnSync(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.join(",")], { stdout: "pipe", stderr: "pipe" });
  return r.stdout.toString().split("\n").slice(1).filter(Boolean).map((l) => { const f = l.trim().split(/\s+/); return `${f[1]} ${f[8]}`; });
}

async function serving(head: TestNode): Promise<RunView> {
  const r = await waitFor(async () => {
    const x = (await head.client().pool()).run;
    return x && (x.state === "serving" || x.state === "failed" || x.state === "stopped") ? x : null;
  }, { timeoutMs: 120_000, intervalMs: 250, what: "the split run serving" });
  if (r.state !== "serving") throw new Error(`run ${r.state}: ${r.error}`);
  return r;
}

async function complete(r: RunView): Promise<{ text: string; tps: number; n: number }> {
  const key = readFileSync(r.api_key_file!, "utf8").trim();
  const res = await fetch(`${r.endpoint}/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Once upon a time", max_tokens: 48, temperature: 0 }),
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { choices: { text: string }[]; timings: { predicted_n: number; predicted_per_second: number } };
  // Without the key: refused (the endpoint is localhost-only AND keyed).
  expect((await fetch(`${r.endpoint}/completions`, { method: "POST", body: "{}" })).status).toBe(401);
  return { text: body.choices[0]!.text, tps: body.timings.predicted_per_second, n: body.timings.predicted_n };
}

describe.skipIf(!HAVE)("a real split run through Walkie's tunnels", () => {
  let c: Cluster;
  beforeAll(() => { c = new Cluster(); });
  afterAll(async () => { await c.close(); });

  for (const transport of ["tailscale", "direct"] as const) {
    test(`${transport}: head + worker, completion through the head's endpoint, loopback only, then Stop`, async () => {
      const direct = transport === "direct";
      const head = await c.add({ name: `h-${transport}`, login: `alex-${transport}@example.com`, hostname: `alex-${transport}`, direct, pool: POOL });
      const worker = await c.add({ name: `w-${transport}`, login: `kira-${transport}@example.com`, hostname: `kira-${transport}`, direct, pool: POOL });
      await head.client().init(`team-${transport}`, "alex");
      if (direct) {
        const inv = await head.client().inviteCode("kira", "member");
        expect((await worker.client().join(inv.code)).admitted).toBe(true);
      } else {
        await head.client().invite(`kira-${transport}@example.com`, "kira", "member");
        expect((await worker.client().join(head.peerAddr)).admitted).toBe(true);
      }
      await worker.client().poolShare(true, 4);
      // The head learns over sync that the worker shares, with the runtime installed.
      await waitFor(async () => (await head.client().team()).nodes.find((n) => n.hostname === worker.hostname)?.pool?.share, { timeoutMs: 15_000, what: "worker sharing seen by the head" });

      const started = (await head.client().poolRun({ file: GGUF, machines: [worker.hostname] })).run;
      expect(started.stages.map((s) => s.hostname)).toEqual([head.hostname, worker.hostname]);
      const r = await serving(head);
      const stage = await waitFor(async () => (await worker.client().pool()).stage, { what: "worker stage" });
      expect(stage.head_hostname).toBe(head.hostname);
      expect(stage.tunnels).toBeGreaterThanOrEqual(1);

      const out = await complete(r);
      console.log(`[evidence] ${transport}: completion "${out.text.replace(/\n/g, " ").slice(0, 160)}" · ${out.n} tokens at ${out.tps.toFixed(1)} tokens/s (llama-server timings)`);
      expect(out.n).toBeGreaterThan(0);
      expect(out.text.trim().length).toBeGreaterThan(0);
      // The worker really holds its share: the weights crossed the tunnel into its rpc-server.
      const after = (await worker.client().pool()).stage!;
      console.log(`[evidence] ${transport}: ${after.bytes_in} bytes went through the tunnel into ${worker.hostname}'s rpc-server (model file ${Bun.file(GGUF).size} bytes)`);
      expect(after.bytes_in).toBeGreaterThan(Bun.file(GGUF).size / 4);

      // Nothing listens beyond loopback: llama-server, the rpc-server, and this test process (both daemons' peer
      // APIs, dashboards and the head's tunnel listeners).
      const socks = listening([r.server_pid!, stage.pid, process.pid]);
      console.log(`[evidence] ${transport}: lsof listeners ${JSON.stringify(socks)}`);
      expect(socks.some((l) => l.startsWith(`${stage.pid} `))).toBe(true);
      expect(socks.some((l) => l.startsWith(`${r.server_pid} `))).toBe(true);
      expect(socks.every((l) => / 127\.0\.0\.1:\d+$/.test(l) || / \[::1\]:\d+$/.test(l))).toBe(true);

      // The rpc-server's port is loopback-only and reached only via the tunnel; the worker's peer gate names the head.
      const stopped = (await head.client().poolStop()).run!;
      expect(stopped.state).toBe("stopped");
      await waitFor(async () => (await worker.client().pool()).stage === null, { what: "worker stage stopped" });
      const alive = Bun.spawnSync(["ps", "-p", `${r.server_pid},${stage.pid}`, "-o", "pid="], { stdout: "pipe" }).stdout.toString().trim();
      expect(alive).toBe("");
    }, 240_000);
  }

  test("a stage that dies mid-run stops the whole run cleanly and names the machine", async () => {
    const head = await c.add({ name: "h-die", login: "alex-die@example.com", hostname: "alex-die", pool: POOL });
    const worker = await c.add({ name: "w-die", login: "kira-die@example.com", hostname: "kira-die", pool: POOL });
    await head.client().init("team-die", "alex");
    await head.client().invite("kira-die@example.com", "kira", "member");
    expect((await worker.client().join(head.peerAddr)).admitted).toBe(true);
    await worker.client().poolShare(true, null);
    await waitFor(async () => (await head.client().team()).nodes.find((n) => n.hostname === "kira-die")?.pool?.share, { timeoutMs: 15_000, what: "sharing seen" });
    await head.client().poolRun({ file: GGUF, machines: ["kira-die"] });
    const r = await serving(head);
    const stage = (await worker.client().pool()).stage!;
    // The worker's owner turns sharing off mid-run: its rpc-server is killed at once.
    await worker.client().poolShare(false);
    const failed = await waitFor(async () => { const x = (await head.client().pool()).run; return x?.state === "failed" ? x : null; }, { timeoutMs: 30_000, what: "run failed" });
    console.log(`[evidence] stage death: ${failed.error}`);
    expect(failed.error).toContain("kira-die");
    expect(failed.stages.find((s) => s.hostname === "kira-die")?.state).toBe("lost");
    const alive = Bun.spawnSync(["ps", "-p", `${r.server_pid},${stage.pid}`, "-o", "pid="], { stdout: "pipe" }).stdout.toString().trim();
    expect(alive).toBe("");
  }, 120_000);
});
