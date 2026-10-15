// No native provider access. Only injected source fixtures may assemble a launch in this phase.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { installLinuxChildSubreaper, noteChildProcess } from "../adopted-zombies.ts";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { OSS_NATIVE_HELD } from "./oss.ts";
import { workerRootOccupied } from "./worker-root.ts";

export const OSS_SYSTEM_CONFIG_PATHS = ["/etc/codex", "/Library/Managed Preferences/com.openai.codex.plist"] as const;
// This conservative inventory is not an exact-build native configuration attestation.
export interface OssFixtureRuntime {
  /** Source-only dependency injection, never a config/API/env option or native approval. */
  evidence: "fake-runtime-only";
  binary: string;
  path: string;
  configKnowledge: "fixture-only";
  inspectConfig: (cwd: string) => void;
  readiness: (model: string, signal: AbortSignal) => Promise<{ service: boolean; model: boolean; resources: boolean }>;
  /** Source fixture process inventory; never native admission evidence. */
  probeReaders?: DarwinProbeReaders;
}

/** A native adapter is intentionally absent. Unknown knowledge never auto-enables a new release. */
export function requireOssFixture(runtime?: OssFixtureRuntime): OssFixtureRuntime {
  if (!runtime || runtime.evidence !== "fake-runtime-only" || runtime.configKnowledge !== "fixture-only") throw new Error(OSS_NATIVE_HELD);
  return runtime;
}

export function binaryIdentity(binary: string): string {
  if (!isAbsolute(binary)) throw new Error("OSS executable must be absolute");
  const real = realpathSync(binary);
  const st = lstatSync(real);
  if (!st.isFile() || !(st.mode & 0o111) || st.size > 256 * 1024 * 1024) throw new Error("unsupported OSS executable identity");
  return [real, st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs, st.mode,
    createHash("sha256").update(readFileSync(real)).digest("hex")].join(":");
}

/** Directory components may not redirect a config inspection through a symlink. No contents of config/auth are read. */
function metadata(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("OSS configuration inspection failed"); }
}
function chain(path: string): string[] {
  if (!isAbsolute(path)) throw new Error("OSS config path must be absolute");
  const result: string[] = [];
  for (let p = resolve(path); ; p = dirname(p)) { result.push(p); if (dirname(p) === p) return result; }
}
export interface OssConfigInspection { metadata: typeof metadata; readText: (path: string) => string }
const nativeInspection: OssConfigInspection = { metadata, readText: (p) => readFileSync(p, "utf8") };
function refusePresent(path: string, inspection: OssConfigInspection): void {
  const { metadata } = inspection;
  for (const p of chain(path)) if (metadata(p)?.isSymbolicLink()) throw new Error("OSS config path is symlinked");
  if (metadata(path)) throw new Error("external Codex configuration is present; OSS held");
}
/** Conservative superset; native coverage is still UNVERIFIED. Tests supply synthetic system roots. */
export function inspectOssConfig(cwd: string, systemPaths: readonly string[], inspection: OssConfigInspection = nativeInspection): void {
  const { metadata, readText } = inspection;
  for (const p of systemPaths) refusePresent(p, inspection);
  for (const dir of chain(cwd)) {
    if (metadata(dir)?.isSymbolicLink()) throw new Error("OSS workspace ancestor is symlinked");
    refusePresent(join(dir, ".codex"), inspection);
    const dotgit = join(dir, ".git");
    const st = metadata(dotgit);
    if (!st) continue;
    if (st.isSymbolicLink()) throw new Error("OSS git metadata is symlinked");
    let gitdir = dotgit;
    if (st.isFile()) {
      if (st.size > 4096) throw new Error("unknown OSS worktree metadata");
      const m = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(readText(dotgit));
      if (!m) throw new Error("unknown OSS worktree metadata");
      gitdir = resolve(dir, m[1]!);
    } else if (!st.isDirectory()) throw new Error("unknown OSS git metadata");
    for (const p of chain(gitdir)) {
      if (metadata(p)?.isSymbolicLink()) throw new Error("OSS common git directory is symlinked");
      refusePresent(join(p, ".codex"), inspection);
    }
    const common = join(gitdir, "commondir");
    const cs = metadata(common);
    if (cs) {
      if (!cs.isFile() || cs.isSymbolicLink() || cs.size > 4096) throw new Error("unknown OSS common directory");
      const value = readText(common).trim();
      if (!value || /[\x00-\x1f]/.test(value)) throw new Error("unknown OSS common directory");
      for (const p of chain(resolve(gitdir, value))) {
        if (metadata(p)?.isSymbolicLink()) throw new Error("OSS common directory is symlinked");
        refusePresent(join(p, ".codex"), inspection);
      }
    }
  }
}

