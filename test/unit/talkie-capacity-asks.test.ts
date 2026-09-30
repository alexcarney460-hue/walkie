import { expect, test } from "bun:test";
import { capacityAskState, eligibleCapacityTargets, latestCapacityChecks } from "../../src/daemon/orchestrator/capacity-asks.ts";
import type { Core } from "../../src/daemon/core.ts";

const TARGET = "@alex/lab-host/project-orchestrator";
const now = 9_000_000;
const ask = { id: "a:1", ts: now - 60_000, kind: "ask", author: { agent: "orchestrator" }, body: { to: TARGET, text: "Can you use a seat?" } };

function coreFor(answer?: { declined?: boolean }, to = TARGET) {
  const rows = [{ json: JSON.stringify({ ...ask, body: { ...ask.body, to } }) }];
  return {
    store: {
      queryEvents: () => rows,
      replies: () => answer ? [{ json: JSON.stringify({ id: "b:1", ts: now - 30_000, kind: "answer", body: { ask: ask.id, text: "no", ...answer } }) }] : [],
    },
  } as unknown as Core;
}

test("persisted asks record denial and suppress another capacity turn for two hours", () => {
  const core = coreFor({ declined: true });
  expect(capacityAskState(core, [TARGET], now)).toEqual([{ target: TARGET, lastAsked: ask.ts, answer: "denied" }]);
  expect(eligibleCapacityTargets(core, [TARGET], now)).toEqual([]);
  expect(eligibleCapacityTargets(core, [TARGET], now + 2 * 3_600_000)).toEqual([TARGET]);
});

test("an unanswered ask also cools down the orchestrator", () => {
  const core = coreFor();
  expect(capacityAskState(core, [TARGET], now)).toEqual([{ target: TARGET, lastAsked: ask.ts, answer: "unanswered" }]);
  expect(eligibleCapacityTargets(core, [TARGET], now)).toEqual([]);
});

test("a broad person address cools down that person's orchestrator targets", () => {
  const core = coreFor(undefined, "@alex");
  expect(eligibleCapacityTargets(core, [TARGET], now)).toEqual([]);
});

test("a persisted check cools down a target even when no ask exists", () => {
  const core = { store: { queryEvents: () => [] } } as unknown as Core;
  expect(eligibleCapacityTargets(core, [TARGET], now, { [TARGET]: now - 60_000 })).toEqual([]);
  expect(eligibleCapacityTargets(core, [TARGET], now + 2 * 3_600_000, { [TARGET]: now })).toEqual([TARGET]);
});

test("the latest checked time wins across capacity schedules", () => {
  const schedules = [{ capacity_checked_at: { [TARGET]: now - 1_000 } },
    { capacity_checked_at: { [TARGET]: now - 60_000 } }];
  expect(latestCapacityChecks(schedules)[TARGET]).toBe(now - 1_000);
});
