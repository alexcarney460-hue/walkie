// WALK-74 (ASYNC-PERMS-1): a message queued for WalkieTalkie is authorised again when its turn comes. A person made an
// observer while their message waited gets it refused (observers can't run an orchestrator), never sent to Claude; a
// duty's turn refused there gets the plain reason as its run's result instead of a 10-minute timeout. The control: the
// same queued message from a person who is still a member goes on to be sent.
import { expect, test } from "bun:test";
import { OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";

type Origin = { via: "dashboard" | "cli" | "schedule" };
const pump = (OrchestratorHost.prototype as unknown as { pump: (this: unknown) => void }).pump;

function host(role: "member" | "observer", via: Origin["via"]) {
  const states: Array<[string, string]> = [];
  const logs: Array<Record<string, unknown>> = [];
  const replies = new Map<string, { text: string; ok: boolean }>();
  let spawned = 0;
  const fake = {
    leadership: { valid: true }, stopping: false, closed: false, gaveUp: false,
    state: { active: true, owner: "kira", sessions: {}, access: "platform" }, turn: null, phase: "idle", maxAge: 600_000,
    queue: [{ id: "om_1", text: "please do it", thread: "om_1", ts: Date.now(), origin: { via } }],
    core: { me: () => ({ handle: "kira", login: "kira@example.com", role }) },
    log: { info: (_key: string, fields: Record<string, unknown>) => { logs.push(fields); } },
    setState: (id: string, state: string) => { states.push([id, state]); },
    scheduleReplies: replies,
    toollessUnavailable: () => false,
    child: null,
    // Past the authorisation loop, a still-authorised message needs a Claude: the fake records that one was asked for.
    spawn: () => { spawned++; },
  };
  return { fake, states, logs, replies, spawned: () => spawned };
}

test("a person made an observer while their message waited: refused when its turn comes, never handed to Claude", () => {
  const h = host("observer", "dashboard");
  pump.call(h.fake);
  expect(h.states).toEqual([["om_1", "refused"]]);
  expect(h.logs).toEqual([{ id: "om_1", reason: "observer" }]);
  expect(h.fake.queue).toHaveLength(0);
  expect(h.spawned()).toBe(0);
});

test("a duty's turn refused at its turn: the run's result is the plain reason, not a timeout", () => {
  const h = host("observer", "schedule");
  pump.call(h.fake);
  expect(h.replies.get("om_1")).toEqual({ text: "Not run: WalkieTalkie's person is now an observer, and observers can't run WalkieTalkie", ok: false });
  expect(h.spawned()).toBe(0);
});

test("control: a person who is still a member gets the queued message sent on (a Claude is started for it)", () => {
  const h = host("member", "dashboard");
  pump.call(h.fake);
  expect(h.states).toEqual([]);
  expect(h.replies.size).toBe(0);
  expect(h.spawned()).toBe(1);
});
