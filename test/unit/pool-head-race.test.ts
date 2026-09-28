// Seats round 10 (Opus/Codex MEDIUM): a head run stopped while its llama-server is being spawned leaves nothing
// running, and while any model server this daemon started (or is starting) runs, the pool says so to seats.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildRegistry, spawnChild } from "../../src/pool/run/child.ts";
import { PoolRunner } from "../../src/pool/run/runner.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

/** A llama-server stand-in: answers --list-devices, else records its PID and sleeps (killed by exact PID only). */
function standIn(): { root: string; rt: string; srv: string; pidf: string } {
  const root = mkdtempSync(join(tmpdir(), "walkie-headrace-"));
  const rt = join(root, "rt");
  mkdirSync(rt);
  const srv = join(rt, "llama-server");
  const pidf = join(root, "srv.pid");
  writeFileSync(srv, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "--list-devices" ]; then echo "Available devices:"; echo "  MTL0: Apple fake (1000 MiB, 1000 MiB free)"; exit 0; fi; done\necho $$ > ${pidf}\nexec sleep 47\n`);
  chmodSync(srv, 0o755);
  cleanups.push(() => {
    if (existsSync(pidf)) { const pid = Number(readFileSync(pidf, "utf8").trim()); try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, rt, srv, pidf };
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a head stopped while its llama-server is spawning: the late server is stopped, nothing stays recorded", async () => {
  const { root, rt, srv, pidf } = standIn();
  const gguf = join(root, "m.gguf");
  writeFileSync(gguf, "x".repeat(1024));
  const log = { info() {}, warn() {}, error() {}, debug() {} } as never;
  const reg = new ChildRegistry(join(root, "children.json"));
  let stopped: Promise<unknown> | null = null;
  let runner!: PoolRunner;
  runner = new PoolRunner({
    home: root, log, runtime: () => ({ dir: rt, server: srv, rpc: srv }),
    stage: async () => ({ ok: true }), tunnel: async () => { throw new Error("no tunnel"); },
    // Stop the moment the run says "loading": its llama-server is being spawned right then.
    changed: () => { if (!stopped && runner?.view()?.state === "loading") stopped = runner.stop(); },
    registry: reg,
  });
  const self = { node_id: "a".repeat(16), hostname: "me", self: true, online: true, rtt_ms: 0, stats: null } as never;
  runner.start({ file: gguf, machines: ["me"] }, [self]);
  for (let i = 0; i < 100 && !(stopped && runner.view()?.state === "stopped"); i++) await Bun.sleep(50);
  await stopped;
  await Bun.sleep(300);
  expect(runner.view()?.state).toBe("stopped");
  expect(existsSync(pidf)).toBe(true); // it did start
  const pid = Number(readFileSync(pidf, "utf8").trim());
  expect(alive(pid)).toBe(false);
  expect(reg.busy()).toBe(false);
});

test("the registry is busy while a child is being started and while one runs", async () => {
  const { root, srv } = standIn();
  const reg = new ChildRegistry(join(root, "children.json"));
  expect(reg.busy()).toBe(false);
  const starting = spawnChild([srv], { PATH: "/usr/bin:/bin" }, { registry: reg, role: "llama-server" });
  expect(reg.busy()).toBe(true); // before its PID is known
  const child = await starting;
  expect(reg.busy()).toBe(true);
  await child.stop(1_000);
  expect(reg.busy()).toBe(false);
  expect(alive(child.pid)).toBe(false);
});

test("Opus r11: a run stops when the seats gate turns on while it runs (the run watchdog)", async () => {
  const { root, rt, srv, pidf } = standIn();
  const gguf = join(root, "m.gguf");
  writeFileSync(gguf, "x".repeat(1024));
  const log = { info() {}, warn() {}, error() {}, debug() {} } as never;
  let gate: string | null = null;
  const runner = new PoolRunner({
    home: root, log, runtime: () => ({ dir: rt, server: srv, rpc: srv }),
    stage: async () => ({ ok: true }), tunnel: async () => { throw new Error("no tunnel"); },
    changed: () => undefined, registry: new ChildRegistry(join(root, "children.json")),
    seatsBlock: () => gate, seatsWatchMs: 50,
  });
  const self = { node_id: "a".repeat(16), hostname: "me", self: true, online: true, rtt_ms: 0, stats: null } as never;
  runner.start({ file: gguf, machines: ["me"] }, [self]);
  // Its stand-in llama-server never answers health checks: the run stays loading until something stops it.
  for (let i = 0; i < 100 && !existsSync(pidf); i++) await Bun.sleep(50);
  expect(runner.view()?.state).toBe("loading");
  gate = "seats and compute sharing can't be on together on one machine: test";
  for (let i = 0; i < 100 && runner.view()?.state !== "failed"; i++) await Bun.sleep(50);
  expect(runner.view()?.state).toBe("failed");
  expect(runner.view()?.error).toContain("can't be on together");
  await Bun.sleep(300);
  expect(alive(Number(readFileSync(pidf, "utf8").trim()))).toBe(false);
});
