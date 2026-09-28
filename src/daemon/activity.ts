// Is a discovered session working right now? (WALKIE-MISSION-1.) Headless seats (`claude -p`, `codex exec`) run
// without Walkie hooks, so discovery judges them from two cheap, local signals:
//   1. its session file: Claude's transcript (<config dir>/projects/<cwd slug>/<session>.jsonl, and its subagents'
//      files), Codex's open rollout file, Kimi's open .jsonl. A write in the last minute, or a turn still in progress
//      (the last record is a prompt, a tool call or a tool result), means working. Only the last TAIL_BYTES are read,
//      and only when the file changed.
//   2. CPU: the session's process tree (the CLI plus the tools it runs), from the `time` column of the one `ps` the
//      scan already runs. More than CPU_BUSY_RATIO of one core since the last scan means working.
// The tail also gives a short activity line (the last tool call: a fixed phrase, or its redacted text with
// share_activity), the model, and a title (the last prompt's first line, only with share_prompts). Nothing here leaves
// the machine except through the status discovery posts.
//
// Fix round 1 (WALKIE-MISSION-1 audits): CPU counts only for a session without a session file (a background dev server
// a finished turn left running is not the agent working, Opus B); slash commands, their output, meta records and
// bookkeeping records (queue-operation, ai-title, ...) are not activity, and an interrupt ends the turn (Opus 2 / 8);
// a last record longer than the tail window is read back to its start (Opus 4); and a session file is opened only when
// its id is a plain id, its path stays inside the config directory's projects, and it is a regular file of this user
// (Codex 4 / Opus 9).
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describeTool, titleFromPrompt } from "../hooks/activity.ts";
import type { ProcRow } from "./procs.ts";

/** A session file written this recently, or CPU used this recently, means working. */
export const ACTIVE_WINDOW_MS = 60_000;
/** A turn in progress (a model reply or a tool running) without any write for longer than this is not trusted. */
export const MID_TURN_MAX_MS = 10 * 60_000;
/** Share of one core the process tree must use between two scans to count as busy (an idle Claude CLI uses ~1-2 %). */
export const CPU_BUSY_RATIO = 0.08;
export const TAIL_BYTES = 32 * 1024;
/** A last record longer than TAIL_BYTES is read back to its start, up to this much. */
export const READ_BACK_MAX = 1024 * 1024;
const HEAD_BYTES = 64 * 1024;
/** A session id as Claude / Codex / Kimi write them (UUIDs); anything else is never made into a path. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/;
const MAX_TREE = 400;
const MAX_DIR_ENTRIES = 4_000;
const PROJECT_MISS_RETRY_MS = 60_000;

/** `ps -o time=`: macOS "M:SS.cc" (minutes may exceed 59), Linux "[DD-]HH:MM:SS". Milliseconds, or null. */
export function parseCpuTime(s: string): number | null {
  const m = /^(?:(\d+)-)?(\d+(?::\d+){0,2}(?:\.\d+)?)$/.exec(s.trim());
  if (!m) return null;
  const secs = (m[2] as string).split(":").reduce((acc, part) => acc * 60 + Number(part), 0);
  const total = (Number(m[1] ?? 0) * 86_400 + secs) * 1000;
  return Number.isFinite(total) ? Math.round(total) : null;
}

/** CPU share of one core used by each root's process tree since the previous sample (null on the first). */
export class CpuTracker {
  private prev = new Map<string, number>();
  private lastAt = new Map<number, number>();

  sample(rows: readonly ProcRow[], roots: readonly ProcRow[], now: number): Map<number, number | null> {
    const kids = new Map<number, ProcRow[]>();
    for (const r of rows) {
      const list = kids.get(r.ppid);
      if (list) list.push(r); else kids.set(r.ppid, [r]);
    }
    const next = new Map<string, number>();
    const out = new Map<number, number | null>();
    const nextAt = new Map<number, number>();
    for (const root of roots) {
      const since = this.lastAt.get(root.pid);
      let used = 0;
      const tree = [root];
      for (let i = 0; i < tree.length && tree.length < MAX_TREE; i++) tree.push(...(kids.get((tree[i] as ProcRow).pid) ?? []));
      for (const p of tree) {
        if (p.cpuMs === undefined || p.cpuMs === null) continue;
        const key = `${p.pid}:${p.startedAt ?? 0}`;
        next.set(key, p.cpuMs);
        const before = this.prev.get(key);
        // A process that appeared since the last sample (a tool the session just ran) counts in full.
        if (before !== undefined) used += Math.max(0, p.cpuMs - before);
        else if (since !== undefined && (p.startedAt ?? 0) >= since - 1_000) used += p.cpuMs;
      }
      out.set(root.pid, since !== undefined && now > since ? used / (now - since) : null);
      nextAt.set(root.pid, now);
    }
    this.prev = next;
    this.lastAt = nextAt;
    return out;
  }
}

