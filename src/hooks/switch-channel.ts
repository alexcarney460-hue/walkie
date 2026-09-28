// The account switcher's side channel (ACCOUNTS-2). A session launched by `walkie claude` has WALKIE_SWITCH_EVENTS
// in its environment: a file the wrapper created in ~/.walkie/run/. Claude Code hooks (`walkie hook claude`, or the
// `walkie hook switch` hooks the wrapper adds when Walkie's hooks are not installed) append one line per event:
// {ev, sid, tp, cpid?, ts} for SessionStart / UserPromptSubmit / SessionEnd — the event name, the session id, the
// transcript path, the Claude Code pid that ran the hook. No prompt, no message text. The file is written only when it is a regular file of ours inside
// ~/.walkie/run (a variable pointing anywhere else is ignored). Failures are silent: hooks never break a session.
import { appendFileSync, lstatSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { walkieHome } from "../client/index.ts";

export interface SwitchEventInput {
  hook_event_name?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
}

/** Round 3: the switcher reads only the session id and prompts (switching happens at the hard limit only). */
export const SWITCH_EVENTS = ["SessionStart", "UserPromptSubmit", "SessionEnd"] as const;
const EVENTS: ReadonlySet<string> = new Set(SWITCH_EVENTS);

export function switchEventsFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env.WALKIE_SWITCH_EVENTS;
  if (!path || !path.startsWith("/")) return null;
  const run = resolve(join(walkieHome(), "run")) + sep;
  const abs = resolve(path);
  if (!abs.startsWith(run)) return null;
  try {
    const st = lstatSync(abs);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null;
  } catch {
    return null;
  }
  return abs;
}

export function recordSwitchEvent(input: SwitchEventInput, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const file = switchEventsFile(env);
    const ev = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
    if (!file || !EVENTS.has(ev)) return;
    const sid = typeof input.session_id === "string" && /^[A-Za-z0-9-]{8,80}$/.test(input.session_id) ? input.session_id : undefined;
    const tp = typeof input.transcript_path === "string" && input.transcript_path.startsWith("/") && input.transcript_path.length < 1024 ? input.transcript_path : undefined;
    // CLAUDE_PID: the Claude Code process that ran this hook. A claude started INSIDE the wrapped session (an agent's
    // own `claude -p`) inherits WALKIE_SWITCH_EVENTS too; the wrapper tells its own session's events by this pid.
    const cpid = /^[0-9]{1,10}$/.test(env.CLAUDE_PID ?? "") ? Number(env.CLAUDE_PID) : undefined;
    appendFileSync(file, JSON.stringify({ ev, ...(sid ? { sid } : {}), ...(tp ? { tp } : {}), ...(cpid ? { cpid } : {}), ts: Date.now() }) + "\n");
  } catch { /* never break the session */ }
}

/** `walkie hook switch`: the hook the wrapper adds when Walkie's own hooks are not installed. */
export function runSwitchHook(raw: string, env: NodeJS.ProcessEnv = process.env): void {
  try { recordSwitchEvent(JSON.parse(raw) as SwitchEventInput, env); } catch { /* bad input */ }
}
