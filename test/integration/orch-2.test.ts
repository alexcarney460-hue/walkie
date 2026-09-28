// ORCH-2: the orchestrator's access, end to end through a real daemon and the fake claude (its launches are logged):
// `platform` (default) and `full` both give Claude the Walkie tools (--allowedTools); `full` is bypassPermissions; the
// dashboard's Start dialog may choose the access (and nothing else); an agent may too, audited (AGENT-ADMIN-1); the
// choice is persisted in orchestrator.json.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OrchestratorView } from "../../src/protocol/orchestrator.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

const FAKE_DIR = join(import.meta.dir, "..", "fixtures", "fake-claude");
let c: Cluster;
let alex: TestNode;
let launches: string;

const url = (n: TestNode, p: string) => `http://127.0.0.1:${n.d.localPort as number}${p}`;
async function session(n: TestNode): Promise<Record<string, string>> {
  const { nonce } = await n.client().authNonce();
  const res = await fetch(url(n, `/auth?nonce=${nonce}`), { redirect: "manual" });
  const value = /#s=([0-9a-f]{64})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
  if (!value) throw new Error("no dashboard session");
  return { "X-Walkie-Session": value, Origin: `http://127.0.0.1:${n.d.localPort as number}`, Accept: "application/json", "Content-Type": "application/json" };
}
async function dashStart(h: Record<string, string>, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url(alex, "/v1/orchestrator/start"), { method: "POST", headers: h, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
/** The argv of the newest launch of the fake claude. */
function lastArgv(): string[] {
  const lines = existsSync(launches) ? readFileSync(launches, "utf8").trim().split("\n") : [];
  for (const l of lines.reverse()) {
    const o = JSON.parse(l) as { argv?: string[] };
    if (o.argv && o.argv.includes("-p")) return o.argv;
  }
  return [];
}
const valueOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
async function launchedAfter(n: number): Promise<string[]> {
  await waitFor(async () => countLaunches() > n, { what: "a new claude launch" });
  await waitFor(async () => (await alex.client("").orchestrator()).local.state === "idle", { what: "orchestrator idle" });
  return lastArgv();
}
function countLaunches(): number {
  if (!existsSync(launches)) return 0;
  return readFileSync(launches, "utf8").trim().split("\n").filter((l) => (JSON.parse(l) as { argv?: string[] }).argv?.includes("-p")).length;
}

beforeAll(async () => {
  c = new Cluster();
  const state = join(c.root, "fake-state");
  mkdirSync(state, { recursive: true });
  launches = join(c.root, "fake-launches.jsonl");
  const orchestrator = {
    autoCheckMs: 500, restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 50,
    env: { ...process.env, PATH: `${FAKE_DIR}:${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: launches },
  };
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", orchestrator });
  await alex.client().init("acme", "alex");
}, 60_000);

afterAll(async () => { await c.close(); });

describe("ORCH-2 access", () => {
  test("the dashboard starts it with the default access: platform, Walkie tools allowed, default permissions", async () => {
    const h = await session(alex);
    const n = countLaunches();
    const r = await dashStart(h, {});
    expect(r.status).toBe(200);
    const v = r.body as unknown as OrchestratorView;
    expect(v.local.access).toBe("platform");
    expect(v.local.permission_mode).toBe("default");
    const argv = await launchedAfter(n);
    expect(argv).toContain("--allowedTools=mcp__walkie");
    expect(valueOf(argv, "--permission-mode")).toBe("default");
    expect(valueOf(argv, "--append-system-prompt")).toContain("MISSION: interact with the project orchestrators");
    // Codex RC MEDIUM 5: the walkie MCP server comes with the launch (this daemon's home and socket).
    const mcp = argv.find((x) => x.startsWith("--mcp-config="));
    const cfg = JSON.parse((mcp ?? "").slice("--mcp-config=".length)) as { mcpServers: { walkie: { args: string[]; env: Record<string, string> } } };
    expect(cfg.mcpServers.walkie.args.at(-1)).toBe("mcp");
    expect(cfg.mcpServers.walkie.env).toEqual({ WALKIE_HOME: alex.home, WALKIE_SOCKET: alex.socket });
  }, 30_000);

  test("Codex RC MEDIUM 4: the dashboard switches the access (header control; allow-listed route)", async () => {
    const h = await session(alex);
    const n = countLaunches();
    const res = await fetch(url(alex, "/v1/orchestrator/access"), { method: "POST", headers: h, body: JSON.stringify({ access: "full" }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as OrchestratorView).local).toMatchObject({ access: "full", permission_mode: "bypassPermissions" });
    expect(valueOf(await launchedAfter(n), "--permission-mode")).toBe("bypassPermissions");
    const m = countLaunches();
    const back = await fetch(url(alex, "/v1/orchestrator/access"), { method: "POST", headers: h, body: JSON.stringify({ access: "platform" }) });
    expect(((await back.json()) as OrchestratorView).local).toMatchObject({ access: "platform", permission_mode: "default" });
    expect(valueOf(await launchedAfter(m), "--permission-mode")).toBe("default");
    expect((await fetch(url(alex, "/v1/orchestrator/access"), { method: "POST", headers: h, body: JSON.stringify({ access: "root" }) })).status).toBe(400);
  }, 30_000);

  test("the dashboard's Start dialog chooses full access: bypassPermissions, Walkie tools still listed, persisted", async () => {
    const h = await session(alex);
    const n = countLaunches();
    const r = await dashStart(h, { access: "full" });
    expect(r.status).toBe(200);
    const v = r.body as unknown as OrchestratorView;
    expect(v.local.access).toBe("full");
    expect(v.local.permission_mode).toBe("bypassPermissions");
    const argv = await launchedAfter(n);
    expect(valueOf(argv, "--permission-mode")).toBe("bypassPermissions");
    expect(argv).toContain("--allowedTools=mcp__walkie");
    expect(valueOf(argv, "--append-system-prompt")).toContain("You run with full access to this machine");
    const saved = JSON.parse(readFileSync(join(alex.home, "orchestrator.json"), "utf8")) as { access: string; permission_mode: string };
    expect(saved).toMatchObject({ access: "full", permission_mode: "bypassPermissions" });
  }, 30_000);

  test("the dashboard still names nothing but access and model, and a bad access is refused", async () => {
    const h = await session(alex);
    for (const extra of [{ access: "full", cwd: "/" }, { access: "platform", permission_mode: "bypassPermissions" }, { access: "full", claude: "/bin/sh" }]) {
      const r = await dashStart(h, extra);
      expect({ extra, status: r.status }).toEqual({ extra, status: 403 });
    }
    expect((await dashStart(h, { access: "root" })).status).toBe(400);
    expect((await alex.client("").orchestrator()).local.access).toBe("full"); // unchanged
  }, 30_000);

  test("the CLI: platform keeps the permission mode it names; full overrides it", async () => {
    const person = alex.client("");
    let n = countLaunches();
    const p = await person.orchestratorStart({ cwd: c.root, access: "platform", permission_mode: "acceptEdits" });
    expect(p.local).toMatchObject({ access: "platform", permission_mode: "acceptEdits" });
    let argv = await launchedAfter(n);
    expect(valueOf(argv, "--permission-mode")).toBe("acceptEdits");
    expect(argv).toContain("--allowedTools=mcp__walkie");
    n = countLaunches();
    const f = await person.orchestratorStart({ cwd: c.root, access: "full", permission_mode: "default" });
    expect(f.local).toMatchObject({ access: "full", permission_mode: "bypassPermissions" });
    argv = await launchedAfter(n);
    expect(valueOf(argv, "--permission-mode")).toBe("bypassPermissions");
  }, 30_000);

  test("an agent may set the access while agent admin is on (AGENT-ADMIN-1), audited with the access", async () => {
    const n = countLaunches();
    const v = await alex.client("cc-agent1").orchestratorStart({ access: "platform" });
    expect(v.local.access).toBe("platform");
    await launchedAfter(n);
    const audit = readFileSync(join(alex.home, "admin-audit.jsonl"), "utf8");
    expect(audit).toContain("started the orchestrator (access: platform, model: default)");
    await alex.client("").orchestratorStop();
  }, 30_000);

  test("walkie stale --json runs against the daemon: to-do cards waiting, this idle machine flagged, nothing stale yet", async () => {
    const person = alex.client("");
    const { project } = await person.createProject({ name: "Stale smoke", prefix: "STL" });
    await person.createTask({ project: project.channel, title: "waiting card", column: "todo" });
    await person.createTask({ project: project.channel, title: "fresh doing card", column: "doing" });
    const env = { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: alex.home, WALKIE_SOCKET: alex.socket };
    const r = await runAsPerson([process.execPath, join(import.meta.dir, "../../src/cli/main.ts"), "stale", "--json"], env);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out) as { cards: unknown[]; agents: unknown[]; machines: { hostname: string; reason: string }[]; todo_waiting: number; thresholds: { card_hours: number }; trust: string };
    expect(out.todo_waiting).toBe(1);
    expect(out.cards).toEqual([]);
    expect(out.thresholds.card_hours).toBe(4);
    expect(out.trust).toBe("team-member");
    expect(out.machines).toEqual([expect.objectContaining({ hostname: "alex-mbp", reason: "idle_while_cards_wait" })]);
  }, 30_000);
});

describe("ORCH-2 models", () => {
  const person = () => alex.client("");
  async function reply(to: string): Promise<void> {
    await waitFor(async () => (await person().orchestratorMessages({ limit: 500 })).messages.some((m) => m.role === "orchestrator" && m.reply_to === to), { what: "a reply", timeoutMs: 30_000 });
  }
  const sessionOf = async () => (await person().orchestrator()).local.session;

  test("the dashboard starts it with a model; a bad model is refused (400) by the start and the switch routes", async () => {
    const h = await session(alex);
    const n = countLaunches();
    const r = await dashStart(h, { model: "sonnet" });
    expect(r.status).toBe(200);
    expect((r.body as unknown as OrchestratorView).local.model_setting).toBe("sonnet");
    expect(valueOf(await launchedAfter(n), "--model")).toBe("sonnet");
    expect((await dashStart(h, { model: "-rf" })).status).toBe(400);
    for (const bad of ["-rf", "opus sonnet", "$(id)", "x".repeat(101)]) {
      const res = await fetch(url(alex, "/v1/orchestrator/model"), { method: "POST", headers: h, body: JSON.stringify({ model: bad }) });
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
    }
    await expect(person().orchestratorModel("a;b")).rejects.toMatchObject({ status: 400 });
  }, 30_000);

  test("a switch while idle resumes the SAME session with the new model, notes it in the thread and is saved", async () => {
    await person().orchestratorStart({ cwd: c.root, model: "sonnet" });
    await waitFor(async () => (await person().orchestrator()).local.state === "idle", { what: "idle" });
    const { message } = await person().orchestratorSay("hello");
    await reply(message.id);
    const before = await sessionOf();
    const n = countLaunches();
    const v = await person().orchestratorModel("opus");
    expect(v.local).toMatchObject({ model_setting: "opus" });
    expect(v.local.model_pending).toBeUndefined();
    const argv = await launchedAfter(n);
    expect(valueOf(argv, "--resume")).toBe(before as string);
    expect(valueOf(argv, "--model")).toBe("opus");
    expect(await sessionOf()).toBe(before);
    const thread = (await person().orchestratorMessages({ thread: message.thread })).messages;
    expect(thread.at(-1)).toMatchObject({ role: "orchestrator", text: "_Switched to opus._" });
    const saved = JSON.parse(readFileSync(join(alex.home, "orchestrator.json"), "utf8")) as { model?: string };
    expect(saved.model).toBe("opus");
    // the conversation continues on the resumed session
    const next = await person().orchestratorSay("again", message.thread);
    await reply(next.message.id);
    expect(await sessionOf()).toBe(before);
    // default: no --model at all
    const m = countLaunches();
    expect((await person().orchestratorModel("default")).local.model_setting).toBe("default");
    expect(await launchedAfter(m)).not.toContain("--model");
    expect((JSON.parse(readFileSync(join(alex.home, "orchestrator.json"), "utf8")) as { model?: string }).model).toBeUndefined();
  }, 60_000);

  test("a switch during a reply waits for it to end, then resumes the same session", async () => {
    const n0 = countLaunches();
    await person().orchestratorModel("sonnet");
    await launchedAfter(n0);
    const n1 = countLaunches();
    const { message } = await person().orchestratorSay("slow please"); // a new conversation: a fresh Claude session
    await waitFor(async () => countLaunches() > n1 && (await person().orchestrator()).local.state === "working", { what: "working" });
    const session1 = await sessionOf();
    const n = countLaunches();
    const v = await person().orchestratorModel("haiku");
    expect(v.local.model_pending).toBe("haiku");
    expect(v.local.model_setting).toBe("haiku");
    await Bun.sleep(500);
    expect(countLaunches()).toBe(n); // nothing restarted mid-reply
    expect((await person().orchestrator()).local.state).toBe("working");
    await reply(message.id);
    const argv = await launchedAfter(n);
    expect(valueOf(argv, "--resume")).toBe(session1 as string);
    expect(valueOf(argv, "--model")).toBe("haiku");
    expect((await person().orchestrator()).local.model_pending).toBeUndefined();
    const msgs = (await person().orchestratorMessages({ thread: message.thread })).messages;
    const iReply = msgs.findIndex((m) => m.reply_to === message.id);
    const iNote = msgs.findIndex((m) => m.text === "_Switched to haiku._");
    expect(iReply).toBeGreaterThanOrEqual(0);
    expect(iNote).toBeGreaterThan(iReply);
  }, 60_000);

  test("the model survives a daemon restart; an agent may switch it (audited); status and who show it", async () => {
    await person().orchestratorModel("fable");
    await alex.restart();
    await waitFor(async () => (await alex.client("").orchestrator()).local.state === "idle", { what: "resumed idle", timeoutMs: 20_000 });
    expect((await alex.client("").orchestrator()).local.model_setting).toBe("fable");
    await waitFor(async () => valueOf(lastArgv(), "--model") === "fable", { what: "resumed with fable" });
    const v = await alex.client("cc-agent1").orchestratorModel("claude-sonnet-4-6");
    expect(v.local.model_setting).toBe("claude-sonnet-4-6");
    expect(readFileSync(join(alex.home, "admin-audit.jsonl"), "utf8")).toContain("switched the orchestrator model to claude-sonnet-4-6");
    await waitFor(async () => (await alex.client().agents()).agents.some((a) => a.agent === "orchestrator" && a.status.model === "claude-sonnet-4-6"), { what: "status model" });
    const env = { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: alex.home, WALKIE_SOCKET: alex.socket };
    const cli = join(import.meta.dir, "../../src/cli/main.ts");
    const who = await runAsPerson([process.execPath, cli, "who", "--all"], env);
    expect(who.out).toMatch(/WalkieTalkie\s+idle\s+.*· claude-sonnet-4-6/);
    const st = await runAsPerson([process.execPath, cli, "orchestrator", "status", "--json"], env);
    expect((JSON.parse(st.out) as OrchestratorView).local.model_setting).toBe("claude-sonnet-4-6");
    const sw = await runAsPerson([process.execPath, cli, "orchestrator", "model", "opus"], env);
    expect(sw.code).toBe(0);
    expect(sw.out).toContain("switched to opus");
    const bad = await runAsPerson([process.execPath, cli, "orchestrator", "model", "-x"], env);
    expect(bad.code).not.toBe(0);
    await alex.client("").orchestratorStop();
  }, 60_000);
});
