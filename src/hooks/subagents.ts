// Claude Code sub-agents as their own Mission Control rows (WALKIE-MISSION-SUB-1). Recorded hook payloads (Claude Code
// 2.1.283, test/fixtures/claude-subagents, docs/plans/MISSION-SUB-1.md):
//   SubagentStart / SubagentStop     session_id (the parent session), agent_id, agent_type; no description
//   Pre/PostToolUse inside one       the same fields plus agent_id / agent_type: its own tool calls
//   PreToolUse of Agent / Task       the parent's launch: tool_input.description + subagent_type, tool_use_id; no id yet
//   PostToolUse of Agent / Task      tool_response.agentId + description: before SubagentStart for a background agent,
//                                    after SubagentStop for a foreground one
//   Stop (the parent's)              background_tasks: [{ id, type: "subagent", status, description, agent_type }]
// So a sub-agent's description comes from its launch: exact when the launch reply named its id first, else the oldest
// pending launch of the same type (a foreground agent), corrected when the launch reply arrives. Every file here is
// one entry (a launch, a sub-agent), written atomically: parallel hooks never lose each other's updates.
//
// Privacy: the description is text an agent wrote from the person's prompt, so it is sent with provenance "prompt":
// the daemon shares it with the team only with share_prompts, and keeps it for this machine's own dashboard.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient } from "../client/index.ts";
import type { AgentState } from "../protocol/schemas.ts";
import { cleanSubagentType, MAX_SUBAGENTS_PER_PARENT, subagentName } from "../protocol/subagents.ts";
import { detectTask, repoContext } from "../agent/identity.ts";
import { titleFromPrompt } from "./activity.ts";
import { agentsDir, loadState, saveState, type HookState } from "./state.ts";

/** The Claude Code hook fields sub-agents add (all optional: older Claude Code versions send none of them). */
export interface SubagentFields {
  agent_id?: string;
  agent_type?: string;
  tool_use_id?: string;
  tool_response?: unknown;
  background_tasks?: unknown;
}

export const LAUNCH_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);
/** A launch whose sub-agent never started is forgotten after this long; a known id after LAUNCH_ID_TTL_MS. */
export const LAUNCH_TTL_MS = 10 * 60_000;
export const LAUNCH_ID_TTL_MS = 60 * 60_000;
/** Most launch entries kept per session (the oldest go first). */
export const MAX_LAUNCHES = 64;
/** A sub-agent's state file is rewritten at most this often just to note that it is still reporting. */
const TOUCH_MS = 60_000;
/** A tool call this soon after its sub-agent stopped is a straggler of that run, not a resume. */
export const RESUME_GRACE_MS = 3_000;
/** Ended sub-agents' state files are removed after this long (and all of a session's when it ends). */
export const ENDED_TTL_MS = 86_400_000;

const HOOK_TIMEOUT_MS = 1200;
/** A sub-agent silent this long no longer counts toward the cap (the daemon's STALE_STATUS_MS: it renders offline). */
const STALE_MS = 30 * 60_000;
const SAFE = /[^A-Za-z0-9_-]/g;

interface Launch { description?: string; type?: string; at: number; tool_use_id?: string }

/** A sub-agent event: SubagentStart / SubagentStop, or any hook fired inside a sub-agent (it names its agent_id). */
export function isSubagentEvent(input: { hook_event_name: string } & SubagentFields): boolean {
  if (input.hook_event_name === "SubagentStart" || input.hook_event_name === "SubagentStop") return true;
  return typeof input.agent_id === "string" && input.agent_id.length > 0;
}

function prefix(parent: string): string {
  // subagentName cuts the parent: the same cut finds them all again.
  return (subagentName(parent, "x") as string).slice(0, -1);
}

/**
 * A sub-agent's hook-state key: its session and its FULL id (Codex mission-sub r1 #6), never an alias: an id that
 * isn't plain lowercase letters and digits (Claude Code's are hex) is keyed by its hash (Codex r2 #1: "abc-def" and
 * "abcdef" were one key).
 */
export function stateKey(parent: string, agentId: string): string | null {
  if (!agentId) return null;
  const id = /^[a-z0-9]{1,64}$/.test(agentId) ? agentId : `h${createHash("sha256").update(agentId).digest("hex").slice(0, 40)}`;
  return `${prefix(parent)}${id}`;
}

/**
 * The row names a sub-agent may take, in order: 12 characters of its id, then longer prefixes of it, then one from its
 * hash. The first one no other sub-agent of the session holds is its row for good (Codex mission-sub r2 #1).
 */
