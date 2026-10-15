// Linux-only. The seats probe calls prctl(PR_SET_CHILD_SUBREAPER) so a detached descendant stays our child
// (oss-runtime.ts). That flag is process-wide and is never cleared. After the parent dies, the orphan is
// reparented here; a later SIGKILL leaves it a zombie until some waitpid collects it. Bun and node wait only
// for the pids they spawned, so those zombies accumulate, and kill(-pgid, 0) still succeeds on them
// (WALK-175). waitpid(-1) would also collect a Bun or node child and steal its exit status, so this reaps
// only zombies whose pid this process did not spawn.
import { readFileSync, readdirSync } from "node:fs";
import { dlopen, FFIType, ptr } from "bun:ffi";

const WNOHANG = 1;
/** How often a long-running daemon collects adopted zombies when nobody is inside a reap poll. */
const SWEEP_MS = 200;

const owned = new Set<number>();
/** Start ticks for a pre-prctl snapshot pid. A reused pid has different ticks and must leave `owned`. */
const snapshotStart = new Map<number, string>();
let subreaper = false;
let trackingArmed = false;
let sweepStarted = false;
let spawnWrapped = false;
let waitpidFn: ((pid: number, status: ReturnType<typeof ptr>, options: number) => number) | null | undefined;

/** Remember a pid Bun or node is going to wait for. `released` resolves after that owner has collected it. */
export function noteOwnedChild(pid: number | undefined, released: Promise<unknown>): void {
  if (pid === undefined || pid <= 0) return;
  owned.add(pid);
  const got = process.platform === "linux" ? procFields(pid) : "unreadable";
  const start = got === "gone" || got === "unreadable" ? undefined : startTicks(got.fields);
  // A reused pid must not keep the previous snapshot. Record this process, and let the promise drop only that one.
  if (start !== undefined) snapshotStart.set(pid, start);
  void released.finally(() => {
    if (snapshotStart.get(pid) !== start) return;
    owned.delete(pid);
    if (start !== undefined) snapshotStart.delete(pid);
  });
}

/** node:child_process's spawn export is read-only, so each call site notes the child. `exit` fires after node reaps. */
export function noteChildProcess(child: { pid?: number; once(event: "exit", listener: () => void): unknown }): void {
  noteOwnedChild(child.pid, new Promise((resolve) => { child.once("exit", () => resolve(undefined)); }));
}

/** "gone" is ENOENT (already reaped). "unreadable" stays owned so a transient /proc error is not treated as an exit. */
function procFields(pid: number): { fields: string[] } | "gone" | "unreadable" {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return { fields: stat.slice(stat.lastIndexOf(")") + 2).split(" ") };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unreadable";
  }
}

/** `/proc` stat field 22. Same slice as `fields[0]` = state, so start ticks are `fields[19]`. */
function startTicks(fields: string[]): string | undefined {
  const ticks = fields[19];
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : undefined;
}

function directChildRecords(): { pid: number; start: string | undefined }[] {
  let entries: string[];
  try { entries = readdirSync("/proc"); }
  catch { return []; }
  const rows: { pid: number; start: string | undefined }[] = [];
  for (const entry of entries) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    const got = procFields(Number(entry));
    if (got !== "gone" && got !== "unreadable" && Number(got.fields[1]) === process.pid) {
      rows.push({ pid: Number(entry), start: startTicks(got.fields) });
    }
  }
  return rows;
}

function directChildPids(): number[] {
  return directChildRecords().map((row) => row.pid);
}

/**
 * Own a direct child from the pre-prctl snapshot. `startTicks` is the value read with that snapshot.
 * A later row with different ticks is a reused pid: `forgetGoneOwned` drops it so the new process can be waitpid'd.
 * No start ticks means no identity, so the pid is not owned.
 */
export function noteSnapshotIdentity(pid: number, startTicks: string | undefined): void {
  if (!(pid > 0) || startTicks === undefined || !/^\d+$/.test(startTicks)) return;
  owned.add(pid);
  snapshotStart.set(pid, startTicks);
}

function forgetGoneOwned(): void {
  for (const pid of owned) {
    const got = procFields(pid);
    if (got === "gone") {
      owned.delete(pid);
      snapshotStart.delete(pid);
      continue;
    }
    if (got === "unreadable") continue;
    const recorded = snapshotStart.get(pid);
    if (recorded === undefined) continue;
    const now = startTicks(got.fields);
    if (now !== undefined && now !== recorded) {
      owned.delete(pid);
      snapshotStart.delete(pid);
    }
  }
}

