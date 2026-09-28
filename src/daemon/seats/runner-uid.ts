// Busy by UID (Codex r3 HIGH 1, Codex r4 MEDIUM 6): each seat runs as its own user (a fresh one per run, admin.ts), so
// "everything of this seat" is "every process of that user". These operations run AS the seat's user (a separate
// `sudo -n -u <seat user> <runner> seat-runner` invocation, never the seat's own runner) and are verified by listing
// that user's processes afterwards:
//   stop  SIGSTOP every process, pass after pass, until one pass finds none still running (busy);
//   cont  SIGCONT every process, verified none is left stopped.
// Each answers `{ left, verified }`; an inspection or signalling error is never "done". Ending a seat's processes is
// the root helper's destroy (admin.ts), which removes the whole user.
//
// Tests can't create OS users; there (never in a release build, and never through sudo, which resets the
// environment) WALKIE_SEAT_FAKE_UID names a marker every process of the fake user carries in its environment.
import { readdirSync, readFileSync } from "node:fs";
import { RELEASE_BUILD } from "../../license/service.ts";

export const FAKE_UID_ENV = "WALKIE_SEAT_FAKE_UID";
const PASSES = 20;

export type UidOp = "stop" | "cont";

/** The fake user's marker in a test build, else null (the real uid is the scope). */
export function fakeScope(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env[FAKE_UID_ENV];
  return !RELEASE_BUILD && v && /^[a-z0-9_-]{1,40}$/.test(v) ? v : null;
}

/** Pids of this login's processes carrying `FAKE_UID_ENV=<marker>` (not the caller). */
export function fakePids(marker: string): number[] {
  const want = `${FAKE_UID_ENV}=${marker}`;
  const out: number[] = [];
  if (process.platform === "linux") {
    for (const d of readdirSync("/proc")) {
      const pid = Number(d);
      if (!Number.isInteger(pid) || pid === process.pid) continue;
      try { if (readFileSync(`/proc/${d}/environ`, "latin1").split("\0").includes(want)) out.push(pid); } catch { /* gone or not ours */ }
    }
    return out;
  }
  const r = Bun.spawnSync(["ps", "-axwwE", "-o", "pid=,command="], { stdout: "pipe", stderr: "ignore", env: { PATH: "/bin:/usr/bin", LC_ALL: "C" } });
  if (r.exitCode !== 0) throw new Error("ps failed");
  const re = new RegExp(`(?:^|\\s)${want.replace(/[-]/g, "\\-")}(?:\\s|$)`);
  for (const line of r.stdout.toString().split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid !== process.pid && pid !== r.pid && re.test(m[2] as string)) out.push(pid);
  }
  return out;
}

export interface Proc { pid: number; stat: string }

/**
 * The user's live processes (not the caller, not zombies) with their state: `ps -U <uid>` for the real user, the
 * marked pids for the fake one. Throws when it can't tell (never "none" by mistake).
 */
export function procList(scope: string | null): Proc[] {
  const argv = scope
    ? (() => { const pids = fakePids(scope); return pids.length ? ["ps", "-o", "pid=,stat=", "-p", pids.join(",")] : null; })()
    : ["ps", "-U", String(process.getuid?.() ?? -1), "-o", "pid=,stat="];
  if (!argv) return [];
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", env: { PATH: "/bin:/usr/bin", LC_ALL: "C" } });
  const text = r.stdout.toString();
  // ps exits 1 with nothing printed (and nothing on stderr) when no process matches: an empty list. Anything else is
  // a failure to tell.
  if (r.exitCode === 1 && text.trim() === "" && r.stderr.toString().trim() === "") return [];
  if (r.exitCode !== 0) throw new Error(`ps failed (exit ${r.exitCode})`);
  const out: Proc[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || pid === r.pid || (m[2] as string).startsWith("Z")) continue;
    out.push({ pid, stat: m[2] as string });
  }
  return out;
}

/** Signals every process of the user (or of the fake scope). Throws on anything but "no such process". */
function signalAll(sig: NodeJS.Signals, scope: string | null): void {
  if (scope) {
    for (const pid of fakePids(scope)) {
      try { process.kill(pid, sig); } catch (err) { if ((err as { code?: string }).code !== "ESRCH") throw err; }
    }
    return;
  }
  try { process.kill(-1, sig); } catch (err) { if ((err as { code?: string }).code !== "ESRCH") throw err; }
}

/** SIGSTOP pass after pass until one finds nothing of the user still running. */
function stopSweep(scope: string | null): Proc[] {
  let list: Proc[] = [];
  for (let i = 0; i < PASSES; i++) {
    signalAll("SIGSTOP", scope);
    list = procList(scope);
    if (list.every((p) => p.stat.startsWith("T"))) return list;
  }
  return list;
}

/** Real kill(-1) only as a seat user of a release build; in a source build only inside a test scope; never as root. */
function guard(scope: string | null): void {
  if (process.getuid?.() === 0) throw new Error("uid-wide operations never run as root");
  if (!scope && !RELEASE_BUILD) throw new Error("uid-wide operations run only as a seat user");
}

export async function uidOp(op: UidOp, scope: string | null = fakeScope()): Promise<{ left: number; verified: boolean }> {
  guard(scope);
  if (op === "stop") {
    const list = stopSweep(scope);
    return { left: list.filter((p) => !p.stat.startsWith("T")).length, verified: list.every((p) => p.stat.startsWith("T")) };
  }
  if (op === "cont") {
    signalAll("SIGCONT", scope);
    const list = procList(scope);
    return { left: list.filter((p) => p.stat.startsWith("T")).length, verified: !list.some((p) => p.stat.startsWith("T")) };
  }
  throw new Error(`unknown operation ${op as string}`);
}
