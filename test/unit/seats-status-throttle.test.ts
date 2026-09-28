import { expect, test } from "bun:test";
import type { BodyOf, Event } from "../../src/protocol/schemas.ts";
import { SeatStatusThrottle } from "../../src/daemon/seats/status-throttle.ts";
import { StatusCoalescer } from "../../src/daemon/status-coalesce.ts";
import { ACTIVITY_PHRASES } from "../../src/protocol/activity-phrases.ts";

const body = (state: "idle" | "working" | "offline" = "working", activity = "thinking"): BodyOf<"agent.status"> => ({
  agent: "seat-test", parent: "seats", state, runtime: "claude-code", activity,
});

function setup() {
  let now = 1_000_000;
  const emitted: Array<{ agent: string; body: BodyOf<"agent.status"> }> = [];
  const throttle = new SeatStatusThrottle((agent, value) => {
    emitted.push({ agent, body: value });
    return {} as Event;
  }, () => now);
  return { throttle, emitted, advance: (ms: number) => { now += ms; } };
}

test("unchanged seat refreshes are suppressed and a five-minute heartbeat is kept", () => {
  const { throttle, emitted, advance } = setup();
  throttle.submit("seat-test", body("idle"));
  advance(15_000);
  expect(throttle.submit("seat-test", body("idle"))).toBeNull();
  advance(285_000);
  throttle.submit("seat-test", body("idle"));
  expect(emitted).toHaveLength(2);
});

test("changed activity for one seat is coalesced within ten seconds to the latest body", () => {
  const { throttle, emitted, advance } = setup();
  throttle.submit("seat-test", body("working", "one"));
  throttle.submit("seat-test", body("working", "two"));
  throttle.submit("seat-test", body("working", "three"));
  expect(emitted).toHaveLength(1);
  advance(10_000);
  throttle.flush();
  expect(emitted.map((item) => item.body.activity)).toEqual(["one", "three"]);
});

test("a failed deferred emit is logged and later updates including offline still flow", () => {
  let now = 1_000_000;
  let attempts = 0;
  const emitted: string[] = [];
  const errors: unknown[] = [];
  const throttle = new SeatStatusThrottle((_agent, value) => {
    if (++attempts === 2) throw new Error("store unavailable");
    emitted.push(value.activity ?? value.state);
    return {} as Event;
  }, () => now, (error) => errors.push(error));
  throttle.submit("seat-test", body("working", "first"));
  throttle.submit("seat-test", body("working", "failed"));
  now += 10_000;
  expect(() => throttle.flush()).not.toThrow();
  expect(errors).toHaveLength(1);
  throttle.submit("seat-test", body("working", "later"));
  now += 10_000;
  throttle.flush();
  throttle.submit("seat-test", body("offline"));
  expect(emitted).toEqual(["first", "later", "thinking"]);
});

test("a state transition is emitted immediately inside the ten-second activity window", () => {
  const { throttle, emitted, advance } = setup();
  throttle.submit("seat-test", body("idle"));
  advance(1_000);
  throttle.submit("seat-test", body("working", "tool use"));
  expect(emitted.map((item) => item.body.state)).toEqual(["idle", "working"]);
});

test("seat statuses share a 30-per-minute host bucket and retain latest body per seat", () => {
  const { throttle, emitted, advance } = setup();
  for (let i = 0; i < 31; i++) throttle.submit(`seat-${i}`, { ...body(), agent: `seat-${i}` });
  expect(emitted).toHaveLength(30);
  advance(60_000);
  throttle.flush();
  expect(emitted).toHaveLength(31);
  expect(emitted[30]?.agent).toBe("seat-30");
});

test("offline status bypasses both seat spacing and the shared bucket", () => {
  const { throttle, emitted } = setup();
  for (let i = 0; i < 30; i++) throttle.submit(`seat-${i}`, { ...body(), agent: `seat-${i}` });
  expect(throttle.submit("seat-offline", { ...body("offline"), agent: "seat-offline" })).toBeTruthy();
  expect(emitted).toHaveLength(31);
  expect(emitted.at(-1)?.body.state).toBe("offline");
});

test("stopping a throttle discards held updates and ignores late submissions", () => {
  const { throttle, emitted, advance } = setup();
  throttle.submit("seat-test", body("working", "first"));
  throttle.submit("seat-test", body("working", "held"));
  throttle.stop();
  advance(60_000);
  throttle.flush();
  expect(throttle.submit("seat-test", body("offline"))).toBeNull();
  expect(emitted.map((item) => item.body.activity)).toEqual(["first"]);
});

test("final offline cancels a queued working status and emits synchronously", () => {
  const emitted: Array<{ agent: string; body: BodyOf<"agent.status"> }> = [];
  let attempts = 0;
  const coalescer = new StatusCoalescer({ tryEmit: (agent, value) => {
    if (attempts++ === 0) return null;
    emitted.push({ agent, body: value });
    return {} as Event;
  } });
  coalescer.submit("seat-test", body("working", "queued"));
  coalescer.submitFinal("seat-test", body("offline"));
  expect(emitted.map((item) => item.body.state)).toEqual(["offline"]);
  coalescer.stop();
});

test("seat activity phrases remain shareable fixed phrases", () => {
  for (const phrase of ["Seat running", "Seat paused", "Seat finished"]) expect(ACTIVITY_PHRASES.has(phrase)).toBe(true);
});
