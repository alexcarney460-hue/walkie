// AGENT-SEE-1: one label for an agent's runtime and how it runs, shared by `walkie who` and the dashboard:
// "kimi · headless", "claude · acp", "grok · headless". The runtime's own name (runtime_name) stands in for "other".
import type { BodyOf } from "./schemas.ts";

type Status = Pick<BodyOf<"agent.status">, "runtime" | "runtime_name" | "launch">;

const SHORT: Record<Status["runtime"], string> = { "claude-code": "claude", codex: "codex", kimi: "kimi", cli: "cli", other: "agent" };
const LONG: Record<Status["runtime"], string> = { "claude-code": "Claude Code", codex: "Codex", kimi: "Kimi", cli: "CLI", other: "Agent" };
const NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;
const LAUNCH_RE = /^[a-z][a-z0-9-]{0,15}$/;

function nameOf(s: Status, long: boolean): string {
  if (s.runtime === "other" && s.runtime_name && NAME_RE.test(s.runtime_name)) {
    return long ? s.runtime_name.charAt(0).toUpperCase() + s.runtime_name.slice(1) : s.runtime_name;
  }
  return (long ? LONG : SHORT)[s.runtime] ?? (long ? "Agent" : "agent");
}

/** "Kimi · headless" (long, the dashboard) or "kimi · headless" (short, the terminal). */
export function runtimeLabel(s: Status, long = false): string {
  const launch = s.launch && LAUNCH_RE.test(s.launch) ? s.launch : undefined;
  return launch ? `${nameOf(s, long)} · ${launch}` : nameOf(s, long);
}

/**
 * Whether `walkie who` shows the label: for a run that isn't a plain interactive Claude Code / Codex session (a
 * headless or ACP run, Kimi, or a runtime without a wire value), where the name alone doesn't say what it is.
 */
export function labelWorthShowing(s: Status): boolean {
  return !!s.launch || s.runtime === "kimi" || s.runtime === "other";
}