/** Closing our pipes bounds waiting; it does not establish descendant absence or containment. */
export class OssProbeFailure extends Error {
  readonly cleanupUncertain = true;
  constructor(why: string) { super(`${why}; probe descendant cleanup is uncertain`); }
}

/** A live group member reserves the PGID. Zombies cannot execute or retain the worker root. */
function probeGroupLive(pgid: number): boolean | null {
  try { process.kill(-pgid, 0); }
  catch (err) { return (err as NodeJS.ErrnoException).code === "ESRCH" ? false : null; }
  if (process.platform !== "linux") return true;
  try {
    let found = false;
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let stat: string;
      try { stat = readFileSync(`/proc/${entry}/stat`, "utf8"); }
      catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; return null; }
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) !== pgid) continue;
      found = true;
      if (fields[0] !== "Z" && fields[0] !== "X") return true;
    }
    return found ? false : null;
  } catch { return null; }
}

async function reapProbeGroup(pgid: number): Promise<boolean> {
  if (process.platform === "darwin") {
    // The leader has exited; a saved PGID may now name an unrelated group.
    for (let i = 0; i < 25; i++) {
      if (probeGroupLive(pgid) === false) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return false;
  }
  // Signal first: a pre-signal /proc scan could miss a member forked during enumeration.
  try { process.kill(-pgid, "SIGKILL"); }
  catch (err) { return (err as NodeJS.ErrnoException).code === "ESRCH"; }
  for (let i = 0; i < 25; i++) {
    if (probeGroupLive(pgid) === false) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

let probeSubreaper = false;
function ensureProbeSubreaper(): void {
  if (process.platform !== "linux" || probeSubreaper) return;
  try {
    // Sets PR_SET_CHILD_SUBREAPER and collects adopted zombies. The direct probe child stays node's to reap.
    installLinuxChildSubreaper();
    probeSubreaper = true;
  } catch { throw new OssProbeFailure("OSS probe descendant custody unavailable"); }
}

export interface DarwinProcess { pid: number; ppid: number; pgid: number; sess: number; uid: number; stat: string; started: string; psStarted?: string }
export interface DarwinProbeReaders {
  inventory: () => Map<number, DarwinProcess>;
  session: (pid: number) => number | null;
  identity: (pid: number) => string | null;
}

const BSD_INFO_BYTES = 136;
const PS_IDENTITY_UNAVAILABLE = "ps-identity-unavailable";
let procInfo: ReturnType<typeof loadProcInfo> | undefined;
function loadProcInfo() {
  try {
    return dlopen("/usr/lib/libproc.dylib", {
      proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    }).symbols;
  } catch { throw new OssProbeFailure("OSS probe libproc unavailable"); }
}
function processGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function processInert(pid: number): boolean {
  if (processGone(pid)) return true;
  const ps = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "stat="],
    { stdout: "pipe", stderr: "pipe", env: { PATH: "/bin:/usr/bin", LC_ALL: "C" } });
  return ps.exitCode === 0 && /^[ZX]/.test(ps.stdout.toString().trim());
}
function darwinBsdInfo(pid: number): Pick<DarwinProcess, "pid" | "ppid" | "pgid" | "uid" | "stat" | "started"> | null {
  const buffer = new Uint8Array(BSD_INFO_BYTES);
  let bytes = 0;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      bytes = (procInfo ??= loadProcInfo()).proc_pidinfo(pid, 3, 0, ptr(buffer), buffer.byteLength);
      if (bytes === BSD_INFO_BYTES || processInert(pid)) break;
      Bun.sleepSync(1);
    }
  } catch (error) {
    if (error instanceof OssProbeFailure) throw error;
    throw new OssProbeFailure("OSS probe libproc call failed");
  }
  if (bytes !== BSD_INFO_BYTES) {
    if (processInert(pid)) return null;
    throw new OssProbeFailure(`OSS probe libproc process lookup failed for live process ${pid}`);
  }
  const view = new DataView(buffer.buffer);
  return { pid: view.getUint32(12, true), ppid: view.getUint32(16, true), uid: view.getUint32(20, true),
    pgid: view.getUint32(100, true), stat: view.getUint32(4, true) === 5 ? "Z" : "S",
    started: `${view.getBigUint64(120, true)}.${view.getBigUint64(128, true)}` };
}