/** What the end of a session file says. */
export interface TailInfo {
  /** A turn is in progress: the model is replying or a tool is running. */
  midTurn: boolean;
  /** The turn's last record is a tool call: a tool is running (a quiet one may write nothing for minutes). */
  toolRunning?: boolean;
  /**
   * The newest record is part of a turn (a prompt, a reply, a tool result, the turn's end). False when it is a slash
   * command, its output, a meta or a bookkeeping record: then the file's last write is not the agent working.
   */
  newestIsTurn?: boolean;
  /** When the newest turn record was written (its timestamp), if records carry one. */
  lastTurnAt?: number;
  /** No complete record could be read (a last record beyond READ_BACK_MAX): the caller keeps what it knew. */
  unknown?: boolean;
  /** At least one turn record was read (a window of bookkeeping records only says nothing about the turn). */
  turnSeen?: boolean;
  /** The last tool call, described like the hooks describe it ("Edit src/x.ts", "$ bun test"). */
  step?: string;
  model?: string;
  /** The last prompt's text (raw; titleOf() makes a title of it). */
  prompt?: string;
}

export type FileKind = "claude" | "codex" | "kimi" | "other";

interface Rec { [k: string]: unknown }

function records(text: string, fromStart: boolean): Rec[] {
  const lines = text.split("\n");
  if (!fromStart) lines.shift(); // a partial first line
  const out: Rec[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { const v = JSON.parse(l) as unknown; if (v && typeof v === "object") out.push(v as Rec); } catch { /* partial */ }
  }
  return out;
}

const obj = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});

/** A prompt a person (or a launcher) typed, not a tool result or an injected notice. */
function promptText(content: unknown): string | undefined {
  const text = typeof content === "string" ? content
    : Array.isArray(content) && content.every((c) => obj(c).type === "text") ? content.map((c) => String(obj(c).text ?? "")).join("\n") : undefined;
  if (!text || /^<[a-zA-Z]/.test(text.trim())) return undefined; // <task-notification>, <command-name>, reminders
  return text;
}

/** A slash command (/model, /usage), its output or its caveat: typed at the prompt, but no turn for the model. */
const LOCAL_COMMAND_RE = /^\s*<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/;

function userTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  return Array.isArray(content) ? content.map(obj).filter((c) => c.type === "text").map((c) => String(c.text ?? "")) : [];
}

/** A record written by the turn itself (not bookkeeping: queue-operation, ai-title, mode, attachment, ...). */
function claudeKind(r: Rec): "turn-user" | "interrupt" | "assistant" | "turn-end" | null {
  if (r.isSidechain === true) return null;
  if (r.type === "assistant") return "assistant";
  if (r.type === "user") {
    if (r.isMeta === true) return null;
    const texts = userTexts(obj(r.message).content);
    if (texts.some((t) => LOCAL_COMMAND_RE.test(t))) return null;
    if (texts.some((t) => t.trimStart().startsWith("[Request interrupted"))) return "interrupt";
    return "turn-user";
  }
  if (r.type === "system" && (r.subtype === "turn_duration" || r.subtype === "stop_hook_summary")) return "turn-end";
  return null;
}

