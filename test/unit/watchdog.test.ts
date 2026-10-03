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

/** A watchdog on hand-driven clocks (the monotonic one and the wall clock advance together): `busy(ms)` is an operation that holds the loop that long. */
function manual(stallMs = 500, intervalMs = 250) {
  const clock = { t: 1_000, wall: 1_700_000_000_000 };
  const { log, lines } = memLog();
  const w = new LoopWatchdog(log, { stallMs, intervalMs, now: () => clock.t, wallNow: () => clock.wall });
  w.start();
  stops.push(() => w.stop());
  const busy = (ms: number) => { clock.t += ms; clock.wall += ms; };
  const tick = () => { busy(intervalMs); w.check(); };
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
    const { w, clock, busy } = manual();
    busy(20_250);
    expect(w.stallTotalMs()).toBe(20_000);
    expect(w.recentLag()).toEqual({ max_ms: 20_000, at: clock.wall });
    // A minute of healthy ticks (the clocks advance together, each tick on time): the stall is no longer recent.
    for (let i = 0; i < 240; i++) { busy(250); w.check(); }
    expect(w.recentLag()).toBeNull();
  });

  test("a sleep the monotonic clock does not see (a laptop's lid) discounts presence but is no lagging daemon", () => {
    const { w, clock, lines, busy } = manual();
    busy(250);
    expect(w.stallTotalMs()).toBe(0);
    clock.wall += 600_000; // ten minutes asleep: the monotonic clock stood still
    expect(w.stallTotalMs()).toBe(600_000); // peers' last contact is discounted by it…
    expect(w.recentLag()).toBeNull(); // …but the dashboard is not told the daemon lagged
    expect(lines.map((l) => [l.level, l.msg, l.fields])).toEqual([["info", "sleep_resume", { slept_ms: 600_000 }]]);
    // Counted once: the next healthy tick adds nothing.
    busy(250);
    expect(w.stallTotalMs()).toBe(600_000);
  });

  test("a real stall is still a stall, and counts once when the wall clock agrees with the monotonic one", () => {
    const { w, lines, busy } = manual();
    busy(3_250);
    expect(w.stallTotalMs()).toBe(3_000);
    expect(lines.map((l) => l.msg)).toEqual(["event_loop_stall"]);
    expect(w.recentLag()?.max_ms).toBe(3_000);
  });

  test("a wall clock set back and then forward again is not a sleep", () => {
    const { w, clock, lines, busy } = manual();
    busy(250);
    clock.wall -= 300_000; // stepped back five minutes (a clock correction)
    busy(250);
    w.check();
    expect(w.stallTotalMs()).toBe(0);
    busy(250);
    clock.wall += 300_000; // …and the correction forward again
    expect(w.stallTotalMs()).toBe(0);
    expect(w.recentLag()).toBeNull();
    expect(lines).toEqual([]);
    // What a later real sleep adds beyond what was credited still counts.
    clock.wall += 120_000;
    expect(w.stallTotalMs()).toBe(120_000);
  });

  test("a wall clock set forward with nothing credited reads as a sleep; a step back lapses after ten minutes", () => {
    const { w, clock, busy } = manual();
    busy(250);
    clock.wall += 90_000;
    expect(w.stallTotalMs()).toBe(90_000);
    clock.wall -= 200_000; // stepped back…
    busy(250);
    w.check();
    for (let i = 0; i < 2_400; i++) { busy(250); w.check(); } // …ten minutes pass…
    busy(250);
    clock.wall += 200_000; // …and a forward jump the credit no longer covers
    expect(w.stallTotalMs()).toBe(90_000 + 200_000);
  });

  test("a step back of under a second is credited against the next step forward", () => {
    const { w, clock, lines } = manual();
    // Older than the ten-minute credit lifetime, clocks agreeing. The 0.9 s loss still has to be credited on the
    // following tick, after that lifetime has already run out.
    for (let i = 0; i < 2_440; i++) { clock.t += 250; clock.wall += 250; w.check(); }
    const wall0 = clock.wall;
    for (let n = 0; n < 90; n++) { // 90 pairs: 45 s on the monotonic clock
      clock.t += 250; clock.wall += 250 - 900; w.check(); // back 0.9 s
      clock.t += 250; clock.wall += 250 + 1_100; w.check(); // forward 1.1 s
    }
    // Each pair gains a net 0.2 s, under the 0.5 s stall line, so none of it is sleep. The discount must not grow.
    expect(w.stallTotalMs()).toBe(0);
    expect(lines.filter((l) => l.msg === "sleep_resume")).toEqual([]);
    expect(clock.wall - wall0).toBe(90 * 700); // the presence clock did move; a zero discount ages a peer on it
    // The credit from the last pair was spent. A real sleep after the pattern still counts in full.
    clock.t += 250;
    clock.wall += 250 + 60_000;
    expect(w.stallTotalMs()).toBe(60_000);
    expect(lines).toEqual([{ level: "info", msg: "sleep_resume", fields: { slept_ms: 60_000 } }]);
  });

  test("a backward step of exactly one second is credited against the next forward step", () => {
    const { w, clock } = manual();
    clock.t += 250;
    clock.wall += 250 - 1_000; // exactly the old threshold, which used to credit nothing
    w.check();
    clock.t += 250;
    clock.wall += 250 + 1_600;
    expect(w.stallTotalMs()).toBe(600); // 1.6 s gained, 1 s credited
  });

  test("losses of under a second cannot credit more than an hour", () => {
    const { w, clock } = manual();
    for (let i = 0; i < 5_000; i++) { clock.t += 250; clock.wall += 250 - 900; w.check(); } // 4_500 s of losses
    clock.t += 250;
    clock.wall += 250 + 7_200_000; // two hours forward: the hour cap still bounds the credit
    expect(w.stallTotalMs()).toBe(7_200_000 - 3_600_000);
  });

  test("one-millisecond residuals do not keep a backward step alive past ten minutes", () => {
    const { w, clock, busy } = manual();
    busy(250);
    clock.wall -= 200_000;
    busy(250);
    w.check();
    // An integer wall clock against a fractional monotonic clock leaves about a millisecond. That must not renew the credit.
    for (let i = 0; i < 2_400; i++) {
      clock.t += 250;
      clock.wall += 250 + (i % 2 === 0 ? -1 : 1);
      w.check();
    }
    busy(250); // crosses the ten minutes; both clocks move, so this tick itself is not a residual
    clock.wall += 200_000;
    expect(w.stallTotalMs()).toBe(200_000);
  });

  test("a one-millisecond loss every other tick does not eat a later sleep", () => {
    const { w, clock } = manual();
    // Long enough that renewed credit would survive the ten-minute lapse. Gains of 1 ms must spend what the losses added.
    for (let i = 0; i < 4_000; i++) {
      clock.t += 250;
      clock.wall += 250 + (i % 2 === 0 ? -1 : 1);
      w.check();
    }
    clock.t += 250;
    clock.wall += 250 + 60_000;
    expect(w.stallTotalMs()).toBe(60_000);
    // A gain of exactly one second is still not a sleep.
    clock.t += 250;
    clock.wall += 250 + 1_000;
    expect(w.stallTotalMs()).toBe(60_000);
  });

  test("track returns what the operation returns and rethrows what it throws", () => {
    const { w } = manual();
    expect(w.track("x", () => 7)).toBe(7);
    expect(() => w.track("y", () => { throw new Error("boom"); })).toThrow("boom");
  });

  test("an injected late tick is caught and named through trackOp without CPU load", () => {
    const { log, lines } = memLog();
    let now = 0;
    const w = startWatchdog(log, { stallMs: 150, intervalMs: 20, now: () => now, wallNow: () => 1_700_000_000_000 + now });
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
