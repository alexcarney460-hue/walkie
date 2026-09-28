// Sub-agents in Mission Control (WALKIE-MISSION-SUB-1). A Claude Code session that starts sub-agents (the Agent / Task
// tool, foreground or background) reports each one as its own agent row, a child of the session's row:
//   name    "<parent>.<first 12 of the sub-agent id>" (a valid AgentName, so still addressable and unique per machine)
//   parent  the session's agent name, on the status (agent.status `parent`)
//   type    the sub-agent type (agent.status `subagent_type`): shared as is only for Claude Code's built-in types; a
//           custom agent's name is shared only with share_prompts (it can name a project), else "custom".
// Pure: the hooks, the daemon (views, projection, caps) and the dashboard use these same helpers.

/** Most live (not ended) sub-agents one session may show at once; more are not reported (hook) or refused (daemon). */
export const MAX_SUBAGENTS_PER_PARENT = 16;
/** Archived sub-agents a daemon keeps per machine (inside the archive's own cap), and for how long. */
export const SUBAGENT_ARCHIVE_CAP_PER_NODE = 100;
export const SUBAGENT_ARCHIVE_TTL_MS = 86_400_000;

/** Claude Code's built-in sub-agent types: names, never a person's text. */
export const BUILTIN_SUBAGENT_TYPES: ReadonlySet<string> = new Set([
  "general-purpose", "Explore", "Plan", "statusline-setup", "output-style-setup", "claude-code-guide", "fork",
]);

/** What a custom (non built-in) sub-agent type is shared as without share_prompts. */
export const CUSTOM_SUBAGENT_TYPE = "custom";

const ID_RE = /[^a-z0-9]/g;
/** Characters of the sub-agent id in its row's name (Opus mission-sub r1: 8 could collide within a busy day). */
export const SUBAGENT_ID_CHARS = 12;
const PARENT_MAX = 48 - 1 - SUBAGENT_ID_CHARS;

/** "<parent>.<12 chars of the sub-agent id>"; null when the id has no usable characters. */
export function subagentName(parent: string, agentId: string): string | null {
  const short = agentId.toLowerCase().replace(ID_RE, "").slice(0, SUBAGENT_ID_CHARS);
  return short ? `${parent.slice(0, PARENT_MAX)}.${short}` : null;
}

/** A sub-agent type as it may be stored or shown: name characters only, at most 60. */
export function cleanSubagentType(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/[^A-Za-z0-9._:@/ -]/g, "").trim().slice(0, 60);
  return t || undefined;
}

/** Whether `agent` is named as a sub-agent of `parent` (the daemon refuses a `parent` that doesn't match the name). */
export function namedUnder(agent: string, parent: string): boolean {
  return agent !== parent && agent.startsWith(`${parent.slice(0, PARENT_MAX)}.`);
}

/** The sub-agent type a status may carry: a built-in type as is; a custom one only with share_prompts. */
export function shareableSubagentType(type: string, sharePrompts: boolean): string {
  return sharePrompts || BUILTIN_SUBAGENT_TYPES.has(type) ? type : CUSTOM_SUBAGENT_TYPE;
}

/** A sub-agent row's one-line label when it has no title: "Sub-agent (Explore)". */
export function subagentLabel(type: string | undefined): string {
  return type ? `Sub-agent (${type})` : "Sub-agent";
}

export interface SubagentCount { readonly working: number; readonly live: number }

interface Row {
  readonly node: string; readonly agent: string; readonly effective_state: string; readonly archived?: boolean;
  readonly status: { readonly parent?: string };
}

/** Per "<node>/<parent>": how many of its sub-agents are working, and how many are in the live roster. */
export function countSubagents(rows: readonly Row[]): Map<string, SubagentCount> {
  const out = new Map<string, SubagentCount>();
  for (const r of rows) {
    const p = r.status.parent;
    if (!p || r.archived) continue;
    const key = `${r.node}/${p}`;
    const c = out.get(key) ?? { working: 0, live: 0 };
    out.set(key, { working: c.working + (r.effective_state === "working" ? 1 : 0), live: c.live + 1 });
  }
  return out;
}

/** "3 sub-agents working" / "1 sub-agent working"; "" for none. */
export function subagentsText(working: number): string {
  return working > 0 ? `${working} sub-agent${working === 1 ? "" : "s"} working` : "";
}
