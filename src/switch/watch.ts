// What a wrapped session is doing (ACCOUNTS-2), read from the files the CLI and its hooks write — never from the
// terminal (the CLI owns the terminal; see launch.ts). Round 3: the switcher moves a session only at the HARD limit,
// so this reads only what that needs:
//   · the session id (Claude: pinned on the command line, or from the SessionStart hook event on the side channel;
//     Codex: the rollout positively tied to the process);
//   · the limit the API answered with (Claude transcript `error: "rate_limit"` + quotaLimits; Codex
//     task_complete.error `usage_limit_exceeded`), a refused token, a refused cross-account resume;
//   · background work that may still be running (so the switch waits for it, bounded): Claude background shells
//     (toolUseResult.backgroundTaskId — run_in_background, Ctrl+B, a timeout), async agents (status async_launched),
//     any run_in_background call (true or "true") whose result names no task, until a <task-notification> reports the
//     task done; Codex exec sessions reported running (a session_id without an exit_code) until they report an exit;
//   · a genuine prompt the person submitted after the limit (the resumed session is asked to answer it);
//   · Codex's own per-turn rate limits (the account's usage).
// Only entries written after the launch count (a resumed transcript holds the earlier ones).
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AccountUsage } from "../protocol/accounts.ts";
import { parseCodexSessionTail } from "../accounts/adapters/codex.ts";
import { toMs } from "../accounts/windows.ts";

export interface Signals {
  session: string | null;
  /** Last time anything was written in the session (the watcher's clock). */
  lastActivity: number;
  /** A usage limit the session hit: when it lifts (null = unknown) and which window. */
  limit: { at: number; until: number | null; window: string; model?: string } | null;
  /** The provider refused the account's token. */
  refused: { at: number } | null;
  /** The provider refused to continue a resumed conversation on this account (signed thinking / encrypted reasoning). */
  resumeFailed: { at: number } | null;
  /** Codex: the account's usage as the session last saw it. */
  reading: AccountUsage | null;
  /** The file the session's messages are in (for the summary fallback). */
  transcript: string | null;
  /** Background work started in this launch and not yet reported finished ("?…" = no task id was reported). */
  background: string[];
  /** What each pending background task is (its description, clipped), for the resumed session: id → text. */
  backgroundInfo: Record<string, string>;
  /** A genuine user prompt came after the limit: the resumed session is asked to answer it. */
  promptAfterLimit: boolean;
  /** Codex: the rollout is positively the child's (its open file, or the session id on the command line). */
  bound: boolean;
}

export interface Watcher {
  poll(now: number): Signals;
}

const MAX_READ = 1024 * 1024;
const FIRST_TAIL = 256 * 1024;

/** Reads the bytes appended to a file since `offset` (whole lines only). */
export class Tail {
  private offset = -1;
  private rest = "";
  constructor(readonly path: string, private readonly firstTail = FIRST_TAIL) {}

  /** Skips what the file holds right now (only later appends are read). */
  fromEnd(): this {
    try { this.offset = existsSync(this.path) ? statSync(this.path).size : 0; } catch { this.offset = 0; }
    return this;
  }