export function rowCandidates(parent: string, agentId: string): string[] {
  const base = subagentName(parent, agentId);
  const p = prefix(parent);
  const clean = agentId.toLowerCase().replace(/[^a-z0-9]/g, "");
  const room = 48 - p.length;
  const out = base ? [base] : [];
  for (const n of [16, 20, 24, 32, room]) if (n <= room && clean.length >= n) out.push(`${p}${clean.slice(0, n)}`);
  out.push(`${p}x${createHash("sha256").update(agentId).digest("hex").slice(0, Math.min(room - 1, 23))}`);
  return [...new Set(out)];
}

/** A sub-agent's row name as stored (older state files: its 12-character name). */
function rowOf(parent: string, s: HookState): string | null {
  return s.row ?? (s.agent_id ? subagentName(parent, s.agent_id) : null);
}

function launchDir(parent: string): string {
  return join(agentsDir(), `${parent}.subq`);
}

function writeAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

function unlink(path: string): boolean {
  try { unlinkSync(path); return true; } catch { return false; }
}

function list(dir: string): string[] {
  try { return readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return []; }
}

/** One line of the launch's description, redacted (titleFromPrompt), or undefined. */
function cleanDescription(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? titleFromPrompt(v) || undefined : undefined;
}

function launchOf(input: { tool_input?: Record<string, unknown> }): { description?: string; type?: string } {
  const ti = input.tool_input ?? {};
  const description = cleanDescription(ti.description);
  const type = cleanSubagentType(ti.subagent_type) ?? "general-purpose";
  return { ...(description ? { description } : {}), type };
}

/** Old and excess launch entries go (bounded per session). */
/** Expired entries go, and the oldest beyond MAX_LAUNCHES - 1: room for the one about to be written. */
function pruneLaunches(dir: string, now: number): void {
  const kept: Array<{ f: string; at: number }> = [];
  for (const f of list(dir)) {
    const e = readJson<Launch>(join(dir, f));
    const ttl = f.startsWith("id-") ? LAUNCH_ID_TTL_MS : LAUNCH_TTL_MS;
    if (!e || typeof e.at !== "number" || now - e.at > ttl) unlink(join(dir, f));
    else kept.push({ f, at: e.at });
  }
  const oldestFirst = kept.sort((x, y) => x.at - y.at || x.f.localeCompare(y.f));
  for (const { f } of oldestFirst.slice(0, Math.max(0, oldestFirst.length - (MAX_LAUNCHES - 1)))) unlink(join(dir, f));
}

/** PreToolUse of Agent / Task in the parent: a pending launch (its sub-agent's id is not known yet). */
export function recordLaunch(parent: string, input: { tool_use_id?: string; tool_input?: Record<string, unknown> }, now: number): void {
  const dir = launchDir(parent);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneLaunches(dir, now);
  const id = (input.tool_use_id ?? `${process.pid}-${now}`).replace(SAFE, "").slice(0, 80);
  writeAtomic(join(dir, `tu-${String(now).padStart(15, "0")}-${id}.json`), { ...launchOf(input), at: now, tool_use_id: input.tool_use_id } satisfies Launch);
}

/**
 * PostToolUse of Agent / Task in the parent: the launch reply names the sub-agent's id. Its pending entry goes; the
 * id is remembered for a SubagentStart still to come (a background agent), and a sub-agent already titled from
 * another launch (the order guess was wrong) gets this one's description. A foreground one has ended by then: its
 * row is posted again with the corrected title (Opus mission-sub r1).
 */
