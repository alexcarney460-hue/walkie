// AGENT-SEE-1: the Kimi Code session a running `kimi-code` process writes, found on disk. Kimi renames its process
// (its argv, prompt included, is gone) and holds no session file open, so discovery can't read the session from the
// process. Kimi keeps each session in <KIMI_CODE_HOME or ~/.kimi-code>/sessions/wd_<slug>_<sha256(cwd)[0:12]>/
// session_<uuid>/ with a state.json (id, cwd, createdAt, updatedAt) and agents/main/wire.jsonl (the event log). Kimi
// Code 0.37.2 (Linux) and 0.43.1 (macOS) use the same layout.
//
// Binding (Codex p8 #1): the processes of one directory and the sessions of its bucket are matched together, and only
// on unambiguous evidence. A process owns a session it CREATED: one created within CREATE_WINDOW_MS of the process's
// start, when no other process of that directory started about as near to it (CLEAR_MARGIN_MS) and the process has no
// second such session.
// A process that created none (it resumed one) owns the one session created before it started and written since, only
// when it is the only such process and that session the only candidate. Anything else stays unbound: the agent keeps its pid name rather
// than borrow another process's session, its activity and its exit.
//
// Every read is bounded by the scan's budget (ScanBudget: a deadline and a count of file operations, shared by the
// whole scan; Codex p8 #5), a bucket is listed once per scan whatever the number of processes in it, and paths are
// contained: built from a hash and names of a fixed grammar, and a wire.jsonl outside the sessions directory is refused
// (the reader checks containment again on the opened descriptor, activity.ts).
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { readSmallFile } from "../agent/safe-read.ts";
import { listDir } from "./activity.ts";

const MAX_BUCKET_ENTRIES = 4_000;
const MAX_SESSIONS_READ = 40;
const STATE_MAX = 64 * 1024;
/** A session created this long before its process was seen starting still counts (ps start times have 1 s resolution). */
export const START_SLACK_MS = 15_000;
/**
 * Kimi creates its session as it starts (its first log line follows within about a second): one created later than
 * this after the process started is another process's. A slower start only leaves the process unbound.
 */
export const CREATE_WINDOW_MS = 20_000;
/** Of two processes that could have created a session, the nearer start wins only by at least this much. */
export const CLEAR_MARGIN_MS = 10_000;
const SESSION_DIR_RE = /^session_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** One scan's shared limit on Kimi's file operations: a wall-clock deadline and a number of stats / reads. */
export class ScanBudget {
  private ops = 0;
  constructor(private readonly deadline: number, private readonly maxOps: number, private readonly now: () => number = Date.now) {}
  /** Takes `n` operations; false (and nothing may be read) once the deadline passed or the operations ran out. */
  take(n = 1): boolean {
    if (this.ops + n > this.maxOps || this.now() >= this.deadline) { this.ops = this.maxOps; return false; }
    this.ops += n;
    return true;
  }
  get spent(): boolean { return this.ops >= this.maxOps || this.now() >= this.deadline; }
}

export interface KimiSession {
  /** The session's UUID (the "session_" prefix removed): the agent is named kimi-<first six>. */
  id: string;
  /** Its event log (agents/main/wire.jsonl). */
  file: string;
  /** The sessions directory the file must stay inside. */
  root: string;
  createdAt: number;
  updatedAt: number;
}