function timeOf(r: Rec): number | undefined {
  const t = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

function claudeTail(recs: readonly Rec[], cwd: string, detail: boolean): TailInfo {
  const info: TailInfo = { midTurn: false, newestIsTurn: false };
  let decided = false;
  let newest = true;
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i] as Rec;
    const kind = claudeKind(r);
    if (newest && r.isSidechain !== true) { info.newestIsTurn = kind !== null; newest = false; }
    if (kind === null) continue;
    info.turnSeen = true;
    if (info.lastTurnAt === undefined) { const t = timeOf(r); if (t !== undefined) info.lastTurnAt = t; }
    const msg = obj(r.message);
    const content = Array.isArray(msg.content) ? (msg.content as unknown[]).map(obj) : [];
    if (kind === "assistant") {
      if (!decided) {
        info.midTurn = content.some((c) => c.type === "tool_use");
        info.toolRunning = info.midTurn;
        decided = true;
      }
      if (!info.model && typeof msg.model === "string" && !msg.model.startsWith("<")) info.model = msg.model.slice(0, 60); // not "<synthetic>"
      if (!info.step) {
        const tool = [...content].reverse().find((c) => c.type === "tool_use");
        if (tool && typeof tool.name === "string") info.step = describeTool(tool.name, obj(tool.input), typeof r.cwd === "string" ? r.cwd : cwd, detail);
      }
    } else if (kind === "turn-user") {
      if (!decided) { info.midTurn = true; decided = true; } // a prompt or a tool result: the model is replying
      if (!info.prompt) info.prompt = promptText(msg.content);
    } else if (!decided) {
      decided = true; // the turn ended (turn_duration / stop hook summary) or was interrupted (Esc)
    }
    if (decided && info.step && info.model && info.prompt && info.lastTurnAt !== undefined) break;
  }
  // tool_use with no tool_result after it (and no turn end since): still running, however quiet (Codex r3 #3).
  const open = openClaudeTools(recs).size;
  return open > 0 ? { ...info, toolRunning: true, midTurn: true } : info;
}

/** Tool calls still open after `recs`, starting from `init` (the calls open before them). */
export function openClaudeTools(recs: readonly Rec[], init: ReadonlySet<string> = new Set()): Set<string> {
  const open = new Set(init);
  for (const r of recs) {
    const kind = claudeKind(r);
    if (kind === null) continue;
    if (kind === "turn-end" || kind === "interrupt") { open.clear(); continue; }
    const content = Array.isArray(obj(r.message).content) ? (obj(r.message).content as unknown[]).map(obj) : [];
    if (kind === "assistant") {
      for (const c of content) if (c.type === "tool_use") open.add(typeof c.id === "string" ? c.id : `anon-${open.size}`);
    } else {
      const results = content.filter((c) => c.type === "tool_result");
      if (!results.length) { open.clear(); continue; } // a new prompt: a new turn
      for (const c of results) { if (typeof c.tool_use_id === "string") open.delete(c.tool_use_id); else open.clear(); }
    }
  }
  return open;
}

