import { expect, test } from "bun:test";
import { DELIVERY_TTL_MS, MAX_DELIVERIES, RecentDeliveries } from "../../src/daemon/hook-dedupe.ts";
import { hookDeliveryKey, parseHookDelivery, type HookDelivery } from "../../src/protocol/hook-delivery.ts";

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("the first delivery is applied and a repeat inside the window is dropped", () => {
  const c = clock();
  const seen = new RecentDeliveries(1_000, 10, c.now);
  expect(seen.firstSeen("a")).toBe(true);
  expect(seen.firstSeen("a")).toBe(false);
  expect(seen.firstSeen("b")).toBe(true);
  expect(seen.firstSeen("b")).toBe(false);
});

test("a delivery is forgotten after its window, and a repeat does not extend the window", () => {
  const c = clock();
  const seen = new RecentDeliveries(1_000, 10, c.now);
  expect(seen.firstSeen("a")).toBe(true);
  c.advance(600);
  expect(seen.firstSeen("a")).toBe(false);
  c.advance(500); // 1100 ms after the first sighting, 500 ms after the repeat
  expect(seen.firstSeen("a")).toBe(true);
});

test("at most `max` deliveries are kept, the oldest first, however many distinct ones arrive", () => {
  const c = clock();
  const seen = new RecentDeliveries(1_000_000, 3, c.now);
  for (let i = 0; i < 1_000; i++) {
    seen.firstSeen(`k${i}`);
    c.advance(1);
    expect(seen.size).toBeLessThanOrEqual(3);
  }
  expect(seen.size).toBe(3);
  expect(seen.firstSeen("k999")).toBe(false); // the newest are kept
  expect(seen.firstSeen("k0")).toBe(true); // the oldest are long gone
});

test("the daemon's cap is 4096: exactly that many are kept, and the 4097th evicts the oldest", () => {
  expect(MAX_DELIVERIES).toBe(4_096);
  const c = clock();
  const seen = new RecentDeliveries(undefined, undefined, c.now); // the defaults, as the daemon builds it
  for (let i = 0; i < 4_096; i++) {
    expect(seen.firstSeen(`k${i}`)).toBe(true);
    c.advance(1);
  }
  expect(seen.size).toBe(4_096);
  // Nothing is lost yet, the oldest included.
  expect(seen.firstSeen("k0")).toBe(false);
  expect(seen.firstSeen("k4095")).toBe(false);
  // One more: the size stays, and it is the oldest that goes.
  expect(seen.firstSeen("k4096")).toBe(true);
  expect(seen.size).toBe(4_096);
  expect(seen.firstSeen("k1")).toBe(false); // the second oldest is kept ...
  expect(seen.firstSeen("k4096")).toBe(false); // ... and so is the newest
  expect(seen.firstSeen("k0")).toBe(true); // the oldest was evicted, long before its window ended
  expect(seen.size).toBe(4_096);
});

test("expired deliveries are swept as new ones arrive, so a burst leaves nothing behind", () => {
  const c = clock();
  const seen = new RecentDeliveries(1_000, 10_000, c.now);
  for (let i = 0; i < 500; i++) seen.firstSeen(`k${i}`);
  expect(seen.size).toBe(500);
  c.advance(1_001);
  expect(seen.firstSeen("fresh")).toBe(true);
  expect(seen.size).toBe(1);
});

test("the defaults outlast two hooks of one event and stay small", () => {
  expect(DELIVERY_TTL_MS).toBeGreaterThanOrEqual(30_000); // a hook's own timeout is 5 s
  expect(MAX_DELIVERIES).toBeLessThanOrEqual(10_000);
  const seen = new RecentDeliveries();
  expect(seen.firstSeen("a")).toBe(true);
  expect(seen.firstSeen("a")).toBe(false);
});

const delivery: HookDelivery = { session: "abc123-4567", event: "PostToolUse", at: "2026-10-01T00:00:01Z", call: "t1", turn: "p1" };

test("a delivery identity is parsed strictly: unknown fields are dropped and anything malformed is no identity", () => {
  expect(parseHookDelivery(delivery)).toEqual(delivery);
  expect(parseHookDelivery({ ...delivery, extra: 1 })).toEqual(delivery);
  const bare = { session: "abc123-4567", event: "Stop", at: "2026-10-01T00:00:02Z" };
  expect(parseHookDelivery(bare)).toEqual(bare);
  const typed = { session: "abc123-4567", event: "Notification", at: "2026-10-01T00:00:03Z", kind: "idle_prompt" };
  expect(parseHookDelivery(typed)).toEqual(typed);
  expect(parseHookDelivery({ ...typed, kind: "k".repeat(80) })).toEqual({ ...typed, kind: "k".repeat(80) }); // as long as a notification type may be
  for (const bad of [undefined, null, "x", 7, [], {}, { ...delivery, session: "" }, { ...delivery, at: "x".repeat(65) }, { ...delivery, call: 5 }, { ...delivery, event: "e".repeat(41) }, { ...typed, kind: "" }, { ...typed, kind: "k".repeat(81) }, { ...typed, kind: 3 }]) {
    expect(parseHookDelivery(bad)).toBeUndefined();
  }
});

test("two deliveries are the same event only when agent, session, event, time, call, turn and kind all match", () => {
  const key = hookDeliveryKey("grok-abc123", delivery);
  expect(hookDeliveryKey("grok-abc123", { ...delivery })).toBe(key);
  expect(hookDeliveryKey("grok-def456", delivery)).not.toBe(key);
  for (const other of [{ session: "def456-7890" }, { event: "PostToolUseFailure" }, { at: "2026-10-01T00:00:02Z" }, { call: "t2" }, { call: undefined }, { turn: "p2" }, { turn: undefined }, { kind: "idle_prompt" }]) {
    expect(hookDeliveryKey("grok-abc123", { ...delivery, ...other })).not.toBe(key);
  }
  // Two notifications of one session in one second differ by their type alone (no call, no turn).
  const note: HookDelivery = { session: "abc123-4567", event: "Notification", at: "2026-10-01T00:00:05Z", kind: "permission_prompt" };
  const noteKey = hookDeliveryKey("grok-abc123", note);
  expect(hookDeliveryKey("grok-abc123", { ...note })).toBe(noteKey);
  expect(hookDeliveryKey("grok-abc123", { ...note, kind: "idle_prompt" })).not.toBe(noteKey);
  expect(hookDeliveryKey("grok-abc123", { ...note, kind: undefined })).not.toBe(noteKey);
});
