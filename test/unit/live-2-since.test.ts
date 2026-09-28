// WALKIE-LIVE-2: the daemon's roster says when each agent's state and activity line began (time-in-state on the cards).
import { afterEach, expect, test } from "bun:test";
import type { SyncManager } from "../../src/daemon/sync.ts";
import { agentsPayload } from "../../src/daemon/views.ts";
import { AGENT, hook, world } from "../helpers/discovery-world.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
const online = { isOnline: () => true } as unknown as SyncManager;
const mine = (w: ReturnType<typeof world>) => agentsPayload(w.core, online, {}, w.clock.t).agents.find((a) => a.agent === AGENT)!;

test("GET /v1/agents: activity_since stays while the line does (a re-post), moves when it changes; state_since per state", () => {
  const w = world(cleanups);
  const t0 = w.clock.t;
  hook(w.core, "working", "Running a command");
  const first = mine(w);
  expect(first.activity_since).toBe(first.updated_at);
  expect(first.state_since).toBe(first.updated_at);
  w.clock.t += 5 * 60_000;
  hook(w.core, "working", "Running a command", AGENT, { title: "same line, new title" }); // a newer status, same line
  const again = mine(w);
  expect(again.updated_at).toBeGreaterThan(first.updated_at);
  expect(again.activity_since).toBe(first.activity_since);
  w.clock.t += 60_000;
  hook(w.core, "working", "Editing files");
  const next = mine(w);
  expect(next.activity_since).toBe(next.updated_at);
  expect(next.state_since).toBe(first.state_since);
  expect(first.activity_since).toBeGreaterThanOrEqual(t0 - 1_000);
});
