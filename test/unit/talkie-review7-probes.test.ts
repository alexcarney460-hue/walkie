// Adapted regression probes from review/probe7-*.test.ts; only fake helper calls and local SQLite are used.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CleanupObligation } from "../../src/daemon/orchestrator/cleanup-obligation.ts";
import { TalkieOsUser } from "../../src/daemon/orchestrator/os-user.ts";
import { repairTalkieCleanup, type RepairSnapshot } from "../../src/daemon/orchestrator/cleanup-repair.ts";
import { processStart, selfOp } from "../../src/daemon/seats/admin-ledger.ts";
import type { Ctx } from "../../src/cli/context.ts";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const state = () => {
  const dir = mkdtempSync("/tmp/walkie-review7-"); roots.push(dir);
  return join(dir, "cleanup.sqlite");
};

// Probe 7 owner-record-gap: a bare daemon record cannot bypass an active monitor claim.
test("a live monitor claim excludes a daemon claim in the same database transaction", () => {
  const path = state();
  const obligation = new CleanupObligation(path);
  const start = processStart(1);
  expect(start).not.toBeNull();
  expect(obligation.record("run", { pid: 1, start: start! })).toBe(true);
  expect(obligation.record("run")).toBe(false);
  expect(obligation.record("run", selfOp())).toBe(false);
  expect(obligation.monitorOwner("run")).toEqual({ pid: 1, start: start! });
});

// Probe 7 handoff-window: a restarted daemon defers to a fresh owner, then resumes after expiry.
test("restart handoff resumes after the monitor heartbeat expires", async () => {
  const path = state();
  const obligation = new CleanupObligation(path);
  const start = processStart(1);
  expect(start).not.toBeNull();
  expect(obligation.record("run", { pid: 1, start: start! }, 1_000)).toBe(true);
  const waits: Array<() => void> = [];
  let calls = 0;
  const user = new TalkieOsUser("/not-a-socket", () => false, {
    cleanupFile: path,
    admin: async () => { calls++; return { ok: true }; },
    retrySleep: () => new Promise<void>((resolve) => { waits.push(resolve); }),
  });
  await user.cleanupStale();
  waits.shift()?.();
  for (let i = 0; i < 50 && waits.length === 0; i++) await Bun.sleep(2);
  expect(calls).toBe(0);
  const db = new Database(path);
  try { db.query("UPDATE retry_owner SET heartbeat = ? WHERE generation = ?").run(Date.now() - 3_001, "run"); }
  finally { db.close(); }
  waits.shift()?.();
  for (let i = 0; i < 50 && obligation.read(); i++) await Bun.sleep(2);
  expect(calls).toBe(1);
  expect(obligation.read()).toBeNull();
});

// Probe 7 repair-guards: direct callers must confirm, and a remaining account blocks the clear.
test("direct repair refuses an agent and keeps the obligation for a remaining account", async () => {
  const path = state();
  const obligation = new CleanupObligation(path);
  expect(obligation.record("run")).toBe(true);
  const clean: RepairSnapshot = { accountUid: null, uidTaken: false, processes: [], homeExists: false, ledgerOwner: null };
  const ctx = (marker: string | null): Ctx => ({
    agentMarker: () => marker, agentSignals: () => ({ marker, inspection: "ok" }),
    person: { interactive: () => true, ask: async () => "yes", note: () => undefined },
  } as unknown as Ctx);
  await expect(repairTalkieCleanup(path, async () => clean, ctx("agent"))).rejects.toThrow("agents can't");
  const result = await repairTalkieCleanup(path, async () => ({ ...clean, accountUid: 550_000 }), ctx(null));
  expect(result.remaining.join(" ")).toContain("account remains");
  expect(obligation.read()?.generation).toBe("run");
});
