// Claude's process group, remembered across a daemon crash (ORCH-FIX-13, Opus r13 MEDIUM). ClaudeChild ends the whole
// group when it stops, but a daemon that dies abruptly (SIGKILL, a panic) never gets to: Claude sees its stdin close
// and exits, and what its tools started keeps running. So the host records each group it starts (the leader's pid =
// the group id, its start time and command) in orchestrator.json, and the next daemon start ends a recorded group
// only once it is sure the group is still the one it started.
import { spawnSync } from "node:child_process";
import { killMarkedProcesses } from "./marked-processes.ts";

export interface GroupRecord {
  /** The group id: the leader's (Claude's) pid. */
  pgid: number;
  /** The leader's start time as `ps -o lstart=` prints it. */
  started: string;
  /** The leader's command as `ps -o comm=` prints it. */
  comm: string;
  marker?: string;
}

export interface ProcRow { pid: number; pgid: number; uid: number; started: string; comm: string }

/** `ps` rows: pid, pgid, uid, start time (five words) and command. */
export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split("\n")) {
    const w = line.trim().split(/\s+/);
    if (w.length < 9) continue;
    const [pid, pgid, uid] = [Number(w[0]), Number(w[1]), Number(w[2])];
    if (![pid, pgid, uid].every(Number.isInteger)) continue;
    rows.push({ pid, pgid, uid, started: w.slice(3, 8).join(" "), comm: w.slice(8).join(" ") });
  }
  return rows;
}

function ps(args: string[]): string {
  const r = spawnSync("ps", args, { encoding: "utf8", timeout: 5_000 });
  return r.status === 0 ? r.stdout : "";
}

/** The record for a group whose leader is `pid` (just spawned), or null when `ps` can't see it. */
export function recordGroup(pid: number, marker?: string): GroupRecord | null {
  const row = parsePs(ps(["-o", "pid=,pgid=,uid=,lstart=,comm=", "-p", String(pid)])).find((r) => r.pid === pid);
  return row && row.pgid === pid ? { pgid: pid, started: row.started, comm: row.comm, ...(marker ? { marker } : {}) } : null;
}

/** `ps` start times ("Sat Sep 26 20:16:01 2026") as epoch ms (local time), or NaN. */
export function startMs(started: string): number {
  const w = started.split(" ");
  return w.length === 5 ? new Date(`${w[1]} ${w[2]} ${w[4]} ${w[3]}`).getTime() : Number.NaN;
}

/**
 * The pids of `rec`'s group if it is still the group this host started, else [] (pure: `rows` from `ps`).
 * - Its leader is alive: it must have the recorded start time and command (a reused pid is someone else's leader).
 * - Its leader is gone but members are left (Claude exited when its daemon died; its tools didn't): a group id can't be
 *   reused while any member lives, so the group is the same one, unless it emptied and a new group got the id since.
 *   Such a new group has members that started after `before` (this daemon's start) or before the recorded leader, or
 *   of another user; any of those makes the whole group someone else's.
 */
export function stillOurs(rec: GroupRecord, rows: readonly ProcRow[], uid: number, before: number): number[] {
  const members = rows.filter((r) => r.pgid === rec.pgid);
  if (!members.length) return [];
  const leader = members.find((r) => r.pid === rec.pgid);
  if (leader) return leader.started === rec.started && leader.comm === rec.comm && leader.uid === uid ? members.map((r) => r.pid) : [];
  const from = startMs(rec.started);
  if (!Number.isFinite(from)) return [];
  const ours = members.every((r) => r.uid === uid && startMs(r.started) >= from && startMs(r.started) <= before);
  return ours ? members.map((r) => r.pid) : [];
}

/**
 * Ends the recorded groups that are still ours (SIGTERM, then SIGKILL after `graceMs`); returns the pids signalled.
 * Called once at daemon start, before this host starts a new Claude.
 */
export async function endStaleGroups(recs: readonly GroupRecord[], graceMs = 2_000): Promise<number[]> {
  if (!recs.length) return [];
  const uid = process.getuid?.() ?? -1;
  const before = Date.now();
  const rows = parsePs(ps(["-A", "-o", "pid=,pgid=,uid=,lstart=,comm="]));
  const marked = recs.filter((rec) => rec.marker);
  const markedPids = marked.flatMap((rec) => killMarkedProcesses(
    stillOurs(rec, rows, uid, before).includes(rec.pgid) ? rec.pgid : 0, rec.marker!));
  const groups = recs.filter((rec) => !rec.marker && stillOurs(rec, rows, uid, before).length > 0);
  const pids = groups.flatMap((rec) => stillOurs(rec, rows, uid, before));
  for (const g of groups) { try { process.kill(-g.pgid, "SIGTERM"); } catch { /* gone */ } }
  if (!groups.length) return markedPids;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && groups.some((g) => alive(-g.pgid))) await Bun.sleep(50);
  for (const g of groups) { try { process.kill(-g.pgid, "SIGKILL"); } catch { /* gone */ } }
  return [...markedPids, ...pids];
}

function alive(pidOrGroup: number): boolean {
  try { process.kill(pidOrGroup, 0); return true; } catch { return false; }
}
