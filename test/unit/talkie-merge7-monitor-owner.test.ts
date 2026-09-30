import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TalkieOsUser } from "../../src/daemon/orchestrator/os-user.ts";
import { CleanupObligation } from "../../src/daemon/orchestrator/cleanup-obligation.ts";
import { selfOp } from "../../src/daemon/seats/admin-ledger.ts";

test("monitor exit 3 does not fault while this daemon owns qualified cleanup", () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-monitor-owner-"));
  try {
    const run = "owned-generation";
    const file = join(dir, "uid-lease.json");
    const cleanupFile = join(dir, "cleanup.sqlite");
    const obligation = new CleanupObligation(cleanupFile);
    expect(obligation.record(run, selfOp(), 180_000)).toBe(true);
    const failures: string[] = [];
    const user = new TalkieOsUser("/not-a-socket", () => false, {
      cleanupFile, monitorFailure: (reason) => failures.push(reason),
      retrySleep: () => new Promise<void>(() => undefined),
    });
    const monitor = { kill: () => undefined };
    Object.assign(user, { monitor, monitorFile: file, generation: run });
    (user as unknown as { monitorExited: (m: typeof monitor, f: string, r: string, code: number) => void })
      .monitorExited(monitor, file, run, 3);
    expect(failures).toEqual([]);
    expect(user.pendingCleanup?.generation).toBe(run);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("monitor exit 0 during verified daemon cleanup is expected", () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-monitor-complete-"));
  try {
    const run = "completed-generation";
    const file = join(dir, "uid-lease.json");
    const cleanupFile = join(dir, "cleanup.sqlite");
    const obligation = new CleanupObligation(cleanupFile);
    expect(obligation.record(run, selfOp(), 3_000)).toBe(true);
    expect(obligation.clear(run)).toBe(true);
    const failures: string[] = [];
    const user = new TalkieOsUser("/not-a-socket", () => false, {
      cleanupFile, monitorFailure: (reason) => failures.push(reason),
    });
    const monitor = { kill: () => undefined };
    Object.assign(user, { monitor, monitorFile: file, generation: run, cleaning: Promise.resolve() });
    (user as unknown as { monitorExited: (m: typeof monitor, f: string, r: string, code: number) => void })
      .monitorExited(monitor, file, run, 0);
    expect(failures).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("monitor exit 0 while daemon cleanup is in flight is expected", () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-monitor-finishing-"));
  try {
    const run = "finishing-generation";
    const file = join(dir, "uid-lease.json");
    const cleanupFile = join(dir, "cleanup.sqlite");
    expect(new CleanupObligation(cleanupFile).record(run, selfOp(), 3_000)).toBe(true);
    const failures: string[] = [];
    const user = new TalkieOsUser("/not-a-socket", () => false, {
      cleanupFile, monitorFailure: (reason) => failures.push(reason),
    });
    const monitor = { kill: () => undefined };
    Object.assign(user, { monitor, monitorFile: file, generation: run, cleaning: new Promise<void>(() => undefined) });
    (user as unknown as { monitorExited: (m: typeof monitor, f: string, r: string, code: number) => void })
      .monitorExited(monitor, file, run, 0);
    expect(failures).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
