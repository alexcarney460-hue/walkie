// The daemon's side of one seat run as the seat OS user (runner.ts, PROTOCOL §11 "Seat user"): spawns the switch
// (`sudo -n -u <seat user> <runner> seat-runner`), hands it the spec, the repo bundle and the prompt on stdin, turns
// the runner's framed stdout back into the runtime's lines, its readiness, exit code and post-run outcome, and
// controls the runtime's process group through it (the daemon can't signal another user's processes).
import { stderrDiagnostic } from "../orchestrator/process.ts";
import { RUNNER_MAX_BUNDLE, RUNNER_PROTOCOL, type RunnerSpec } from "./runner.ts";
import { MAX_RESULT_FILE } from "../../protocol/seats.ts";
import type { AdminResult } from "./admin.ts";
import type { UidOp } from "./runner-uid.ts";

export interface RunnerReady { dir: string; cwd: string; base: string | null; pid: number }
export interface RunnerOutcome {
  commits: number; dirty: number; bundle?: Uint8Array; file?: Uint8Array; file_error?: string;
  /** The seat was aborted: only the result file counts. */
  aborted?: true;
  /** A commit carries the brief file: no bundle was made. */
  brief?: true;
}
/** Control of the runtime's group through this seat's own runner (busy and cleanup are uid operations: runnerOp). */
export type RunnerControl = "term" | "kill" | "abort";

/**
 * What sudo (and so the runner and the root helper) is started with: cwd `/` and a fixed minimal environment, so no
 * bunfig.toml, .env or variable of the daemon's reaches them (Opus r6 LOW 3; the release build also turns off its
 * autoloading: scripts/build.ts).
 */
export const SPAWN_ENV: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" };
const STDERR_WINDOW = 64 * 1024;
const MAX_LINE = 48 * 1024 * 1024; // an outcome line carries the result bundle (≤ 25 MB, base64)
/** After `term`, how long the runtime has before `kill`; after `kill`, how long the runner has to report and exit. */
const TERM_GRACE_MS = 2_000;
const KILL_WAIT_MS = 5_000;

export class RunnerChild<S> {
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private stderr = "";
  private stderrCut = false;
  private closed = false;
  private resolveReady: (r: RunnerReady | null) => void = () => undefined;
  private resolveExit: (code: number | null) => void = () => undefined;
  private resolveOutcome: (o: RunnerOutcome | null) => void = () => undefined;
  /** The runtime has started (its group's leader pid, the seat's directories), or null when the runner failed first. */
  readonly ready: Promise<RunnerReady | null>;
  /** The runtime's exit code (null when it never ran or the runner died). */
  readonly exited: Promise<number | null>;
  /** The post-run git's result (commits as a bundle), or null (aborted, none, or the runner died). */
  readonly outcome: Promise<RunnerOutcome | null>;
  /** The runner process is gone. */
  readonly done: Promise<number | null>;
  /** The runner's own refusal or failure (`r {"error"}`), scrubbed by the runner. */
  error: string | null = null;
  runtimePid: number | null = null;
  /**
   * The runner ended without reporting the runtime's exit: the seat killed or lost it (it runs as the same user).
   * Nothing it says is trusted after that; the host reaps the seat user and reports the seat stopped.
   */
  lost = false;
  private reportedExit = false;