export async function recordLaunched(parent: string, input: { tool_use_id?: string; tool_input?: Record<string, unknown>; tool_response?: unknown }, now: number, cwd: string): Promise<void> {
  const res = input.tool_response && typeof input.tool_response === "object" ? (input.tool_response as Record<string, unknown>) : {};
  const agentId = typeof res.agentId === "string" ? res.agentId : null;
  const dir = launchDir(parent);
  if (input.tool_use_id) {
    const tail = `-${input.tool_use_id.replace(SAFE, "").slice(0, 80)}.json`;
    for (const f of list(dir)) if (f.startsWith("tu-") && f.endsWith(tail)) unlink(join(dir, f));
  }
  if (!agentId) return;
  const launch = launchOf(input);
  const description = cleanDescription(res.description) ?? launch.description;
  const key = stateKey(parent, agentId);
  const state = key ? loadState(key) : null;
  const name = state?.agent_id === agentId ? rowOf(parent, state) : null;
  if (name && key && state?.agent_id === agentId) {
    if (!description || state.title === description) return;
    const fixed: HookState = { ...state, title: description, title_src: "prompt" };
    saveState(key, fixed);
    if (fixed.done) await post(name, fixed, "offline", "Sub-agent finished", "phrase", cwd);
    return;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneLaunches(dir, now); // the same size and expiry limits as a pending launch (Codex mission-sub r2 #3)
  writeAtomic(join(dir, `id-${agentId.replace(SAFE, "").slice(0, 80)}.json`), { ...(description ? { description } : {}), type: launch.type, at: now } satisfies Launch);
}

/**
 * The parent's turn ended (Stop) or a new one began (UserPromptSubmit): a launch still pending never started. A
 * foreground launch has always finished by then and a background one got its reply, so what is left was refused
 * (a PreToolUse hook's deny fires no PostToolUse at all: test/fixtures/claude-subagents/denied-launch.jsonl).
 */
export function dropPendingLaunches(parent: string): number {
  const dir = launchDir(parent);
  let n = 0;
  for (const f of list(dir)) if (f.startsWith("tu-") && unlink(join(dir, f))) n++;
  return n;
}

/**
 * The description of a starting sub-agent: its id's entry, else (`pending`: only for a SubagentStart, never for a
 * first-seen tool call) the oldest pending launch of its type (claimed).
 */
export function claimDescription(parent: string, agentId: string, agentType: string | undefined, now: number, pending = true): string | undefined {
  const dir = launchDir(parent);
  const byId = join(dir, `id-${agentId.replace(SAFE, "").slice(0, 80)}.json`);
  const exact = readJson<Launch>(byId);
  if (exact) { unlink(byId); if (now - exact.at <= LAUNCH_ID_TTL_MS) return exact.description; }
  if (!pending) return undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const pending = list(dir).filter((f) => f.startsWith("tu-"))
      .map((f) => ({ f, e: readJson<Launch>(join(dir, f)) }))
      .filter((x): x is { f: string; e: Launch } => !!x.e && now - x.e.at <= LAUNCH_TTL_MS);
    // Only a launch of the same type: another type's description would be a wrong title (Opus mission-sub r1).
    const pick = pending.find((x) => x.e.type === (agentType ?? "general-purpose"));
    if (!pick) return undefined;
    if (unlink(join(dir, pick.f))) return pick.e.description; // a parallel start claimed it first: next one
  }
  return undefined;
}

/** A sub-agent's state: its state key, its row's name, and the state. */
interface SubState { key: string; name: string; state: HookState }

/** This session's sub-agents with a state file (live and ended). */
export function sessionSubagents(parent: string): SubState[] {
  const p = prefix(parent);
  const out: SubState[] = [];
  for (const f of list(agentsDir())) {
    if (!f.startsWith(p) || f.includes(".tmp")) continue;
    const key = f.slice(0, -".json".length);
    if (key.slice(p.length).includes(".")) continue; // "<parent>.subq" is a directory; nothing nests deeper
    const state = loadState(key);
    const name = rowOf(parent, state);
    if (name && state.parent === parent) out.push({ key, name, state });
  }
  return out;
}

/** Started, not ended, and reporting recently. */
function live(s: HookState, now: number): boolean {
  return !s.done && s.started_at !== undefined && now - (s.last_at ?? s.started_at) < STALE_MS;
}

export interface SubContext {
  parent: string; cwd: string; now: number;
  /** How a tool call / notification inside the sub-agent changes its state (claude.ts `transition`). */
  step: () => { state: AgentState; activity?: string; activityKind: "phrase" | "tool" | "notification" } | null;
}

async function post(name: string, s: HookState, state: AgentState, activity: string, kind: "phrase" | "tool" | "notification", cwd: string): Promise<void> {
  const ctx = repoContext(cwd);
  const client = new WalkieClient({ agent: name, timeoutMs: HOOK_TIMEOUT_MS });
  await client.status({
    agent: name, parent: s.parent, state, runtime: "claude-code",
    ...(s.sub_type ? { subagent_type: s.sub_type } : {}),
    // Sent with provenance "prompt": shared with the team only with share_prompts; this machine's dashboard shows it.
    ...(s.title ? { title: s.title } : {}),
    task: detectTask(ctx.branch?.toUpperCase()),
    repo: ctx.repo, branch: ctx.branch, cwd: ctx.cwd, activity,
    session: s.agent_id?.slice(0, 80), started_at: s.started_at, ask_policy: "off",
  }, { title: "prompt", task: "branch", activity: kind });
}

