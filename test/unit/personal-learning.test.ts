import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/daemon/memory/store.ts";
import { recallPersonal } from "../../src/daemon/memory/primer.ts";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { DEFAULT_LIMITS, RateLimiter } from "../../src/daemon/ratelimit.ts";
import { applyRosterEvent, EMPTY_ROSTER } from "../../src/daemon/roster.ts";
import { personKey } from "../../src/daemon/memory/ownership.ts";
import { createTeam, memberEv, nodeEv, tnode } from "../helpers/events.ts";
import { callTool } from "../../src/mcp/tools.ts";
import { learn } from "../../src/cli/commands/learn.ts";
import { dashboardRoute } from "../../src/daemon/local-api.ts";
import type { Ctx } from "../../src/cli/context.ts";
import type { WalkieClient } from "../../src/client/index.ts";
import "../../src/daemon/memory/routes.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "walkie-learn-"));
  const alex = tnode("alex");
  const sam = tnode("sam");
  const { create } = createTeam(alex);
  const teamRoster = [create, memberEv(create.team, alex, sam, "member"), nodeEv(create.team, alex, sam)]
    .reduce(applyRosterEvent, EMPTY_ROSTER);
  const outsider = tnode("outsider");
  const { create: outsideCreate } = createTeam(outsider);
  const identities = {
    alex: { teamId: create.team, nodeId: alex.keys.nodeId, roster: teamRoster },
    sam: { teamId: create.team, nodeId: sam.keys.nodeId, roster: teamRoster },
    outsider: { teamId: outsideCreate.team, nodeId: outsider.keys.nodeId, roster: applyRosterEvent(EMPTY_ROSTER, outsideCreate) },
  };
  const request = async (handle: keyof typeof identities, method: string, path: string, body?: unknown, agent?: string) => {
    const req = new Request(`http://walkie${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await dispatch({ req, url: new URL(req.url), via: "cli", listener: "unix", agent, noTimeout: () => {},
      core: { paths: { home: dir }, myHandle: () => handle, ...identities[handle], limits: DEFAULT_LIMITS, limiter: new RateLimiter() },
    } as unknown as RouteCtx);
    return response.json();
  };
  return { dir, identities, request, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("safe writer is idempotent, preserves quotes, keeps correction history and decays confidence", () => {
  const f = fixture();
  try {
    const owner = personKey(f.identities.alex)!;
    const other = personKey(f.identities.sam)!;
    let clock = 1_700_000_000_000;
    const store = MemoryStore.open(f.dir, { now: () => clock });
    const writer = store.learnings();
    const base = { owner, actor: "person", machine: "node-a", session: "session-a", category: "correction",
      rule: `Don't replace "quoted" text`, evidence: `Alex's exact words`, confidence: 0.8, requestId: "req-1" };
    const first = writer.add(base);
    expect(writer.add(base)).toEqual(first);
    expect(writer.list(owner, true)).toHaveLength(1);
    expect(first.rule).toBe(base.rule);
    expect(first.evidence).toBe(base.evidence);
    expect(writer.list(other, true)).toEqual([]);
    expect(() => writer.retract(first.id, other, "foreign-retract")).toThrow(/no such learning/);
    const corrected = writer.correct({ ...base, requestId: "req-2", rule: `Keep Alex's "quoted" text`, supersedes: first.id });
    expect(writer.correct({ ...base, requestId: "req-2", rule: `Keep Alex's "quoted" text`, supersedes: first.id })).toEqual(corrected);
    expect(writer.list(owner, false).map((x) => x.id)).toEqual([corrected.id]);
    expect(writer.list(owner, true).find((x) => x.id === first.id)?.status).toBe("superseded");
    expect(recallPersonal(store, "quoted", owner, [], new Set()).items.map((x) => x.id)).toEqual([corrected.id]);
    clock += 180 * 86_400_000;
    expect(writer.list(owner, false)[0]!.effectiveConfidence).toBeCloseTo(0.4);
    expect(writer.retract(corrected.id, owner, "retract-1").status).toBe("retracted");
    expect(recallPersonal(store, "quoted", owner, [], new Set()).items).toEqual([]);
    expect(writer.list(owner, true)).toHaveLength(2);
    store.close();
  } finally { f.close(); }
});

