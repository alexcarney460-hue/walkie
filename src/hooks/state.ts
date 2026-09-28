// Per-agent hook state so every agent.status we send is a full snapshot even
// though each hook event only knows one piece (the prompt, the last tool, ...).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { walkieHome } from "../client/index.ts";

/**
 * Where a cached title came from: a person's prompt (shared only with share_prompts), walkie_set_status (explicit,
 * always allowed) or the fixed placeholder. A title saved before this field existed counts as a prompt's.
 */
export type TitleSource = "prompt" | "person" | "agent" | "placeholder" | "explicit";
/** Where a cached task key came from (a key saved before this field existed counts as a prompt's). */
export type TaskSource = "prompt" | "person" | "agent" | "explicit";

/** A title / task set on purpose (walkie_set_status, `walkie status`; round 2's "explicit" = an agent's). */
export function isDeliberate(src: string | undefined): boolean {
  return src === "person" || src === "agent" || src === "explicit";
}

export interface HookState {
  title?: string;
  title_src?: TitleSource;
  task?: string;
  task_src?: TaskSource;
  started_at?: number;
  model?: string;
  injected: string[]; // event ids already surfaced to the model (bounded)
  /** A sub-agent's own state (WALKIE-MISSION-SUB-1, src/hooks/subagents.ts): its id, session agent and type. */
  agent_id?: string;
  parent?: string;
  /** Its row's agent name, chosen once (unique within the session). */
  row?: string;
  sub_type?: string;
  /** Ended (SubagentStop, or its session ended); late events for it change nothing. */
  done?: boolean;
  /** When it last reported (staleness for the per-session cap). */
  last_at?: number;
  /** The card whose Data Room context (pinned documents, attached files) this session already got (DATA-ROOM-1). */
  room_card?: string;
}

const EMPTY: HookState = { injected: [] };

/** The title a status may carry under the policy: a prompt-derived (or unknown-source) title only with share_prompts. */
export function shareableTitle(state: Pick<HookState, "title" | "title_src">, sharePrompts: boolean): string | undefined {
  if (!state.title) return undefined;
  return sharePrompts || isDeliberate(state.title_src) || state.title_src === "placeholder" ? state.title : undefined;
}

/** The cached task key a status may carry: a prompt's (or an unknown-source one) only with share_prompts. */
export function shareableTask(state: Pick<HookState, "task" | "task_src">, sharePrompts: boolean): string | undefined {
  if (!state.task) return undefined;
  return sharePrompts || isDeliberate(state.task_src) ? state.task : undefined;
}

/** The provenance of the cached title / task for the daemon's projection (status-projection.ts); legacy = prompt. */
export function stateProvenance(state: Pick<HookState, "title_src" | "task_src">): { title: Exclude<TitleSource, "explicit">; task: Exclude<TaskSource, "explicit"> } {
  const fix = <T extends string>(v: T | undefined) => (v === "explicit" ? "agent" : v ?? "prompt");
  return { title: fix(state.title_src) as Exclude<TitleSource, "explicit">, task: fix(state.task_src) as Exclude<TaskSource, "explicit"> };
}

/** The directory holding every agent's hook state. */
export function agentsDir(): string {
  return join(walkieHome(), "agents");
}

function file(agent: string): string {
  return join(agentsDir(), `${agent}.json`);
}

export function loadState(agent: string): HookState {
  try {
    const raw = JSON.parse(readFileSync(file(agent), "utf8")) as Partial<HookState>;
    return { ...EMPTY, ...raw, injected: Array.isArray(raw.injected) ? raw.injected.slice(-200) : [] };
  } catch {
    return EMPTY;
  }
}

export function saveState(agent: string, state: HookState): void {
  const path = file(agent);
  try {
    mkdirSync(join(walkieHome(), "agents"), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...state, injected: state.injected.slice(-200) }), { mode: 0o600 });
    renameSync(tmp, path); // atomic: parallel PostToolUse hooks never see a torn file
  } catch {
    /* state is a cache; losing it only costs a title until the next prompt */
  }
}