/** Codex's "code mode" runs a script calling tools.exec_command({cmd: "…"}), tools.write_stdin(…), … */
function codexScriptStep(input: string, detail: boolean): string | undefined {
  const cmd = /exec_command\(\s*\{\s*"?cmd"?\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
  if (cmd) {
    let text = cmd[1] as string;
    try { text = JSON.parse(`"${text}"`) as string; } catch { /* keep it escaped */ }
    return describeTool("Bash", { command: text }, "", detail);
  }
  if (/\bwrite_stdin\(/.test(input)) return "Waiting on a command's output";
  if (/\bapply_patch\b/.test(input)) return "Edit files";
  const tool = /tools\.(\w{1,60})\(/.exec(input);
  return tool ? describeTool(tool[1] as string, {}, "", detail) : undefined;
}

function codexStep(p: Rec, detail: boolean): string | undefined {
  const name = typeof p.name === "string" ? p.name : "";
  if (!name) return undefined;
  if (name === "apply_patch") return "Edit files";
  if (name === "wait" || name === "write_stdin") return "Waiting on a command's output";
  if (name === "sleep") return "Waiting";
  if (typeof p.input === "string") { const step = codexScriptStep(p.input, detail); if (step) return step; }
  let args: Rec = {};
  try { args = obj(typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments); } catch { /* not JSON */ }
  const cmd = args.cmd ?? args.command;
  if (cmd !== undefined) return describeTool("Bash", { command: Array.isArray(cmd) ? cmd.map(String).join(" ") : String(cmd) }, "", detail);
  return describeTool(name, {}, "", detail);
}

/** Codex events that are the turn itself; token_count, turn_context, session_meta, ... are bookkeeping (Codex r3 #5). */
const CODEX_END = new Set(["task_complete", "turn_aborted", "shutdown_complete"]);
const CODEX_START = new Set(["task_started", "user_message"]);
const CODEX_TURN_EVENTS = new Set([...CODEX_END, ...CODEX_START, "agent_message", "agent_reasoning", "exec_command_begin",
  "exec_command_end", "patch_apply_begin", "patch_apply_end", "mcp_tool_call_begin", "mcp_tool_call_end", "web_search_begin",
  "web_search_end", "exec_approval_request", "apply_patch_approval_request"]);
const CODEX_CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
const CODEX_OUTPUTS = new Set(["function_call_output", "custom_tool_call_output", "local_shell_call_output"]);

function codexKind(r: Rec): "end" | "start" | "turn" | null {
  const p = obj(r.payload);
  if (r.type === "response_item") return "turn";
  if (r.type !== "event_msg" || typeof p.type !== "string" || !CODEX_TURN_EVENTS.has(p.type)) return null;
  return CODEX_END.has(p.type) ? "end" : CODEX_START.has(p.type) ? "start" : "turn";
}

/** Tool calls of the tail with no output after them (and no turn end since): what is still running. */
export function openCodexCalls(recs: readonly Rec[], init: ReadonlySet<string> = new Set()): Set<string> {
  const open = new Set(init);
  for (const r of recs) {
    const kind = codexKind(r);
    const p = obj(r.payload);
    if (kind === "end" || kind === "start") { open.clear(); continue; }
    const id = typeof p.call_id === "string" ? p.call_id : typeof p.id === "string" ? p.id : "";
    if (r.type === "response_item" && CODEX_CALLS.has(String(p.type))) open.add(id || `anon-${open.size}`);
    else if (r.type === "response_item" && CODEX_OUTPUTS.has(String(p.type))) {
      if (id) open.delete(id); else open.clear();
    }
  }
  return open;
}

function codexTail(recs: readonly Rec[], detail: boolean): TailInfo {
  const info: TailInfo = { midTurn: false, newestIsTurn: false };
  let decided = false;
  let newest = true;
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i] as Rec;
    const kind = codexKind(r);
    if (newest) { info.newestIsTurn = kind !== null; newest = false; }
    const p = obj(r.payload);
    if (r.type === "turn_context" && !info.model && typeof p.model === "string") info.model = p.model.slice(0, 60);
    if (kind === null) continue;
    info.turnSeen = true;
    if (info.lastTurnAt === undefined) { const t = timeOf(r); if (t !== undefined) info.lastTurnAt = t; }
    if (r.type === "event_msg") {
      if (!decided && kind === "end") decided = true;
      else if (!decided && (kind === "start" || p.type === "agent_reasoning")) { info.midTurn = true; decided = true; }
      if (!info.prompt && p.type === "user_message" && typeof p.message === "string") info.prompt = p.message;
    } else if (r.type === "response_item") {
      if (!decided && p.type !== "message") { info.midTurn = true; decided = true; }
      if (!info.step && CODEX_CALLS.has(String(p.type))) info.step = codexStep(p, detail);
    }
    if (decided && info.step && info.model && info.prompt && info.lastTurnAt !== undefined) break;
  }
  // A call with no output after it: the tool is running, however long ago it started (Codex r2 #6 / r3 #3).
  const open = openCodexCalls(recs).size;
  return { ...info, ...(open > 0 ? { toolRunning: true, midTurn: true } : {}) };
}

// ---- Kimi Code (AGENT-SEE-1) ---------------------------------------------------------------------------------
// Kimi's wire.jsonl: {"type": "agent.turn.started" | "turn.prompt" | "llm.request" | "context.append_loop_event"
// (event.type "step.begin" | "tool.call" | "tool.result" | "step.end" | "content.part") | ... | "turn.ended" |
// "prompt.completed", "time": <ms>}. A `kimi -p` run is one long turn: started → steps → ended.

const KIMI_END = new Set(["turn.ended", "agent.turn.ended", "prompt.completed", "prompt.aborted"]);
const KIMI_START = new Set(["agent.turn.started", "turn.prompt"]);
const KIMI_TURN = new Set([...KIMI_END, ...KIMI_START, "context.append_loop_event", "llm.request", "agent.message.appended",
  "context.append_message", "turn.step.retrying"]);
/** Kimi's tool names that differ from Claude Code's (describeTool speaks Claude's). */
const KIMI_TOOL_ALIAS: Readonly<Record<string, string>> = { FetchURL: "WebFetch", TodoList: "TodoWrite", ReadMediaFile: "Read" };

function kimiKind(r: Rec): "end" | "start" | "turn" | null {
  const t = typeof r.type === "string" ? r.type : "";
  if (!KIMI_TURN.has(t)) return null;
  return KIMI_END.has(t) ? "end" : KIMI_START.has(t) ? "start" : "turn";
}

function kimiTime(r: Rec): number | undefined {
  return typeof r.time === "number" && Number.isFinite(r.time) ? r.time : undefined;
}

/** Tool calls of the tail with no result after them (and no turn end since). */
export function openKimiCalls(recs: readonly Rec[], init: ReadonlySet<string> = new Set()): Set<string> {
  const open = new Set(init);
  for (const r of recs) {
    const kind = kimiKind(r);
    if (kind === "end" || kind === "start") { open.clear(); continue; }
    if (r.type !== "context.append_loop_event") continue;
    const ev = obj(r.event);
    const id = typeof ev.toolCallId === "string" ? ev.toolCallId : "";
    if (ev.type === "tool.call") open.add(id || `anon-${open.size}`);
    else if (ev.type === "tool.result") { if (id) open.delete(id); else open.clear(); }
  }
  return open;
}

function kimiPrompt(r: Rec): string | undefined {
  if (r.type !== "turn.prompt" || !Array.isArray(r.input)) return undefined;
  return promptText(r.input);
}

function kimiTail(recs: readonly Rec[], cwd: string, detail: boolean): TailInfo {
  const info: TailInfo = { midTurn: false, newestIsTurn: false };
  let decided = false;
  let newest = true;
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i] as Rec;
    const kind = kimiKind(r);
    if (newest) { info.newestIsTurn = kind !== null; newest = false; }
    if (r.type === "llm.request" && !info.model && typeof r.model === "string") info.model = r.model.slice(0, 60);
    if (kind === null) continue;
    info.turnSeen = true;
    if (info.lastTurnAt === undefined) { const t = kimiTime(r); if (t !== undefined) info.lastTurnAt = t; }
    if (!decided) { info.midTurn = kind !== "end"; decided = true; }
    const ev = obj(r.event);
    if (!info.step && r.type === "context.append_loop_event" && ev.type === "tool.call" && typeof ev.name === "string") {
      info.step = describeTool(KIMI_TOOL_ALIAS[ev.name] ?? ev.name, obj(ev.args), cwd, detail);
    }
    if (!info.prompt) info.prompt = kimiPrompt(r);
    if (decided && info.step && info.model && info.prompt && info.lastTurnAt !== undefined) break;
  }
  const open = openKimiCalls(recs).size;
  return open > 0 ? { ...info, toolRunning: true, midTurn: true } : info;
}

