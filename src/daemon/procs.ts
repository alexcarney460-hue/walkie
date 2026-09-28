// Read-only views of this user's processes for agent discovery (src/daemon/discovery.ts). Every external call is
// bounded (timeout + output cap). Environment reads return the NAMED variables' values and nothing else, or (envNames)
// only which of the named variables are set: a token variable's value is never read into a result.
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { readSmallFile } from "../agent/safe-read.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseCpuTime } from "./activity.ts";

export interface ProcRow {
  pid: number; ppid: number; uid: number;
  /** Process start (ms since epoch), second resolution; null if unparseable. */
  startedAt: number | null;
  /** argv joined by spaces, as `ps` prints it. */
  command: string;
  /** CPU time used so far (ms), from `ps -o time=`; absent when the listing had no time column. */
  cpuMs?: number;
  /**
   * AGENT-SEE-1: the controlling terminal (`ps -o tty=`), null when it has none ("?" on Linux, "??" on macOS): a
   * process with no terminal runs headless. Absent when the listing had no tty column.
   */
  tty?: string | null;
}

export interface ProcessProvider {
  /** Every process on the machine (the caller keeps its own user's); null when the listing failed. */
  list(): Promise<ProcRow[] | null>;
  /** For each pid, the values of the named environment variables that are set (other variables are never kept). */
  envVars(pids: readonly number[], names: readonly string[]): Promise<Map<number, Record<string, string>>>;
  /** For each pid, which of the named variables are set (names only; for token variables, whose values are never kept). */
  envNames?(pids: readonly number[], names: readonly string[]): Promise<Map<number, string[]>>;
  /** The process's working directory. */
  cwd(pid: number): Promise<string | undefined>;
  /** Paths of the files the process holds open. */
  openFiles(pid: number): Promise<string[]>;
  /**
   * Claude Code's own record of a running session (<config dir>/sessions/<pid>.json, the config dir being the
   * session's CLAUDE_CONFIG_DIR, default ~/.claude): its session id and start.
   */
  claudeSession(pid: number, configDir?: string): Promise<{ sessionId: string; startedAt?: number } | undefined>;
}

const TIMEOUT_MS = 5_000;
const OUTPUT_MAX = 8 * 1024 * 1024;

export interface RunOptions {
  timeoutMs?: number;
  /** Stdout cap in bytes; more is "overflow". */
  max?: number;
  /** The child's whole environment (default: this process's, with LC_ALL=C). */
  env?: Record<string, string | undefined>;
  /** setsid(): the child gets its own session, so no controlling terminal to prompt on. */
  detached?: boolean;
  /** After the deadline: SIGTERM, then SIGKILL this much later if it is still running. */
  killGraceMs?: number;
}

export type RunResult =
  | { kind: "ok"; stdout: string; code: number }
  | { kind: "timeout" } | { kind: "overflow" } | { kind: "error" };

/**
 * Runs a command with a HARD completion deadline (ACCOUNTS-FIX-1, Codex 4): the result is decided at the deadline
 * whether or not the child exits (SIGTERM, then SIGKILL after killGraceMs), so a child that ignores signals can never
 * leave the caller waiting. A timeout is reported as such, never as empty output.
 */
export async function runProcess(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const max = opts.max ?? OUTPUT_MAX;
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "ignore">>;
  try {
    proc = Bun.spawn(argv, {
      stdout: "pipe", stderr: "ignore", stdin: "ignore", env: opts.env ?? { ...process.env, LC_ALL: "C" },
      ...(opts.detached ? { detached: true } : {}),
    });
  } catch {
    return { kind: "error" };
  }
  const kill = (sig: "SIGTERM" | "SIGKILL") => { try { proc.kill(sig); } catch { /* already gone */ } };
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<RunResult>((resolve) => {
    timer = setTimeout(() => {
      if (settled) return;
      kill("SIGTERM");
      const hard = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) kill("SIGKILL"); }, opts.killGraceMs ?? 1_000);
      (hard as { unref?: () => void }).unref?.();
      resolve({ kind: "timeout" });
    }, timeoutMs);
  });
  const work = (async (): Promise<RunResult> => {
    const reader = proc.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { kill("SIGKILL"); await reader.cancel().catch(() => undefined); return { kind: "overflow" }; }
      chunks.push(value);
    }
    const code = await proc.exited;
    return { kind: "ok", stdout: Buffer.concat(chunks).toString("utf8"), code };
  })().catch((): RunResult => ({ kind: "error" }));
  const result = await Promise.race([work, deadline]);
  settled = true;
  clearTimeout(timer);
  return result;
}