  constructor(
    argv: string[], spec: Omit<RunnerSpec, "bundle_len" | "prompt_len">, bundle: Uint8Array | { file: string; size: number } | null, prompt: string,
    private readonly onSignal: (s: S) => void, private readonly parse: (line: string) => S | null,
  ) {
    this.ready = new Promise((r) => { this.resolveReady = r; });
    this.exited = new Promise((r) => { this.resolveExit = r; });
    this.outcome = new Promise((r) => { this.resolveOutcome = r; });
    // sudo gets a minimal environment (it resets it anyway); everything the seat needs is in the spec.
    this.proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true, cwd: "/", env: SPAWN_ENV });
    const promptBytes = new TextEncoder().encode(prompt);
    const len = bundle === null ? 0 : bundle instanceof Uint8Array ? bundle.byteLength : bundle.size;
    const full: RunnerSpec = { ...spec, bundle_len: len, prompt_len: promptBytes.byteLength };
    const sink = this.proc.stdin as import("bun").FileSink;
    sink.write(`${JSON.stringify(full)}\n`);
    if (bundle && !(bundle instanceof Uint8Array)) {
      // A staged bundle (FO-2): streamed from the daemon's private file, chunk by chunk, never held whole.
      void this.streamFile(sink, bundle.file, bundle.size, promptBytes);
    } else {
      if (bundle) sink.write(bundle);
      sink.write(promptBytes);
      sink.flush();
    }
    void this.readStdout();
    void this.readStderr();
    this.done = this.proc.exited.then(async (code) => {
      await Bun.sleep(0);
      this.closed = true;
      if (!this.reportedExit && this.runtimePid !== null) this.lost = true;
      this.resolveReady(null);
      this.resolveExit(null);
      this.resolveOutcome(null);
      return code;
    });
  }

  /** Streams `size` bytes of `file`, then the prompt; a short or failed read ends the runner's stdin (it aborts). */
  private async streamFile(sink: import("bun").FileSink, file: string, size: number, prompt: Uint8Array): Promise<void> {
    try {
      const reader = (Bun.file(file).stream() as ReadableStream<Uint8Array>).getReader();
      let sent = 0;
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        const chunk = r.value.subarray(0, Math.max(0, size - sent));
        if (!chunk.byteLength) break;
        sink.write(chunk);
        sent += chunk.byteLength;
        await sink.flush();
      }
      if (sent !== size) throw new Error("the staged bundle changed size");
      sink.write(prompt);
      await sink.flush();
    } catch {
      try { sink.end(); } catch { /* gone */ }
    }
  }

  get pid(): number { return this.proc.pid; }
  get alive(): boolean { return !this.closed; }
  /** The end of the runner's (and runtime's) stderr, scrubbed. */
  get diagnostic(): string { return stderrDiagnostic(this.stderr, this.stderrCut); }

  /** One control line to the runner (ignored once it is gone). */
  control(cmd: RunnerControl): void {
    if (this.closed) return;
    try {
      const sink = this.proc.stdin as import("bun").FileSink;
      sink.write(`${cmd}\n`);
      sink.flush();
    } catch { /* the runner is gone */ }
  }

  /** Stops the runtime's group (SIGCONT + SIGTERM, then SIGKILL) and waits for the runner to report and exit. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.control("term");
    const exited = await Promise.race([this.exited.then(() => true), Bun.sleep(TERM_GRACE_MS).then(() => false)]);
    if (!exited) this.control("kill");
    const gone = await Promise.race([this.done.then(() => true), Bun.sleep(exited ? 120_000 : KILL_WAIT_MS).then(() => false)]);
    if (!gone) this.kill();
  }

  /**
   * Ends the runner itself (its stdin closes: it kills the runtime's group, then exits), and, when the runner
   * doesn't go, the switch process too.
   */
  kill(): void {
    try { (this.proc.stdin as import("bun").FileSink).end(); } catch { /* closed */ }
    const t = setTimeout(() => { try { this.proc.kill("SIGTERM"); } catch { /* gone */ } }, TERM_GRACE_MS);
    void this.done.then(() => clearTimeout(t));
  }

  private onRunner(msg: Record<string, unknown>): void {
    const ready = msg.ready as Record<string, unknown> | undefined;
    if (ready && typeof ready.dir === "string" && typeof ready.cwd === "string" && Number.isInteger(ready.pid)) {
      this.runtimePid = ready.pid as number;
      this.resolveReady({ dir: ready.dir, cwd: ready.cwd, base: typeof ready.base === "string" ? ready.base : null, pid: ready.pid as number });
      return;
    }
    if ("exit" in msg) { this.reportedExit = true; this.resolveExit(Number.isInteger(msg.exit) ? (msg.exit as number) : null); return; }
    if ("outcome" in msg) {
      const o = msg.outcome as Record<string, unknown> | null;
      if (!o || !Number.isInteger(o.commits) || !Number.isInteger(o.dirty)) { this.resolveOutcome(null); return; }
      let bundle: Uint8Array | undefined;
      if (typeof o.bundle === "string") {
        const bytes = new Uint8Array(Buffer.from(o.bundle, "base64"));
        if (bytes.byteLength <= RUNNER_MAX_BUNDLE) bundle = bytes;
      }
      let file: Uint8Array | undefined;
      if (typeof o.file === "string") {
        const bytes = new Uint8Array(Buffer.from(o.file, "base64"));
        if (bytes.byteLength <= MAX_RESULT_FILE) file = bytes;
      }
      const fileError = typeof o.file_error === "string" ? o.file_error.slice(0, 200) : undefined;
      this.resolveOutcome({
        ...(o.aborted === true ? { aborted: true as const } : {}), ...(o.brief === true ? { brief: true as const } : {}),
        commits: Math.max(0, o.commits as number), dirty: Math.max(0, o.dirty as number), ...(bundle ? { bundle } : {}),
        ...(file ? { file } : {}), ...(fileError ? { file_error: fileError } : {}),
      });
      return;
    }
    if (typeof msg.error === "string") { this.error = msg.error.slice(0, 300); this.resolveReady(null); }
  }

  private async readStdout(): Promise<void> {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    const line = (l: string) => {
      if (l.startsWith("o ")) {
        const s = this.parse(l.slice(2));
        if (s) this.onSignal(s);
      } else if (l.startsWith("r ")) {
        try { this.onRunner(JSON.parse(l.slice(2)) as Record<string, unknown>); } catch { /* not a runner message */ }
      }
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          line(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
        if (buf.length > MAX_LINE) buf = "";
      }
      if (buf) line(buf);
    } catch { /* the runner went away */ }
  }

  private async readStderr(): Promise<void> {
    const reader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const next = this.stderr + dec.decode(value, { stream: true });
        if (next.length > STDERR_WINDOW) this.stderrCut = true;
        this.stderr = next.slice(-STDERR_WINDOW);
      }
    } catch { /* gone */ }
  }
}