/** macOS cannot subreap. ps inventories all UIDs; libproc identifies our own pre-existing PIDs
 * when readable and our own new candidates. Other UIDs use ps start seconds, group, session,
 * and parent chain. Same-second reuse of a PID whose pre-existing exact identity was unreadable,
 * or an adopted setuid child that leaves the group,
 * whose ps parent chain no longer reaches the probe, and whose session is unreadable can escape. */
function darwinProcessInventory(): Map<number, DarwinProcess> {
  const ps = Bun.spawnSync(["/bin/ps", "-A", "-o", "pid=,ppid=,pgid=,sess=,uid=,stat=,lstart="],
    { stdout: "pipe", stderr: "pipe", env: { PATH: "/bin:/usr/bin", LC_ALL: "C" } });
  if (ps.exitCode !== 0) throw new OssProbeFailure("OSS probe process inventory failed");
  return darwinInventoryFromPs(ps.stdout.toString());
}

/** ps is readable across UIDs. Precise libproc reads belong only to new custody candidates. */
export function darwinInventoryFromPs(output: string): Map<number, DarwinProcess> {
  const processes = new Map<number, DarwinProcess>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!fields) throw new OssProbeFailure("OSS probe process inventory failed");
    const pid = Number(fields[1]);
    if (/^[ZX]/.test(fields[6]!)) continue;
    processes.set(pid, { pid, ppid: Number(fields[2]), pgid: Number(fields[3]), sess: Number(fields[4]),
      uid: Number(fields[5]), stat: fields[6]!, started: PS_IDENTITY_UNAVAILABLE, psStarted: fields[7]! });
  }
  return processes;
}

/** Recheck the same BSD record for identity and state after getsid fails. A zombie holds no custody. */
export function darwinSessionAfterLookup(pid: number, session: number,
  inspect: (pid: number) => Pick<DarwinProcess, "stat" | "started"> | null = darwinBsdInfo): number | null {
  if (session >= 0) return session;
  const process = inspect(pid);
  if (process === null || /^[ZX]/.test(process.stat)) return null;
  throw new OssProbeFailure("OSS probe session lookup failed for live process");
}

function darwinSessionId(pid: number): number | null {
  // macOS ps can report sess=0 for a detached process even while getsid(pid) is valid.
  let libc: ReturnType<typeof dlopen<{ getsid: { args: [typeof FFIType.i32]; returns: typeof FFIType.i32 } }>>;
  try { libc = dlopen("/usr/lib/libSystem.B.dylib", { getsid: { args: [FFIType.i32], returns: FFIType.i32 } }); }
  catch { throw new OssProbeFailure("OSS probe session reader unavailable"); }
  try {
    const session = libc.symbols.getsid(pid);
    return darwinSessionAfterLookup(pid, session);
  }
  finally { libc.close(); }
}

const nativeDarwinReaders: DarwinProbeReaders = {
  inventory: darwinProcessInventory, session: darwinSessionId, identity: (pid) => darwinBsdInfo(pid)?.started ?? null,
};

