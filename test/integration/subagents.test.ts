// WALKIE-MISSION-SUB-1 end to end: Claude Code hook calls for one session and its sub-agents against real daemons.
// 1 session + 3 sub-agents = 4 working rows, on this machine (titles shown to its owner) and on a teammate's
// (titles private by default); the session row counts them; they end on SubagentStop and move to the archive.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runClaudeHook } from "../../src/hooks/claude.ts";
import { OFFLINE_GRACE_MS, shownByDefault } from "../../src/protocol/agent-roster.ts";
import { MAX_SUBAGENTS_PER_PARENT } from "../../src/protocol/subagents.ts";
import { agentsPayload } from "../../src/daemon/views.ts";
import type { AgentView } from "../../src/protocol/schemas.ts";
import { Cluster, standardTeam, waitFor, type TestNode } from "../helpers/cluster.ts";

let c: Cluster;
let alex: TestNode, kira: TestNode;
const SESSION = "5ab5e551-0000-4000-8000-000000000000";
const PARENT = "cc-5ab5e5";
const SUBS = [
  { id: "a1a1a1a1b2b2b2b2c", description: "Audit the ExampleCo invoices", type: "general-purpose" },
  { id: "b2b2b2b2c3c3c3c3d", description: "Map the billing flow", type: "Explore" },
  { id: "c3c3c3c3d4d4d4d4e", description: "Draft the rollout plan", type: "Plan" },
];
const name = (id: string) => `${PARENT}.${id.slice(0, 12)}`;
const saved = { home: process.env.WALKIE_HOME, socket: process.env.WALKIE_SOCKET };

beforeAll(async () => {
  c = new Cluster();
  ({ alex, kira } = await standardTeam(c));
  process.env.WALKIE_HOME = kira.home; // the hooks run on kira's machine, like a real session
  process.env.WALKIE_SOCKET = kira.socket;
});
afterAll(async () => {
  process.env.WALKIE_HOME = saved.home;
  process.env.WALKIE_SOCKET = saved.socket;
  await c.close();
});

const hook = (input: Record<string, unknown>) => runClaudeHook(JSON.stringify({ session_id: SESSION, cwd: "/tmp", ...input }), { CLAUDE_CODE_SESSION_ID: SESSION });
const rows = async (n: TestNode) => (await n.client().agents()).agents.filter((a) => a.agent === PARENT || a.agent.startsWith(`${PARENT}.`));
const byName = (list: AgentView[], agent: string) => list.find((a) => a.agent === agent) as AgentView;