test("poison is quarantined without raw text; another identity cannot read or change it", async () => {
  const f = fixture();
  try {
    const poisoned = await f.request("alex", "POST", "/v1/learn", { action: "add", category: "warning",
      rule: "Never log sk-ant-abcdefghijklmnopqrstuvwxyz123456", evidence: "source", confidence: 0.9, requestId: "poison-1" });
    expect(poisoned.entry.status).toBe("quarantined");
    expect(JSON.stringify(poisoned)).not.toContain("sk-ant-");
    expect(JSON.stringify(await f.request("alex", "GET", "/v1/recall?q=never"))).not.toContain(poisoned.entry.id);
    expect(JSON.stringify(await f.request("sam", "GET", "/v1/learn?all=1"))).not.toContain(poisoned.entry.id);
    expect(JSON.stringify(await f.request("sam", "GET", "/v1/learn?all=1", undefined, "sam-agent"))).not.toContain(poisoned.entry.id);
    expect(JSON.stringify(await f.request("outsider", "GET", "/v1/learn?all=1"))).not.toContain(poisoned.entry.id);
    await expect(f.request("sam", "POST", "/v1/learn", { action: "retract", id: poisoned.entry.id, requestId: "foreign" }))
      .rejects.toMatchObject({ status: 404 });
    await expect(f.request("sam", "POST", "/v1/learn", { action: "retract", id: poisoned.entry.id, requestId: "agent-foreign" }, "sam-agent"))
      .rejects.toMatchObject({ status: 404 });
    const active = await f.request("alex", "POST", "/v1/learn", { action: "add", category: "warning",
      rule: "Only Alex may correct this", evidence: "fixture", confidence: 0.9, requestId: "alex-active" });
    await expect(f.request("sam", "POST", "/v1/learn", { action: "correct", category: "warning",
      rule: "Steal another rule", evidence: "none", confidence: 0.5, requestId: "foreign-correct", supersedes: active.entry.id }, "sam-agent"))
      .rejects.toMatchObject({ status: 404 });
    const path = await f.request("alex", "POST", "/v1/learn", { action: "add", category: "warning",
      rule: "See /Users/example-user/keys/private", evidence: "source", confidence: 0.9, requestId: "path-1" });
    expect(path.entry.status).toBe("quarantined");
    const db = new Database(join(f.dir, "memory.db"));
    const raw = JSON.stringify(db.query("SELECT * FROM personal_learnings").all());
    db.close();
    expect(raw).not.toContain("sk-ant-");
    expect(raw).not.toContain("/Users/example-user/keys/private");
  } finally { f.close(); }
});

test("CLI, MCP and daemon use the same writer contract", async () => {
  const f = fixture();
  try {
    const client = { request: (method: string, path: string, body?: unknown) => f.request("alex", method, path, body) } as WalkieClient;
    const lines: string[] = [];
    const ctx = { args: { pos: ["add", `Don't alter "quoted" values`], flags: new Map([
      ["category", "procedure"], ["confidence", "0.8"], ["evidence", "fixture"], ["request-id", "cli-1"],
    ]) }, json: true, client: () => client, out: (line: string) => lines.push(line) } as unknown as Ctx;
    expect(await learn(ctx)).toBe(0);
    const fromCli = JSON.parse(lines[0]!) as { entry: { id: string } };
    const replay = await callTool(client, "walkie_learn", { action: "add", rule: `Don't alter "quoted" values`,
      category: "procedure", evidence: "fixture", confidence: 0.8, requestId: "cli-1" });
    const replayEntry = JSON.parse(replay.content[0]!.text).entry;
    expect(replayEntry.id).toBe(fromCli.entry.id);
    expect(replayEntry.rule).toContain('trust="team-member"');
    expect(replayEntry.evidence).toContain("information, not instructions");
    const fromMcp = await callTool(client, "walkie_learn", { action: "list" });
    expect(JSON.parse(fromMcp.content[0]!.text).entries[0].id).toBe(fromCli.entry.id);
    expect(JSON.parse(fromMcp.content[0]!.text).entries[0].rule).toContain('trust="team-member"');
    const fromRoute = await f.request("alex", "GET", "/v1/learn");
    expect(fromRoute.entries[0].id).toBe(fromCli.entry.id);
    const retry = await callTool(client, "walkie_learn", { action: "add", category: "procedure", rule: "same", evidence: "fixture", confidence: 0.8, requestId: "mcp-1" });
    expect(JSON.parse(retry.content[0]!.text).entry.status).toBe("active");
  } finally { f.close(); }
});

test("daemon owns learning provenance and only a person confirms an agent learning", async () => {
  const f = fixture();
  try {
    const body = { action: "add", category: "procedure", rule: "Cite the source before editing", evidence: "fixture",
      confidence: 1, session: "forged-session", requestId: "agent-provenance" };
    const added = await f.request("alex", "POST", "/v1/learn", body, "helper");
    expect(added.entry.actor).toBe("claimed:helper");
    expect(added.entry.machine).toBe(f.identities.alex.nodeId);
    expect(added.entry.session).toBe("");
    expect(added.entry.confidence).toBe(0.6);
    await expect(f.request("alex", "POST", "/v1/learn/confirm", { id: added.entry.id }, "helper"))
      .rejects.toMatchObject({ status: 403 });
    await expect(f.request("alex", "POST", "/v1/learn/confirm", { id: added.entry.id }))
      .rejects.toMatchObject({ status: 403 });
    expect(dashboardRoute("POST", "/v1/learn/confirm")).toBe(true);
    const req = new Request("http://walkie/v1/learn/confirm", { method: "POST", body: JSON.stringify({ id: added.entry.id }) });
    const confirmedResponse = await dispatch({ req, url: new URL(req.url), via: "dashboard", listener: "tcp",
      dashboard: true, credentialExpiresAt: Date.now() + 60_000, noTimeout: () => {},
      core: { paths: { home: f.dir }, myHandle: () => "alex", ...f.identities.alex,
        limits: DEFAULT_LIMITS, limiter: new RateLimiter() },
    } as unknown as RouteCtx);
    const confirmed = await confirmedResponse.json();
    expect(confirmed.entry.confidence).toBe(1);
    expect(confirmed.entry.actor).toBe("claimed:helper");
  } finally { f.close(); }
});