function loadWaitpid(): ((pid: number, status: ReturnType<typeof ptr>, options: number) => number) | null {
  if (waitpidFn !== undefined) return waitpidFn;
  try {
    waitpidFn = dlopen("libc.so.6", {
      waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    }).symbols.waitpid;
  } catch {
    waitpidFn = null;
  }
  return waitpidFn;
}

/**
 * Collect adopted zombies (state Z or X, parented here, not a pid we spawned). Returns how many waitpid reaped.
 * Live children are left in place so subreaper custody of a detached descendant still works. No-op until tracking
 * is armed, and no-op off Linux: reaping without a record of spawned pids would steal Bun's children.
 */
export function reapAdoptedZombies(): number {
  if (process.platform !== "linux" || !trackingArmed) return 0;
  const waitpid = loadWaitpid();
  if (!waitpid) return 0;
  forgetGoneOwned();
  let reaped = 0;
  for (const pid of directChildPids()) {
    if (owned.has(pid)) continue;
    const got = procFields(pid);
    if (got === "gone" || got === "unreadable") continue;
    const fields = got.fields;
    if ((fields[0] !== "Z" && fields[0] !== "X") || Number(fields[1]) !== process.pid) continue;
    const status = new Int32Array(1);
    if (waitpid(pid, ptr(status), WNOHANG) === pid) reaped++;
  }
  return reaped;
}

/** PR_SET_CHILD_SUBREAPER. Throws when libc refuses; a second call is a no-op. */
export function enableLinuxChildSubreaper(): void {
  if (process.platform !== "linux" || subreaper) return;
  const libc = dlopen("libc.so.6", {
    prctl: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  if (libc.symbols.prctl(36, 1, 0, 0, 0) !== 0) throw new Error("prctl failed"); // PR_SET_CHILD_SUBREAPER
  subreaper = true;
}

function wrapBunSpawn(): void {
  if (spawnWrapped) return;
  spawnWrapped = true;
  const current = Bun.spawn;
  Bun.spawn = ((...args: unknown[]) => {
    const proc = (current as (...a: unknown[]) => ReturnType<typeof Bun.spawn>)(...args);
    noteOwnedChild(proc.pid, proc.exited);
    return proc;
  }) as typeof Bun.spawn;
}

function armTracking(rows: readonly { pid: number; start: string | undefined }[]): void {
  if (process.platform !== "linux" || trackingArmed) return;
  wrapBunSpawn();
  for (const row of rows) noteSnapshotIdentity(row.pid, row.start);
  trackingArmed = true;
}

/**
 * Wrap later Bun.spawn calls. `preSubreaperChildren` is the direct-child set taken before prctl.
 * Each pid is owned with the start ticks from that read. A reused pid's ticks differ, so it leaves `owned`
 * and can be waitpid'd. A scan after prctl can put an adopted descendant into `owned`. Pass the snapshot,
 * or call this only before prctl. After prctl, an omitted list owns nobody.
 */
export function armAdoptedZombieTracking(preSubreaperChildren?: readonly number[]): void {
  if (preSubreaperChildren) {
    armTracking(preSubreaperChildren.map((pid) => {
      const got = procFields(pid);
      return { pid, start: got === "gone" || got === "unreadable" ? undefined : startTicks(got.fields) };
    }));
    return;
  }
  armTracking(subreaper ? [] : directChildRecords());
}

/** Unref'd sweep so a daemon that is not inside ClaudeChild.reap still collects adopted zombies. */
export function startAdoptedZombieSweep(): void {
  if (process.platform !== "linux" || sweepStarted) return;
  sweepStarted = true;
  const timer = setInterval(() => { try { reapAdoptedZombies(); } catch { /* one bad /proc read is not fatal */ } }, SWEEP_MS);
  (timer as { unref?: () => void }).unref?.();
}

/** What the seats probe turns on: subreaper, spawn tracking, and the sweep. */
export function installLinuxChildSubreaper(): void {
  if (process.platform !== "linux") return;
  // Wrap before the snapshot so a spawn cannot fall between the list and tracking.
  wrapBunSpawn();
  if (!subreaper && !trackingArmed) {
    const existing = directChildRecords();
    enableLinuxChildSubreaper();
    armTracking(existing);
  } else {
    enableLinuxChildSubreaper();
    armAdoptedZombieTracking();
  }
  startAdoptedZombieSweep();
}
