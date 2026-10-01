// `walkie hook claude|grok` as Grok runs them: a child process with Grok's hook-runner variables, the event JSON on
// stdin, and a temp HOME (so whatever Grok hook files exist there are the only ones any code could read). A stand-in
// daemon records what each run reports.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grokCommand } from "../../src/hooks/install-grok.ts";
import { fakeDaemon, type FakeDaemon } from "../helpers/fake-daemon.ts";

const MAIN = join(import.meta.dir, "../../src/cli/main.ts");
const SESSION = "abc123-4567";
/** Every event Grok sends that Walkie reports, spelled as in Grok's hook payloads. */
const ALL_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "StopFailure", "StopCancelled", "SessionEnd"];

let dir: string;
let daemon: FakeDaemon;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "walkie-grok-cli-"));
  mkdirSync(join(dir, "home", ".grok", "hooks"), { recursive: true });
  mkdirSync(join(dir, "walkie"), { recursive: true });
  // The asks and mentions a Claude Code hook looks up after its status (a Grok hook never does).
  daemon = fakeDaemon({ "POST /v1/status": { event: null }, "GET /v1/asks": { asks: [] }, "GET /v1/events": { events: [] } });
});
afterEach(() => {
  daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** A Grok hook config naming `command` for every event: what an earlier build wrote, or a hand edit. */
function writeNativeConfig(command: string): void {
  const hooks = Object.fromEntries(ALL_EVENTS.map((event) => [event, [{ hooks: [{ type: "command", command, timeout: 5 }] }]]));
  writeFileSync(join(dir, "home", ".grok", "hooks", "walkie.json"), JSON.stringify({ hooks }));
}

async function runHook(runtime: "claude" | "grok", event: string, extra: Record<string, unknown> = {}): Promise<void> {
  const child = Bun.spawn([process.execPath, MAIN, "hook", runtime], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "", NO_COLOR: "1", HOME: join(dir, "home"), WALKIE_HOME: join(dir, "walkie"), WALKIE_SOCKET: daemon.socket,
      GROK_SESSION_ID: SESSION, GROK_HOOK_EVENT: event.replace(/[A-Z]/g, (c, i) => (i ? "_" : "") + c.toLowerCase()),
    },
  });
  child.stdin.write(JSON.stringify({ hook_event_name: event, sessionId: SESSION, cwd: "/fixture", ...extra }));
  child.stdin.end();
  expect(await child.exited).toBe(0);
}

const reports = () => daemon.requests.filter((r) => r.method === "POST" && r.path === "/v1/status");

const CLAUDE_CODE_SESSION = "5e55a1b2-0000-4000-8000-000000000001";

/** `walkie hook claude` as Claude Code runs it: its own session variable, plus whatever its parent shell exported. */
async function runClaudeCodeHook(inherited: Record<string, string>): Promise<void> {
  const child = Bun.spawn([process.execPath, MAIN, "hook", "claude"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", HOME: join(dir, "home"), WALKIE_HOME: join(dir, "walkie"), WALKIE_SOCKET: daemon.socket, CLAUDE_CODE_SESSION_ID: CLAUDE_CODE_SESSION, ...inherited },
  });
  child.stdin.write(JSON.stringify({ hook_event_name: "Stop", session_id: CLAUDE_CODE_SESSION, cwd: "/fixture" }));
  child.stdin.end();
  expect(await child.exited).toBe(0);
}

test("a Claude Code hook that only inherited GROK_SESSION_ID (a Claude Code started from a Grok tool shell) reports as Claude Code, not as the Grok session", async () => {
  await runClaudeCodeHook({});
  const control = reports().map((r) => r.body);
  expect(control).toMatchObject([{ agent: "cc-5e55a1", runtime: "claude-code", session: CLAUDE_CODE_SESSION }]);
  expect(daemon.requests.some((r) => r.path.startsWith("/v1/asks"))).toBe(true); // the Claude path ran: it looked for asks

  daemon.requests.length = 0;
  await runClaudeCodeHook({ GROK_SESSION_ID: SESSION });
  expect(reports().map((r) => r.body)).toEqual(control);
  expect(daemon.requests.some((r) => r.path.startsWith("/v1/asks"))).toBe(true);
}, 30_000);

test("the same Stop with Grok's hook runner variables is Grok's: it reports as the Grok session and never looks for asks", async () => {
  const child = Bun.spawn([process.execPath, MAIN, "hook", "claude"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", HOME: join(dir, "home"), WALKIE_HOME: join(dir, "walkie"), WALKIE_SOCKET: daemon.socket,
      CLAUDE_CODE_SESSION_ID: CLAUDE_CODE_SESSION, GROK_SESSION_ID: SESSION, GROK_HOOK_EVENT: "stop" },
  });
  child.stdin.write(JSON.stringify({ hook_event_name: "Stop", sessionId: SESSION, cwd: "/fixture" }));
  child.stdin.end();
  expect(await child.exited).toBe(0);
  expect(reports().map((r) => r.body)).toMatchObject([{ agent: "grok-abc123", runtime: "other", runtime_name: "grok", session: SESSION }]);
  expect(daemon.requests.some((r) => r.path.startsWith("/v1/asks"))).toBe(false);
}, 30_000);

test("the Claude-compatible hook reports every event it owns even when a native config for a runnable Walkie is on disk", async () => {
  writeNativeConfig(`${grokCommand([process.execPath, MAIN])} hook grok # walkie-managed`);
  const owned: [string, string, Record<string, unknown>][] = [
    ["SessionStart", "idle", {}], ["UserPromptSubmit", "working", { prompt: "go" }],
    ["PostToolUse", "working", { toolName: "run_terminal_command", toolInput: { command: "ls" } }],
    ["Notification", "idle", { notificationType: "idle_prompt" }], ["Stop", "idle", {}], ["SessionEnd", "offline", {}],
  ];
  for (const [event, , extra] of owned) await runHook("claude", event, extra);
  expect(reports().map((r) => (r.body as { state: string }).state)).toEqual(owned.map(([, state]) => state));
  for (const r of reports()) expect(r.body).toMatchObject({ agent: "grok-abc123", runtime: "other", runtime_name: "grok", session: SESSION });
}, 60_000);

test("a stale native config pointing at a removed binary changes nothing", async () => {
  await runHook("claude", "Stop");
  const without = reports().length;
  writeNativeConfig(`${grokCommand(["/nonexistent/removed/walkie"])} hook grok # walkie-managed`);
  await runHook("claude", "Stop");
  expect(without).toBe(1);
  expect(reports()).toHaveLength(2);
}, 30_000);

test("the Claude-compatible hook stands down for what the native path owns, and reports the rest", async () => {
  await runHook("claude", "PreToolUse", { toolName: "spawn_subagent", toolInput: {} });
  await runHook("claude", "StopFailure");
  expect(reports()).toHaveLength(0);
  await runHook("claude", "SessionStart");
  await runHook("claude", "PostToolUse", { toolName: "run_terminal_command", toolInput: { command: "ls" } });
  expect(reports()).toHaveLength(2);
}, 30_000);

test("the native hook stands down for what the Claude-compatible path owns, and reports the rest", async () => {
  await runHook("grok", "SessionStart");
  await runHook("grok", "Stop");
  expect(reports()).toHaveLength(0);
  await runHook("grok", "PreToolUse", { toolName: "run_terminal_command", toolInput: { command: "sleep 1" } });
  await runHook("grok", "StopCancelled");
  expect(reports()).toHaveLength(2);
}, 30_000);