  lines(): string[] {
    if (!existsSync(this.path)) return [];
    let size = 0;
    try { size = statSync(this.path).size; } catch { return []; }
    if (this.offset < 0) this.offset = Math.max(0, size - this.firstTail);
    if (size < this.offset) { this.offset = 0; this.rest = ""; } // truncated / replaced
    if (size === this.offset) return [];
    const len = Math.min(MAX_READ, size - this.offset);
    const buf = Buffer.alloc(len);
    let fd: number | null = null;
    try {
      fd = openSync(this.path, "r");
      const n = readSync(fd, buf, 0, len, this.offset);
      this.offset += n;
      const text = this.rest + buf.subarray(0, n).toString("utf8");
      const parts = text.split("\n");
      this.rest = parts.pop() ?? "";
      return parts.filter((l) => l.trim() !== "");
    } catch {
      return [];
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
}

function json(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line) as unknown;
    return v && typeof v === "object" ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function initial(now: number, session: string | null): Signals {
  return { session, lastActivity: now, limit: null, refused: null, resumeFailed: null, reading: null, transcript: null, background: [], backgroundInfo: {}, promptAfterLimit: false, bound: false };
}

/** Claude's project directory name for a working directory (every character but letters and digits becomes "-"). */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

const SIGNATURE_RE = /signature|thinking block|redacted_thinking/i;
/** Statuses of a <task-notification> that mean the task is over. */
const TASK_OVER = new Set(["completed", "failed", "killed", "cancelled", "canceled", "stopped", "error", "timeout", "timed_out", "expired"]);

/**
 * A runtime task notification (round 4, Codex 6): ONLY the record kinds Claude Code writes for one — a queue operation
 * whose content, a `queued_command` attachment whose prompt, or a user message of origin task-notification whose
 * content STARTS with <task-notification> — never text inside a tool result or an ordinary message. Returns the task
 * id and status from the leading block.
 */
export function taskNotification(e: Record<string, unknown>): { id: string; status: string } | null {
  let text: unknown = null;
  if (e.type === "queue-operation" && (e.operation === "enqueue" || e.operation === "remove")) text = e.content;
  else if (e.type === "attachment") {
    const a = e.attachment as { type?: unknown; prompt?: unknown } | undefined;
    if (a?.type === "queued_command") text = a.prompt;
  } else if (e.type === "user" && (e.origin as { kind?: unknown } | undefined)?.kind === "task-notification" && e.toolUseResult === undefined) {
    text = (e.message as { content?: unknown } | undefined)?.content;
  }
  if (typeof text !== "string") return null;
  const m = /^\s*<task-notification>\s*<task-id>([A-Za-z0-9_-]{1,120})<\/task-id>[\s\S]{0,2000}?<status>([a-z_]{1,20})<\/status>/.exec(text);
  return m ? { id: m[1] as string, status: m[2] as string } : null;
}

/**
 * A HARD usage limit, from affirmative evidence only (round 4, Codex 8 / Opus 5): the quota headers Claude Code
 * records (quotaLimits rejected, or a named 5-hour / weekly / model window not merely warned about), or one of Claude
 * Code's own limit messages. A transient per-minute rate limit ("Rate limit reached for requests per minute",
 * overloaded) is none of these and never moves a session.
 */
export function claudeQuotaLimit(e: Record<string, unknown>): { until: number | null; window: string; model?: string } | null {
  if (e.isApiErrorMessage !== true) return null;
  const q = (e.quotaLimits && typeof e.quotaLimits === "object" ? e.quotaLimits : {}) as Record<string, unknown>;
  const text = JSON.stringify((e.message as { content?: unknown } | undefined)?.content ?? "").slice(0, 4_000);
  const status = typeof q.status === "string" ? q.status : null;
  const named = typeof q.rateLimitType === "string" ? q.rateLimitType.slice(0, 40) : null;
  const headers = status === "rejected" || (named !== null && status !== "allowed" && status !== "allowed_warning");
  const message = LIMIT_MESSAGE_RE.test(text) && !TRANSIENT_RE.test(text);
  if (!headers && !message) return null;
  // Round 5 (Opus 4): "You've reached your Fable limit" is one model's limit, not the account's.
  const who = /You['\u2019]ve (?:hit|reached) your (\w{2,20}) limit/i.exec(text)?.[1] ?? "";
  const model = MODEL_FAMILIES.has(who.toLowerCase()) ? who.toLowerCase() : undefined;
  const at = toMs(e.timestamp) ?? Date.now();
  return { until: toMs(q.resetsAt) ?? claudeResetAt(text, at), window: named ?? (model ? `${model} model` : "usage"), ...(model ? { model } : {}) };
}
const MODEL_FAMILIES = new Set(["fable", "mythos", "opus", "sonnet", "haiku"]);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Wall-clock parts of `t` in time zone `tz`. */
function partsIn(t: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const v: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(t))) if (p.type !== "literal") v[p.type] = Number(p.value);
  return { y: v.year as number, mo: (v.month as number) - 1, d: v.day as number, h: (v.hour as number) % 24, mi: v.minute as number };
}

/** The instant a wall-clock time in `tz` names. */
function zonedTime(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const off = (t: number) => { const p = partsIn(t, tz); return Date.UTC(p.y, p.mo, p.d, p.h, p.mi) - Math.floor(t / 60_000) * 60_000; };
  let t = guess - off(guess);
  const o2 = off(t);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}

/**
 * The reset Claude Code prints ("resets 8:30am (America/Los_Angeles)", "resets Sep 25 at 11pm (…)"), as the next such
 * time after `at` in the named zone (the local zone when none or an unknown one is named). Null when there is none.
 */
export function claudeResetAt(text: string, at: number): number | null {
  const m = /resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+){0,2})\))?/i.exec(text);
  if (!m) return null;
  let h = Number(m[3]);
  const mi = m[4] ? Number(m[4]) : 0;
  if (h < 1 || h > 12 || mi > 59) return null;
  if (m[5]?.toLowerCase() === "p" && h < 12) h += 12;
  if (m[5]?.toLowerCase() === "a" && h === 12) h = 0;
  let tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (m[6]) { try { new Intl.DateTimeFormat("en-US", { timeZone: m[6] }); tz = m[6]; } catch { /* unknown zone: local */ } }
  const today = partsIn(at, tz);
  if (m[1] && m[2]) {
    const mo = MONTHS.indexOf(m[1].toLowerCase());
    if (mo < 0) return null;
    let t = zonedTime(today.y, mo, Number(m[2]), h, mi, tz);
    if (t < at - 86_400_000) t = zonedTime(today.y + 1, mo, Number(m[2]), h, mi, tz);
    return t;
  }
  let t = zonedTime(today.y, today.mo, today.d, h, mi, tz);
  if (t <= at) t = zonedTime(today.y, today.mo, today.d + 1, h, mi, tz);
  return t;
}
const LIMIT_MESSAGE_RE = /You['\u2019]ve (hit|reached) your [^."\\]{0,60}limit|out of usage credits|cc_cli_limit_message|monthly spend limit|shared budget|\blimit reached\b[^."\\]{0,40}\bresets?\b/i;
const TRANSIENT_RE = /per minute|requests per|overloaded|retry shortly|try again shortly/i;

/** Text of a user record that a person typed (not tool output, hook feedback, a command echo or a notification). */
function typedPrompt(e: Record<string, unknown>): boolean {
  if (e.type !== "user" || e.isMeta === true || e.toolUseResult !== undefined) return false;
  const c = (e.message as { content?: unknown } | undefined)?.content;
  const text = typeof c === "string" ? c
    : Array.isArray(c) && !c.some((b) => (b as { type?: unknown })?.type === "tool_result")
      ? c.map((b) => ((b as { type?: unknown; text?: unknown })?.type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("")
      : "";
  const t = text.trim();
  return t.length > 0 && !/^<(command-|local-command|task-notification|system-reminder|bash-)/.test(t) && !t.startsWith("Caveat:");
}

export class ClaudeWatcher implements Watcher {
  private s: Signals;
  private readonly events: Tail;
  private transcript: Tail | null = null;
  /** Background tasks by id; run_in_background calls whose result has not named a task yet (by tool_use id). */
  private readonly tasks = new Set<string>();
  private readonly bgCalls = new Set<string>();
  private readonly done = new Set<string>();
  /** tool_use id → what the call said it was (description / command), for tasks it started. */
  private readonly callInfo = new Map<string, string>();
  private readonly callName = new Map<string, string>();
  private readonly taskInfo = new Map<string, string>();

  constructor(private readonly o: {
    eventsFile: string; configDir: string; cwd: string; session: string | null; since: number;
    /** The Claude Code process the wrapper started (events from any other claude — a nested one — are ignored). */
    childPid?: () => number | null;
  }) {
    this.s = initial(o.since, o.session);
    this.events = new Tail(o.eventsFile).fromEnd();
    // A resumed session's transcript already holds the earlier launches' lines: only what is appended now counts.
    if (o.session) {
      this.setSession(o.session, null);
      this.transcript?.fromEnd();
    }
  }

  /** The session's transcript: the path its hooks named, else where Claude keeps it for this (real) directory. */
  private setSession(sid: string, tp: string | null): void {
    let cwd = this.o.cwd;
    try { cwd = realpathSync(cwd); } catch { /* as given */ }
    const path = tp && tp.startsWith("/") ? tp : join(this.o.configDir, "projects", projectSlug(cwd), `${sid}.jsonl`);
    if (sid === this.s.session && this.transcript?.path === path) return;
    if (sid === this.s.session && this.transcript && !tp) return; // keep a path the hooks named
    this.transcript = new Tail(path);
    this.s = { ...this.s, session: sid, transcript: path };
  }

  poll(now: number): Signals {
    for (const line of this.events.lines()) {
      const e = json(line);
      if (!e || typeof e.ev !== "string" || !this.ours(e)) continue;
      if (typeof e.sid === "string" && /^[A-Za-z0-9-]{8,80}$/.test(e.sid)) this.setSession(e.sid, typeof e.tp === "string" ? e.tp : null);
      if (e.ev === "UserPromptSubmit") {
        this.s = { ...this.s, lastActivity: now, ...(this.s.limit ? { promptAfterLimit: true } : {}) };
      }
    }
    if (!this.transcript && this.s.session) this.setSession(this.s.session, null);
    for (const line of this.transcript?.lines() ?? []) this.transcriptLine(line, now);
    const pending = [...this.tasks].filter((t) => !this.done.has(t));
    const info: Record<string, string> = {};
    for (const t of pending) { const d = this.taskInfo.get(t); if (d) info[t] = d; }
    for (const c of this.bgCalls) { const d = this.callInfo.get(c); if (d) info[`?${c}`] = d; }
    this.s = { ...this.s, background: [...pending, ...[...this.bgCalls].map((c) => `?${c}`)], backgroundInfo: info };
    return this.s;
  }

  /**
   * An event of the wrapped session itself: from its own Claude process (CLAUDE_PID; a /clear there starts a new
   * session id the wrapper follows), or, without a pid, one naming the session already known. A claude started inside
   * the session (it inherits the side channel) is neither.
   */
  private ours(e: Record<string, unknown>): boolean {
    if (this.s.session === null) return true; // not known yet (-c, the picker): the first session to speak is it
    const child = this.o.childPid?.() ?? null;
    if (typeof e.cpid === "number" && child !== null && e.cpid === child) return true;
    return typeof e.sid !== "string" || e.sid === this.s.session;
  }

  private transcriptLine(line: string, now: number): void {
    const e = json(line);
    if (!e) return;
    const at = toMs(e.timestamp);
    if (at === null || at < this.o.since) return;
    // A finished task is reported only by a runtime notification record (never by text inside a tool result).
    const note = taskNotification(e);
    if (note && TASK_OVER.has(note.status)) this.done.add(note.id);
    if (e.type === "assistant" || e.type === "user") this.s = { ...this.s, lastActivity: now };
    this.backgroundWork(e);
    if (e.isApiErrorMessage === true) {
      const text = JSON.stringify((e.message as { content?: unknown } | undefined)?.content ?? "").slice(0, 2_000);
      const hard = claudeQuotaLimit(e);
      if (hard) {
        this.s = { ...this.s, limit: { at, until: hard.until, window: hard.window, ...(hard.model ? { model: hard.model } : {}) } };
      } else if (e.error === "authentication_failed" || e.apiErrorStatus === 401) {
        this.s = { ...this.s, refused: { at } };
      } else if (e.apiErrorStatus === 400 && SIGNATURE_RE.test(text)) {
        this.s = { ...this.s, resumeFailed: { at } };
      }
      return;
    }
    // A prompt typed after the limit (the transcript is the record even when no hook event arrived).
    if (this.s.limit && at > this.s.limit.at && typedPrompt(e)) this.s = { ...this.s, promptAfterLimit: true };
  }

  /**
   * Background tasks started (ids) and run_in_background calls not yet tied to a task. A task is named by its result:
   * `backgroundTaskId` (a shell: run_in_background, Ctrl+B, a timeout), `async_launched` + `agentId` (an agent), or a
   * bare `taskId` (a Monitor and other watches, round 4 Opus 3). Each keeps what its call said it was.
   */
  private backgroundWork(e: Record<string, unknown>): void {
    const content = (e.message as { content?: unknown } | undefined)?.content;
    if (e.type === "assistant" && Array.isArray(content)) {
      for (const b of content as Record<string, unknown>[]) {
        if (b?.type !== "tool_use" || typeof b.id !== "string") continue;
        const input = (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>;
        const what = typeof input.description === "string" ? input.description : typeof input.command === "string" ? input.command : "";
        const name = typeof b.name === "string" ? b.name : "tool";
        if (this.callInfo.size < 2_000) { this.callInfo.set(b.id, `${name}: ${what}`.replace(/\s+/g, " ").slice(0, 80)); this.callName.set(b.id, name); }
        const bg = input.run_in_background;
        if (bg === true || bg === "true") this.bgCalls.add(b.id);
      }
    }
    if (e.type !== "user") return;
    const r = (e.toolUseResult && typeof e.toolUseResult === "object" ? e.toolUseResult : {}) as Record<string, unknown>;
    const task = typeof r.backgroundTaskId === "string" ? r.backgroundTaskId
      : r.status === "async_launched" && typeof r.agentId === "string" ? r.agentId
        : typeof r.taskId === "string" ? r.taskId : null;
    if (task) this.tasks.add(task);
    if (Array.isArray(content)) {
      for (const b of content as Record<string, unknown>[]) {
        if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        // Round 5 (Opus 1): a TaskStop (or KillShell) that succeeded ended the task it names.
        const stopper = this.callName.get(b.tool_use_id);
        const stopped = typeof r.task_id === "string" ? r.task_id : typeof r.shell_id === "string" ? r.shell_id : null;
        if ((stopper === "TaskStop" || stopper === "KillShell" || stopper === "KillBash") && stopped && b.is_error !== true) this.done.add(stopped);
        const info = this.callInfo.get(b.tool_use_id);
        if (task && info) this.taskInfo.set(task, info);
        if (!this.bgCalls.has(b.tool_use_id)) continue;
        // Now tracked by its task id; a call that failed started nothing.
        if (task || b.is_error === true) this.bgCalls.delete(b.tool_use_id);
      }
    }
  }
}

// ---- Codex ----------------------------------------------------------------------------

const ROLLOUT_RE = /rollout-[^/]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const RESUME_REFUSED_RE = /encrypted|reasoning item|could not be verified|invalid_encrypted_content/i;
const ORDINAL_RE = /(\d)(st|nd|rd|th)\b/g;

/**
 * "…try again at Sep 30th, 2026 8:54 PM." → ms (local time), or null. A time alone ("try again at 8:29 PM", round 4
 * Opus 7) is its next occurrence after `now`.
 */
export function codexRetryAt(message: string, now: number = Date.now()): number | null {
  const m = /try again (?:at|after) ([^\n]{3,60}?)(?:\.(?:\s|$)|$|\n)/i.exec(message);
  if (!m) return null;
  const when = (m[1] as string).trim();
  const clock = /^(\d{1,2}):(\d{2})(?:\s*([AaPp])\.?[Mm]\.?)?$/.exec(when);
  if (clock) {
    let h = Number(clock[1]);
    const min = Number(clock[2]);
    const ap = clock[3]?.toLowerCase();
    if (h > 23 || min > 59 || (ap && (h < 1 || h > 12))) return null;
    if (ap === "p" && h < 12) h += 12;
    if (ap === "a" && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const t = Date.parse(when.replace(ORDINAL_RE, "$1"));
  return Number.isFinite(t) ? t : null;
}

/** The text of a Codex tool output (a string, or content items with text). */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((b) => (typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : "")).join("\n");
  return JSON.stringify(output ?? "");
}

const SESSION_JSON_RE = /\\?"session_id\\?"\s*:\s*"?(\d{1,12})/g;
const EXIT_JSON_RE = /\\?"exit_code\\?"\s*:\s*-?\d/;
const SESSION_TEXT_RE = /Process running with session ID (\d{1,12})/g;
const CELL_RUNNING_RE = /Script running with cell ID (\d{1,12})/g;

/** The text parts of a Codex tool output (a string, or content items with text). */
function outputParts(output: unknown): string[] {
  if (typeof output === "string") return [output];
  if (Array.isArray(output)) return output.map((b) => (typeof (b as { text?: unknown })?.text === "string" ? (b as { text: string }).text : "")).filter(Boolean);
  return [JSON.stringify(output ?? "")];
}

/** A part that is itself JSON: its objects (one, or a list). */
function jsonObjects(part: string): Record<string, unknown>[] | null {
  const t = part.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  try {
    const v = JSON.parse(t) as unknown;
    const list = Array.isArray(v) ? v : [v];
    const objs = list.map((x) => (x && typeof x === "object" && "value" in (x as object) && typeof (x as { value?: unknown }).value === "object" ? (x as { value: unknown }).value : x))
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
    return objs;
  } catch {
    return null;
  }
}

const idOf = (v: unknown): string | null => (typeof v === "number" || typeof v === "string") && String(v).length <= 40 ? String(v) : null;

/**
 * What an exec result says (round 5, Codex 4): sessions still running (a session_id with no exit code, or the text
 * "Process running with session ID N") and whether it AFFIRMATIVELY reports an exit (an exit code in a structured
 * result, or "Process exited with code N"). Only structured top-level results and Codex's own status lines count —
 * never JSON embedded inside a command's output string.
 */
export function execResult(output: unknown): { running: Set<string>; exited: Set<string>; exit: boolean } {
  const running = new Set<string>();
  const exited = new Set<string>();
  let exit = false;
  for (const part of outputParts(output)) {
    const objs = jsonObjects(part);
    if (objs) {
      for (const o of objs) {
        const sid = idOf(o.session_id);
        const code = o.exit_code !== undefined && o.exit_code !== null;
        if (sid && !code) running.add(sid);
        if (sid && code) exited.add(sid);
        if (code) exit = true;
      }
      continue;
    }
    for (const m of part.matchAll(SESSION_TEXT_RE)) running.add(m[1] as string);
    if (/^Process exited with code -?\d+/m.test(part)) exit = true;
  }
  return { running, exited, exit };
}

/** Code-mode: cells an output reports running, and whether it reports a cell finished ("Script completed" …). */
function cellResult(output: unknown): { running: Set<string>; finished: boolean } {
  const text = outputParts(output).join("\n");
  const running = new Set([...text.matchAll(CELL_RUNNING_RE)].map((m) => m[1] as string));
  return { running, finished: /^\s*Script (completed|failed|errored|error|terminated|timed out|cancelled|canceled|aborted|interrupted)\b/im.test(text) };
}

/** Agent states Codex reports (AgentStatus): over or not. */
const AGENT_OVER = new Set(["completed", "errored", "error", "shutdown", "not_found", "closed", "interrupted", "failed", "cancelled"]);
const EVENT_AGENT_KEYS = ["agent_id", "new_thread_id", "receiver_thread_id"];
const TOOL_AGENT_KEYS = ["agent_id", "new_thread_id", "receiver_thread_id", "id"];

/** A status value (a string, or a one-key object such as {"completed": "…"}) as a lower-case name. */
function statusName(v: unknown): string | null {
  if (typeof v === "string") return v.toLowerCase();
  if (v && typeof v === "object" && !Array.isArray(v)) { const k = Object.keys(v)[0]; return k ? k.toLowerCase() : null; }
  return null;
}

/** Agents a record names, with their status when it says one (a walk over the structure, bounded). */
export function agentStates(v: unknown, keys: readonly string[], out: Map<string, string | null> = new Map(), depth = 0): Map<string, string | null> {
  if (depth > 6 || !v || typeof v !== "object") return out;
  if (Array.isArray(v)) { for (const x of v.slice(0, 100)) agentStates(x, keys, out, depth + 1); return out; }
  const o = v as Record<string, unknown>;
  const status = statusName(o.status ?? o.agent_status ?? o.state);
  for (const k of keys) {
    const id = typeof o[k] === "string" && /^[0-9A-Za-z_-]{6,80}$/.test(o[k] as string) ? o[k] as string : null;
    if (id) { out.set(id, status ?? out.get(id) ?? null); break; }
  }
  // A map of agent id → status (wait_agent's answer).
  for (const [k, x] of Object.entries(o)) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) { const st = statusName(x); if (st) out.set(k, st); }
    else if (typeof x === "object") agentStates(x, keys, out, depth + 1);
  }
  return out;
}

/** Exec sessions an output reports still running: `session_id` with no exit code in the same result, or the text form. */
export function runningSessions(text: string): string[] {
  const out = new Set<string>();
  // A result that is itself JSON (an object, or a list of them) is read structurally.
  try {
    const v = JSON.parse(text) as unknown;
    const objs = (Array.isArray(v) ? v : [v]).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
    if (objs.length) {
      for (const o of objs) {
        const sid = typeof o.session_id === "number" || typeof o.session_id === "string" ? String(o.session_id) : null;
        if (sid && (o.exit_code === undefined || o.exit_code === null)) out.add(sid);
      }
      for (const m of text.matchAll(SESSION_TEXT_RE)) out.add(m[1] as string);
      return [...out];
    }
  } catch { /* text with JSON inside it: below */ }
  for (const m of text.matchAll(SESSION_JSON_RE)) {
    const i = m.index ?? 0;
    const from = text.lastIndexOf("{", i);
    const outKey = text.indexOf("output", i);
    const to = outKey > i ? outKey : Math.min(text.length, i + 200);
    const brace = text.indexOf("}", i);
    const end = brace > i && brace < to ? brace : to;
    if (!EXIT_JSON_RE.test(text.slice(from < 0 ? Math.max(0, i - 200) : from, end))) out.add(m[1] as string);
  }
  for (const m of text.matchAll(SESSION_TEXT_RE)) out.add(m[1] as string);
  return [...out];
}

/** The shapes of a code-mode script that does nothing but poll one exec session (and print the answer). */
const OBJ = String.raw`\{[^{}()\[\]\`;]*\}`;
const POLL = String.raw`(?:await\s+)?tools\.write_stdin\(\s*${OBJ}\s*\)`;
const SINGLE_POLL_RES = [
  new RegExp(String.raw`^(?:(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*)?${POLL}\s*;?\s*(?:text\(\s*(?:JSON\.stringify\(\s*)?\1\s*\)?\s*\)\s*;?)?\s*$`),
  new RegExp(String.raw`^text\(\s*(?:JSON\.stringify\(\s*)?${POLL}\s*\)?\s*\)\s*;?\s*$`),
];
export function singlePollScript(src: string): boolean {
  const t = src.trim();
  return t.length < 2_000 && SINGLE_POLL_RES.some((re) => re.test(t));
}

const AGENT_TOOLS = new Set(["spawn_agent", "resume_agent", "send_input", "wait_agent", "close_agent"]);

/** Agent ids an agent tool's arguments name (id / agent_id / ids). */
function agentRefs(args: string): string[] {
  try {
    const v = JSON.parse(args) as Record<string, unknown>;
    const out: string[] = [];
    for (const k of ["id", "agent_id"]) if (typeof v[k] === "string") out.push(v[k] as string);
    for (const k of ["ids", "agent_ids"]) if (Array.isArray(v[k])) for (const x of v[k] as unknown[]) if (typeof x === "string") out.push(x);
    return out.slice(0, 50);
  } catch {
    return [];
  }
}

/** Session ids a call writes to / polls (write_stdin), and cell ids it waits on — in its JSON arguments or script. */
function callRefs(args: string): { sessions: string[]; cells: string[] } {
  const sessions = new Set<string>();
  const cells = new Set<string>();
  for (const m of args.matchAll(/write_stdin\s*\(\s*\{[^}]{0,300}?session_id\\?"?\s*:\s*"?(\d{1,12})/g)) sessions.add(m[1] as string);
  try {
    const v = JSON.parse(args) as Record<string, unknown>;
    if (v && typeof v === "object") {
      if (typeof v.session_id === "number" || typeof v.session_id === "string") sessions.add(String(v.session_id));
      if (typeof v.cell_id === "number" || typeof v.cell_id === "string") cells.add(String(v.cell_id));
    }
  } catch { /* a script, not JSON */ }
  return { sessions: [...sessions], cells: [...cells] };
}

/** Newest rollout files (today and the two days before) whose name carries `sid` or, without a sid, any. */
export function findRollouts(sessionsDir: string, now: number, sid: string | null, days = 3): string[] {
  const out: { path: string; mtime: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 86_400_000);
    const dir = join(sessionsDir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!ROLLOUT_RE.test(name) || (sid && !name.includes(sid))) continue;
      try { out.push({ path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }); } catch { /* gone */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map((f) => f.path);
}

export class CodexWatcher implements Watcher {
  private s: Signals;
  private rollout: Tail | null = null;
  private lastLookup = 0;
  /** Exec sessions reported running (a session_id without an exit code) and code-mode cells still running. */
  private readonly sessions = new Set<string>();
  private readonly cells = new Set<string>();
  /** Codex agent threads (subagents) running (round 5, Codex 5). */
  private readonly agents = new Set<string>();
  /** Spawn calls an event already reported (their placeholder is not needed). */
  private readonly spawnSeen = new Set<string>();
  /** call_id → what the call refers to (sessions it polls, cells it waits on, agents) and what it was. */
  private readonly calls = new Map<string, { name: string; sessions: string[]; cells: string[]; agents: string[]; what: string; ops: number }>();
  private readonly info = new Map<string, string>();

  constructor(private readonly o: {
    sessionsDir: string; cwd: string;
    /** The session id given on the command line (`codex resume <id>`, or the wrapper's own resume), else null. */
    session: string | null;
    since: number;
    /** The rollout file the child holds open (lsof / /proc), when it can be told. */
    openRollout?: () => Promise<string | readonly string[] | null>;
  }) {
    this.s = initial(o.since, o.session);
  }

  /**
   * Binds the rollout (round 1, Codex 5 / Opus 10) only by a positive association: the file the child process holds
   * open, or — for `codex resume <id>` — the file of that id. A new session whose file cannot be tied to the process
   * stays unbound (no switching in this run); the newest file with the same cwd is never assumed to be ours.
   */
  private async locate(now: number): Promise<void> {
    if (this.rollout || now - this.lastLookup < 2_000) return;
    this.lastLookup = now;
    const got = await this.o.openRollout?.().catch(() => null);
    const held = (got === null || got === undefined ? [] : typeof got === "string" ? [got] : [...got]).filter((f) => ROLLOUT_RE.test(f));
    const sidOf = (f: string) => ROLLOUT_RE.exec(f)?.[1] ?? null;
    let path: string | null = null;
    if (this.o.session) {
      // Round 5 (Codex 6): an explicitly requested session binds only to ITS file — never another rollout the process
      // holds open (a subagent thread's).
      path = held.find((f) => sidOf(f) === this.o.session) ?? findRollouts(this.o.sessionsDir, now, this.o.session, 60)[0] ?? null;
      if (path && sidOf(path) !== this.o.session) path = null;
    } else {
      // A new session: the one root conversation among the files held open (subagent threads excluded); ambiguous → none.
      const roots = held.filter((f) => rolloutIsRoot(f));
      path = roots.length === 1 ? roots[0] as string : null;
    }
    if (!path) return;
    const sid = sidOf(path);
    this.rollout = new Tail(path);
    this.s = { ...this.s, transcript: path, bound: true, ...(sid ? { session: sid } : {}) };
  }

  async refresh(now: number): Promise<Signals> {
    await this.locate(now);
    return this.poll(now);
  }

  poll(now: number): Signals {
    for (const line of this.rollout?.lines() ?? []) this.line(line, now);
    const background = [...[...this.sessions].map((x) => `exec:${x}`), ...[...this.cells].map((x) => `cell:${x}`), ...[...this.agents].map((x) => `agent:${x}`)];
    const backgroundInfo: Record<string, string> = {};
    for (const b of background) { const d = this.info.get(b); if (d) backgroundInfo[b] = d; }
    this.s = { ...this.s, background, backgroundInfo };
    return this.s;
  }

  /**
   * A tool call's output (round 4, Codex 7 / Opus 4 and 6). Codex drops a process's session id once it exits, so an
   * exit is recognised by CORRELATION: a call that polled session N (write_stdin) or waited on cell N, whose output no
   * longer reports N running, ended it. Sessions an output reports running are added; code-mode cells ("Script
   * running with cell ID N") likewise.
   */
  private toolOutput(callId: string | null, output: unknown): void {
    const call = callId ? this.calls.get(callId) : undefined;
    const ex = execResult(output);
    const cell = cellResult(output);
    // Completion needs affirmative evidence from the call that polled it (round 5, Codex 4): an exit reported in that
    // call's own structured result or status line — never embedded text, silence, or a failed write.
    // …and only from a call whose one operation was that poll: a composite script's exit code may be another command's.
    const single = !!call && call.ops <= 1 && call.sessions.length === 1;
    for (const sid of call?.sessions ?? []) if (!ex.running.has(sid) && (ex.exited.has(sid) || (single && ex.exit))) this.sessions.delete(sid);
    for (const sid of ex.exited) this.sessions.delete(sid);
    for (const cid of call?.cells ?? []) if (!cell.running.has(cid) && cell.finished) this.cells.delete(cid);
    for (const sid of ex.running) { this.sessions.add(sid); if (call?.what && !this.info.has(`exec:${sid}`)) this.info.set(`exec:${sid}`, call.what); }
    for (const cid of cell.running) { this.cells.add(cid); if (call?.what && !this.info.has(`cell:${cid}`)) this.info.set(`cell:${cid}`, call.what); }
    if (call && AGENT_TOOLS.has(call.name)) this.agentOutput(callId as string, call, output);
    if (callId) this.calls.delete(callId);
  }

  /** An agent tool's answer: spawned / resumed / messaged agents run until a status says they are over. */
  private agentOutput(callId: string, call: { name: string; agents: string[]; what: string }, output: unknown): void {
    const states = new Map<string, string | null>();
    for (const part of outputParts(output)) {
      try { agentStates(JSON.parse(part) as unknown, TOOL_AGENT_KEYS, states); } catch { /* text */ }
    }
    if (call.name === "close_agent") {
      const failed = outputParts(output).some((p) => /\b(error|failed|not found)\b/i.test(p));
      if (!failed) for (const id of call.agents) this.agents.delete(id);
    }
    for (const [id, st] of states) this.agentState(id, st, call.name !== "wait_agent" && call.name !== "close_agent", call.what);
    // A spawn whose answer names no agent (a format this does not know): pending under its call until an event names it.
    if ((call.name === "spawn_agent" || call.name === "resume_agent") && states.size === 0 && !this.spawnSeen.has(callId)) {
      this.agents.add(`?${callId}`);
      this.info.set(`agent:?${callId}`, call.what);
    }
  }

  private agentState(id: string, status: string | null, starts: boolean, what?: string): void {
    if (status && AGENT_OVER.has(status)) { this.agents.delete(id); return; }
    if (starts || this.agents.has(id) || (status !== null)) {
      this.agents.add(id);
      if (what && !this.info.has(`agent:${id}`)) this.info.set(`agent:${id}`, what);
    }
  }

  /** Codex's collaboration events (collab_*): agents spawned, resumed, messaged, waited on, closed. */
  private collabEvent(kind: string, p: Record<string, unknown>): void {
    const states = agentStates(p, EVENT_AGENT_KEYS);
    const ids = [...states.keys()];
    if (typeof p.call_id === "string") { this.agents.delete(`?${p.call_id}`); this.spawnSeen.add(p.call_id); }
    if (kind === "collab_close_end") { for (const id of ids) this.agents.delete(id); return; }
    const starts = kind === "collab_agent_spawn_end" || kind === "collab_resume_end" || kind === "collab_agent_interaction_end";
    for (const [id, st] of states) this.agentState(id, st, starts);
  }

  private line(line: string, now: number): void {
    const e = json(line);
    if (!e) return;
    const at = toMs(e.timestamp);
    if (at === null || at < this.o.since) return;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const kind = typeof p.type === "string" ? p.type : "";
    if (e.type === "session_meta" && typeof p.id === "string") { this.s = { ...this.s, session: p.id }; return; }
    this.s = { ...this.s, lastActivity: now };
    if (kind === "function_call" || kind === "custom_tool_call" || kind === "local_shell_call") {
      const args = typeof p.arguments === "string" ? p.arguments : typeof p.input === "string" ? p.input : JSON.stringify(p.action ?? "");
      const name = typeof p.name === "string" ? p.name : kind;
      if (typeof p.call_id === "string" && this.calls.size < 2_000) {
        // A code-mode script may run several tool operations; its one output cannot say which one exited (round 7).
        // Round 9 (Codex r7 3): a script counts as ONE operation only in the exact shape of a lone poll; aliases,
        // bracket access or anything else make it ambiguous (its output cannot complete a session).
        const ops = kind === "custom_tool_call" ? (singlePollScript(args) ? 1 : 2) : 1;
        this.calls.set(p.call_id, { name, ...callRefs(args.slice(0, 64 * 1024)), agents: AGENT_TOOLS.has(name) ? agentRefs(args) : [], what: `${name}: ${args}`.replace(/\s+/g, " ").slice(0, 80), ops });
      }
    }
    if (e.type === "event_msg" && /^collab_/.test(kind)) this.collabEvent(kind, p);
    else if (/_output$/.test(kind) || /_end$/.test(kind)) this.toolOutput(typeof p.call_id === "string" ? p.call_id : null, p.output ?? p);
    if (e.type === "event_msg" && kind === "task_started" && this.s.limit && at > this.s.limit.at) this.s = { ...this.s, promptAfterLimit: true };
    if (e.type === "response_item" && kind === "message" && p.role === "user" && this.s.limit && at > this.s.limit.at) this.s = { ...this.s, promptAfterLimit: true };
    if (kind === "token_count") {
      const r = parseCodexSessionTail(line);
      if (r) this.s = { ...this.s, reading: r };
      return;
    }
    if (kind === "task_complete" || kind === "turn_aborted") {
      const err = (p.error && typeof p.error === "object" ? p.error : null) as Record<string, unknown> | null;
      const msg = typeof err?.message === "string" ? err.message : "";
      if (err?.codex_error_info === "usage_limit_exceeded") {
        const fromWindows = this.s.reading?.windows.filter((w) => w.used_pct >= 100).map((w) => w.resets_at).filter((t): t is number => t !== null) ?? [];
        this.s = { ...this.s, limit: { at, until: codexRetryAt(msg) ?? (fromWindows.length ? Math.max(...fromWindows) : null), window: "usage" } }; // "reached its usage limit"
      } else if (err?.codex_error_info === "unauthorized") {
        this.s = { ...this.s, refused: { at } };
      } else if (err && RESUME_REFUSED_RE.test(msg)) {
        this.s = { ...this.s, resumeFailed: { at } };
      }
    }
  }
}

export function rolloutIn(files: readonly string[]): string | null {
  return files.find((f) => ROLLOUT_RE.test(f)) ?? null;
}

/** Every rollout file among a process's open files. */
export function rolloutsIn(files: readonly string[]): string[] {
  return files.filter((f) => ROLLOUT_RE.test(f));
}

/**
 * Whether a rollout is a root conversation (round 5, Codex 6): its session_meta names no parent thread and a user (not
 * subagent) source. An unreadable file or one without session_meta is not assumed to be one.
 */
export function rolloutIsRoot(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
    const e = JSON.parse(first) as { type?: unknown; payload?: Record<string, unknown> };
    if (e.type !== "session_meta" || !e.payload) return false;
    const p = e.payload;
    if (p.parent_thread_id || p.forked_from_id || p.parent_id) return false;
    if (p.thread_source !== undefined && p.thread_source !== "user") return false;
    if (p.source && typeof p.source === "object") return false; // {"subagent": …}
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
