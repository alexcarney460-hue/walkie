// Asking the person at their terminal (SETUP-TTY). Every question opens a descriptor of its own on the terminal
// (/dev/tty) and closes it after the answer; nothing reads through Bun's process.stdin. Every question has a time
// limit: no answer in time takes the default (or skips), so an install never hangs on a prompt.
//
// Why: the installer runs `walkie setup < /dev/tty` (its own stdin is the `curl | sh` pipe). On macOS, when stdin is
// /dev/tty itself, Bun's process.stdin never delivers a keystroke (macOS kqueue refuses /dev/tty with EINVAL, which
// is presumably what its reader waits on), so the first question froze the install.
//
// No read may outlive its question (PRE5 RC, Opus MEDIUM): a stream's read on the terminal runs on a pool thread, and
// destroying the stream (a question that timed out) doesn't end it, so that read took the NEXT question's answer, or a
// child's (sudo) password. So the terminal is opened non-blocking and polled: every read returns at once (EAGAIN when
// nothing was typed), and once the question is over nothing reads the terminal. Raw mode is set with stty, restored
// after.
import { closeSync, constants, openSync, readSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

/** How often an open question looks for keystrokes. */
export const POLL_MS = 15;
/** How long a question waits: then the default is taken (or the command stops), never a hung install. */
export const PROMPT_TIMEOUT_MS = 5 * 60_000;

/** WALKIE_PROMPT_TIMEOUT_S may only shorten the wait (tests, scripted installs). */
export function promptTimeoutMs(): number {
  const v = Number(process.env.WALKIE_PROMPT_TIMEOUT_S);
  return Number.isFinite(v) && v > 0 ? Math.min(v * 1000, PROMPT_TIMEOUT_MS) : PROMPT_TIMEOUT_MS;
}

/** What came back: a typed line, or why there is none (no terminal, end of input, no answer in time). */
export type Answer = { text: string; how: "typed" | "timeout" | "eof" | "no-terminal" };

/** Ctrl-C at a question. */
export class PromptCancelled extends Error {}

export interface TermInput {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(on: boolean): unknown };
  close(): void;
}

/** `stty <args>` on the terminal at `fd`: its output, or null when it failed. */
function stty(fd: number, args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["stty", ...args], { stdin: fd, stdout: "pipe", stderr: "ignore", env: { PATH: "/bin:/usr/bin" } });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

/**
 * The terminal at `fd` (opened non-blocking) as a readable stream fed by polling: each poll reads until nothing is
 * left and returns (no read is ever left waiting). `setRawMode` sets what libuv's raw mode sets, with stty; the
 * terminal's settings from before are restored when raw mode ends and at close.
 */
class PolledTerm extends Readable {
  readonly isTTY = true;
  private readonly timer: ReturnType<typeof setInterval>;
  private saved: string | null = null;
  private isShut = false;
  private readonly buf = Buffer.alloc(4096);