/** Runs a command with a timeout and an output cap; its stdout, or null on a timeout, overflow or spawn failure. */
export async function runBounded(argv: string[], timeoutMs = TIMEOUT_MS, max = OUTPUT_MAX): Promise<string | null> {
  const r = await runProcess(argv, { timeoutMs, max });
  return r.kind === "ok" ? r.stdout : null;
}

/**
 * Parses `ps -A -o pid=,ppid=,uid=,tty=,time=,lstart=,args=` (LC_ALL=C; tty is "ttys003" / "pts/3", or "??" / "?" for
 * none; time is "12:34.56" on macOS, "[DD-]HH:MM:SS" on Linux; lstart is "Sat Sep 26 08:24:59 2026"). The tty and time
 * columns are optional (older listings had neither). A tty name is lower case and lstart starts with a capitalised
 * weekday, so the two never read as each other.
 */
export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  const re = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:(\?\??|[a-z][a-z0-9/]{0,31})\s+)?(?:((?:\d+-)?\d+(?::\d+)+(?:\.\d+)?)\s+)?([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;
  for (const line of out.split("\n")) {
    const m = re.exec(line);
    if (!m) continue;
    const t = new Date((m[6] as string).replace(/\s+/g, " ")).getTime();
    const cpu = m[5] ? parseCpuTime(m[5]) : null;
    const tty = m[4];
    rows.push({
      pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), startedAt: Number.isFinite(t) ? t : null, command: m[7] as string,
      ...(cpu !== null ? { cpuMs: cpu } : {}),
      ...(tty !== undefined ? { tty: tty.startsWith("?") ? null : tty } : {}),
    });
  }
  return rows;
}

/**
 * The named variables from the ENVIRONMENT part of a `ps eww` line (envPart: argv removed first, so an argument such
 * as "--note CLAUDE_CONFIG_DIR=/x" can never pass for a variable, Opus LOW 7). The last occurrence wins.
 */
export function pickEnv(envText: string, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const re = new RegExp(`(?:^|\\s)${name}=(\\S*)`, "g");
    let m: RegExpExecArray | null;
    let last: string | undefined;
    while ((m = re.exec(envText))) last = m[1];
    if (last) out[name] = last;
  }
  return out;
}

/** Which of the named variables are set (non-empty) in an environment text; no value is returned. */
export function envNamesIn(envText: string, names: readonly string[]): string[] {
  return names.filter((name) => new RegExp(`(?:^|\\s)${name}=\\S`).test(envText));
}

/**
 * `ps eww` prints the argv and then the environment; `ps ww` the argv alone. The environment is what follows the
 * argv; null when the two do not line up (the process changed in between), and then nothing is read.
 */
export function envPart(withEnv: string, argvOnly: string): string | null {
  return withEnv.startsWith(argvOnly) ? withEnv.slice(argvOnly.length) : null;
}

function psLines(out: string | null): Map<number, string> {
  const res = new Map<number, string>();
  for (const line of (out ?? "").split("\n")) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (m) res.set(Number(m[1]), m[2] as string);
  }
  return res;
}

