// v0.1.3: the daemon's local socket must come up even when Tailscale is slow or stuck. Found in production
// (a busy Mac, 0.1.1 → 0.1.2 update): launchd ran the daemon in the Background band (priority 4) on a loaded machine,
// the Tailscale CLI calls before the socket took 23 s, and `walkie doctor` saw no socket for ~100 s.
// These tests run a real `walkie daemon run` (from source) in a temp home with a fake `tailscale` first on PATH.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient } from "../../src/client/index.ts";

const MAIN = join(import.meta.dir, "../../src/daemon/main.ts");
const roots: string[] = [];
const daemons: Bun.Subprocess[] = [];

// Answers `tailscale …` only after SIGTERM, which it logs. Its sleep does not hold the stdout pipe.
const SLOW = `#!/bin/sh
echo "start $$ $*" >> "$TS_LOG"
sleep 60 > /dev/null 2>&1 &
child=$!
echo "pid $child" >> "$TS_LOG"
trap 'kill $child; echo "killed $$" >> "$TS_LOG"; exit 143' TERM
wait
`;

// Ignores SIGTERM, and its sleep (which ignores it too) keeps the stdout pipe open: only SIGKILL ends it.
const STUCK = `#!/bin/sh
echo "start $$ $*" >> "$TS_LOG"
echo "pid $$" >> "$TS_LOG"
trap '' TERM
sleep 600 &
echo "pid $!" >> "$TS_LOG"
wait
`;

interface Run { home: string; socket: string; tsLog: string; daemon: Bun.Subprocess; started: number }

function launch(fake: string): Run {
  const root = mkdtempSync("/tmp/walkie-start-");
  roots.push(root);
  const bin = join(root, "bin");
  const home = join(root, "h");
  mkdirSync(bin);
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(bin, "tailscale"), fake);
  chmodSync(join(bin, "tailscale"), 0o755);
  writeFileSync(join(home, "config.json"), JSON.stringify({ discover_agents: false }));
  const tsLog = join(root, "tailscale.log");
  writeFileSync(tsLog, "");
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: root, WALKIE_HOME: home, WALKIE_LOCAL_PORT: "0", WALKIE_PEER_PORT: "0", TS_LOG: tsLog, NO_COLOR: "1",
  };
  const daemon = Bun.spawn([process.execPath, MAIN], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  daemons.push(daemon);
  return { home, socket: join(home, "walkie.sock"), tsLog, daemon, started: Date.now() };
}

async function healthy(socket: string): Promise<boolean> {
  if (!existsSync(socket)) return false;
  try { return (await new WalkieClient({ socket, timeoutMs: 1_000 }).healthz()).ok; } catch { return false; }
}

async function until<T>(fn: () => Promise<T | null | false> | T | null | false, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await Bun.sleep(50);
  }
  return null;
}

function logText(run: Run): string {
  const p = join(run.home, "logs", "daemon.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

afterAll(() => {
  for (const d of daemons) d.kill("SIGKILL");
  for (const root of roots) {
    const log = join(root, "tailscale.log");
    const pids = existsSync(log) ? [...readFileSync(log, "utf8").matchAll(/^pid (\d+)$/gm)].map((m) => Number(m[1])) : [];
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("daemon startup with a slow or stuck Tailscale CLI", () => {
  test("a slow Tailscale: the socket answers while the first `tailscale` call is still running", async () => {
    const run = launch(SLOW);
    // The daemon's own 5 s CLI timeout kills the call; the socket must not wait for that.
    const up = await until(async () => (await healthy(run.socket)) && readFileSync(run.tsLog, "utf8"), 20_000);
    expect(up).not.toBeNull();
    expect(up as string).toContain("start ");
    expect(up as string).not.toContain("killed");
    // …and the daemon finishes starting, with the peer API retrying in the background.
    const started = await until(() => logText(run).includes('"daemon_started"'), 20_000);
    expect(started).toBe(true);
  }, 45_000);

  test("a stuck Tailscale that ignores SIGTERM and holds its pipe: the socket still comes up and the peer link keeps retrying", async () => {
    const run = launch(STUCK);
    const up = await until(() => healthy(run.socket), 15_000);
    expect(up).toBe(true);
    const started = await until(() => logText(run).includes('"daemon_started"'), 15_000);
    expect(started).toBe(true);
    // The peer link's first Tailscale lookup never settles; it gives up on it and schedules a retry.
    const retrying = await until(() => /"msg":"tailscale_unavailable","error":"tailscale did not answer within/.test(logText(run)), 30_000);
    expect(retrying).toBe(true);
    expect(await healthy(run.socket)).toBe(true);
  }, 70_000);
});
