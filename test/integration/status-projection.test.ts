// WALKIE-MISSION-1 fix round 2: EVERY writer of agent.status goes through one projection where the daemon signs it.
// Under the default config (nothing shared) this drives each writer with private content and asserts that every
// status the node signed carries only allow-listed fields, only fixed activity phrases, and no private text:
// the Claude hook (every event, incl. notifications), the Codex hook, the MCP server's announcement with a legacy
// cache (a resume / reconnect), walkie_set_status, `walkie status`, a raw local-API client, and discovery.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoContext } from "../../src/agent/identity.ts";
import { claudeProjectSlug } from "../../src/daemon/activity.ts";
import { AgentDiscovery } from "../../src/daemon/discovery.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { runClaudeHook } from "../../src/hooks/claude.ts";
import { runCodexHook } from "../../src/hooks/codex.ts";
import { announce } from "../../src/mcp/server.ts";
import { callTool } from "../../src/mcp/tools.ts";
import { ACTIVITY_PHRASES, PRIVATE_TITLE, STATUS_FIELDS } from "../../src/protocol/status-projection.ts";
import type { BodyOf, Event } from "../../src/protocol/schemas.ts";
import { Cluster, standardTeam, waitFor, type TestNode } from "../helpers/cluster.ts";
import { Fixture, jl, prompt, toolCall } from "../helpers/discovery-world.ts";

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
let c: Cluster;
let kira: TestNode;
let repo: string;
const saved = { home: process.env.WALKIE_HOME, socket: process.env.WALKIE_SOCKET, agent: process.env.WALKIE_AGENT };

/** Text that must never leave the machine under the default config. */
const PRIVATE = ["ExampleCo", "ORION-742", "acquisition", "internal.example", "/private", "psql", "acme_merger", "term sheet", "42M", "SecretCo", "layoffs", "/tmp/walkie-"];
/** Titles a person set explicitly (always allowed) and the placeholder. */
const ALLOWED_TITLES = new Set([PRIVATE_TITLE, "Reviewing PR 12", "Explicit CLI title"]);
/** Explicit keys, and the key of the repo's branch. */
const ALLOWED_TASKS = new Set(["ALE-1234", "ALE-77", "ALE-88"]);