/** Snapshot exact start identity when readable; preserve ps identity for every existing PID. */
export function darwinBeforeInventory(readers: DarwinProbeReaders = nativeDarwinReaders): Map<number, DarwinProcess> {
  const before = readers.inventory();
  const ownUid = process.getuid?.() ?? -1;
  const recorded = new Map<number, DarwinProcess>();
  for (const row of before.values()) {
    if (row.uid !== ownUid) { recorded.set(row.pid, row); continue; }
    let started: string | null = null;
    try { started = readers.identity(row.pid); }
    catch { /* A pre-existing PID remains recorded by its ps identity. */ }
    recorded.set(row.pid, started && started !== PS_IDENTITY_UNAVAILABLE ? { ...row, started } : row);
  }
  return recorded;
}

export function darwinProbeDescendantExists(before: Map<number, DarwinProcess>, probePid: number,
  readers: DarwinProbeReaders = nativeDarwinReaders, probeStarted: string | null = null): boolean {
  const after = readers.inventory();
  const ownUid = process.getuid?.() ?? -1;
  const preciseIdentity = (row: DarwinProcess): string | null => {
    try { return readers.identity(row.pid); }
    catch (error) {
      const reason = error instanceof Error ? error.message : "";
      // A PID can exit and be reused after ps captured its row. The captured process is then inert.
      if (row.psStarted !== undefined && /process lookup failed/.test(reason) &&
        readers.inventory().get(row.pid)?.psStarted !== row.psStarted)
        return null;
      throw error;
    }
  };
  const sameProcess = (row: DarwinProcess): boolean => {
    const old = before.get(row.pid);
    if (!old) return false;
    const samePs = row.psStarted !== undefined && old.psStarted === row.psStarted;
    if (old.started !== PS_IDENTITY_UNAVAILABLE && row.uid === ownUid) {
      try {
        const current = preciseIdentity(row);
        if (current !== null && current !== PS_IDENTITY_UNAVAILABLE) return current === old.started;
      } catch { /* Best-effort exact identity for a pre-existing PID. */ }
    }
    return samePs ||
      row.psStarted === undefined && row.started !== PS_IDENTITY_UNAVAILABLE && old.started === row.started;
  };
  for (const candidate of after.values()) {
    if (sameProcess(candidate) || /^[ZX]/.test(candidate.stat)) continue;
    const foreign = candidate.uid !== ownUid;
    // Other-UID processes are judged by readable ps group and parent fields only.
    const liveIdentity = foreign ? null : preciseIdentity(candidate);
    if (!foreign && liveIdentity === null) continue; // Proven exit or zombie.
    if (candidate.started !== PS_IDENTITY_UNAVAILABLE && liveIdentity !== null && liveIdentity !== candidate.started)
      throw new OssProbeFailure("OSS probe process identity changed during inspection");
    if (candidate.started === PS_IDENTITY_UNAVAILABLE && liveIdentity === PS_IDENTITY_UNAVAILABLE)
      throw new OssProbeFailure("OSS probe identity unavailable for live process");
    const session = foreign ? candidate.sess || null : readers.session(candidate.pid);
    if (!foreign && session === null) continue;
    if (liveIdentity !== null && readers.identity(candidate.pid) !== liveIdentity)
      throw new OssProbeFailure("OSS probe process identity changed during session lookup");
    if (candidate.pgid === probePid || session === probePid) return true;
    const seen = new Set<number>();
    const ancestors: number[] = [];
    let parent = candidate.ppid;
    while (parent > 1 && !seen.has(parent) && parent !== probePid) {
      seen.add(parent);
      const row = after.get(parent);
      if (!row || sameProcess(row)) break;
      ancestors.push(parent);
      parent = row.ppid;
    }
    if (parent !== probePid) continue;
    if (!probeStarted) throw new OssProbeFailure(`OSS probe parent identity could not be verified (${candidate.pid}->${probePid})`);
    const probeInInventory = after.get(probePid);
    if (probeInInventory && probeInInventory.started !== PS_IDENTITY_UNAVAILABLE && probeInInventory.started !== probeStarted) continue;
    if (readers.identity(probePid) !== probeStarted) continue;
    let validChain = true;
    for (const ancestor of ancestors) {
      const row = after.get(ancestor)!;
      if (row.uid !== ownUid) continue; // ps parent chain is the other-UID evidence.
      const identity = preciseIdentity(row);
      if (identity === null) { validChain = false; break; }
      if (identity !== null && (row.started !== PS_IDENTITY_UNAVAILABLE && identity !== row.started || readers.identity(ancestor) !== identity))
        throw new OssProbeFailure(`OSS probe parent identity could not be verified (${candidate.pid}->${ancestor})`);
    }
    if (validChain) return true;
  }
  return false;
}