describe("a session and its sub-agents", () => {
  test("1 session + 3 sub-agents show as 4 working rows, sub-agents as children of the session", async () => {
    await hook({ hook_event_name: "SessionStart", source: "startup" });
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "Fan out the invoice audit" });
    for (const s of SUBS) {
      const tu = `toolu_${s.id}`;
      await hook({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: tu, tool_input: { description: s.description, subagent_type: s.type, prompt: "…" } });
      await hook({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: tu, tool_input: { description: s.description, subagent_type: s.type }, tool_response: { isAsync: true, status: "async_launched", agentId: s.id, description: s.description } });
      await hook({ hook_event_name: "SubagentStart", agent_id: s.id, agent_type: s.type });
      await hook({ hook_event_name: "PostToolUse", agent_id: s.id, agent_type: s.type, tool_name: "Read", tool_input: { file_path: "/tmp/ledger.csv" } });
    }
    const local = await waitFor(async () => {
      const r = await rows(kira);
      return r.length === 4 && r.every((a) => a.effective_state === "working") && byName(r, PARENT).subagents?.working === 3 ? r : null;
    }, { what: "4 working rows on kira" });
    const parent = byName(local, PARENT);
    expect(parent.subagents).toEqual({ working: 3, live: 3 });
    for (const s of SUBS) {
      const sub = byName(local, name(s.id));
      expect(sub.status).toMatchObject({ parent: PARENT, subagent_type: s.type, state: "working", runtime: "claude-code", ask_policy: "off", activity: "Reading files" });
      // The owner's own dashboard shows the description even though the team doesn't get it (share_prompts off).
      expect(sub.status.title).toBe(s.description);
    }
  });

  test("a teammate sees the same 4 working rows, without the private descriptions", async () => {
    const seen = await waitFor(async () => {
      const r = await rows(alex);
      return r.length === 4 && r.every((a) => a.effective_state === "working") ? r : null;
    }, { what: "4 working rows on alex" });
    expect(byName(seen, PARENT).subagents).toEqual({ working: 3, live: 3 });
    for (const s of SUBS) {
      const sub = byName(seen, name(s.id));
      expect(sub.status).toMatchObject({ parent: PARENT, subagent_type: s.type });
      expect(sub.status.title).toBeUndefined();
    }
    expect(JSON.stringify(seen)).not.toMatch(/ExampleCo|billing flow|rollout plan|ledger/);
  });

  test("the session's turn ends while its sub-agents work: it stays shown with them", async () => {
    await hook({ hook_event_name: "Stop", background_tasks: SUBS.map((s) => ({ id: s.id, type: "subagent", status: "running", description: s.description, agent_type: s.type })) });
    const r = await waitFor(async () => {
      const list = await rows(kira);
      return byName(list, PARENT)?.effective_state === "idle" ? list : null;
    }, { what: "session idle" });
    expect(r.filter((a) => a.effective_state === "working").length).toBe(3);
    expect(shownByDefault(byName(r, PARENT))).toBe(true);
  });

  test("SubagentStop ends each one; ended sub-agents move to the archive by the existing rules", async () => {
    for (const s of SUBS) await hook({ hook_event_name: "SubagentStop", agent_id: s.id, agent_type: s.type, last_assistant_message: "done" });
    const r = await waitFor(async () => {
      const list = await rows(kira);
      return SUBS.every((s) => byName(list, name(s.id))?.effective_state === "offline") ? list : null;
    }, { what: "sub-agents ended" });
    expect(SUBS.map((s) => byName(r, name(s.id)).status.activity)).toEqual(["Sub-agent finished", "Sub-agent finished", "Sub-agent finished"]);
    expect(byName(r, PARENT).subagents).toEqual({ working: 0, live: 3 });
    expect(shownByDefault(byName(r, PARENT))).toBe(false);
    const later = agentsPayload(kira.d.core, kira.d.sync, { scope: "all" }, Date.now() + OFFLINE_GRACE_MS + 1_000);
    for (const s of SUBS) expect(later.agents.find((a) => a.agent === name(s.id))?.archived).toBe(true);
  });

  test("the daemon refuses a sub-agent not named under its parent, and more than the per-session cap", async () => {
    const parent = "cc-ca9ca9";
    await expect(kira.client("cc-other.abcdef01").status({ agent: "cc-other.abcdef01", parent, state: "working", runtime: "claude-code" })).rejects.toThrow(/named/);
    for (let i = 0; i < MAX_SUBAGENTS_PER_PARENT; i++) {
      const agent = `${parent}.${String(i).padStart(8, "0")}`;
      await kira.client(agent).status({ agent, parent, state: "working", runtime: "claude-code" });
      await waitFor(() => kira.d.core.store.agent(kira.d.nodeId, agent), { what: `sub ${i} stored`, timeoutMs: 15_000 });
    }
    const extra = `${parent}.ffffffff`;
    await expect(kira.client(extra).status({ agent: extra, parent, state: "working", runtime: "claude-code" })).rejects.toThrow(/live sub-agents/);
    // One that is already shown keeps reporting.
    const first = `${parent}.00000000`;
    await kira.client(first).status({ agent: first, parent, state: "working", runtime: "claude-code", activity: "Reading files" });
  }, 60_000);

  test("a burst from many sub-agents of one session is rate-limited together (coalesced, not lost)", async () => {
    const parent = "cc-b0b5b0";
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => {
      const agent = `${parent}.${String(i).padStart(8, "0")}`;
      return kira.client(agent).status({ agent, parent, state: "working", runtime: "claude-code" }) as Promise<{ event: unknown; coalesced?: boolean }>;
    }));
    expect(results.filter((r) => r.coalesced).length).toBeGreaterThan(0);
    // The held ones are emitted as the shared bucket refills: all ten end up shown.
    await waitFor(async () => (await kira.client().agents()).agents.filter((a) => a.status.parent === parent).length === 10, { what: "all ten emitted", timeoutMs: 15_000 });
  }, 30_000);

  test("Codex r1 #2: a burst of 40 starts under one session (most of them queued) never shows more than the cap", async () => {
    const parent = "cc-f10000";
    const results = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => {
      const agent = `${parent}.${String(i).padStart(12, "0")}`;
      return kira.client(agent).status({ agent, parent, state: "working", runtime: "claude-code" });
    }));
    expect(results.filter((r) => r.status === "rejected").length).toBeGreaterThan(0);
    await Bun.sleep(4_000); // every held status drained (shared bucket 3/s)
    const live = (await kira.client().agents()).agents.filter((a) => a.status.parent === parent && a.effective_state === "working");
    expect(live.length).toBe(MAX_SUBAGENTS_PER_PARENT);
  }, 30_000);

  test("Codex r1 #1 HIGH: share_activity on, share_prompts off: no launch description in any field a teammate gets", async () => {
    const cfg = join(kira.home, "config.json");
    const saved = readFileSync(cfg, "utf8");
    writeFileSync(cfg, JSON.stringify({ ...(JSON.parse(saved) as object), share_activity: true }));
    try {
      const sid = "5ec0e700-0000-4000-8000-000000000000";
      const env = { CLAUDE_CODE_SESSION_ID: sid };
      const h = (input: Record<string, unknown>) => runClaudeHook(JSON.stringify({ session_id: sid, cwd: "/tmp", ...input }), env);
      const desc = "Acquire ExampleCo before earnings";
      await h({ hook_event_name: "UserPromptSubmit", prompt: "Plan the ExampleCo deal" });
      await h({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "toolu_h1", tool_input: { description: desc, subagent_type: "exampleco-deal-desk" } });
      await h({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_use_id: "toolu_h1", tool_input: { description: desc, subagent_type: "exampleco-deal-desk" }, tool_response: { isAsync: true, agentId: "5ec5ec5ec5ec0001", description: desc } });
      await h({ hook_event_name: "SubagentStart", agent_id: "5ec5ec5ec5ec0001", agent_type: "exampleco-deal-desk" });
      await h({ hook_event_name: "PostToolUse", agent_id: "5ec5ec5ec5ec0001", agent_type: "exampleco-deal-desk", tool_name: "Read", tool_input: { file_path: "/tmp/term-sheet.md" } });
      const sub = "cc-5ec0e7.5ec5ec5ec5ec";
      const seen = await waitFor(async () => {
        const list = (await alex.client().agents()).agents.filter((a) => a.agent === "cc-5ec0e7" || a.agent === sub);
        return list.length === 2 && list.find((a) => a.agent === sub)?.status.activity === "Read term-sheet.md" ? list : null;
      }, { what: "both rows on alex" });
      // Every field of both rows, and every status event alex holds for them.
      const events = (await alex.client().events({ kinds: "agent.status", limit: 500 })).events.filter((e) => e.author.agent === "cc-5ec0e7" || e.author.agent === sub);
      expect(events.length).toBeGreaterThan(2);
      const wire = JSON.stringify({ seen, events });
      expect(wire).not.toMatch(/ExampleCo|Acquire|earnings|deal-desk|Plan the/);
      expect(seen.find((a) => a.agent === sub)?.status.subagent_type).toBe("custom");
      // The owner's machine still shows the description.
      const own = (await kira.client().agents()).agents.find((a) => a.agent === sub);
      expect(own?.status.title).toBe(desc);
    } finally {
      writeFileSync(cfg, saved);
    }
  });

  test("Codex r2 #2: idle children count toward the cap too", async () => {
    const parent = "cc-1d1e00";
    const results: string[] = [];
    for (let i = 0; i < MAX_SUBAGENTS_PER_PARENT + 4; i++) {
      const agent = `${parent}.${String(i).padStart(12, "0")}`;
      try {
        await kira.client(agent).status({ agent, parent, state: "idle", runtime: "claude-code", session: `${String(i).padStart(12, "0")}ffff` });
        await waitFor(() => kira.d.core.store.agent(kira.d.nodeId, agent), { what: `idle ${i} stored`, timeoutMs: 15_000 });
        results.push("ok");
      } catch (err) {
        results.push((err as Error).message.includes("live sub-agents") ? "capped" : `error ${(err as Error).message}`);
      }
    }
    expect(results.filter((r) => r === "ok").length).toBe(MAX_SUBAGENTS_PER_PARENT);
    expect(results.filter((r) => r === "capped").length).toBe(4);
  }, 60_000);

  test("Codex r2 #1: a live sub-agent row belongs to its sub-agent: another id can't update or stop it", async () => {
    const parent = "cc-0e0e00";
    const agent = `${parent}.aaaaaaaaaaaa`;
    await kira.client(agent).status({ agent, parent, state: "working", runtime: "claude-code", session: "aaaaaaaaaaaa1111" });
    await waitFor(() => kira.d.core.store.agent(kira.d.nodeId, agent), { what: "row stored" });
    await expect(kira.client(agent).status({ agent, parent, state: "offline", runtime: "claude-code", session: "aaaaaaaaaaaa2222" })).rejects.toThrow(/belongs to another sub-agent/);
    const row = kira.d.core.store.agent(kira.d.nodeId, agent);
    expect(JSON.parse(row?.body ?? "{}")).toMatchObject({ state: "working", session: "aaaaaaaaaaaa1111" });
    // Its own sub-agent may.
    await kira.client(agent).status({ agent, parent, state: "offline", runtime: "claude-code", session: "aaaaaaaaaaaa1111" });
  });
});