beforeAll(async () => {
  c = new Cluster();
  ({ kira } = await standardTeam(c));
  process.env.WALKIE_HOME = kira.home;
  process.env.WALKIE_SOCKET = kira.socket;
  delete process.env.WALKIE_AGENT;
  repo = join(c.root, "clients", "SecretCo", "layoffs", "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/ALE-1234-work\n");
});
afterAll(async () => {
  for (const [k, v] of Object.entries({ WALKIE_HOME: saved.home, WALKIE_SOCKET: saved.socket, WALKIE_AGENT: saved.agent })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await c.close();
});

function signed(): Array<BodyOf<"agent.status"> & { _agent: string }> {
  return kira.d.core.store.queryEvents({ kinds: ["agent.status"], limit: 5_000 })
    .map((r) => JSON.parse(r.json) as Event)
    .filter((e) => e.origin === kira.d.nodeId)
    .map((e) => ({ ...(e.body as BodyOf<"agent.status">), _agent: e.author.agent ?? "" }));
}
const latest = (agent: string) => signed().filter((b) => b.agent === agent).at(0);

describe("every writer, default config (nothing shared)", () => {
  test("Claude hook: prompt, tool, notifications (classified), stop, end", async () => {
    const session = "c1a0de00-0000-4000-8000-000000000001";
    const env = { CLAUDE_CODE_SESSION_ID: session };
    const hook = (input: Record<string, unknown>) => runClaudeHook(JSON.stringify({ session_id: session, cwd: repo, ...input }), env);
    await hook({ hook_event_name: "SessionStart", source: "startup" });
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "Confidential: acquire ExampleCo ORION-742, draft the term sheet at 42M" });
    await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "psql -h db acme_merger" } });
    await hook({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to Read /private/acquisition/ORION-742.xlsx at https://internal.example/deal" });
    await waitFor(() => latest("cc-c1a0de")?.state === "waiting", { what: "waiting" });
    expect(latest("cc-c1a0de")).toMatchObject({ state: "waiting", activity: "Needs your permission", task: "ALE-1234", repo: "repo", branch: "feat/ALE-1234-work" });
    await hook({ hook_event_name: "Notification", message: "Claude is waiting for your input" }); // no type: classified by text
    await waitFor(() => latest("cc-c1a0de")?.activity === "Waiting for input", { what: "idle prompt" });
    expect(latest("cc-c1a0de")?.state).toBe("idle");
    const before = signed().length;
    await hook({ hook_event_name: "Notification", notification_type: "auth_success", message: "Logged in as someone@ExampleCo" });
    await Bun.sleep(100);
    expect(signed().length).toBe(before); // not a state: no status at all
    await hook({ hook_event_name: "Stop" });
    await hook({ hook_event_name: "SessionEnd" });
    await waitFor(() => latest("cc-c1a0de")?.state === "offline", { what: "offline" });
  });

  test("Codex hook: no prompt title, no reply line", async () => {
    await runCodexHook(JSON.stringify({
      type: "agent-turn-complete", "thread-id": "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0002", cwd: repo,
      "input-messages": ["Draft the ExampleCo term sheet ORION-742"], "last-assistant-message": "Here is the term sheet: 42M",
    }), {});
    await waitFor(() => latest("codex-0199aa"), { what: "codex status" });
    expect(latest("codex-0199aa")).toMatchObject({ title: PRIVATE_TITLE, activity: "Finished turn", task: "ALE-1234" });
  });

  test("MCP announcement on resume / reconnect with a LEGACY cache (a prompt title and key, no provenance)", async () => {
    const agent = "legacy-cache"; // not seat-*: that prefix is reserved for remote seats (PROTOCOL §11)
    mkdirSync(join(kira.home, "agents"), { recursive: true });
    writeFileSync(join(kira.home, "agents", `${agent}.json`), JSON.stringify({ title: "Confidential acquisition of ExampleCo", task: "ORION-742", started_at: 1, injected: [] }));
    await announce(kira.client(agent), agent, repo);
    await waitFor(() => latest(agent), { what: "announce" });
    const s = latest(agent);
    expect(s).toMatchObject({ state: "idle", activity: "Connected to Walkie", task: "ALE-1234" });
    expect(s?.title).toBeUndefined();
    // Even an older MCP binary that sends the cached title and task with no provenance at all: dropped at signing.
    await kira.client(agent).status({ agent, state: "idle", runtime: "claude-code", title: "Confidential acquisition of ExampleCo", task: "ORION-742", activity: "Connected to Walkie" });
    await Bun.sleep(50);
    expect(JSON.stringify(latest(agent))).not.toContain("ExampleCo");
  });

  test("walkie_set_status and `walkie status` (explicit) keep their title and key", async () => {
    process.env.WALKIE_AGENT = "cc-settitle";
    try {
      const client = kira.client("cc-settitle");
      const r = await callTool(client, "walkie_set_status", { title: "Reviewing PR 12", task: "ALE-77" }) as { isError?: boolean };
      expect(r.isError).toBeFalsy();
    } finally {
      delete process.env.WALKIE_AGENT;
    }
    await waitFor(() => latest("cc-settitle"), { what: "set_status" });
    expect(latest("cc-settitle")).toMatchObject({ title: "Reviewing PR 12", task: "ALE-77" });
    const p = Bun.spawn([process.execPath, CLI, "status", "Explicit", "CLI", "title", "--task", "ALE-88", "--agent", "cli-x"], {
      env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: kira.home, WALKIE_SOCKET: kira.socket }, stdout: "pipe", stderr: "pipe",
    });
    expect(await p.exited).toBe(0);
    await waitFor(() => latest("cli-x"), { what: "cli status" });
    expect(latest("cli-x")).toMatchObject({ title: "Explicit CLI title", task: "ALE-88" });
  });

  test("a raw local-API client with no provenance: title, task, activity text and cwd dropped", async () => {
    await kira.client("raw-1").status({
      agent: "raw-1", state: "working", runtime: "cli", title: "Raw ExampleCo title", task: "ORION-742",
      activity: "$ psql acme_merger", cwd: "~/clients/SecretCo/layoffs", repo: "/Users/x/clients/SecretCo/layoffs/repo",
    });
    await waitFor(() => latest("raw-1"), { what: "raw" });
    expect(latest("raw-1")).toMatchObject({ state: "working", activity: "Working", repo: "repo" });
    expect(latest("raw-1")?.title).toBeUndefined();
    expect(latest("raw-1")?.task).toBeUndefined();
    expect(latest("raw-1")?.cwd).toBeUndefined();
  });

  test("discovery: a seat's private prompt and command", async () => {
    const cfg = join(c.root, "seat-claude");
    const sid = "5ea70000-0000-4000-8000-000000000003";
    mkdirSync(join(cfg, "projects", claudeProjectSlug(repo)), { recursive: true });
    const transcript = join(cfg, "projects", claudeProjectSlug(repo), `${sid}.jsonl`);
    writeFileSync(transcript, jl(prompt("Confidential: ExampleCo ORION-742 layoffs list"), toolCall("Bash", { command: "psql acme_merger" })));
    utimesSync(transcript, new Date(), new Date());
    const fx = new Fixture();
    fx.procs.push({ pid: 1, ppid: 0, uid: 0, startedAt: 1, command: "/sbin/launchd" }, { pid: 700, ppid: 1, uid: 4242, startedAt: Date.now() - 5_000, command: "claude -p go", cpuMs: 1 });
    fx.env.set(700, { CLAUDE_CONFIG_DIR: cfg });
    fx.sessions.set(`${cfg}\n700`, { sessionId: sid });
    fx.cwds.set(700, repo);
    const d = new AgentDiscovery(kira.d.core, createLogger({}), { provider: fx, uid: 4242, home: kira.home, nonAgentDirs: [] });
    await d.tick();
    expect(latest("cc-5ea700")).toMatchObject({ state: "working", activity: "Running a command", task: "ALE-1234", repo: "repo" });
  });

  test("EVERY status this node signed: allow-listed fields only, fixed phrases, no private text", () => {
    const all = signed();
    expect(all.length).toBeGreaterThanOrEqual(10); // one or more per writer (bursts coalesce)
    for (const b of all) {
      const fields = Object.keys(b).filter((k) => k !== "_agent");
      for (const f of fields) expect(STATUS_FIELDS.has(f) && f !== "cwd").toBe(true);
      if (b.activity !== undefined) expect(ACTIVITY_PHRASES.has(b.activity)).toBe(true);
      if (b.title !== undefined) expect(ALLOWED_TITLES.has(b.title)).toBe(true);
      if (b.task !== undefined) expect(ALLOWED_TASKS.has(b.task)).toBe(true);
      const text = JSON.stringify(b);
      for (const p of PRIVATE) if (text.includes(p)) throw new Error(`"${p}" in a signed status: ${text}`);
    }
    expect(repoContext(repo).branch).toBe("feat/ALE-1234-work");
  });
});
