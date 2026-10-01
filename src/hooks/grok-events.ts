// Which of Walkie's two hook paths reports each Grok event, so that no Grok event has two delivery paths.
//
// Grok merges the hooks of every source it scans and runs each matching handler of each (Grok 1.0.40 user guide,
// 10-hooks.md "Hook Locations", "How a Hook Resolves"). Walkie reaches it two ways, and `walkie hooks install grok`
// installs both (install-grok.ts), so a machine with only Grok gets every event:
//  - "claude": Walkie's Claude Code hook (`walkie hook claude`, in ~/.claude/settings.json). Grok scans that file by
//    default ([compat.claude] hooks, 26-config-reference.md), so it runs Walkie's hook with its own variables set. This
//    path reports SessionStart, UserPromptSubmit, PostToolUse (the Claude install registers it for every tool, matcher
//    "*"), Notification, Stop and SessionEnd.
//  - "native": ~/.grok/hooks/walkie.json (`walkie hook grok`). It reports what the Claude path does not: PreToolUse for
//    every tool (Bash included), and PostToolUseFailure, StopFailure and StopCancelled, which Walkie's Claude install
//    never registers. Without this file nothing reports a Grok PreToolUse, a sub-agent launch included.
// An event belongs to one path, and each handler ignores an event it does not own, whatever any hook file registers
// (grok.ts), so a stale, hand-edited or foreign registration cannot add a second path. The native file registers only
// native events. The Claude install also registers PreToolUse for the Agent / Task launch tools (Claude Code's own
// sub-agent rows): for a Grok event that handler stands down, because the native path owns every Grok PreToolUse.
// If one delivery still arrives twice (one path registered twice), the daemon applies it once: src/daemon/hook-dedupe.ts.

export type GrokPath = "claude" | "native";

export interface GrokEvent {
  /** Grok's PascalCase name: the `hook_event_name` value in its payload. */
  readonly name: string;
  /** Grok's own snake_case name: the `hookEventName` value. */
  readonly snake: string;
  /** The Claude Code event `transition()` (claude.ts) turns it into. */
  readonly walkie: "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Notification" | "Stop" | "SessionEnd";
  readonly path: GrokPath;
}

export const GROK_EVENTS: readonly GrokEvent[] = [
  { name: "SessionStart", snake: "session_start", walkie: "SessionStart", path: "claude" },
  { name: "UserPromptSubmit", snake: "user_prompt_submit", walkie: "UserPromptSubmit", path: "claude" },
  { name: "PreToolUse", snake: "pre_tool_use", walkie: "PreToolUse", path: "native" },
  { name: "PostToolUse", snake: "post_tool_use", walkie: "PostToolUse", path: "claude" },
  { name: "PostToolUseFailure", snake: "post_tool_use_failure", walkie: "PostToolUse", path: "native" },
  { name: "Notification", snake: "notification", walkie: "Notification", path: "claude" },
  { name: "Stop", snake: "stop", walkie: "Stop", path: "claude" },
  { name: "StopFailure", snake: "stop_failure", walkie: "Stop", path: "native" },
  { name: "StopCancelled", snake: "stop_cancelled", walkie: "Stop", path: "native" },
  { name: "SessionEnd", snake: "session_end", walkie: "SessionEnd", path: "claude" },
];

/** The events `walkie hooks install grok` registers in the Grok hook file: the ones the Claude-compatible path does not report. */
export const GROK_NATIVE_EVENTS: readonly string[] = GROK_EVENTS.filter((e) => e.path === "native").map((e) => e.name);

const BY_NAME = new Map<string, GrokEvent>(GROK_EVENTS.flatMap((e): [string, GrokEvent][] => [[e.name, e], [e.snake, e]]));

/**
 * The event a Grok payload names: `hook_event_name` (Claude's PascalCase value), else `hookEventName` (Grok's
 * snake_case value) when the first is not one Walkie reports. Both paths resolve through this, so they agree.
 */
export function grokEvent(input: { hook_event_name?: string; hookEventName?: string }): GrokEvent | undefined {
  for (const name of [input.hook_event_name, input.hookEventName]) {
    const event = name ? BY_NAME.get(name) : undefined;
    if (event) return event;
  }
  return undefined;
}

/**
 * Whether this hook process was started by Grok's hook runner. The runner sets GROK_HOOK_EVENT, GROK_HOOK_NAME,
 * GROK_SESSION_ID, GROK_WORKSPACE_ROOT and CLAUDE_PROJECT_DIR on every hook process it starts, whichever file
 * registered the hook, and strips a hook's own `env` entries for them (10-hooks.md "Runner-injected variables"). Only
 * GROK_HOOK_EVENT decides: GROK_SESSION_ID also reaches processes the runner did not start (a notification command, a
 * Claude Code started from a Grok tool shell), and such a Claude Code's hooks are Claude Code's. The guide documents no
 * process-ancestry marker, so the environment is the only one used.
 */
export function isGrokHook(env: NodeJS.ProcessEnv): boolean {
  return !!env.GROK_HOOK_EVENT;
}