/**
 * One uid-wide operation (runner-uid.ts) as a seat user, through the same sudo rule: `stop` / `cont` every process of
 * the user (busy), or `reap` them all. Resolves with how many were left (null when the runner couldn't be reached or
 * didn't answer in time: the caller treats the user as still in use).
 */
export interface RunnerOpResult { verified: boolean; left?: number; samples?: string[]; leftoverDirs?: string[]; why?: string }

export async function runnerOp(argv: string[], op: UidOp | "sweep", timeoutMs = 15_000, extra: Record<string, unknown> = {}): Promise<RunnerOpResult | null> {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "ignore", cwd: "/", env: SPAWN_ENV });
  } catch {
    return null;
  }
  const sink = p.stdin as import("bun").FileSink;
  sink.write(`${JSON.stringify({ ...extra, rv: RUNNER_PROTOCOL, op })}\n`);
  sink.end();
  const out = new Response(p.stdout as ReadableStream<Uint8Array>).text();
  const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
  try {
    const [text] = await Promise.all([out, p.exited]);
    const line = text.split("\n").find((l) => l.startsWith("r {"));
    if (!line) return null;
    const o = JSON.parse(line.slice(2)) as { left?: unknown; verified?: unknown; samples?: unknown; leftoverDirs?: unknown; why?: unknown; error?: unknown };
    // Verified only when the runner says so explicitly; anything else (an error, a missing field) is not done.
    return {
      verified: o.verified === true && o.left === 0,
      ...(Number.isInteger(o.left) ? { left: o.left as number } : {}),
      ...(Array.isArray(o.samples) ? { samples: o.samples.filter((x): x is string => typeof x === "string").slice(0, 10) } : {}),
      ...(Array.isArray(o.leftoverDirs) ? { leftoverDirs: o.leftoverDirs.filter((x): x is string => typeof x === "string" && x.startsWith("/private/var/folders/")).slice(0, 200) } : {}),
      ...(typeof o.error === "string" ? { why: o.error } : {}),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One call of the root helper (`sudo -n <admin> seat-admin <create|destroy> <n>`, admin.ts): its one JSON line, or
 * null when it couldn't be run or didn't answer in time (the caller treats that as not done).
 */
export async function adminCall(argv: string[], timeoutMs = 180_000): Promise<AdminResult | null> {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", cwd: "/", env: SPAWN_ENV });
  } catch {
    return null;
  }
  const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
  try {
    const [text] = await Promise.all([new Response(p.stdout as ReadableStream<Uint8Array>).text(), p.exited]);
    const line = text.trim().split("\n").pop() ?? "";
    const o = JSON.parse(line) as AdminResult;
    return typeof o.ok === "boolean" ? o : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
