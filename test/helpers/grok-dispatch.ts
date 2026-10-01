// A stand-in for Grok's hook dispatch, written from its user guide (10-hooks.md): it reads the hook files Grok scans
// (~/.grok/hooks/*.json, ~/.claude/settings.json), picks the handlers whose matcher fits the event's tool, drops
// identical handlers, and runs each one as the CLI would, in order, every one given the same event JSON. Walkie's own
// handlers run in-process; a handler whose binary is gone does nothing (Grok records a failed hook and goes on), and so
// does a runnable program that is not Walkie.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { WalkieClient } from "../../src/client/index.ts";
import { runClaudeHook } from "../../src/hooks/claude.ts";
import { runGrokHook } from "../../src/hooks/grok.ts";
import type { HookDelivery } from "../../src/protocol/hook-delivery.ts";

export interface GrokEventSpec {
  /** Grok's PascalCase event name and its snake_case twin. */
  name: string; snake: string;
  /** The tool the event is about, when it is a tool event (Grok's own name for it). */
  tool?: string;
  /** It reports on the session, not on a turn, so it carries no promptId (10-hooks.md: the idle_prompt ping, the session-end Stop). */
  session?: true;
  extra?: Record<string, unknown>;
}

/** What one dispatch did: how many hook processes reported, and how many of those the daemon applied (not a repeat). */
export interface Outcome { sent: number; applied: number; repeats: number }

interface Sent { duplicate: boolean }

/** Records every status report the hooks make through the real client, and whether the daemon dropped it as a repeat. */
export function recordStatuses(): { sent: Sent[]; stop(): void } {
  const original = WalkieClient.prototype.status;
  const sent: Sent[] = [];
  WalkieClient.prototype.status = async function (this: WalkieClient, body: Record<string, unknown>, provenance?: Parameters<typeof original>[1], delivery?: HookDelivery) {
    const res = await original.call(this, body, provenance, delivery);
    sent.push({ duplicate: res.duplicate === true });
    return res;
  };
  return { sent, stop: () => { WalkieClient.prototype.status = original; } };
}

/** 10-hooks.md "Tool Name Aliases": a matcher's Claude-style tool names also match Grok's own. */
const TOOL_ALIASES: Record<string, string> = {
  Bash: "run_terminal_command", Read: "read_file", Edit: "search_replace", Write: "search_replace", MultiEdit: "search_replace",
  Grep: "grep", Glob: "list_dir", ListDir: "list_dir", WebSearch: "web_search", Task: "spawn_subagent",
};

function matcherFits(matcher: string | undefined, tool: string | undefined): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true; // an empty or omitted matcher matches everything
  if (tool === undefined) return true; // Walkie registers no matcher on an event with no tool
  const names = matcher.split("|").flatMap((m) => (TOOL_ALIASES[m] ? [m, TOOL_ALIASES[m]] : [m]));
  return new RegExp(names.join("|")).test(tool);
}

type HookFile = { hooks?: Record<string, { matcher?: string; hooks?: { type?: string; command?: string }[] }[]> };

export class GrokDispatcher {
  private clock = 0;
  constructor(readonly home: string, readonly session: string, readonly cwd = "/fixture") {}

  get hooksDir(): string { return join(this.home, ".grok", "hooks"); }
  get claudeSettings(): string { return join(this.home, ".claude", "settings.json"); }

  /** The handler commands Grok would run for this event, in scan order, identical ones once. */
  handlers(event: string, tool?: string): string[] {
    const files = [
      ...(existsSync(this.hooksDir) ? readdirSync(this.hooksDir).filter((f) => f.endsWith(".json")).sort().map((f) => join(this.hooksDir, f)) : []),
      this.claudeSettings,
    ];
    const commands: string[] = [];
    for (const path of files) {
      if (!existsSync(path)) continue;
      const file = JSON.parse(readFileSync(path, "utf8")) as HookFile;
      for (const group of file.hooks?.[event] ?? []) {
        if (!matcherFits(group.matcher, tool)) continue;
        for (const h of group.hooks ?? []) if (h.type === "command" && h.command && !commands.includes(h.command)) commands.push(h.command);
      }
    }
    return commands;
  }

  /** Dispatch one event once: every matching handler gets the same JSON, as Grok sends it. */
  async dispatch(spec: GrokEventSpec, recorder: { sent: Sent[] }, over: { at?: string; call?: string } = {}): Promise<Outcome> {
    const n = ++this.clock;
    const sessionScoped = spec.session === true || spec.name === "SessionStart" || spec.name === "SessionEnd";
    const raw = JSON.stringify({
      hookEventName: spec.snake, hook_event_name: spec.name, sessionId: this.session, cwd: this.cwd, workspaceRoot: this.cwd, permissionMode: "default",
      timestamp: over.at ?? `2026-10-01T00:00:${String(n).padStart(2, "0")}Z`,
      ...(sessionScoped ? {} : { promptId: "p1" }),
      ...(spec.tool ? { toolName: spec.tool, toolUseId: over.call ?? `call-${n}` } : {}),
      ...spec.extra,
    });
    const env: NodeJS.ProcessEnv = { GROK_HOOK_EVENT: spec.snake, GROK_HOOK_NAME: "walkie", GROK_SESSION_ID: this.session, GROK_WORKSPACE_ROOT: this.cwd, CLAUDE_PROJECT_DIR: this.cwd };
    const before = recorder.sent.length;
    for (const command of this.handlers(spec.name, spec.tool)) await this.run(command, raw, env);
    const reports = recorder.sent.slice(before);
    return { sent: reports.length, applied: reports.filter((r) => !r.duplicate).length, repeats: reports.filter((r) => r.duplicate).length };
  }

  private async run(command: string, raw: string, env: NodeJS.ProcessEnv): Promise<void> {
    const word = /^(?:'([^']*)'|"([^"]*)")/.exec(command.trim());
    const exe = word?.[1] ?? word?.[2];
    if (!exe || !existsSync(exe) || basename(exe) === "noop") return;
    if (command.includes(" hook claude ")) await runClaudeHook(raw, env);
    else if (command.includes(" hook grok ")) await runGrokHook(raw, env);
  }
}

export function readJsonFile<T>(path: string, fallback: T): T {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : fallback;
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