/**
 * What the end of a session file says. `detail` (share_activity): the activity line is the tool call's redacted text;
 * otherwise a fixed phrase ("Running a command").
 */
export function parseTail(text: string, kind: FileKind, fromStart = false, cwd = "", detail = false): TailInfo {
  if (kind === "other") return { midTurn: false, newestIsTurn: true };
  const recs = records(text, fromStart);
  return kind === "claude" ? claudeTail(recs, cwd, detail) : kind === "kimi" ? kimiTail(recs, cwd, detail) : codexTail(recs, detail);
}

/**
 * A dashboard title from a prompt: its first line that says something (not an HTML comment or a bare tag), markdown
 * heading marks removed, secrets redacted, trimmed (like the hooks' titleFromPrompt).
 */
export function titleOf(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const line = prompt.split("\n").map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("<!--") && !/^<\/?[\w-]+>$/.test(l) && !/^[-=*_]{3,}$/.test(l));
  const t = line ? titleFromPrompt(line.replace(/^#+\s*/, "")) : "";
  return t || undefined;
}

/** A regular file of `uid` (not a FIFO, device or symlink): its size and last write; null otherwise. */
function statFile(path: string, uid: number | null): { mtime: number; size: number } | null {
  try {
    const s = lstatSync(path);
    if (!s.isFile() || (uid !== null && s.uid !== uid)) return null;
    return { mtime: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/**
 * Reads `length` bytes at `start`, opening without following a symlink and without blocking (a FIFO swapped in never
 * stalls the daemon), and only when the opened descriptor is a regular file of `uid`.
 */
function readRange(path: string, start: number, length: number, uid: number | null, root?: string): string | null {
  const buf = readBytes(path, start, length, uid, root);
  return buf === null ? null : buf.toString("utf8");
}

/** Bytes [start, start+length) of a file, with readRange's checks. */
function readBytes(path: string, start: number, length: number, uid: number | null, root?: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || (uid !== null && st.uid !== uid)) return null;
    // Containment bound to the OPENED file (Codex r2 #9): the path, resolved now, lies inside `root` and is the very
    // file the descriptor holds. A parent directory swapped for a symlink before or after the open fails one check.
    if (root !== undefined) {
      const real = realpathSync(path);
      const r = realpathSync(root);
      const at = statSync(real);
      if (!real.startsWith(r.endsWith(sep) ? r : r + sep) || at.ino !== st.ino || at.dev !== st.dev) return null;
    }
    const buf = Buffer.alloc(Math.max(0, Math.min(length, st.size - start)));
    const n = buf.byteLength ? readSync(fd, buf, 0, buf.byteLength, start) : 0;
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* closed */ }
  }
}

/** Up to `max` names in a directory, without reading the whole directory first (Codex r2 #12). */
export function listDir(dir: string, max: number): string[] {
  const out: string[] = [];
  let d: ReturnType<typeof opendirSync> | null = null;
  try {
    d = opendirSync(dir);
    for (let e = d.readSync(); e && out.length < max; e = d.readSync()) out.push(e.name);
  } catch { /* missing or unreadable */ } finally {
    try { d?.closeSync(); } catch { /* closed */ }
  }
  return out;
}

/** Chunks of growth followed per read (MAX_CHUNKS_PER_READ × READ_BACK_MAX bytes); the rest on the next scan. */
const MAX_CHUNKS_PER_READ = 16;

/** The offset of the next newline at or after `from` (scanning at most 16 MB), or null. */
function nextNewline(path: string, from: number, size: number, uid: number | null, root?: string): number | null {
  for (let at = from; at < size && at - from < 16 * 1024 * 1024; at += READ_BACK_MAX) {
    const buf = readBytes(path, at, Math.min(READ_BACK_MAX, size - at), uid, root);
    if (buf === null) return null;
    const nl = buf.indexOf(0x0a);
    if (nl >= 0) return at + nl;
  }
  return null;
}

/** Claude's project directory name for a working directory ("/Users/a/x.y" → "-Users-a-x-y"). */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** `path` resolves to a location inside `root` (both resolved: a symlinked project directory can't lead out). */
function inside(root: string, path: string): boolean {
  try {
    const r = realpathSync(root);
    const p = realpathSync(path);
    return p.startsWith(r.endsWith(sep) ? r : r + sep);
  } catch {
    return false;
  }
}

export interface SessionFilesOptions {
  /** share_activity: tool calls as their redacted text (default: fixed phrases). */
  detail?: boolean;
  /** Only files owned by this user are read (default: the daemon's own; null: any, tests only). */
  uid?: number | null;
}

/** Reads session files, caching by (path, mtime, size): an unchanged file is never read again. */
export class SessionFiles {
  private readonly tails = new Map<string, { mtime: number; size: number; info: TailInfo }>();
  /**
   * Tool calls still open per file, kept across reads (Codex r4 #4): the file is followed from `parsedTo` (a record
   * boundary) as it grows, so a call opened before the last 32 KB is not forgotten.
   */
  private readonly calls = new Map<string, { parsedTo: number; open: Set<string> }>();
  private readonly paths = new Map<string, { path: string | null; at: number }>();
  private readonly heads = new Map<string, string | undefined>();
  /** A transcript's containment root (<config dir>/projects), checked on every read of it. */
  private readonly roots = new Map<string, string>();
  private readonly detail: boolean;
  private readonly uid: number | null;

  constructor(opts: SessionFilesOptions = {}) {
    this.detail = opts.detail ?? false;
    this.uid = opts.uid === undefined ? process.getuid?.() ?? null : opts.uid;
  }

  /**
   * Claude's transcript for a session, found by the cwd slug first, else by looking through every project. Null for
   * a session id that isn't a plain id, or a file outside <configDir>/projects or not this user's regular file.
   */
  claudeTranscript(configDir: string, cwd: string | undefined, session: string, now: number): string | null {
    if (!SESSION_ID_RE.test(session)) return null;
    const key = `${configDir}\n${session}`;
    const hit = this.paths.get(key);
    const projects = join(configDir, "projects");
    const ok = (p: string) => !!statFile(p, this.uid) && inside(projects, p);
    if (hit?.path && ok(hit.path)) { this.roots.set(hit.path, projects); return hit.path; } // re-validated (Codex r2 #9)
    if (hit && !hit.path && now - hit.at < PROJECT_MISS_RETRY_MS) return null;
    const file = `${session}.jsonl`;
    let found: string | null = null;
    if (cwd) {
      const guess = join(projects, claudeProjectSlug(cwd), file);
      if (ok(guess)) found = guess;
    }
    if (!found) {
      try {
        for (const dir of listDir(projects, MAX_DIR_ENTRIES)) {
          const p = join(projects, dir, file);
          if (ok(p)) { found = p; break; }
        }
      } catch { /* no projects directory */ }
    }
    this.paths.set(key, { path: found, at: now });
    if (found) this.roots.set(found, projects);
    return found;
  }

  /** A session file a process holds open (Codex rollout, Kimi): only this user's regular .jsonl files. */
  openFile(path: string): string | null {
    return path.endsWith(".jsonl") && statFile(path, this.uid) ? path : null;
  }

  /** A Kimi session's wire.jsonl found on disk (kimi-sessions.ts): this user's regular file inside `root`, checked on every read. */
  kimiFile(path: string, root: string): string | null {
    if (!path.endsWith(".jsonl") || !statFile(path, this.uid) || !inside(root, path)) return null;
    this.roots.set(path, root);
    return path;
  }

  /** Newest write among a Claude session's subagent transcripts (<project>/<session>/subagents/*.jsonl). */
  subagentsMtime(transcript: string): number | null {
    const dir = join(transcript.replace(/\.jsonl$/, ""), "subagents");
    const names = listDir(dir, MAX_DIR_ENTRIES);
    if (!names.length) return null;
    let newest: number | null = null;
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const m = statFile(join(dir, n), this.uid);
      if (m && (newest === null || m.mtime > newest)) newest = m.mtime;
    }
    return newest;
  }

  /** The file's last write and what its tail says (re-read only when it changed). */
  read(path: string, kind: FileKind, cwd = ""): { mtime: number; info: TailInfo } | null {
    const st = statFile(path, this.uid);
    if (!st) { this.tails.delete(path); return null; }
    const cached = this.tails.get(path);
    if (cached && cached.mtime === st.mtime && cached.size === st.size) return { mtime: st.mtime, info: cached.info };
    let info: TailInfo;
    if (kind === "other") info = parseTail("", kind);
    else {
      const start = Math.max(0, st.size - TAIL_BYTES);
      const root = this.roots.get(path);
      const text = readRange(path, start, TAIL_BYTES, this.uid, root);
      if (text === null) return null;
      info = parseTail(text, kind, start === 0, cwd, this.detail);
      // No whole turn record in the window (one huge record, or a big one followed by bookkeeping): read further
      // back for turn evidence (Opus 4, Codex r2 #7).
      if (start > 0 && (!completeRecord(text) || !info.turnSeen)) info = this.readBack(path, st.size, kind, cwd, cached?.info, root);
      const open = this.openCalls(path, st.size, kind, root);
      if (open !== null) info = open > 0 ? { ...info, toolRunning: true, midTurn: true } : { ...info, toolRunning: false };
    }
    this.tails.set(path, { mtime: st.mtime, size: st.size, info });
    return { mtime: st.mtime, info };
  }

  /**
   * How many tool calls are open at the end of the file, following it from where it was last read; the first time
   * (or after it shrank or grew by more than READ_BACK_MAX), from its last READ_BACK_MAX bytes. Null: unreadable.
   */
  private openCalls(path: string, size: number, kind: FileKind, root?: string): number | null {
    const prev = this.calls.get(path);
    const track = (recs: Rec[], init: ReadonlySet<string>) => (kind === "claude" ? openClaudeTools(recs, init) : kind === "kimi" ? openKimiCalls(recs, init) : openCodexCalls(recs, init));
    if (prev && size >= prev.parsedTo) {
      // Follow the growth in consecutive chunks from a record boundary, never resetting what is known (Codex r5 #3).
      let at = prev.parsedTo;
      let open: Set<string> = prev.open;
      for (let chunks = 0; at < size && chunks < MAX_CHUNKS_PER_READ; chunks++) {
        const buf = readBytes(path, at, Math.min(READ_BACK_MAX, size - at), this.uid, root);
        if (buf === null) return null;
        const nl = buf.lastIndexOf(0x0a);
        if (nl < 0) {
          if (buf.byteLength < READ_BACK_MAX) break; // the last record is still being written
          // One record longer than a chunk: skip to its end (what it closes is not seen; what was open stays open).
          const next = nextNewline(path, at + buf.byteLength, size, this.uid, root);
          if (next === null) break;
          at = next + 1;
          continue;
        }
        open = track(records(buf.subarray(0, nl + 1).toString("utf8"), true), open);
        at += nl + 1;
      }
      this.calls.set(path, { parsedTo: at, open });
      return open.size;
    }
    // First read (or the file shrank): the last READ_BACK_MAX bytes, from their first record boundary.
    const from = Math.max(0, size - READ_BACK_MAX);
    const buf = size > from ? readBytes(path, from, size - from, this.uid, root) : Buffer.alloc(0);
    if (buf === null) return null;
    const first = from === 0 ? -1 : buf.indexOf(0x0a);
    const nl = buf.lastIndexOf(0x0a);
    if (from > 0 && (first < 0 || first === nl)) return prev ? prev.open.size : null; // inside one huge record
    const open = nl < 0 ? new Set<string>() : track(records(buf.subarray(first + 1, nl + 1).toString("utf8"), true), new Set());
    this.calls.set(path, { parsedTo: nl < 0 ? from : from + nl + 1, open });
    return open.size;
  }


  /**
   * The last record is longer than the tail window (a big tool result): read back to its start, up to READ_BACK_MAX.
   * Beyond that, what was known before stands (marked unknown), never "the turn ended".
   */
  private readBack(path: string, size: number, kind: FileKind, cwd: string, prev: TailInfo | undefined, root?: string): TailInfo {
    const start = Math.max(0, size - READ_BACK_MAX);
    const text = readRange(path, start, READ_BACK_MAX, this.uid, root);
    if (text !== null && (start === 0 || completeRecord(text))) {
      const info = parseTail(text, kind, start === 0, cwd, this.detail);
      if (start === 0 || info.turnSeen) return info;
    }
    return { ...(prev ?? { midTurn: false }), unknown: true };
  }

  /** The first prompt in a session file (read once per file): a title for a session whose tail has no prompt. */
  firstPrompt(path: string, kind: FileKind): string | undefined {
    if (this.heads.has(path)) return this.heads.get(path);
    const text = kind === "other" ? null : readRange(path, 0, HEAD_BYTES, this.uid, this.roots.get(path));
    let prompt: string | undefined;
    for (const r of text ? records(text, true) : []) {
      if (kind === "claude" && claudeKind(r) === "turn-user") prompt = promptText(obj(r.message).content);
      if (kind === "kimi") prompt = kimiPrompt(r);
      if (kind === "codex" && r.type === "event_msg" && obj(r.payload).type === "user_message") {
        const m = obj(r.payload).message;
        prompt = typeof m === "string" ? m : undefined;
      }
      if (prompt) break;
    }
    this.heads.set(path, prompt);
    return prompt;
  }

  /** Forget files no longer in use (bounded caches). */
  retain(paths: ReadonlySet<string>): void {
    for (const k of [...this.tails.keys()]) if (!paths.has(k)) this.tails.delete(k);
    for (const k of [...this.heads.keys()]) if (!paths.has(k)) this.heads.delete(k);
    for (const k of [...this.roots.keys()]) if (!paths.has(k)) this.roots.delete(k);
    for (const k of [...this.calls.keys()]) if (!paths.has(k)) this.calls.delete(k);
    for (const [k, v] of [...this.paths]) if (v.path && !paths.has(v.path)) this.paths.delete(k);
    if (this.paths.size > MAX_DIR_ENTRIES) this.paths.clear();
  }
}

/** A window read from the middle of a file holds at least one whole record (a newline after its partial first line). */
function completeRecord(text: string): boolean {
  const nl = text.indexOf("\n");
  return nl >= 0 && text.slice(nl + 1).trim().length > 0;
}

/** The verdict for one session from its signals. */
export interface Judgement {
  working: boolean;
  /** When it was last seen doing something (a file write or busy CPU); null = never seen active. */
  lastActiveAt: number | null;
}

/**
 * `fileAt`: the session file's last turn write (null: none seen). CPU (`lastBusyAt`) counts only for a session without
 * a session file (`hasFile` false): with one, a busy process tree after the turn ended is a background process.
 */
export function judge(now: number, fileAt: number | null, midTurn: boolean, lastBusyAt: number | null, hasFile = fileAt !== null): Judgement {
  const fileMtime = fileAt;
  const lastActiveAt = hasFile ? fileMtime ?? -Infinity : Math.max(fileMtime ?? -Infinity, lastBusyAt ?? -Infinity);
  const seen = Number.isFinite(lastActiveAt) ? lastActiveAt : null;
  const recent = seen !== null && now - seen <= ACTIVE_WINDOW_MS;
  const inTurn = midTurn && fileMtime !== null && now - fileMtime <= MID_TURN_MAX_MS;
  return { working: recent || inTurn, lastActiveAt: seen };
}
