// Running the real CLI in the SAME terminal (ACCOUNTS-2). The child inherits the terminal itself (stdin, stdout,
// stderr are the user's tty; nothing is proxied), so the UX is identical by construction: raw mode, colours, mouse,
// paste, window resizes (the kernel signals the foreground process group) and Ctrl-C / Ctrl-Z job control all reach
// the CLI directly. The wrapper:
//   · ignores SIGINT / SIGQUIT while a child runs (the child gets them from the terminal and decides);
//   · forwards SIGTERM / SIGHUP to the child and then exits with its status (no relaunch);
//   · exits with the child's own code (128 + signal number when a signal ended it);
//   · after it ends a child itself (to switch accounts), restores the terminal settings saved at start (`stty -g`)
//     and the modes a TUI may leave on (bracketed paste, focus/mouse reporting, keyboard protocol, cursor).
import { closeSync, writeSync } from "node:fs";
import { constants } from "node:os";

export interface Child {
  pid: number;
  exited: Promise<number>;
  /** Asks the child to end (SIGTERM), then SIGKILL after `graceMs`. Resolves with its status. */
  stop(graceMs?: number): Promise<number>;
  kill(sig: NodeJS.Signals): void;
  /** With captureStdout: everything the child wrote to stdout (complete once `exited` resolved). */
  output?: () => Uint8Array;
  /** The token could not be written to fd 3 (the child is running anyway: the caller ends it). */
  handoffError?: string;
}

export interface SpawnOptions {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  /** Written to the child's fd 3 and closed (Claude: CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR=3). */
  fd3?: string;
  /**
   * Headless runs that may be retried on another account (round 1, Opus 11): stdout is kept and the wrapper prints only
   * the result of the run that counts, so a script reading `-p --output-format json` sees exactly one result.
   */
  captureStdout?: boolean;
}

export type Spawner = (o: SpawnOptions) => Child;

function statusOf(code: number | null, signal: string | null): number {
  if (code !== null) return code;
  const n = signal ? (constants.signals as Record<string, number>)[signal] : undefined;
  return 128 + (n ?? 15);
}

/**
 * Subprocesses that were given an extra fd (the token pipe). Bun closes a Subprocess's `stdio[3]` descriptor again when
 * the object is garbage-collected — after we already closed it (to give the CLI its EOF), by which time the number may
 * belong to something else (checked on Bun 1.3.14: the reused descriptor is closed). Keeping these objects alive for the
 * wrapper's lifetime (a handful of relaunches) means the descriptor is closed exactly once, by us.
 */
const keepAlive: unknown[] = [];

export const spawnInherit: Spawner = (o) => {
  const out1 = o.captureStdout ? "pipe" : "inherit";
  const proc = Bun.spawn(o.argv, {
    cwd: o.cwd, env: o.env,
    stdio: (o.fd3 !== undefined ? ["inherit", out1, "inherit", "pipe"] : ["inherit", out1, "inherit"]) as ["inherit", "inherit", "inherit"],
  });
  // The token hand-over never throws (round 2, Codex 5): the child is already running and must reach the caller.
  let handoffError: string | undefined;
  if (o.fd3 !== undefined) {
    keepAlive.push(proc);
    const fd = (proc as unknown as { stdio: unknown[] }).stdio[3];
    if (typeof fd !== "number") handoffError = "no token pipe";
    else {
      try { writeSync(fd, o.fd3); } catch (err) { handoffError = (err as NodeJS.ErrnoException).code ?? "write failed"; }
      try { closeSync(fd); } catch (err) { handoffError ??= (err as NodeJS.ErrnoException).code ?? "close failed"; }
    }
  }
  const chunks: Uint8Array[] = [];
  const drained = o.captureStdout && proc.stdout && typeof proc.stdout !== "number"
    ? (async () => { for await (const c of proc.stdout as unknown as AsyncIterable<Uint8Array>) chunks.push(c); })().catch(() => undefined)
    : Promise.resolve();
  const exited = Promise.all([proc.exited, drained]).then(() => statusOf(proc.exitCode, proc.signalCode));
  const kill = (sig: NodeJS.Signals) => { try { proc.kill(sig); } catch { /* gone */ } };
  return {
    pid: proc.pid, exited, kill, ...(handoffError ? { handoffError } : {}),
    ...(o.captureStdout ? { output: () => Buffer.concat(chunks) } : {}),
    async stop(graceMs = 5_000) {
      kill("SIGTERM");
      const t = setTimeout(() => kill("SIGKILL"), graceMs);
      const s = await exited;
      clearTimeout(t);
      return s;
    },
  };
};

// ---- terminal -------------------------------------------------------------------------

/** The terminal's settings (`stty -g`), or null when stdin is not a terminal. */
export function saveTerminal(): string | null {
  if (!process.stdin.isTTY) return null;
  try {
    const r = Bun.spawnSync(["stty", "-g"], { stdin: "inherit", stdout: "pipe", stderr: "ignore" });
    const s = r.stdout.toString().trim();
    return r.exitCode === 0 && /^[0-9a-fA-F:=,-]+$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** Puts the terminal back after a child was ended mid-screen. `altScreen`: the CLI may have used the alternate screen. */
export function restoreTerminal(saved: string | null, altScreen: boolean, write: (s: string) => void = (s) => process.stderr.write(s)): void {
  if (saved) {
    try { Bun.spawnSync(["stty", saved], { stdin: "inherit", stdout: "ignore", stderr: "ignore" }); } catch { /* best effort */ }
  }
  if (!process.stderr.isTTY) return;
  // Bracketed paste, focus events and mouse reporting off; pop the keyboard protocol; attributes reset; cursor shown.
  write(`${altScreen ? "\x1b[?1049l" : ""}\x1b[?2004l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[<u\x1b[0m\x1b[?25h\r\n`);
}

/**
 * Signal handling for the wrapper's lifetime: SIGINT / SIGQUIT are the child's (ignored here); SIGTERM / SIGHUP
 * are forwarded to the current child and end the wrapper after it. Returns an uninstaller.
 */
export function holdSignals(current: () => Child | null, onStop: (sig: NodeJS.Signals) => void): () => void {
  const ignore = () => { /* the child has it */ };
  const forward = (sig: NodeJS.Signals) => () => { onStop(sig); current()?.kill(sig); };
  const term = forward("SIGTERM");
  const hup = forward("SIGHUP");
  process.on("SIGINT", ignore);
  process.on("SIGQUIT", ignore);
  process.on("SIGTERM", term);
  process.on("SIGHUP", hup);
  return () => {
    process.off("SIGINT", ignore);
    process.off("SIGQUIT", ignore);
    process.off("SIGTERM", term);
    process.off("SIGHUP", hup);
  };
}
