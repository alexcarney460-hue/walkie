import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dlopen, FFIType, ptr } from "bun:ffi";

export interface ProcessRow { pid: number; ppid: number; pgid: number; started: string; marked: boolean }
export type ProcessLedger = Map<number, { pgid: number; started: string }>;

const PID_BUFFER_BYTES = 64 * 1024;
const BSD_INFO_BYTES = 136;
const ownUid = process.getuid?.();
let macSymbols: ReturnType<typeof loadMac> | undefined;
function loadMac() {
  return dlopen("/usr/lib/libproc.dylib", {
    proc_listpids: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_listchildpids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_listpgrppids: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  }).symbols;
}
function mac() { return macSymbols ??= loadMac(); }
function macPids(kind: "all" | "children" | "group", value = 0): number[] {
  const buffer = new Uint8Array(PID_BUFFER_BYTES);
  const fn = mac();
  const count = kind === "all" ? fn.proc_listpids(1, 0, ptr(buffer), buffer.byteLength) / 4
    : kind === "children" ? fn.proc_listchildpids(value, ptr(buffer), buffer.byteLength)
    : fn.proc_listpgrppids(value, ptr(buffer), buffer.byteLength);
  if (count <= 0) return [];
  if (count * 4 >= buffer.byteLength) throw new Error("libproc PID buffer full");
  const view = new DataView(buffer.buffer);
  const result: number[] = [];
  for (let offset = 0; offset / 4 < count; offset += 4) {
    const pid = view.getInt32(offset, true);
    if (pid > 0) result.push(pid);
  }
  return result;
}
function macRow(pid: number): ProcessRow | null {
  const buffer = new Uint8Array(BSD_INFO_BYTES);
  const bytes = mac().proc_pidinfo(pid, 3, 0, ptr(buffer), buffer.byteLength);
  if (bytes !== BSD_INFO_BYTES) return null;
  const view = new DataView(buffer.buffer);
  if (ownUid !== undefined && view.getUint32(20, true) !== ownUid) return null;
  return {
    pid: view.getUint32(12, true), ppid: view.getUint32(16, true), pgid: view.getUint32(100, true),
    started: `${view.getBigUint64(120, true)}.${view.getBigUint64(128, true)}`, marked: false,
  };
}
function linuxRow(pid: number): ProcessRow | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    if (ownUid !== undefined && Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) !== ownUid) return null;
    return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), started: fields[19] ?? "", marked: false };
  } catch { return null; }
}
function row(pid: number): ProcessRow | null { return process.platform === "darwin" ? macRow(pid) : linuxRow(pid); }
function allRows(): ProcessRow[] {
  const pids = process.platform === "darwin" ? macPids("all") : readdirSync("/proc").map(Number).filter((p) => Number.isInteger(p) && p > 0);
  return pids.flatMap((pid) => { const found = row(pid); return found ? [found] : []; });
}
function pollRows(root: number, ledger: ProcessLedger): ProcessRow[] {
  if (process.platform !== "darwin") return allRows();
  const seen = new Set<number>();
  const rootGroup = row(root)?.pgid;
  const queue = [root, ...ledger.keys()];
  const result: ProcessRow[] = [];
  for (let i = 0; i < queue.length; i++) {
    const parent = queue[i]!;
    if (seen.has(parent)) continue;
    seen.add(parent);
    const recorded = ledger.get(parent);
    if (recorded && row(parent)?.started !== recorded.started) continue;
    // Existing groups remain queryable after their leader exits.
    const group = ledger.get(parent)?.pgid;
    const children = macPids("children", parent);
    const members = group && group > 0 && group !== rootGroup ? macPids("group", group) : [];
    for (const pid of [...children, ...members]) {
      if (seen.has(pid)) continue;
      const found = row(pid);
      if (!found) continue;
      result.push(found);
      queue.push(pid);
    }
  }
  return result;
}
function markedPids(marker: string): Set<number> {
  if (process.platform === "linux") {
    const result = new Set<number>();
    for (const name of readdirSync("/proc")) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        if (readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`WALKIE_TALKIE_RUN=${marker}`)) result.add(pid);
      } catch { /* exited or inaccessible */ }
    }
    return result;
  }
  // Only the kill path inspects the environment. PID is numeric; no localized date or command is parsed.
  const ps = spawnSync("/bin/ps", ["-axwwE"], { encoding: "utf8", timeout: 2000, maxBuffer: 16 * 1024 * 1024,
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin" } });
  if (ps.status !== 0) return new Set();
  return new Set(ps.stdout.split("\n").flatMap((line) =>
    line.split(/\s+/).includes(`WALKIE_TALKIE_RUN=${marker}`) ? [Number(/^\s*(\d+)/.exec(line)?.[1])] : []));
}

export function rememberDescendants(root: number, _marker: string, ledger: ProcessLedger): void {
  const snapshot = pollRows(root, ledger);
  const rootGroup = row(root)?.pgid;
  const liveRecorded = [...ledger].filter(([pid, entry]) => row(pid)?.started === entry.started);
  const known = new Set([root, ...liveRecorded.map(([pid]) => pid)]);
  for (let i = 0; i < snapshot.length; i++) {
    let changed = false;
    for (const item of snapshot) if (known.has(item.ppid) && !known.has(item.pid)) { known.add(item.pid); changed = true; }
    if (!changed) break;
  }
  for (const item of snapshot) if (item.pid !== root && item.pid !== process.pid &&
    (known.has(item.pid) || (item.pgid !== rootGroup && liveRecorded.some(([, entry]) => entry.pgid === item.pgid)))) {
    ledger.set(item.pid, { pgid: item.pgid, started: item.started });
  }
}

export function selectRecordedTargets(snapshot: readonly ProcessRow[], ledger: ProcessLedger, self: number): { pids: number[]; pgids: number[] } {
  const live = snapshot.filter((item) => item.pid !== self && ledger.get(item.pid)?.started === item.started);
  const groups = new Set([...ledger.values()].map((entry) => entry.pgid));
  return { pids: live.map((item) => item.pid), pgids: [...new Set(live.filter((item) => groups.has(item.pgid) && item.pgid > 0 && item.pgid !== self).map((item) => item.pgid))] };
}

/** Only ESRCH means exited. The privileged uid helper owns cross-uid cleanup after EPERM. */
export function signalMarkedProcess(pid: number, signal: NodeJS.Signals,
  kill: (pid: number, signal: NodeJS.Signals) => boolean = process.kill,
  report: (line: string) => void = (line) => { process.stderr.write(`${line}\n`); }): void {
  try { kill(pid, signal); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    if (code === "EPERM") { report(`${signal} denied for ${pid < 0 ? "group" : "PID"} ${Math.abs(pid)} (EPERM); privileged uid cleanup is required`); return; }
    throw err;
  }
}

/** Stop descendants, then kill exact recorded PIDs and groups backed by a matching live member. */
export function killMarkedProcesses(root: number, marker: string, ledger: ProcessLedger = new Map()): number[] {
  if (!/^[0-9]+\.[0-9a-f-]{36}$/.test(marker)) return [];
  rememberDescendants(root, marker, ledger);
  const snapshot = allRows();
  const marked = markedPids(marker);
  const descendants = new Set([root]);
  for (let i = 0; i < snapshot.length; i++) {
    let changed = false;
    for (const item of snapshot) if (descendants.has(item.ppid) && !descendants.has(item.pid)) { descendants.add(item.pid); changed = true; }
    if (!changed) break;
  }
  const targets = snapshot.filter((item) => item.pid !== process.pid &&
    (marked.has(item.pid) || descendants.has(item.pid) || (root > 0 && item.pgid === root)));
  for (const item of targets) if (item.pid !== root) signalMarkedProcess(item.pid, "SIGSTOP");
  const latest = allRows();
  const recorded = selectRecordedTargets(latest, ledger, process.pid);
  const all = new Set([...targets.map((item) => item.pid), ...recorded.pids,
    ...latest.filter((item) => item.pid !== process.pid && marked.has(item.pid)).map((item) => item.pid)]);
  for (const pid of all) if (pid !== root) signalMarkedProcess(pid, "SIGSTOP");
  const ownGroup = row(process.pid)?.pgid;
  for (const pgid of recorded.pgids) if (pgid !== ownGroup) signalMarkedProcess(-pgid, "SIGKILL");
  for (const pid of all) signalMarkedProcess(pid, "SIGKILL");
  return [...all];
}
