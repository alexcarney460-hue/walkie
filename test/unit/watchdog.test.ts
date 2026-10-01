// DAEMON-STALL-1: the event-loop watchdog logs `event_loop_stall` naming the operation that held the loop.
import { afterEach, describe, expect, test } from "bun:test";
import type { Logger } from "../../src/daemon/logger.ts";
import { LoopWatchdog, startWatchdog, stopWatchdog, trackOp } from "../../src/daemon/watchdog.ts";

interface Line { level: string; msg: string; fields?: Record<string, unknown> }

function memLog(): { log: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at = (level: string) => (msg: string, fields?: Record<string, unknown>) => { lines.push({ level, msg, ...(fields ? { fields } : {}) }); };
  return { log: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") }, lines };
}

/** A watchdog on a hand-driven clock: `busy(ms)` is an operation that holds the loop that long. */
function manual(stallMs = 500, intervalMs = 250) {
  const clock = { t: 1_000 };
  const { log, lines } = memLog();
  const w = new LoopWatchdog(log, { stallMs, intervalMs, now: () => clock.t });
  w.start();
  stops.push(() => w.stop());
  const busy = (ms: number) => { clock.t += ms; };
  const tick = () => { clock.t += intervalMs; w.check(); };
  return { w, clock, lines, busy, tick };
}

const stops: (() => void)[] = [];
afterEach(() => { while (stops.length) (stops.pop() as () => void)(); });

describe("LoopWatchdog", () => {
  test("a tick 500 ms late logs event_loop_stall with the operation that held the loop and how long", () => {
    const { w, lines, busy, tick } = manual();
    tick();
    expect(lines).toEqual([]);
    w.track("GET /v1/asks", () => busy(40));
    w.track("agent_archive", () => busy(3_000));
    tick();
    expect(lines).toEqual([{ level: "warn", msg: "event_loop_stall", fields: { lag_ms: 3_040, op: "agent_archive", op_ms: 3_000 } }]);
  });

  test("a short delay is not a stall, and each stall is logged once", () => {
    const { w, lines, busy, tick } = manual();
    w.track("sync", () => busy(499));
    tick();
    expect(lines).toEqual([]);
    w.track("sync", () => busy(600));
    tick();
    tick();
    expect(lines.map((l) => l.fields?.op)).toEqual(["sync"]);
  });

  test("a nested operation that took most of the time names the stall (outer > inner)", () => {
    const { w, lines, busy, tick } = manual();
    w.track("GET /v1/agents", () => { busy(10); w.track("agents_view", () => busy(900)); });
    tick();
    expect(lines[0]?.fields).toMatchObject({ op: "GET /v1/agents > agents_view", op_ms: 900 });
    // When the caller itself spent most of it, the caller is named.
    w.track("POST /v1/status", () => { w.track("scrub", () => busy(100)); busy(800); });
    tick();
    expect(lines[1]?.fields).toMatchObject({ op: "POST /v1/status", op_ms: 900 });
  });

  test("a stall no tracked operation explains is 'untracked', with the operation that started last", () => {
    const { w, lines, busy, tick } = manual();
    w.track("POST /v1/status", () => undefined); // an async route: its continuation after an await runs untracked
    busy(2_000);
    tick();
    expect(lines[0]?.fields).toEqual({ lag_ms: 2_000, op: "untracked", last_op: "POST /v1/status" });
  });

  test("reports the largest recent local stall and expires it after a minute", () => {
    let wall = 10_000;
    const clock = { t: 1_000 };
    const { log } = memLog();
    const w = new LoopWatchdog(log, { now: () => clock.t, wallNow: () => wall });
    w.start();
    stops.push(() => w.stop());
    clock.t += 20_250;
    expect(w.stallTotalMs()).toBe(20_000);
    expect(w.recentLag()).toEqual({ max_ms: 20_000, at: 10_000 });
    wall += 60_000;
    expect(w.recentLag()).toBeNull();
  });

  test("track returns what the operation returns and rethrows what it throws", () => {
    const { w } = manual();
    expect(w.track("x", () => 7)).toBe(7);
    expect(() => w.track("y", () => { throw new Error("boom"); })).toThrow("boom");
  });

  test("an injected late tick is caught and named through trackOp without CPU load", () => {
    const { log, lines } = memLog();
    let now = 0;
    const w = startWatchdog(log, { stallMs: 150, intervalMs: 20, now: () => now });
    stops.push(() => stopWatchdog(w));
    trackOp("slow_operation", () => { now += 300; });
    now += 20;
    w.check();
    const stall = lines.find((l) => l.msg === "event_loop_stall");
    expect(stall?.fields).toMatchObject({ op: "slow_operation" });
    expect(Number(stall?.fields?.lag_ms)).toBeGreaterThanOrEqual(150);
    stopWatchdog(w);
    // With no watchdog running, trackOp only runs the operation.
    expect(trackOp("after", () => "ok")).toBe("ok");
  });
});
