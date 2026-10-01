import { afterEach, expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeatsHost } from "../../src/daemon/seats/host.ts";
import { createWorkerRoot, recordWorkerProcess, workerRootOccupied } from "../../src/daemon/seats/worker-root.ts";
import { doctorChecks } from "../../src/daemon/seats/doctor.ts";
import type { SeatsLocalView } from "../../src/protocol/seats.ts";
import { seats } from "../../src/cli/commands/seats.ts";
import { parseArgs } from "../../src/cli/args.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import type { Ctx } from "../../src/cli/context.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "walkie-pending-root-"));
  homes.push(home);
  const id = "0123456789abcdef:12";
  const root = createWorkerRoot(home, id);
  const pendingRoots = new Map<string, { id: string; pid?: number; started?: string; uncertain?: true }>([[root.key, { id: root.key, uncertain: true }]]);
  const host = { home, pendingRoots, seats: new Map(), save: () => true };
  return { id: root.key, root, pendingRoots, host };
}

test("doctor names unknown worker roots with count, age, and reason", () => {
  const f = fixture();
  const methods = SeatsHost.prototype as unknown as { pendingWorkerRoots: (this: unknown) => SeatsLocalView["pending_worker_roots"] };
  const pending = methods.pendingWorkerRoots.call(f.host);
  expect(pending).toEqual([{ id: f.id, age_s: expect.any(Number), reason: "process identity unknown" }]);
  const local = { allow: true, same_user: true, ephemeral: false, channel_ok: true, claude_login: "machine", codex_login: "machine", pending_worker_roots: pending } as SeatsLocalView;
  const checks = doctorChecks(local, { team: "test", release: false, runnerProblem: null, helper: "ok", rootsFile: "ok", runtimes: { claude: "fake", codex: "fake" } });
  expect(checks.map((check) => check.what).join(" ")).toContain("1 pending worker root");
  expect(checks.map((check) => check.what).join(" ")).toContain("process identity unknown");
});

test("local cleanup refuses an unknown identity or open root and removes a verified idle root", () => {
  const f = fixture();
  const cleanup = (SeatsHost.prototype as unknown as { cleanupPendingRoot: (this: unknown, id: string, occupied: (root: string) => boolean) => void }).cleanupPendingRoot;
  expect(() => cleanup.call(f.host, f.id, () => false)).toThrow(/process of this seat may still be running/);
  recordWorkerProcess(f.host.home, f.id, 999_999, "Mon Jan  1 00:00:00 2001");
  f.pendingRoots.set(f.id, { id: f.id, pid: 999_999, started: "Mon Jan  1 00:00:00 2001" });
  expect(() => cleanup.call(f.host, f.id, () => true)).toThrow(/process.*using/);
  expect(existsSync(f.root.root)).toBe(true);
  expect(() => cleanup.call(f.host, f.id, () => { throw new Error("scanner unavailable"); })).toThrow(/process check could not finish/);
  expect(existsSync(f.root.root)).toBe(true);
  cleanup.call(f.host, f.id, () => false);
  expect(existsSync(f.root.root)).toBe(false);
  expect(f.pendingRoots.size).toBe(0);
});

test("cleanup keeps a crashed seat root while an environment-free descendant survives outside it", async () => {
  const f = fixture();
  const cleanup = (SeatsHost.prototype as unknown as { cleanupPendingRoot: (this: unknown, id: string, occupied: (root: string) => boolean) => void }).cleanupPendingRoot;
  const leader = Bun.spawn(["/bin/sh", "-c", "sleep 0.3; env -i /bin/sh -c 'cd /; exec sleep 20' </dev/null >/dev/null 2>&1 &"],
    { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  try {
    const ps = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(leader.pid)], { stdout: "pipe" });
    const started = ps.stdout.toString().trim();
    expect(started).not.toBe("");
    recordWorkerProcess(f.host.home, f.id, leader.pid, started);
    f.pendingRoots.set(f.id, { id: f.id, pid: leader.pid, started });
    await leader.exited;
    expect(workerRootOccupied(f.root.root)).toBe(false);
    expect(() => cleanup.call(f.host, f.id, () => false)).toThrow(/process of this seat may still be running/);
    expect(existsSync(f.root.root)).toBe(true);
  } finally {
    try { process.kill(-leader.pid, "SIGKILL"); } catch { /* fixture already exited */ }
  }
});

test("OS verifier sees an open file in the root", () => {
  const f = fixture();
  const path = join(f.root.codex, "open.txt");
  writeFileSync(path, "fixture");
  const fd = openSync(path, "r");
  try { expect(workerRootOccupied(f.root.root)).toBe(true); }
  finally { closeSync(fd); }
  expect(workerRootOccupied(f.root.root)).toBe(false);
});

test("cleanup command requires local typed person confirmation", async () => {
  const f = fixture();
  let calls = 0;
  const base = {
    args: parseArgs(["cleanup-root", f.id], CLI_BOOLEANS), json: false,
    agentMarker: () => null, agentSignals: () => ({ marker: null, inspection: "ok" as const }),
    client: () => ({ seatsCleanupRoot: async () => { calls++; return { local: {} }; } }),
    out: () => undefined, err: () => undefined,
  };
  const agent = { ...base, agentMarker: () => "agent", agentSignals: () => ({ marker: "agent", inspection: "ok" as const }) } as unknown as Ctx;
  await expect(seats(agent)).rejects.toThrow(/agents can't/);
  const person = { ...base, person: { interactive: () => true, ask: async () => "wrong", note: () => undefined } } as unknown as Ctx;
  await expect(seats(person)).rejects.toThrow(/not confirmed/);
  expect(calls).toBe(0);
  const confirmed = { ...base, person: { interactive: () => true, ask: async () => f.id, note: () => undefined } } as unknown as Ctx;
  expect(await seats(confirmed)).toBe(0);
  expect(calls).toBe(1);
});
