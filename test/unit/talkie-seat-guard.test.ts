import { expect, test } from "bun:test";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { refuseScheduledSeatRun } from "../../src/daemon/seats/routes.ts";
import { playbook } from "../../src/daemon/orchestrator/playbook.ts";
import { schedulePrompt } from "../../src/protocol/talkie-schedule.ts";
import type { Core } from "../../src/daemon/core.ts";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { seatsChannel } from "../../src/protocol/seats.ts";
import { WalkieClient } from "../../src/client/index.ts";
import { ORCHESTRATOR_TOKEN_ENV, ORCHESTRATOR_TOKEN_HEADER } from "../../src/protocol/orchestrator.ts";

test("a scheduled WalkieTalkie turn cannot launch; an interactive turn and another agent can", () => {
  const core = {} as Core;
  let scheduled = true;
  registerHost(core, { scheduledTurnActive: () => scheduled } as unknown as OrchestratorHost);
  expect(() => refuseScheduledSeatRun(core, "orchestrator")).toThrow("scheduled WalkieTalkie turns recommend");
  try { refuseScheduledSeatRun(core, "orchestrator"); } catch (err) {
    expect(err).toMatchObject({ status: 403, code: "scheduled_turn_cannot_launch" });
  }
  expect(() => refuseScheduledSeatRun(core, "other-agent")).not.toThrow();
  scheduled = false;
  expect(() => refuseScheduledSeatRun(core, "orchestrator")).not.toThrow();
});

test("the seat run route rejects a scheduled request and accepts the same interactive request", async () => {
  const node = "0123456789abcdef";
  let scheduled = true;
  let launches = 0;
  const core = { teamId: "team", nodeId: node, hostname: "mac", myHandle: () => "alex",
    me: () => ({ handle: "alex", role: "owner" }),
    roster: { nodes: new Map([[node, { node_id: node, hostname: "mac", login: "alex@example.com", revoked: false }]]),
      members: new Map([["alex@example.com", { handle: "alex", role: "owner" }]]),
      channels: new Map([[seatsChannel(node), { members: ["alex"] }]]) },
    limits: { agentWrite: {} }, limiter: { take: () => true },
    // A machine that takes seats has a live `seats` status; the route refuses one whose seats are off.
    store: { agents: () => [{ node, agent: "seats", ts: Date.now(), body: JSON.stringify({ agent: "seats", state: "idle", runtime: "other", title: "Seats" }) }] },
    emit: () => { launches++; return { id: `${node}:${launches}` }; } } as unknown as Core;
  registerHost(core, { acceptsToken: () => true, scheduledTurnActive: () => scheduled } as unknown as OrchestratorHost);
  const request = (agent = "orchestrator") => {
    const req = new Request("http://localhost/v1/seats/run", { method: "POST",
      body: JSON.stringify({ machine: node, runtime: "codex", prompt: "approved card" }) });
    return dispatch({ core, req, url: new URL(req.url), agent, orchestratorToken: "valid",
      via: "cli", noTimeout: () => {}, sync: { isOnline: () => true } } as unknown as RouteCtx);
  };
  // The dispatcher refuses every write of a scheduled turn (TALKIE-OPS-1); the seat route's own check stays as a second fence.
  await expect(request()).rejects.toMatchObject({ status: 403, code: "scheduled_turn_cannot_act" });
  await expect(request("helper")).rejects.toMatchObject({ status: 403, code: "forbidden" });
  expect(launches).toBe(0);
  scheduled = false;
  expect((await request()).status).toBe(200);
  expect(launches).toBe(1);
});

test("a scheduled child using --agent helper still sends its token and both writes are refused", async () => {
  const prior = process.env[ORCHESTRATOR_TOKEN_ENV];
  process.env[ORCHESTRATOR_TOKEN_ENV] = "test-child-token";
  try {
    const client = new WalkieClient({ agent: "helper" });
    const headers = (client as unknown as { headers(): Record<string, string> }).headers();
    expect(headers["X-Walkie-Agent"]).toBe("helper");
    expect(headers[ORCHESTRATOR_TOKEN_HEADER]).toBe("test-child-token");
    const core = {} as Core;
    registerHost(core, { acceptsToken: (token: string) => token === "test-child-token",
      scheduledTurnActive: () => true } as unknown as OrchestratorHost);
    for (const path of ["/v1/seats/run", "/v1/post"]) {
      const req = new Request(`http://localhost${path}`, { method: "POST", headers,
        body: JSON.stringify(path.endsWith("run") ? { machine: "0123456789abcdef", runtime: "codex", prompt: "task" }
          : { channel: "general", text: "scheduled post" }) });
      await expect(dispatch({ core, req, url: new URL(req.url), agent: "helper", orchestratorToken: headers[ORCHESTRATOR_TOKEN_HEADER],
        via: "cli", noTimeout: () => {} } as unknown as RouteCtx))
        .rejects.toMatchObject({ status: 403, code: "forbidden" });
    }
  } finally {
    if (prior === undefined) delete process.env[ORCHESTRATOR_TOKEN_ENV];
    else process.env[ORCHESTRATOR_TOKEN_ENV] = prior;
  }
});

test("scheduled instructions recommend and forbid launches, including custom schedules", () => {
  expect(schedulePrompt({ prompt: "Check capacity" })).toContain("no seat started or stopped");
  expect(playbook({ owner: "alex", hostname: "test", access: "platform" })).toContain("During scheduled turns, record a recommendation");
});