/** Kimi's bucket hash for a working directory: sha256 of the path without a trailing slash, 12 hex characters. */
export function kimiBucketHash(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

/** A Kimi session id as Kimi writes it ("session_<uuid>") or bare: the UUID, or null. */
export function kimiSessionUuid(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = /^(?:session_)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(raw.trim());
  return m ? (m[1] as string).toLowerCase() : null;
}

function isDir(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

function mtimeOf(path: string): number {
  try { return lstatSync(path).mtimeMs; } catch { return 0; }
}

interface StateRow extends KimiSession { cwd: string }

function readState(dir: string, root: string, uid: number | null): StateRow | null {
  const text = readSmallFile(join(dir, "state.json"), STATE_MAX, uid);
  if (text === null) return null;
  try {
    const s = JSON.parse(text) as { id?: unknown; cwd?: unknown; createdAt?: unknown; updatedAt?: unknown };
    const id = typeof s.id === "string" ? kimiSessionUuid(s.id) : null;
    if (!id || typeof s.cwd !== "string" || typeof s.createdAt !== "number" || !Number.isFinite(s.createdAt)) return null;
    const updatedAt = typeof s.updatedAt === "number" && Number.isFinite(s.updatedAt) ? s.updatedAt : s.createdAt;
    return { id, file: join(dir, "agents", "main", "wire.jsonl"), root, createdAt: s.createdAt, updatedAt, cwd: s.cwd.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

/**
 * The sessions of `cwd` in a Kimi home (newest MAX_SESSIONS_READ per bucket), or null when the budget ran out before
 * the listing was complete (then nothing is bound this scan: a partial listing could make an ambiguous match look sure).
 */
export function listKimiSessions(home: string, cwd: string, uid: number | null, budget: ScanBudget): KimiSession[] | null {
  const root = join(home, "sessions");
  const want = cwd.replace(/\/+$/, "");
  const suffix = `_${kimiBucketHash(want)}`;
  if (!budget.take()) return null;
  const buckets = listDir(root, MAX_BUCKET_ENTRIES).filter((n) => n.startsWith("wd_") && n.endsWith(suffix) && !n.includes(".."));
  const out: KimiSession[] = [];
  for (const b of buckets) {
    const bdir = join(root, b);
    if (!budget.take()) return null;
    if (!isDir(bdir)) continue;
    const names = listDir(bdir, MAX_BUCKET_ENTRIES).filter((n) => SESSION_DIR_RE.test(n));
    if (!budget.take(names.length)) return null;
    const dirs = names.map((n) => join(bdir, n)).map((d) => ({ d, m: mtimeOf(d) })).sort((x, y) => y.m - x.m).slice(0, MAX_SESSIONS_READ);
    for (const { d } of dirs) {
      if (!budget.take()) return null;
      const st = readState(d, root, uid);
      if (st && st.cwd === want) out.push({ id: st.id, file: st.file, root: st.root, createdAt: st.createdAt, updatedAt: st.updatedAt });
    }
  }
  return out;
}

/** A running Kimi process of one directory, to be matched: its key (pid:start) and start time. */
export interface KimiProc { key: string; startedAt: number | null }

/**
 * Matches the unbound processes of one directory to its sessions (see the header): only unambiguous pairs, never a
 * session in `taken` (bound to another running process). Pure.
 *
 * A session's possible creators are the processes whose start lies within [createdAt - CREATE_WINDOW_MS, createdAt +
 * START_SLACK_MS]; with several, the nearest start wins only when it is CLEAR_MARGIN_MS nearer than the next, else
 * nobody gets it. A process given exactly one session owns it. Then a resumed session: the one process left without a
 * created session, and the one session created before it started and written since.
 */
export function assignKimiSessions(procs: readonly KimiProc[], sessions: readonly KimiSession[], taken: ReadonlySet<string>): Map<string, KimiSession> {
  const free = sessions.filter((s) => !taken.has(s.id));
  const creatable = new Set<string>();
  const given = new Map<string, KimiSession[]>();
  for (const s of free) {
    const near = procs.flatMap((p) => {
      if (p.startedAt === null || s.createdAt < p.startedAt - START_SLACK_MS || s.createdAt > p.startedAt + CREATE_WINDOW_MS) return [];
      return [{ p, d: Math.abs(s.createdAt - p.startedAt) }];
    }).sort((x, y) => x.d - y.d);
    if (!near.length) continue;
    creatable.add(s.id);
    const [best, next] = near;
    if (!best || (next && next.d - best.d < CLEAR_MARGIN_MS)) continue; // two could have created it
    given.set(best.p.key, [...(given.get(best.p.key) ?? []), s]);
  }
  const out = new Map<string, KimiSession>();
  for (const [key, list] of given) if (list.length === 1) out.set(key, list[0] as KimiSession);
  const resuming = procs.filter((p) => !given.has(p.key));
  if (resuming.length === 1) {
    const p = resuming[0] as KimiProc;
    const since = p.startedAt === null ? -Infinity : p.startedAt - START_SLACK_MS;
    // A resumed session existed before the process started, and has been written since.
    const cands = free.filter((s) => !creatable.has(s.id) && s.createdAt < since && s.updatedAt >= since);
    if (cands.length === 1) out.set(p.key, cands[0] as KimiSession);
  }
  return out;
}

/** The session's wire.jsonl lies (resolved) inside the sessions directory (resolved): no symlink leads out. */
export function containedWire(s: KimiSession): boolean {
  try {
    const r = realpathSync(s.root);
    const p = realpathSync(s.file);
    return p.startsWith(r.endsWith(sep) ? r : r + sep);
  } catch {
    return false;
  }
}