/** One sub-agent hook event: its row's status. Never throws past the caller's catch; returns what it posted. */
export async function runSubagentEvent(input: { hook_event_name: string } & SubagentFields, c: SubContext): Promise<AgentState | null> {
  const agentId = input.agent_id;
  const key = agentId ? stateKey(c.parent, agentId) : null;
  if (!agentId || !key) return null;
  const prev = loadState(key);
  const ev = input.hook_event_name;
  if (ev === "SubagentStop") {
    const row = prev.agent_id === agentId ? rowOf(c.parent, prev) : null;
    if (!row || prev.done) return null; // never shown, or ended already: nothing to end
    const next: HookState = { ...prev, done: true, last_at: c.now };
    saveState(key, next);
    await post(row, next, "offline", "Sub-agent finished", "phrase", c.cwd);
    return "offline";
  }
  // Claude Code can resume a background sub-agent under its id (Codex mission-sub r1 #7): a new SubagentStart, or a
  // tool call well after it ended, reopens its row; a straggler of the run that just ended does not.
  if (prev.done && ev !== "SubagentStart" && c.now - (prev.last_at ?? 0) < RESUME_GRACE_MS) return null;
  let base: HookState = prev;
  if (!prev.agent_id || prev.done) {
    // Admission: a new sub-agent (SubagentStart, or the first event of one whose start this hook never saw) or a
    // resumed one. Over the cap it is not reported and nothing is stored for it (Codex mission-sub r1 #9): a later
    // event tries again. Its launch is claimed anyway, so it can't title the next sub-agent.
    pruneEnded(c.parent, c.now);
    const type = cleanSubagentType(input.agent_type);
    const description = prev.agent_id ? undefined : claimDescription(c.parent, agentId, type, c.now, ev === "SubagentStart");
    const others = sessionSubagents(c.parent).filter((s) => s.key !== key);
    const count = others.filter((s) => live(s.state, c.now)).length;
    if (count >= MAX_SUBAGENTS_PER_PARENT) return null;
    // Its row: the first name no other sub-agent of the session holds (live or ended), kept from then on.
    const taken = new Set(others.map((s) => s.name));
    const row = prev.agent_id ? rowOf(c.parent, prev) : rowCandidates(c.parent, agentId).find((n) => !taken.has(n));
    if (!row) return null;
    base = prev.agent_id
      ? { ...prev, row, done: false, last_at: c.now }
      : {
        ...prev, agent_id: agentId, parent: c.parent, row, started_at: c.now, last_at: c.now,
        ...(type ? { sub_type: type } : {}), ...(description ? { title: description, title_src: "prompt" as const } : {}),
      };
  }
  const name = rowOf(c.parent, base);
  if (!name) return null;
  const step = ev === "SubagentStart" ? { state: "working" as const, activity: "Sub-agent started", activityKind: "phrase" as const } : c.step();
  if (!step) { if (base !== prev) saveState(key, base); return null; }
  const next = base !== prev || c.now - (prev.last_at ?? 0) >= TOUCH_MS ? { ...base, last_at: c.now } : base;
  if (next !== prev) saveState(key, next);
  await post(name, next, step.state, step.activity ?? "Working", step.activityKind, c.cwd);
  return step.state;
}

/** Ids of the sub-agents a Stop payload lists as still running; null when the payload doesn't list them. */
export function runningIds(backgroundTasks: unknown): Set<string> | null {
  if (!Array.isArray(backgroundTasks)) return null;
  const ids = new Set<string>();
  for (const t of backgroundTasks) {
    if (!t || typeof t !== "object") continue;
    const o = t as { id?: unknown; type?: unknown; status?: unknown };
    if (typeof o.id === "string" && (o.type === undefined || o.type === "subagent") && o.status !== "completed" && o.status !== "failed" && o.status !== "killed") ids.add(o.id);
  }
  return ids;
}

/**
 * The parent's Stop lists its running background sub-agents; a foreground one has always ended by then. A shown
 * sub-agent not in the list ended without a SubagentStop reaching us: its row ends now. The parent's SessionEnd ends
 * every one still shown ("Parent session ended") and removes the session's sub-agent files.
 */
export async function endSubagents(parent: string, cwd: string, now: number, how: { running: Set<string> } | "session-end"): Promise<number> {
  const subs = sessionSubagents(parent);
  const ending = subs.filter((s) => !s.state.done && (how === "session-end" || !how.running.has(s.state.agent_id as string)));
  const phrase = how === "session-end" ? "Parent session ended" : "Sub-agent finished";
  await Promise.all(ending.slice(0, MAX_SUBAGENTS_PER_PARENT * 2).map(async (s) => {
    const next = { ...s.state, done: true, last_at: now };
    saveState(s.key, next);
    await post(s.name, next, "offline", phrase, "phrase", cwd).catch(() => undefined);
  }));
  if (how === "session-end") {
    for (const s of subs) unlink(join(agentsDir(), `${s.key}.json`));
    try { rmSync(launchDir(parent), { recursive: true, force: true }); } catch { /* a cache */ }
  }
  return ending.length;
}

/** Ended sub-agents' files older than ENDED_TTL_MS go (a session that never ended cleanly leaves them behind). */
function pruneEnded(parent: string, now: number): void {
  for (const s of sessionSubagents(parent)) {
    if (!s.state.done) continue;
    const path = join(agentsDir(), `${s.key}.json`);
    try { if (now - statSync(path).mtimeMs > ENDED_TTL_MS) unlink(path); } catch { /* gone already */ }
  }
}
