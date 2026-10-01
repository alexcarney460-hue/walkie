// Private organization for a same-user seat. It is not an OS security boundary.
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CLAUDE_EVENTS, ourEntry, walkieArgv, walkieCommand, withCodexBlock } from "../../hooks/install.ts";

export interface WorkerRoot { key: string; root: string; claude: string; codex: string; temp: string }
export type WorkerProcess = { pid: number; started?: string } | { uncertain: true };
export const WORKER_ROOT_KEY = /^[0-9a-f]{16}:[1-9][0-9]*(?:@[0-9a-f]{32})?$/;

function paths(home: string, key: string): WorkerRoot {
  if (!WORKER_ROOT_KEY.test(key)) throw new Error("invalid worker root key");
  const root = join(home, ".walkie-workers", `seat-${key.replace(":", "-").replace("@", "-")}`);
  return { key, root, claude: join(root, "claude"), codex: join(root, "codex"), temp: join(root, "tmp") };
}

function parent(home: string): string {
  const dir = join(home, ".walkie-workers");
  if (!existing(dir)) mkdirSync(dir, { mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("worker root parent is not a directory");
  chmodSync(dir, 0o700);
  return dir;
}

export function createWorkerRoot(home: string, id: string): WorkerRoot {
  if (!/^[0-9a-f]{16}:[1-9][0-9]*$/.test(id)) throw new Error("invalid seat id for worker root");
  const p = paths(home, `${id}@${randomUUID().replaceAll("-", "")}`);
  parent(home);
  mkdirSync(p.root, { mode: 0o700 }); // an existing or linked root is never reused
  try {
    for (const dir of [p.claude, p.codex, p.temp]) mkdirSync(dir, { mode: 0o700 });
    const hooks: Record<string, ReturnType<typeof ourEntry>[]> = {};
    for (const { event, matcher } of CLAUDE_EVENTS) hooks[event] = [ourEntry(walkieCommand(), matcher)];
    writeFileSync(join(p.claude, "settings.json"), JSON.stringify({ hooks }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    writeFileSync(join(p.claude, "CLAUDE.md"), "# Walkie worker seat\n\nWork on the assigned task in this seat's workspace. Report progress and results through Walkie.\n", { mode: 0o600, flag: "wx" });
    writeFileSync(join(p.codex, "config.toml"), withCodexBlock("", walkieArgv(), true).toml, { mode: 0o600, flag: "wx" });
    writeFileSync(join(p.codex, "AGENTS.md"), "# Walkie worker seat\n\nWork on the assigned task in this seat's workspace. Report progress and results through Walkie.\n", { mode: 0o600, flag: "wx" });
    return p;
  } catch (err) {
    rmSync(p.root, { recursive: true, force: true });
    throw err;
  }
}

export function removeWorkerRoot(home: string, id: string): void {
  const p = paths(home, id);
  const dir = join(home, ".walkie-workers");
  if (!existing(dir)) return;
  const base = lstatSync(dir);
  if (!base.isDirectory() || base.isSymbolicLink()) throw new Error("worker root parent is not a directory");
  if (!existing(p.root)) return;
  const root = lstatSync(p.root);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("worker root is not a directory");
  makeWritable(p.root);
  rmSync(p.root, { recursive: true, force: true });
}

/** Mark the spawn window before starting a child; a crash in that window must leave the root for review. */
export function markWorkerStarting(home: string, id: string): void {
  writeFileSync(join(paths(home, id).root, "process.json"), '{"uncertain":true}\n', { mode: 0o600, flag: "wx" });
}

/** Record the child that can still use this root after a daemon crash. */
export function recordWorkerProcess(home: string, id: string, pid: number, started: string | null): void {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("invalid worker process id");
  writeFileSync(join(paths(home, id).root, "process.json"), JSON.stringify({ pid, ...(started ? { started } : {}) }) + "\n", { mode: 0o600 });
}

export function readWorkerProcess(home: string, id: string): WorkerProcess | null {
  try {
    const raw = JSON.parse(readFileSync(join(paths(home, id).root, "process.json"), "utf8")) as Record<string, unknown>;
    if (Number.isInteger(raw.pid) && (raw.pid as number) > 1) return { pid: raw.pid as number, ...(typeof raw.started === "string" ? { started: raw.started } : {}) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
  }
  return { uncertain: true }; // a partial or invalid marker cannot prove absence
}

function existing(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Do not follow symlinks while making read-only subdirectories removable. */
function makeWritable(path: string): void {
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) return;
  chmodSync(path, st.mode | 0o700);
  for (const name of readdirSync(path)) makeWritable(join(path, name));
}

/** Startup sweep: only validated seat roots, never unrelated files under the worker parent. */
export function workerRootIds(home: string): string[] {
  const dir = join(home, ".walkie-workers");
  if (!existing(dir)) return [];
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("worker root parent is not a directory");
  return readdirSync(dir).flatMap((name) => {
    const match = /^seat-([0-9a-f]{16})-([1-9][0-9]*)(?:-([0-9a-f]{32}))?$/.exec(name);
    return match ? [`${match[1]}:${match[2]}${match[3] ? `@${match[3]}` : ""}`] : [];
  });
}

export function sweepWorkerRoots(home: string, live: ReadonlySet<string>, onError?: (id: string, err: unknown) => void): string[] {
  const removed: string[] = [];
  for (const id of workerRootIds(home)) {
    if (live.has(id)) continue;
    try {
      removeWorkerRoot(home, id);
      removed.push(id);
    } catch (err) {
      if (!onError) throw err;
      onError(id, err);
    }
  }
  return removed;
}

/** Best-effort scan for observable users of this root; a process can retain the path only in memory. */
export function workerRootOccupied(root: string): boolean {
  if (process.platform === "linux") {
    for (const name of readdirSync("/proc")) {
      if (!/^[1-9][0-9]*$/.test(name)) continue;
      const proc = join("/proc", name);
      let own: boolean;
      try { own = statSync(proc).uid === process.getuid?.(); }
      catch { continue; } // exited during enumeration
      if (!own) continue;
      try {
        // cmdline stays readable for every process; environ, cwd and fds are hidden from a non-dumpable one.
        const paths = [readFileSync(join(proc, "cmdline")).toString("utf8")];
        try {
          paths.push(readFileSync(join(proc, "environ")).toString("utf8"));
          try { paths.push(readlinkSync(join(proc, "cwd"))); } catch { /* no cwd */ }
          for (const fd of readdirSync(join(proc, "fd"))) {
            try { paths.push(readlinkSync(join(proc, "fd", fd))); } catch { /* closed during scan */ }
          }
        } catch (err) {
          // A non-dumpable process of this user (an SSH session, ssh-agent, a browser sandbox) hides these even from its
          // own user. The scan is best effort: its command line is still checked, the rest skipped, as for a process that
          // escaped the seat's group.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "EACCES" && code !== "EPERM") throw err;
        }
        if (paths.some((value) => value.includes(root))) return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // exited during the scan
        throw new Error("cannot verify worker root process absence");
      }
    }
    return false;
  }
  if (process.platform !== "darwin") throw new Error("worker root process verification is unavailable on this OS");
  const ps = Bun.spawnSync(["ps", "eww", "-A", "-o", "pid=,command="], { stdout: "pipe", stderr: "pipe", env: { PATH: "/bin:/usr/bin", LC_ALL: "C" } });
  if (ps.exitCode !== 0) throw new Error("cannot verify worker root process environments");
  if (ps.stdout.toString().includes(root)) return true;
  const files = Bun.spawnSync(["lsof", "-nP", "-t", "+D", root], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/sbin:/usr/bin:/bin", LC_ALL: "C" } });
  if (files.stdout.length) return true;
  if (files.exitCode === 1 && !files.stdout.length && !files.stderr.length) return false;
  throw new Error("cannot verify worker root open files");
}