  constructor(private readonly fd: number) {
    super();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  override _read(): void { /* fed by poll() */ }

  private poll(): void {
    // Checked before every read: a keystroke pushed below can end the question (and close this descriptor, whose number
    // may then be reused by a blocking one) before the loop reads again.
    for (let i = 0; i < 64 && !this.isShut; i++) {
      let n: number;
      try {
        n = readSync(this.fd, this.buf, 0, this.buf.length, null);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EAGAIN") return; // nothing typed yet
        return this.end(); // EIO (hung up) and the like: the terminal is gone
      }
      if (n === 0) return this.end(); // end of input (Ctrl-D at the start of a line)
      this.push(Buffer.from(this.buf.subarray(0, n)));
    }
  }

  private end(): void {
    this.stopPolling();
    this.push(null);
  }

  private stopPolling(): void {
    clearInterval(this.timer);
  }

  setRawMode(on: boolean): this {
    if (this.isShut) return this;
    if (on) {
      this.saved ??= stty(this.fd, ["-g"]);
      stty(this.fd, ["-icanon", "-echo", "-isig", "-iexten", "-icrnl", "-ixon", "-brkint", "-inpck", "-istrip", "min", "1", "time", "0"]);
    } else if (this.saved) {
      stty(this.fd, [this.saved]);
      this.saved = null;
    }
    return this;
  }

  /** Stops polling, restores the terminal's settings and closes the descriptor: nothing of this question reads on. */
  shut(): void {
    if (this.isShut) return;
    this.setRawMode(false);
    this.isShut = true;
    this.stopPolling();
    try { closeSync(this.fd); } catch { /* closed */ }
    this.destroy();
  }
}

/** The device of stdin's terminal (`tty`: /dev/ttys003, /dev/pts/2), or null. */
function stdinTtyPath(): string | null {
  try {
    const r = Bun.spawnSync(["tty"], { stdin: "inherit", stdout: "pipe", stderr: "ignore", env: { PATH: "/bin:/usr/bin" } });
    const p = r.stdout.toString().trim();
    return r.exitCode === 0 && /^\/dev\/[A-Za-z0-9/._-]{1,64}$/.test(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * A fresh non-blocking descriptor on the person's terminal: /dev/tty (the controlling terminal, as every prompt reads
 * it), else stdin's own terminal device by its name (when there is no controlling terminal), or null when stdin isn't
 * a terminal. A fresh open of the device is a file description of its own, so the non-blocking flag never reaches a
 * child's stdin. (Not /dev/fd/0: on macOS that is a dup of stdin, where O_NONBLOCK is ignored and a read blocks.)
 */
export function openTermInput(): TermInput | null {
  if (!process.stdin.isTTY) return null;
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY;
  let fd: number | null = null;
  try { fd = openSync("/dev/tty", flags); } catch { /* no controlling terminal */ }
  if (fd === null) {
    const dev = stdinTtyPath();
    if (dev) try { fd = openSync(dev, flags); } catch { /* not openable */ }
  }
  if (fd === null) return null;
  const s = new PolledTerm(fd);
  return { input: s, close: () => s.shut() };
}

/** One line, echoed. Resolves on Enter, end of input or the timeout; rejects PromptCancelled on Ctrl-C. */
export function askLine(question: string, opts: { timeoutMs?: number; output?: NodeJS.WritableStream } = {}): Promise<Answer> {
  const term = openTermInput();
  if (!term) return Promise.resolve({ text: "", how: "no-terminal" });
  const output = opts.output ?? process.stdout;
  const rl = createInterface({ input: term.input, output, terminal: term.input.isTTY === true });
  return new Promise<Answer>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void, newline = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rl.close();
      term.close();
      if (newline) output.write("\n");
      fn();
    };
    const timer = setTimeout(() => finish(() => resolve({ text: "", how: "timeout" }), true), opts.timeoutMs ?? promptTimeoutMs());
    rl.on("SIGINT", () => finish(() => reject(new PromptCancelled("cancelled (Ctrl-C)")), true));
    rl.on("close", () => finish(() => resolve({ text: "", how: "eof" }), true));
    rl.question(question, (a) => finish(() => resolve({ text: a.trim(), how: "typed" })));
  });
}

/** One line, not echoed (a token). Enter or Ctrl-D keeps what was typed; Ctrl-C, end of input or the timeout skip it. */
export function askHidden(question: string, opts: { timeoutMs?: number; output?: NodeJS.WritableStream } = {}): Promise<Answer> {
  const term = openTermInput();
  if (!term) return Promise.resolve({ text: "", how: "no-terminal" });
  const output = opts.output ?? process.stdout;
  const { input } = term;
  output.write(question);
  input.setRawMode?.(true);
  return new Promise<Answer>((resolve) => {
    let buf = "";
    let done = false;
    const finish = (a: Answer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      try { input.setRawMode?.(false); } catch { /* closed */ }
      term.close();
      output.write("\n");
      resolve(a);
    };
    const onData = (d: Buffer | string) => {
      for (const ch of d.toString()) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish({ text: buf, how: "typed" });
        if (ch === "\u0003") return finish({ text: "", how: "eof" });
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " " && buf.length < 8192) buf += ch;
      }
    };
    const onEnd = () => finish({ text: "", how: "eof" });
    const timer = setTimeout(() => finish({ text: "", how: "timeout" }), opts.timeoutMs ?? promptTimeoutMs());
    input.on("data", onData);
    input.on("end", onEnd);
    input.resume();
  });
}