/** A detached child can clear every root reference. A Linux subreaper retains it as our child. */
function liveProcessIdentities(): Set<string> {
  if (process.platform !== "linux") throw new OssProbeFailure("OSS probe process inventory unavailable");
  const identities = new Set<string>();
  for (const entry of readdirSync("/proc")) {
    if (!/^[1-9][0-9]*$/.test(entry)) continue;
    const path = `/proc/${entry}`;
    try {
      const stat = readFileSync(`${path}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[1]) === process.pid && fields[0] !== "Z" && fields[0] !== "X") identities.add(`${entry}:${fields[19]}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new OssProbeFailure("OSS probe process inventory failed");
    }
  }
  return identities;
}

/** Only an isolated OSS home has a worker root; a caller's ordinary HOME is not one. */
function probeWorkerRootOccupied(env: Record<string, string>): boolean {
  const home = env.HOME;
  if (!home || !isAbsolute(home)) throw new OssProbeFailure("OSS probe home unavailable");
  const root = dirname(home);
  if (home !== join(root, "home") || env.CODEX_HOME !== join(root, "codex")) return false;
  return workerRootOccupied(root);
}

/** Success needs completed pipes and exit. Failure settles independently of descendant-held pipes. */
export function boundedOssProbe(binary: string, args: string[], env: Record<string, string>, signal: AbortSignal,
  timeoutMs = 3_000, maxBytes = 32_768, readers: DarwinProbeReaders = nativeDarwinReaders): Promise<string> {
  if (signal.aborted) return Promise.reject(new Error("OSS probe cancelled"));
  let before: Set<string> | Map<number, DarwinProcess>;
  if (process.platform === "darwin") {
    try { before = darwinBeforeInventory(readers); }
    catch (error) { return Promise.reject(error instanceof OssProbeFailure ? error : new OssProbeFailure("OSS probe process inventory failed")); }
  } else {
    try { ensureProbeSubreaper(); before = liveProcessIdentities(); }
    catch { return Promise.reject(new OssProbeFailure("OSS probe process inventory failed")); }
  }
  return new Promise((yes, no) => {
    const child = spawn(binary, args, { env, cwd: env.HOME, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    noteChildProcess(child);
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, settled = false;
    const cleanup = () => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      child.stdout.off("data", readStdout); child.stderr.off("data", readStderr);
    };
    const fail = (why: string) => {
      if (settled) return;
      settled = true;
      // Signal only our still-unreaped session leader's group. Never reuse a saved PGID after exit.
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* failure/absence cannot prove cleanup */ }
      }
      cleanup();
      child.stdout.destroy(); child.stderr.destroy(); // an escaped holder cannot extend this promise
      // Node retains the child handle until exit/reap; no timer or listener waits for descendant pipes.
      no(new OssProbeFailure(why));
    };
    let probeStarted: string | null = null;
    const abort = () => fail("OSS probe cancelled");
    const error = () => fail("OSS probe failed");
    const timer = setTimeout(() => fail("OSS probe timed out"), timeoutMs);
    const read = (chunks: Buffer[], chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { fail("OSS probe output exceeded bound"); return; }
      chunks.push(chunk);
    };
    const readStdout = (chunk: Buffer) => read(stdout, chunk);
    const readStderr = (chunk: Buffer) => read(stderr, chunk);
    const close = async (code: number | null) => {
      child.off("error", error); child.off("close", close);
      if (settled) return;
      if (code !== 0) { fail("OSS probe failed"); return; }
      settled = true;
      // Capture a macOS child while it is still observable before checking its group.
      let observedDescendant = false, inventoryFailure: Error | null = null;
      if (before instanceof Map && child.pid) {
        try { observedDescendant = darwinProbeDescendantExists(before, child.pid, readers, probeStarted); }
        catch (error) { inventoryFailure = error instanceof Error ? error : new Error("OSS probe inventory failed"); }
      }
      const reaped = child.pid ? await reapProbeGroup(child.pid) : false;
      cleanup();
      if (!reaped) { no(new OssProbeFailure("OSS probe group cleanup failed")); return; }
      if (inventoryFailure) { no(inventoryFailure instanceof OssProbeFailure ? inventoryFailure : new OssProbeFailure(inventoryFailure.message)); return; }
      if (observedDescendant) { no(new OssProbeFailure("OSS probe descendant cleanup failed")); return; }
      if (signal.aborted) { no(new OssProbeFailure("OSS probe cancelled")); return; }
      // A child may start a new session and close every pipe before its parent exits.
      // The original group alone cannot establish that the worker root is free.
      if (before instanceof Map) {
        try {
          if (probeWorkerRootOccupied(env) ||
            darwinProbeDescendantExists(before, child.pid!, readers, probeStarted)) {
            no(new OssProbeFailure("OSS probe descendant cleanup failed")); return;
          }
        } catch (error) { no(error instanceof OssProbeFailure ? error : new OssProbeFailure("OSS probe descendant cleanup could not be verified")); return; }
      } else {
        try {
          const after = liveProcessIdentities();
          const newIds = [...after].filter((identity) => !before.has(identity));
          if (!env.HOME || !isAbsolute(env.HOME) || workerRootOccupied(dirname(env.HOME)) ||
            newIds.length) {
            no(new OssProbeFailure("OSS probe descendant cleanup failed")); return;
          }
        } catch { no(new OssProbeFailure("OSS probe descendant cleanup could not be verified")); return; }
      }
      // Independent byte streams: decode each before joining. Preserve per-stream order, not interstream timing.
      yes(Buffer.concat(stdout).toString("utf8") + Buffer.concat(stderr).toString("utf8"));
    };
    child.stdout.on("data", readStdout); child.stderr.on("data", readStderr);
    child.on("error", error); child.on("close", close);
    signal.addEventListener("abort", abort, { once: true });
    try { if (before instanceof Map && child.pid) probeStarted = readers.identity(child.pid); }
    catch (cause) { fail(cause instanceof Error ? cause.message : "OSS probe leader identity unavailable"); return; }
    if (signal.aborted) abort();
  });
}
const cache = new Map<string, true>();
export async function probeOssRuntime(binary: string, env: Record<string, string>, signal: AbortSignal, gate: () => void,
  readers: DarwinProbeReaders = nativeDarwinReaders): Promise<string> {
  gate();
  const identity = binaryIdentity(binary);
  const check = () => { gate(); if (binaryIdentity(binary) !== identity) throw new Error("OSS binary replaced during preparation"); };
  if (!cache.has(identity)) {
    const version = await boundedOssProbe(binary, ["--version"], env, signal, 3_000, 32_768, readers); check();
    if (version.trim() !== "codex-cli 0.160.0") throw new Error("unsupported OSS runtime version");
    const help = await boundedOssProbe(binary, ["exec", "--help"], env, signal, 3_000, 32_768, readers); check();
    for (const flag of ["--oss", "--local-provider", "--model", "--ignore-user-config", "--sandbox", "--json", "--color", "--skip-git-repo-check"]) {
      if (!help.split(/\s+/).includes(flag)) throw new Error("unsupported OSS runtime flags");
    }
    if (cache.size >= 16) cache.clear();
    cache.set(identity, true);
  }
  check(); return identity;
}

/** Bounds an injected readiness wait; cancellation never waits for an external model server to stop. */
export function fixtureReadiness(runtime: OssFixtureRuntime, model: string, signal: AbortSignal): ReturnType<OssFixtureRuntime["readiness"]> {
  if (signal.aborted) return Promise.reject(new Error("local OSS cancelled"));
  return new Promise((yes, no) => {
    const abort = () => { cleanup(); no(new Error("local OSS cancelled")); };
    const timer = setTimeout(() => { cleanup(); no(new Error("local OSS readiness timed out")); }, 3_000);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => runtime.readiness(model, signal)).then((value) => { cleanup(); yes(value); }, (error) => { cleanup(); no(error); });
    if (signal.aborted) abort();
  });
}
