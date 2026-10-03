import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function hostForExit(): any {
  const dir = mkdtempSync("/tmp/walkie-attempt-reset-");
  dirs.push(dir);
  const host: any = Object.create(OrchestratorHost.prototype);
  host.statePath = join(dir, "orchestrator.json");
  host.state = { active: true, access: "platform", sessions: {} };
  host.opts = { restartBaseMs: 60_000, restartMaxMs: 60_000 };
  host.log = { warn: () => undefined };
  host.status = () => undefined;
  host.endLive = () => undefined;
  host.postReply = () => undefined;
  host.pump = () => undefined;
  host.cleanupAfterGiveUp = async () => undefined;
  host.childInit = true;
  host.childResumed = false;
  host.stopping = false;
  host.attempt = 0;
  host.restarts = 0;
  host.phase = "idle";
  host.restartTimer = null;
  return host;
}

function quickExitWithoutResult(host: any): boolean {
  host.childStartedAt = Date.now() - 10;
  host.onExit(0, "");
  const scheduled = host.restartTimer !== null;
  if (host.restartTimer) { clearTimeout(host.restartTimer); host.restartTimer = null; }
  return scheduled;
}

test("quick exits without a successful turn back off and persist give-up", () => {
  const host = hostForExit();
  for (let attempt = 1; attempt <= 4; attempt++) {
    expect(quickExitWithoutResult(host)).toBe(true);
    expect(host.attempt).toBe(attempt);
    expect(host.restarts).toBe(attempt);
    expect(host.phase).toBe("restarting");
    expect(host.state.gave_up).toBeUndefined();
  }
  expect(quickExitWithoutResult(host)).toBe(false);
  expect(host.attempt).toBe(5);
  expect(host.restarts).toBe(4);
  expect(host.phase).toBe("failed");
  expect(host.state.gave_up).toBe(true);
  expect(JSON.parse(readFileSync(host.statePath, "utf8")).gave_up).toBe(true);
});

test("a run longer than the healthy threshold resets the attempt count", () => {
  const host = hostForExit();
  host.attempt = 3;
  host.childStartedAt = Date.now() - 61_000;
  host.onExit(0, "");
  expect(host.attempt).toBe(1);
  expect(host.restarts).toBe(1);
  expect(host.phase).toBe("restarting");
  clearTimeout(host.restartTimer);
});
