import { afterEach, expect, spyOn, test } from "bun:test";
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

/** A child that completes a reply and then exits within ten milliseconds of its launch. */
function successfulQuickExit(host: any): boolean {
  host.turn = {
    id: "turn", thread: "thread", texts: ["done"], tools: [], toolCount: 0,
    item: { id: "turn", origin: { via: "cli" } }, interrupted: false,
  };
  host.childStartedAt = Date.now() - 10;
  host.finishTurn({ kind: "result", ok: true, subtype: "success", text: "done" });
  host.onExit(0, "");
  const scheduled = host.restartTimer !== null;
  if (host.restartTimer) { clearTimeout(host.restartTimer); host.restartTimer = null; }
  return scheduled;
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

// WALK-117: a completed reply only counts as a healthy run when the child it came from had been running longer than the
// healthy threshold. Otherwise a crash loop that keeps answering would reset the count on every pass and never give up.
test("quick clean exits after completed replies back off and persist give-up", () => {
  const host = hostForExit();
  for (let attempt = 1; attempt <= 4; attempt++) {
    expect(successfulQuickExit(host)).toBe(true);
    expect(host.attempt).toBe(attempt);
    expect(host.restarts).toBe(attempt);
    expect(host.phase).toBe("restarting");
    expect(host.state.gave_up).toBeUndefined();
  }
  expect(successfulQuickExit(host)).toBe(false);
  expect(host.attempt).toBe(5);
  expect(host.restarts).toBe(4);
  expect(host.phase).toBe("failed");
  expect(host.state.gave_up).toBe(true);
  expect(JSON.parse(readFileSync(host.statePath, "utf8")).gave_up).toBe(true);
});

function completedReply(host: any, ranMs: number): void {
  host.turn = {
    id: "turn", thread: "thread", texts: ["done"], tools: [], toolCount: 0,
    item: { id: "turn", origin: { via: "cli" } }, interrupted: false,
  };
  host.childStartedAt = Date.now() - ranMs;
  host.finishTurn({ kind: "result", ok: true, subtype: "success", text: "done" });
}

test("a completed reply from a child that ran longer than the healthy threshold resets the attempt count", () => {
  const host = hostForExit();
  host.attempt = 3;
  completedReply(host, 61_000);
  expect(host.attempt).toBe(0);
});

test("a completed reply from a child that has not run the healthy threshold keeps the attempt count", () => {
  const host = hostForExit();
  host.attempt = 3;
  completedReply(host, 59_000);
  expect(host.attempt).toBe(3);
});

test("a completed reply after a give-up still leaves the attempt count alone", () => {
  const host = hostForExit();
  host.attempt = 5;
  host.state = { ...host.state, gave_up: true };
  completedReply(host, 61_000);
  expect(host.attempt).toBe(5);
});

// pump() replaces the child when the next message belongs to another conversation (a full-access WalkieTalkie changes
// conversation by restarting its child). That is deliberate, so it is not a crash attempt and it waits for nothing.
function hostForPump(child: { alive: boolean }): any {
  const host = hostForExit();
  delete host.pump; // the real pump decides here
  host.state = { active: true, owner: "alex", access: "full", sessions: { thread: "session-a" } };
  host.leadership = { valid: true };
  host.core = { me: () => ({ handle: "alex", role: "owner" }) };
  host.closed = false;
  host.turn = null;
  host.attempt = 2;
  host.queue = [{ id: "m1", thread: "thread", ts: Date.now(), text: "hello", origin: { via: "cli" } }];
  host.childSession = "session-b";
  host.childStartedAt = Date.now() - 1_000;
  host.child = { ...child, close: async () => undefined };
  return host;
}

function restartDelay(host: any): number {
  const real = globalThis.setTimeout;
  let delay = -1;
  (globalThis as any).setTimeout = (fn: unknown, ms?: number, ...rest: unknown[]) => {
    delay = ms ?? 0;
    return real(() => undefined, 1, ...rest);
  };
  try { host.pump(); } finally { (globalThis as any).setTimeout = real; }
  if (host.restartTimer) { clearTimeout(host.restartTimer); host.restartTimer = null; }
  return delay;
}

test("replacing a live Claude for another conversation is not a crash attempt", () => {
  const host = hostForPump({ alive: true });
  const delay = restartDelay(host);
  expect(host.attempt).toBe(2);
  expect(host.restarts).toBe(1);
  expect(host.phase).toBe("restarting");
  expect(delay).toBe(0);
  expect(host.state.gave_up).toBeUndefined();
});

test("replacing a Claude that had run longer than the healthy threshold clears the attempt count", () => {
  const host = hostForPump({ alive: true });
  host.childStartedAt = Date.now() - 61_000;
  const delay = restartDelay(host);
  expect(host.attempt).toBe(0);
  expect(host.restarts).toBe(1);
  expect(delay).toBe(0);
});

test("a Claude that is already dead when the next message arrives still counts as a crash attempt", () => {
  const host = hostForPump({ alive: false });
  host.childSession = "session-a"; // the right session, but nothing is running
  const delay = restartDelay(host);
  expect(host.attempt).toBe(3);
  expect(host.restarts).toBe(1);
  expect(host.phase).toBe("restarting");
  expect(delay).toBe(60_000);
});

// A process can be dead while its output is still draining, before onExit resets a healthy run's old attempts.
for (const mode of [{ access: "full" }, { access: "platform", permission_mode: "bypassPermissions" }]) {
  for (const { childExists, ranMs, resets } of [
    { childExists: true, ranMs: 61_000, resets: true },
    { childExists: true, ranMs: 60_001, resets: true },
    { childExists: true, ranMs: 60_000, resets: false },
    { childExists: true, ranMs: 59_000, resets: false },
    { childExists: false, ranMs: 61_000, resets: false },
  ]) {
    test(`pump with four old attempts: ${mode.access}, ${childExists ? "dead child" : "no child"}, ${ranMs}ms`, () => {
      const clock = spyOn(Date, "now").mockReturnValue(100_000);
      try {
        const host = hostForPump({ alive: false });
        host.state = { ...host.state, ...mode };
        host.opts = { restartBaseMs: 100, restartMaxMs: 60_000 };
        host.attempt = 4;
        host.childSession = "session-a";
        host.childStartedAt = Date.now() - ranMs;
        if (!childExists) host.child = null;
        const delay = restartDelay(host);
        expect(host.child).toBeNull();
        expect(host.attempt).toBe(resets ? 1 : 5);
        expect(host.restarts).toBe(resets ? 1 : 0);
        expect(host.phase).toBe(resets ? "restarting" : "failed");
        expect(host.state.gave_up).toBe(resets ? undefined : true);
        expect(delay).toBe(resets ? 100 : -1);
        expect(host.queue.map((item: { id: string }) => item.id)).toEqual(["m1"]);
      } finally {
        clock.mockRestore();
      }
    });
  }
}