function claudeConfigDir(): string { return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"); }

function readClaudeSession(pid: number, configDir = claudeConfigDir()): { sessionId: string; startedAt?: number } | undefined {
  try {
    // One descriptor, checked after it is opened (no lstat-then-open window): a FIFO or symlink can't be swapped in.
    const text = readSmallFile(join(configDir, "sessions", `${pid}.json`), 64 * 1024, process.getuid?.() ?? null);
    if (text === null) return undefined;
    const d = JSON.parse(text) as { pid?: unknown; sessionId?: unknown; startedAt?: unknown };
    if (d.pid !== pid || typeof d.sessionId !== "string" || !d.sessionId) return undefined;
    return { sessionId: d.sessionId, ...(typeof d.startedAt === "number" ? { startedAt: d.startedAt } : {}) };
  } catch {
    return undefined;
  }
}

/** macOS (ps + lsof) and Linux (ps + /proc). */
export class SystemProcessProvider implements ProcessProvider {
  private readonly linux = process.platform === "linux" && existsSync("/proc/self");

  /** Null when `ps` timed out, overflowed, failed or printed nothing parseable: never "no processes". */
  async list(): Promise<ProcRow[] | null> {
    const out = await runBounded(["ps", "-A", "-o", "pid=,ppid=,uid=,tty=,time=,lstart=,args="]);
    const rows = out ? parsePs(out) : [];
    return rows.length ? rows : null;
  }

  /** Linux: each pid's environment entries ("NAME=value"), from /proc (exact, no parsing of text). */
  private procEnv(pids: readonly number[]): Map<number, string[]> {
    const res = new Map<number, string[]>();
    for (const pid of pids) {
      try { res.set(pid, readFileSync(`/proc/${pid}/environ`, "latin1").split("\0")); } catch { /* gone, or not ours */ }
    }
    return res;
  }

  /** macOS: each pid's environment as text, `ps eww` with the argv removed (envPart). */
  private async envTexts(pids: readonly number[]): Promise<Map<number, string>> {
    const res = new Map<number, string>();
    for (let i = 0; i < pids.length; i += 100) {
      const list = pids.slice(i, i + 100).join(",");
      const withEnv = psLines(await runBounded(["ps", "eww", "-o", "pid=,command=", "-p", list]));
      const argvOnly = psLines(await runBounded(["ps", "ww", "-o", "pid=,command=", "-p", list]));
      for (const [pid, line] of withEnv) {
        const argv = argvOnly.get(pid);
        const env = argv === undefined ? null : envPart(line, argv);
        if (env !== null) res.set(pid, env);
      }
    }
    return res;
  }

  async envVars(pids: readonly number[], names: readonly string[]): Promise<Map<number, Record<string, string>>> {
    const res = new Map<number, Record<string, string>>();
    if (!pids.length) return res;
    if (this.linux) {
      for (const [pid, vars] of this.procEnv(pids)) {
        const got: Record<string, string> = {};
        for (const name of names) {
          const v = vars.find((x) => x.startsWith(`${name}=`));
          if (v && v.length > name.length + 1) got[name] = v.slice(name.length + 1);
        }
        res.set(pid, got);
      }
      return res;
    }
    for (const [pid, text] of await this.envTexts(pids)) res.set(pid, pickEnv(text, names));
    return res;
  }

  async envNames(pids: readonly number[], names: readonly string[]): Promise<Map<number, string[]>> {
    const res = new Map<number, string[]>();
    if (!pids.length) return res;
    if (this.linux) {
      for (const [pid, vars] of this.procEnv(pids)) res.set(pid, names.filter((n) => vars.some((x) => x.startsWith(`${n}=`) && x.length > n.length + 1)));
      return res;
    }
    for (const [pid, text] of await this.envTexts(pids)) res.set(pid, envNamesIn(text, names));
    return res;
  }

  async cwd(pid: number): Promise<string | undefined> {
    if (this.linux) {
      try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return undefined; }
    }
    const out = await runBounded(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const line = out?.split("\n").find((l) => l.startsWith("n/"));
    return line ? line.slice(1) : undefined;
  }

  async openFiles(pid: number): Promise<string[]> {
    if (this.linux) {
      try {
        return readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
          try { return [readlinkSync(`/proc/${pid}/fd/${fd}`)]; } catch { return []; }
        });
      } catch {
        return [];
      }
    }
    const out = await runBounded(["lsof", "-a", "-p", String(pid), "-Fn"]);
    return (out ?? "").split("\n").filter((l) => l.startsWith("n/")).map((l) => l.slice(1));
  }

  async claudeSession(pid: number, configDir?: string): Promise<{ sessionId: string; startedAt?: number } | undefined> {
    return readClaudeSession(pid, configDir);
  }
}
