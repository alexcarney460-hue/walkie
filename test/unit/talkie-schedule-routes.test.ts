import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import "../../src/daemon/orchestrator/schedule-routes.ts";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { registerHost } from "../../src/daemon/orchestrator/host.ts";
import { dashboardRoute } from "../../src/daemon/local-api.ts";
import { SeatApi } from "../../src/daemon/seats/seat-api.ts";
import { readAudit } from "../../src/daemon/admin/audit.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { addMachineLink } from "../../src/protocol/add-machine.ts";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Core } from "../../src/daemon/core.ts";
import { PeerCallError } from "../../src/daemon/peer-client.ts";
import type { OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";

function harness() {
  const calls: unknown[] = [];
  const posts: { text: string; channel?: string; agent?: string }[] = [];
  const client = { addrOf: (_node: unknown): unknown => ({ ip: "127.0.0.1", port: 9000 }),
    scheduleManage: async (_addr: unknown, request: unknown) => { calls.push(["forward", request]);
      return { schedule: { id: "11111111-1111-4111-8111-111111111111" } }; } };
  const core = { teamId: "team", hostname: "authority", nodeId: "owner-node", authority: "owner-node",
    authorityLeaseTerm: 0, keys: { sign: () => "x".repeat(80) },
    isAuthority: () => true,
    me: () => ({ handle: "alex", role: "owner" }), myHandle: () => "alex",
    emit: (_kind: string, body: { text: string }, opts: { channel?: string; agent?: string }) => {
      posts.push({ ...body, ...opts }); return {};
    } } as unknown as Core;
  registerHost(core, { acceptsToken: () => true, schedules: {
    list: () => [], acknowledgeLegacyOverflow: () => ({ cleared: 2 }), unresolvedPage: (after?: string, limit?: number) => ({ total: 1,
      entries: [{ id: "11111111-1111-4111-8111-111111111111", name: "Job", run: "22222222-2222-4222-8222-222222222222" }],
      next_cursor: after && limit ? after : null }), ensureChannel: async () => true,
    manage: (request: { op: string; id?: string; input?: unknown; handle: string }) => {
      if (request.op === "add") { calls.push(["add", request.input, request.handle]); return { schedule: { id: "new" } }; }
      if (request.op === "edit") { calls.push(["edit", request.id, request.input]); return { schedule: { id: request.id } }; }
      if (request.op === "remove") { calls.push(["remove", request.id]); return { removed: true }; }
      calls.push(["reset", request.id]); return { schedule: { id: request.id } };
    },
    add: (body: unknown, by: string) => { calls.push(["add", body, by]); return { id: "new" }; },
    edit: (id: string, body: unknown) => { calls.push(["edit", id, body]); return { id }; },
    runNow: (id: string) => { calls.push(["run", id]); return "run-id"; },
    reset: (id: string) => {
      core.emit("msg.post", { text: `[admin] reset WalkieTalkie schedule ${id}` },
        { channel: "general", agent: "walkie-admin" });
      calls.push(["reset", id]);
      return { id };
    },
  } } as unknown as OrchestratorHost);
  const request = (method: string, path: string, body?: unknown, agent?: string,
    origin: { via?: RouteCtx["via"]; listener?: RouteCtx["listener"]; dashboard?: boolean; underAgent?: boolean } = {}) => {
    const req = new Request(`http://localhost${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    return dispatch({ core, client, req, url: new URL(req.url), agent, via: origin.via ?? "cli",
      listener: origin.listener ?? "unix", dashboard: origin.dashboard, underAgent: origin.underAgent,
      noTimeout: () => {}, orchestratorToken: agent === "orchestrator" ? "valid" : undefined } as unknown as RouteCtx);
  };
  return { calls, posts, request, core, client };
}

describe("schedule routes", () => {
  test("a person's join link survives ordinary redaction while other secrets are scrubbed", async () => {
    const h = harness();
    Object.assign(h.core, { roster: { channels: new Map([["general", { name: "general" }]]) },
      visible: () => true, config: { redact: true }, limits: { humanWrite: {} }, limiter: { take: () => true } });
    const link = addMachineLink(`wk1${randomBytes(120).toString("base64url")}`, null);
    const otherSecret = `sk-ant-test-${"A".repeat(36)}`;
    expect((await h.request("POST", "/v1/post", { channel: "general", text: `${link} ${otherSecret}` })).status).toBe(200);
    expect(h.posts[0]?.text).toContain(link);
    expect(h.posts[0]?.text).not.toContain(otherSecret);
  });
  test("a scheduled turn cannot post the fleet summary to #general, due or not", async () => {
    const h = harness();
    let decision: { turn: string; fingerprint: string; due: boolean } | null = { turn: "turn-1", fingerprint: "f".repeat(64), due: false };
    const recorded: string[] = [];
    registerHost(h.core, { acceptsToken: () => true,
      capacitySummaryForCurrentTurn: () => decision,
      recordCapacitySummaryPost: () => { recorded.push("posted"); } } as unknown as OrchestratorHost);
    Object.assign(h.core, { roster: { channels: new Map([["general", { name: "general" }]]) },
      visible: () => true, config: { redact: false }, limits: { agentWrite: {}, humanWrite: {} },
      limiter: { take: () => true }, store: { transaction: (fn: () => void) => fn() } });
    const body = { channel: "general", text: "Fleet capacity changed" };
    await expect(h.request("POST", "/v1/post", body, "orchestrator"))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
    const req = new Request("http://localhost/v1/post", { method: "POST", body: JSON.stringify(body) });
    await expect(dispatch({ core: h.core, req, url: new URL(req.url), agent: "helper", orchestratorToken: "valid",
      via: "cli", noTimeout: () => {} } as unknown as RouteCtx))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
    decision = { turn: "turn-1", fingerprint: "f".repeat(64), due: true };
    await expect(h.request("POST", "/v1/post", body, "orchestrator"))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(recorded).toEqual([]);
    expect(h.posts).toEqual([]);
    // No fleet-summary decision on this turn: an ordinary post is not the summary and is not recorded as one.
    decision = null;
    expect((await h.request("POST", "/v1/post", body, "orchestrator")).status).toBe(200);
    expect(recorded).toEqual([]);
    expect(h.posts).toHaveLength(1);
  });
  test("an orchestrator post of a due fleet summary to #general is refused and not recorded", async () => {
    const h = harness();
    const recorded: string[] = [];
    registerHost(h.core, { acceptsToken: () => true,
      capacitySummaryForCurrentTurn: () => ({ turn: "turn-1", fingerprint: "f".repeat(64), due: true }),
      recordCapacitySummaryPost: () => { recorded.push("posted"); } } as unknown as OrchestratorHost);
    Object.assign(h.core, { roster: { channels: new Map([["general", { name: "general" }]]) },
      visible: () => true, config: { redact: false }, limits: { agentWrite: {}, humanWrite: {} },
      limiter: { take: () => true }, store: { transaction: (fn: () => void) => fn() } });
    const body = { channel: "general", text: "WalkieTalkie fleet capacity: mac-a 2 free" };
    await expect(h.request("POST", "/v1/post", body, "orchestrator")).rejects.toMatchObject({ status: 403 });
    expect(recorded).toEqual([]);
    expect(h.posts).toEqual([]);
  });
  test("the post route refuses an agent's bare invite, one-click link and install command before emission", async () => {
    const h = harness();
    const code = `wk1${"Ab_-".repeat(40)}`;
    for (const text of [code, addMachineLink(code, null), `walkie join ${code}`]) {
      await expect(h.request("POST", "/v1/post", { channel: "general", text }, "orchestrator"))
        .rejects.toMatchObject({ status: 403, code: "join_credential_private_reply_only" });
      await expect(h.request("POST", "/v1/post", { channel: "general", text }, undefined, { underAgent: true }))
        .rejects.toMatchObject({ status: 403, code: "join_credential_private_reply_only" });
    }
    expect(h.posts).toEqual([]);
  });
  test("unresolved paging is available only to local owners with bounded arguments", async () => {
    const h = harness();
    const path = "/v1/orchestrator/schedules/unresolved?limit=1";
    const owner = await h.request("GET", path);
    expect(owner.status).toBe(200);
    expect((await owner.json() as { entries: unknown[] }).entries).toHaveLength(1);
    (h.core as unknown as { me: () => unknown }).me = () => ({ handle: "alex", role: "member" });
    await expect(h.request("GET", path)).rejects.toMatchObject({ status: 403 });
    (h.core as unknown as { me: () => unknown }).me = () => ({ handle: "alex", role: "owner" });
    await expect(h.request("GET", "/v1/orchestrator/schedules/unresolved?limit=101"))
      .rejects.toMatchObject({ status: 400 });
    await expect(h.request("GET", path, undefined, undefined, { via: "phone" }))
      .rejects.toMatchObject({ status: 403 });
  });
  test("acknowledging the legacy overflow is for a local owner, never a phone, the orchestrator, or a member", async () => {
    const h = harness();
    const path = "/v1/orchestrator/schedules/unresolved/ack-legacy";
    const owner = await h.request("POST", path, {});
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({ cleared: 2 });
    await expect(h.request("POST", path, {}, undefined, { via: "phone" })).rejects.toMatchObject({ status: 403 });
    await expect(h.request("POST", path, {}, "orchestrator")).rejects.toMatchObject({ status: 403 });
    (h.core as unknown as { me: () => unknown }).me = () => ({ handle: "alex", role: "member" });
    await expect(h.request("POST", path, {})).rejects.toMatchObject({ status: 403 });
    expect(dashboardRoute("POST", path)).toBe(false);
  });
  test("a local agent acknowledges the legacy overflow while agent admin is on (audited, no #general post) and is refused while it is off", async () => {
    const h = harness();
    const dir = mkdtempSync("/tmp/walkie-schedule-ack-agent-");
    const config = join(dir, "config.json");
    Object.assign(h.core, { hostname: "authority", paths: { home: dir, config },
      roster: { channels: new Map([["general", {}]]) }, log: { info: () => {}, warn: () => {} } });
    const path = "/v1/orchestrator/schedules/unresolved/ack-legacy";
    try {
      const allowed = await h.request("POST", path, {}, "helper");
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual({ cleared: 2 });
      expect(h.posts).toEqual([]); // #general exists, so a post would have been emitted had the route asked for one
      expect(readAudit(dir)).toEqual([expect.objectContaining({ actor: "@alex/authority/helper", via: "local",
        action: "acknowledged older WalkieTalkie schedule completion outcomes" })]);
      writeFileSync(config, JSON.stringify({ agent_admin: false }));
      await expect(h.request("POST", path, {}, "helper")).rejects.toMatchObject({ status: 403, code: "agent_admin_off" });
      expect(readAudit(dir)[0]).toMatchObject({ refused: "agent_admin_off" }); // newest first
      expect(h.posts).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("ordinary posts refuse the private channel and both reserved prefixes for agents and phones", async () => {
    const h = harness();
    for (const origin of [{ via: "cli" as const, agent: "orchestrator" },
      { via: "phone" as const, agent: undefined }, { via: "cli" as const, agent: undefined }]) {
      for (const body of [
        { channel: SCHEDULE_CHANNEL, text: "hello" },
        { channel: "general", text: "walkie-talkie-schedule:v1:{}" },
        { channel: "general", text: "walkie-talkie-claim:v1:{}" },
      ]) {
        await expect(h.request("POST", "/v1/post", body, origin.agent, { via: origin.via }))
          .rejects.toMatchObject({ status: 403, code: "forbidden" });
      }
    }
    expect(h.posts).toEqual([]);
  });
  test("POST /v1/channels refuses the reserved #talkie-schedules name from an owner and from a member", async () => {
    for (const role of ["owner", "member"]) {
      const h = harness();
      (h.core as unknown as { me: () => unknown }).me = () => ({ handle: "alex", role });
      await expect(h.request("POST", "/v1/channels", { name: SCHEDULE_CHANNEL, topic: "squat" }))
        .rejects.toMatchObject({ status: 409, code: "conflict" });
      expect(h.posts).toEqual([]);
    }
  });
  test("list, add, edit and run-now reach the schedule manager", async () => {
    const h = harness();
    expect((await h.request("GET", "/v1/orchestrator/schedules")).status).toBe(200);
    expect((await h.request("POST", "/v1/orchestrator/schedules", { name: "Check", cron: "*/5 * * * *", task: { template: "capacity-check" } })).status).toBe(201);
    expect((await h.request("PATCH", "/v1/orchestrator/schedules/11111111-1111-4111-8111-111111111111", { enabled: false })).status).toBe(200);
    expect((await h.request("POST", "/v1/orchestrator/schedules/11111111-1111-4111-8111-111111111111/run-now")).status).toBe(200);
    expect(h.calls.map((c) => (c as string[])[0])).toEqual(["add", "edit", "run"]);
  });
  test("a co-owner pause forwards identity and audit id; an offline authority gives 503", async () => {
    const h = harness();
    Object.assign(h.core, { isAuthority: () => false, authority: "authority-node",
      roster: { nodes: new Map([["authority-node", { hostname: "lead-laptop" }]]) } });
    const path = "/v1/orchestrator/schedules/11111111-1111-4111-8111-111111111111";
    expect((await h.request("PATCH", path, { enabled: false })).status).toBe(200);
    const forwarded = (h.calls[0] as [string, { op: string; handle: string; audit_id: string; input: unknown }])[1];
    expect(forwarded).toMatchObject({ op: "edit", requester: "owner-node", body: { input: { enabled: false } } });
    expect(forwarded.audit_id).toMatch(/^[0-9a-f-]{36}$/);
    h.client.addrOf = () => null;
    await expect(h.request("PATCH", path, { enabled: false })).rejects.toMatchObject({ status: 503,
      message: expect.stringContaining("lead-laptop") });
    (h.core as unknown as { me: () => unknown }).me = () => ({ handle: "alex", role: "member" });
    await expect(h.request("PATCH", path, { enabled: false })).rejects.toMatchObject({ status: 403 });
    expect(h.calls).toHaveLength(1);
  });
  test("a 404 from the authority asks for its Walkie update", async () => {
    const h = harness();
    Object.assign(h.core, { isAuthority: () => false, authority: "authority-node",
      roster: { nodes: new Map([["authority-node", { hostname: "lead-laptop" }]]) } });
    h.client.scheduleManage = async () => { throw new PeerCallError(404, "not_found", "not found"); };
    await expect(h.request("PATCH", "/v1/orchestrator/schedules/11111111-1111-4111-8111-111111111111",
      { enabled: false })).rejects.toMatchObject({ status: 409, code: "authority_outdated",
      message: expect.stringContaining("lead-laptop runs an older Walkie; update it") });
  });
  test("a co-owner reset is refused locally before any forwarding", async () => {
    const h = harness();
    Object.assign(h.core, { isAuthority: () => false, authority: "authority-node",
      roster: { nodes: new Map([["authority-node", { hostname: "lead-laptop" }]]) } });
    await expect(h.request("POST", "/v1/orchestrator/schedules/11111111-1111-4111-8111-111111111111/reset",
      { confirm: "11111111-1111-4111-8111-111111111111" })).rejects.toMatchObject({ status: 403 });
    expect(h.calls).toHaveLength(0);
  });
  test("WalkieTalkie's restricted caller may run but cannot edit schedules", async () => {
    const h = harness();
    await expect(h.request("PATCH", "/v1/orchestrator/schedules/11111111-1111-4111-8111-111111111111", { enabled: false }, "orchestrator")).rejects.toThrow("cannot edit schedules");
    expect((await h.request("POST", "/v1/orchestrator/schedules/11111111-1111-4111-8111-111111111111/run-now", undefined, "orchestrator")).status).toBe(200);
  });
  test("reset route refuses an agent before any reset or audit", async () => {
    const h = harness();
    await expect(h.request("POST", "/v1/orchestrator/schedules/11111111-1111-4111-8111-111111111111/reset",
      { confirm: "11111111-1111-4111-8111-111111111111" }, "orchestrator")).rejects.toMatchObject({ code: "person_only" });
    await expect(h.request("POST", "/v1/orchestrator/schedules/11111111-1111-4111-8111-111111111111/reset",
      { confirm: "11111111-1111-4111-8111-111111111111" }, undefined, { underAgent: true }))
      .rejects.toMatchObject({ code: "person_only" });
    expect(h.calls).toEqual([]);
  });
  test("reset refuses phone and durable-token loopback callers, while dashboard sessions can reach it", async () => {
    const h = harness();
    const path = "/v1/orchestrator/schedules/11111111-1111-4111-8111-111111111111/reset";
    expect(dashboardRoute("POST", path)).toBe(true);
    for (const origin of [{ via: "phone" as const }, { via: "cli" as const, listener: "tcp" as const }]) {
      await expect(h.request("POST", path, { confirm: "11111111-1111-4111-8111-111111111111" }, undefined, origin))
        .rejects.toMatchObject({ code: "forbidden" });
    }
    expect(h.calls).toEqual([]);
  });
  test("the separate restricted seat socket refuses reset even with a valid seat credential", async () => {
    const dir = mkdtempSync("/tmp/walkie-schedule-seat-socket-");
    const socket = join(dir, "seat.sock");
    const api = new SeatApi(socket, { postAsSeat: () => { throw new Error("unexpected post"); } },
      { warn: () => {} } as never);
    try {
      api.start();
      const credential = api.issue("seat-1");
      const response = await fetch("http://walkie/v1/orchestrator/schedules/11111111-1111-4111-8111-111111111111/reset", {
        method: "POST", unix: socket, headers: { Authorization: `Bearer ${credential}` },
        body: JSON.stringify({ confirm: "11111111-1111-4111-8111-111111111111" }),
      } as RequestInit);
      expect(response.status).toBe(403);
    } finally { api.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
  test("a person reset reaches the manager and writes a local audit entry", async () => {
    const h = harness();
    const dir = mkdtempSync("/tmp/walkie-schedule-audit-");
    Object.assign(h.core, { hostname: "authority", paths: { home: dir },
      roster: { channels: new Map([["general", {}]]) }, log: { info: () => {}, warn: () => {} } });
    try {
      await expect(h.request("POST", "/v1/orchestrator/schedules/11111111-1111-4111-8111-111111111111/reset",
        { confirm: "wrong" })).rejects.toThrow();
      await expect(h.request("POST", "/v1/orchestrator/schedules/11111111-1111-4111-8111-111111111111/reset",
        { confirm: "reset" })).rejects.toThrow();
      expect(h.calls).toEqual([]);
      const response = await h.request("POST", "/v1/orchestrator/schedules/11111111-1111-4111-8111-111111111111/reset",
        { confirm: "11111111-1111-4111-8111-111111111111" });
      expect(response.status).toBe(200);
      expect(h.calls).toEqual([["reset", "11111111-1111-4111-8111-111111111111"]]);
      expect(h.posts).toEqual([]);
      const dashboard = await h.request("POST", "/v1/orchestrator/schedules/11111111-1111-4111-8111-111111111111/reset",
        { confirm: "11111111-1111-4111-8111-111111111111" }, undefined,
        { via: "dashboard", listener: "tcp", dashboard: true });
      expect(dashboard.status).toBe(200);
      expect(h.calls).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
