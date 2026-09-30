import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { monitorUid, uidLeaseValid, writeUidLease } from "../../src/daemon/orchestrator/uid-monitor.ts";
import { CleanupObligation } from "../../src/daemon/orchestrator/cleanup-obligation.ts";
import { adminCall } from "../../src/daemon/seats/runner-child.ts";

test("independent supervisor destroys a detached uid job when the daemon stops renewing", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".uid-monitor-"));
  const file = join(dir, "lease.json");
  const cleanup = join(dir, "cleanup.sqlite");
  const run = "test-run";
  let wall = 10_000, mono = 0, jobAlive = true, calls = 0;
  try {
    writeUidLease(file, { run, expires: wall + 1_000, renewed: wall, serial: 0 });
    const code = await monitorUid(file, run, cleanup, {
      now: () => wall, monotonic: () => mono,
      sleep: async (ms) => { wall += ms; mono += ms; },
      destroy: async () => { calls++; jobAlive = false; return true; },
    });
    expect(code).toBe(0);
    expect(calls).toBe(1);
    expect(new CleanupObligation(cleanup).read()).toBeNull();
    expect(jobAlive).toBe(false);
    expect(wall - 10_000).toBeLessThanOrEqual(1_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("holder wall expiry ends the uid lease, while a late renewal does not", () => {
  const dir = mkdtempSync(join(import.meta.dir, ".uid-monitor-"));
  const file = join(dir, "lease.json");
  try {
    writeUidLease(file, { run: "one", expires: 20_000, renewed: 10_000, serial: 2 });
    expect(uidLeaseValid(file, "one", 2, 10_100, 100).valid).toBe(true);
    expect(uidLeaseValid(file, "one", 2, 20_000, 100).valid).toBe(false);
    expect(uidLeaseValid(file, "one", 2, 13_000, 3_000).valid).toBe(true);
    expect(uidLeaseValid(file, "another", 2, 10_100, 100).valid).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dead daemon parent destroys a uid despite an unexpired lease", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".uid-monitor-"));
  const file = join(dir, "lease.json");
  const cleanup = join(dir, "cleanup.sqlite");
  let parent = 123, calls = 0;
  try {
    writeUidLease(file, { run: "parent-run", expires: Date.now() + 30_000, renewed: Date.now(), serial: 0 });
    const code = await monitorUid(file, "parent-run", cleanup, {
      daemonPid: 123, parentPid: () => parent,
      sleep: async () => { parent = 1; },
      destroy: async () => { calls++; return true; },
    });
    expect(code).toBe(0);
    expect(calls).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dead parent with an uncertain ps result retries its cleanup owner", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".uid-monitor-"));
  const cleanup = join(dir, "cleanup.sqlite");
  const daemonPid = 999_999_999;
  const owner = { pid: daemonPid, start: "unknown-start" };
  const obligation = new CleanupObligation(cleanup);
  try {
    expect(obligation.record("dead-parent", owner, 3_000)).toBe(true);
    let waits = 0, destroys = 0;
    const code = await monitorUid(join(dir, "missing-lease"), "dead-parent", cleanup, {
      daemonPid, parentPid: () => 1,
      sleep: async () => { waits++; obligation.releaseOwner("dead-parent", owner); },
      destroy: async () => { destroys++; return true; },
    });
    expect(code).toBe(0);
    expect(waits).toBeGreaterThan(0);
    expect(destroys).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a three second renewal delay does not destroy the uid before authority expiry", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".uid-monitor-"));
  const file = join(dir, "lease.json");
  const cleanup = join(dir, "cleanup.sqlite");
  let wall = 10_000, parent = 123, calls = 0;
  try {
    writeUidLease(file, { run: "late-run", expires: 20_000, renewed: wall, serial: 0 });
    const code = await monitorUid(file, "late-run", cleanup, {
      daemonPid: 123, parentPid: () => parent, now: () => wall,
      sleep: async (ms) => { wall += ms; if (wall >= 13_250) parent = 1; },
      destroy: async () => { calls++; expect(wall).toBeGreaterThanOrEqual(13_000); return true; },
    });
    expect(code).toBe(0);
    expect(calls).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("helper failures continue past fast retries with jittered five minute waits", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".uid-monitor-"));
  const file = join(dir, "lease.json");
  const cleanup = join(dir, "cleanup.sqlite");
  const delays: number[] = [];
  const lines: string[] = [];
  let calls = 0;
  try {
    writeUidLease(file, { run: "failed-run", expires: 0, renewed: 0, serial: 0 });
    const code = await monitorUid(file, "failed-run", cleanup, {
      now: () => 1, monotonic: () => 0,
      sleep: async (ms) => { delays.push(ms); },
      random: () => 0.5,
      destroy: async () => { calls++; expect(new CleanupObligation(cleanup).read()?.generation).toBe("failed-run"); return calls === 14; },
      report: (line) => { lines.push(line); },
    });
    expect(code).toBe(0);
    expect(calls).toBe(14);
    expect(delays).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 300_000, 300_000]);
    expect(lines).toHaveLength(13);
    expect(lines.every((line) => line.length <= 240 && !line.includes("\n"))).toBe(true);
    expect(new CleanupObligation(cleanup).read()).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("monitor calls destroy while obligation storage is unavailable and records when restored", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".uid-monitor-"));
  const cleanup = join(dir, "cleanup.sqlite");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(cleanup);
  let calls = 0;
  let waits = 0;
  try {
    const code = await monitorUid(join(dir, "missing-lease"), "run", cleanup, {
      destroy: async () => { calls++; return calls === 2; },
      sleep: async () => {
        if (++waits > 3) throw new Error("monitor skipped destroy while storage was unavailable");
        if (calls === 1) rmSync(cleanup, { recursive: true });
      },
    });
    expect(code).toBe(0);
    expect(calls).toBe(2);
    expect(new CleanupObligation(cleanup).read()).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("helper uninstall records the obligation and stops the independent monitor", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".uid-monitor-"));
  const cleanup = join(dir, "cleanup.sqlite");
  let destroys = 0;
  try {
    const code = await monitorUid(join(dir, "missing-lease"), "run", cleanup, {
      helperPresent: () => false,
      destroy: async () => { destroys++; return true; },
    });
    expect(code).toBe(2);
    expect(destroys).toBe(0);
    expect(new CleanupObligation(cleanup).read()?.generation).toBe("run");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a newer helper generation discharges only the old monitor obligation", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".uid-monitor-"));
  const file = join(dir, "lease.json");
  const cleanup = join(dir, "cleanup.sqlite");
  try {
    const code = await monitorUid(file, "old-run", cleanup, {
      destroy: async () => "newer",
      sleep: async () => { throw new Error("unexpected wait"); },
    });
    expect(code).toBe(0);
    expect(new CleanupObligation(cleanup).read()).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a late old monitor does not recreate completed cleanup", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".uid-monitor-"));
  const file = join(dir, "lease.json");
  const cleanup = join(dir, "cleanup.sqlite");
  const state = new CleanupObligation(cleanup);
  try {
    expect(state.record("old-run")).toBe(true);
    expect(state.clear("old-run")).toBe(true);
    let calls = 0;
    expect(await monitorUid(file, "old-run", cleanup, { destroy: async () => { calls++; return false; } })).toBe(0);
    expect(calls).toBe(0);
    expect(state.read()).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("helper stderr is drained to one bounded line", async () => {
  let diagnostic = "";
  const result = await adminCall(["/bin/sh", "-c", "printf 'helper unavailable\\n' >&2; exit 1"], 2_000,
    (line) => { diagnostic = line; });
  expect(result).toBeNull();
  expect(diagnostic).toBe("helper unavailable");
});
