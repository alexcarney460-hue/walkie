// WALKIE-POOL-3 (round-1 MEDIUM): no rpc-server or llama-server outlives the daemon that started it. The daemon
// (a separate process here) is SIGKILLed by its exact PID; its children's supervisors see their stdin pipe close
// and kill them. A daemon that starts on the same home also reaps anything recorded that still runs as recorded.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fakeRuntime } from "../helpers/pool-runtime.ts";
import { waitFor } from "../helpers/cluster.ts";

const HOST = join(import.meta.dir, "../fixtures/pool/orphan-host.ts");
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const LLAMA = process.env.WALKIE_TEST_LLAMA_DIR ?? "";
const GGUF = process.env.WALKIE_TEST_GGUF ?? "";

async function hostThenKill(args: string[]): Promise<{ stage_pid: number; server_pid: number | null; worker_home: string }> {
  const host = Bun.spawn([process.execPath, HOST, ...args], { stdout: "pipe", stderr: "pipe" });
  let out = "";
  const reader = (async () => { for await (const ch of host.stdout as ReadableStream<Uint8Array>) out += new TextDecoder().decode(ch); })();
  const line = await waitFor(() => /HOST (\{.*\})/.exec(out)?.[1], { timeoutMs: 150_000, intervalMs: 100, what: "the host's child PIDs" });
  const info = JSON.parse(line) as { stage_pid: number; server_pid: number | null; worker_home: string };
  expect(alive(info.stage_pid)).toBe(true);
  process.kill(host.pid, "SIGKILL"); // the daemon dies without any cleanup, by its exact PID
  await host.exited;
  void reader;
  return info;
}

/** The killed host couldn't clean its cluster directory. */
function cleanHost(info: { worker_home: string }): void {
  rmSync(join(info.worker_home, ".."), { recursive: true, force: true });
}

describe("children die with the daemon", () => {
  test("stand-in rpc-server: daemon SIGKILLed -> the stage process is gone within seconds", async () => {
    const root = mkdtempSync("/tmp/walkie-orphan-");
    try {
      const info = await hostThenKill(["fake", fakeRuntime(root, "fake-rpc")]);
      await waitFor(() => !alive(info.stage_pid), { timeoutMs: 10_000, what: `stage pid ${info.stage_pid} gone` });
      console.log(`[evidence] orphan (stand-in): daemon SIGKILLed; rpc stand-in ${info.stage_pid} alive afterwards: ${alive(info.stage_pid)}`);
      const rec = join(info.worker_home, "pool", "children.json");
      expect(existsSync(rec) ? readFileSync(rec, "utf8") : "[]").toContain(String(info.stage_pid)); // recorded, for a restart to reap
      cleanHost(info);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test.skipIf(!LLAMA || !GGUF)("real llama.cpp: daemons SIGKILLed mid-run -> llama-server and rpc-server are gone", async () => {
    const info = await hostThenKill(["real", LLAMA, GGUF]);
    await waitFor(() => !alive(info.stage_pid) && !alive(info.server_pid!), { timeoutMs: 15_000, what: "llama.cpp processes gone" });
    const lsof = Bun.spawnSync(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", `${info.stage_pid},${info.server_pid}`], { stdout: "pipe" }).stdout.toString().trim();
    console.log(`[evidence] orphan (real): rpc-server ${info.stage_pid} alive=${alive(info.stage_pid)}, llama-server ${info.server_pid} alive=${alive(info.server_pid!)}, listeners after: ${JSON.stringify(lsof)}`);
    expect(lsof).toBe("");
    cleanHost(info);
  }, 200_000);
});
