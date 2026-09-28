// The seat runner (`walkie seat-runner`, PROTOCOL §11 "Seat users"): what the host daemon runs as a seat's own fresh
// user, only through `sudo -n -u walkie-s<n> <runner> seat-runner` (a fixed argv, no shell). Every seat gets a user made
// for it and destroyed after it (admin.ts), so a seat can't reach the host person's Walkie (the daemon's 0700 home), the
// person's closed home, or another seat. The daemon can't signal another user's processes: this runner does it for it.
//
// stdin (from the daemon; sudo passes no other descriptor and resets the environment): one JSON line (the spec, at
// most HEADER_MAX bytes), and for `op: "run"` then `bundle_len` bytes (the repo bundle, if any), `prompt_len` bytes,
// and control lines (at most 64 bytes each): `term` (SIGCONT + SIGTERM the runtime's group), `kill` (SIGCONT +
// SIGKILL it), `abort` (a revoke or shutdown: cancel preparing, no post-run git). stdin's end (the daemon died), or
// a line over its limit, = abort + kill.
// stdout, one line each: `o <runtime stdout line>` (relayed verbatim: the runtime can't forge a `r` line) or
// `r <json>`: {ready: {dir, cwd, base, pid}}, {exit: code}, {outcome: {commits, dirty, bundle?} | null},
// {error: message}, {left: n} (after a uid operation). The runtime's stderr is the runner's stderr.
//
// `op: "stop" | "cont"` act on EVERY process of the seat's user (runner-uid.ts): busy and resume. `op: "sweep"`
// (runner-sweep.ts) is run by the root helper's destroy, as the seat user, once its processes are stopped: it removes
// every file the user owns outside its home and empties its home, verified. Ending a seat is that destroy (admin.ts),
// which removes the user itself. These are separate invocations, never this seat's own runner, which the seat can
// kill or stop (it runs as the same user).
import { accessSync, closeSync, constants, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { RELEASE_BUILD } from "../../license/service.ts";
import { redactSecrets } from "../../protocol/safety.ts";
import { cloneBundle, git, seatOutcome } from "./git.ts";
import { MAX_SEAT_BRIEF, SEAT_TASK_PROMPT, SEAT_TASK_PROMPT_ALT, SeatBranch, SeatResultFile } from "../../protocol/seats.ts";
import { readResultFile, removeTask, writeTask, type TaskFile } from "./v2.ts";
import { Input } from "./runner-io.ts";
import { FAKE_UID_ENV, fakeScope, uidOp } from "./runner-uid.ts";
import { sweepOp, validRoots } from "./runner-sweep.ts";

/** Bumped when the stdin/stdout protocol changes: an installed runner copy of another version refuses to run. */
export const RUNNER_PROTOCOL = 6;
/**
 * A v2 seat's run (FO-2): the v6 spec plus the brief (written to TASK.md after the clone), a staged bundle path, a
 * branch to check out and a result file to return. This runner takes both; an older installed copy refuses a v7
 * spec with its "not a seat request this runner understands" (the seat fails with that, nothing runs).
 */
export const RUNNER_PROTOCOL_V2 = 7;
export const RUNNER_MAX_BUNDLE = 25 * 1024 * 1024;
/**
 * A v2 seat's workspace bundle (rv 7): the exact commit of the host's own clone, staged privately by the host and
 * streamed over this runner's stdin (never a path another local user could open), written to disk as it arrives.
 */
export const RUNNER_MAX_STAGED = 1024 * 1024 * 1024;
export const RUNNER_MAX_PROMPT = 256 * 1024;
export const HEADER_MAX = 1024 * 1024;
export const CONTROL_MAX = 64;
const REAP_GRACE_MS = 2_000;
/** After the runtime exited and its group was reaped, how long its output may still drain (a leftover may hold it). */
const DRAIN_MS = 2_000;
/** The seat's credential for the seats' socket, in the seat's own directory (never in an environment: `ps -E`). */
export const SEAT_TOKEN_FILE = ".walkie-seat-token";
/** Tests only, never in a release build (and sudo resets the environment anyway): where the fake seat user lives. */
const HOME_OVERRIDE = "WALKIE_SEAT_RUNNER_HOME";

export type RunnerOp = "run" | "stop" | "cont";

export interface RunnerSpec {
  rv: number;
  op?: "run";
  /** `<utc stamp>-<short id>`: the seat's directory under `~walkie-s<n>/walkie-seats/`. */
  dir_name: string;
  /** The runtime's absolute path, its argv (`{cwd}` is replaced by the working directory) and environment. */
  bin: string;
  args: string[];
  env: Record<string, string>;
  /** The seat's credential for the seats' socket; written to SEAT_TOKEN_FILE (0600), never put in the environment. */
  token: string;
  socket: string;
  bundle_len: number;
  prompt_len: number;
  /**
   * Claude: ask the runtime (`--help`, as this seat user, never as the daemon's: Codex r4 MEDIUM 5) whether it knows
   * `--permission-prompts`, and add `--permission-prompts none` when it does.
   */
  probe_permission_prompts?: boolean;
  /**
   * The machine's own Claude Code login (its `.credentials.json`), for this run only: written 0600 into the run's
   * fresh CLAUDE_CONFIG_DIR and wiped with the home. Absent when the environment carries CLAUDE_CODE_OAUTH_TOKEN.
   */
  claude_credentials?: string;
  /**
   * The machine's own Codex sign-in (its `auth.json`), for this run only: written 0600 into the run's fresh CODEX_HOME
   * and gone with the user (the product requirement: seats use the machine's own Claude/Codex login).
   */
  codex_auth?: string;
  /** rv 7: the brief, written into the work tree (TASK.md) once it exists; the prompt is then the fixed pointer. */
  task?: string;
  /** rv 7: after the clone, check out this branch at its HEAD (a build lane). */
  branch?: string;
  /** rv 7: returned with the outcome (read without following symlinks, at most 64 KiB, redacted). */
  result_file?: string;
}

export function validSpec(v: unknown): RunnerSpec | null {
  const s = v as Partial<RunnerSpec> | null;
  if (!s || typeof s !== "object" || (s.rv !== RUNNER_PROTOCOL && s.rv !== RUNNER_PROTOCOL_V2) || (s.op !== undefined && s.op !== "run")) return null;
  const v2 = s.task !== undefined || s.branch !== undefined || s.result_file !== undefined;
  if (v2 && s.rv !== RUNNER_PROTOCOL_V2) return null;
  if (s.task !== undefined && (typeof s.task !== "string" || !s.task || s.task.length > MAX_SEAT_BRIEF)) return null;
  if (s.branch !== undefined && !SeatBranch.safeParse(s.branch).success) return null;
  if (s.result_file !== undefined && !SeatResultFile.safeParse(s.result_file).success) return null;

  if (typeof s.dir_name !== "string" || !/^\d{8}-\d{6}-[a-z0-9-]{1,40}$/.test(s.dir_name)) return null;
  if (typeof s.bin !== "string" || !s.bin.startsWith("/") || !Array.isArray(s.args) || !s.args.every((a) => typeof a === "string")) return null;
  if (typeof s.env !== "object" || s.env === null || !Object.values(s.env).every((x) => typeof x === "string")) return null;
  if (typeof s.token !== "string" || !/^[0-9a-f]{64}$/.test(s.token) || typeof s.socket !== "string" || !s.socket.startsWith("/")) return null;
  const maxBundle = s.rv === RUNNER_PROTOCOL_V2 ? RUNNER_MAX_STAGED : RUNNER_MAX_BUNDLE;
  if (!Number.isInteger(s.bundle_len) || (s.bundle_len as number) < 0 || (s.bundle_len as number) > maxBundle) return null;
  if (!Number.isInteger(s.prompt_len) || (s.prompt_len as number) < 1 || (s.prompt_len as number) > RUNNER_MAX_PROMPT) return null;
  if (s.probe_permission_prompts !== undefined && typeof s.probe_permission_prompts !== "boolean") return null;
  if (s.claude_credentials !== undefined && (typeof s.claude_credentials !== "string" || s.claude_credentials.length > 64 * 1024)) return null;
  if (s.codex_auth !== undefined && (typeof s.codex_auth !== "string" || s.codex_auth.length > 64 * 1024)) return null;
  return s as RunnerSpec;
}

function send(o: Record<string, unknown>): void {
  try { process.stdout.write(`r ${JSON.stringify(o)}\n`); } catch { /* the daemon is gone */ }
}

function fail(message: string): number {
  send({ error: redactSecrets(message).text.slice(0, 300) });
  return 1;
}

function signalGroup(pid: number, sig: NodeJS.Signals | 0): boolean {
  try { process.kill(-pid, sig); return true; } catch { return false; }
}

/** SIGCONT, SIGTERM, a grace, SIGKILL: the runtime's group, as soon as the runtime has exited. */
async function reapGroup(pid: number): Promise<void> {
  if (!signalGroup(pid, "SIGCONT")) return;
  signalGroup(pid, "SIGTERM");
  const until = Date.now() + REAP_GRACE_MS;
  while (Date.now() < until && signalGroup(pid, 0)) await Bun.sleep(50);
  signalGroup(pid, "SIGKILL");
}

/** The seat user's home: its own, or (tests, never a release build) the override. */
function seatHome(): string {
  return (!RELEASE_BUILD && process.env[HOME_OVERRIDE]) || userInfo().homedir;
}

/**
 * Linux: no other process of this user may open this runner's /proc files (its descriptors, among them the pipe to
 * the daemon): prctl(PR_SET_DUMPABLE, 0). Best effort (Opus r4 MEDIUM 3; Linux seats are not verified yet).
 */
function notDumpable(): void {
  if (process.platform !== "linux") return;
  try {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const libc = dlopen("libc.so.6", { prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } });
    libc.symbols.prctl(4 /* PR_SET_DUMPABLE */, 0, 0, 0, 0);
  } catch { /* not available */ }
}

/** `claude --help` as this user, bounded and in its own group: does it know --permission-prompts? */
async function knowsPermissionPrompts(bin: string, env: Record<string, string>): Promise<boolean> {
  try {
    const p = Bun.spawn([bin, "--help"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env, detached: true });
    const kill = () => { try { process.kill(-p.pid, "SIGKILL"); } catch { /* gone */ } };
    const timer = setTimeout(kill, 10_000);
    try { return (await new Response(p.stdout).text()).includes("--permission-prompts"); } finally { clearTimeout(timer); kill(); }
  } catch {
    return false;
  }
}

/** `walkie seat-runner`. */
export async function runSeatRunner(): Promise<number> {
  notDumpable();
  const input = new Input(Bun.stdin.stream());
  const head = await input.line(HEADER_MAX);
  let raw: unknown = null;
  try { raw = head ? JSON.parse(head) : null; } catch { raw = null; }
  const op = (raw as { op?: unknown } | null)?.op;
  if ((raw as { rv?: unknown } | null)?.rv === RUNNER_PROTOCOL && (op === "stop" || op === "cont")) {
    try {
      const r = await uidOp(op);
      send(r);
      return r.verified ? 0 : 1;
    } catch (err) {
      return fail((err as Error).message);
    }
  }
  if ((raw as { rv?: unknown } | null)?.rv === RUNNER_PROTOCOL && op === "sweep") {
    try {
      const roots = validRoots((raw as { roots?: unknown }).roots);
      if (!roots) return fail("the sweep's extra roots are not valid paths");
      const r = sweepOp(seatHome(), process.env, roots);
      send({ ...r });
      return r.verified ? 0 : 1;
    } catch (err) {
      return fail((err as Error).message);
    }
  }
  const spec = validSpec(raw);
  if (!spec) return fail(`not a seat request this runner understands (protocol ${RUNNER_PROTOCOL}; re-run: walkie seats setup-user --apply after an update)`);
  return runSeat(spec, input);
}

async function runSeat(spec: RunnerSpec, input: Input): Promise<number> {
  const me = userInfo();
  const home = seatHome();
  const dir = join(home, "walkie-seats", spec.dir_name);
  const abort = new AbortController();
  try {
    mkdirSync(join(home, "walkie-seats"), { recursive: true, mode: 0o700 });
    mkdirSync(dir, { mode: 0o700 }); // fresh: an existing directory is refused
    mkdirSync(join(dir, "tmp"), { mode: 0o700 });
  } catch (err) {
    return fail(`the seat's directory could not be made under ${home}/walkie-seats: ${(err as Error).message}`);
  }
  // v2 (rv 7): the bundle is streamed straight to a 0600 file in the seat's own directory; v1: held in memory (≤ 25 MB).
  const streamed = spec.rv === RUNNER_PROTOCOL_V2 && spec.bundle_len > 0 ? join(dir, "input.bundle") : null;
  if (streamed) {
    const fd = openSync(streamed, "wx", 0o600);
    let ok = false;
    try { ok = await input.toFile(spec.bundle_len, fd); } finally { closeSync(fd); }
    if (!ok) return fail("the seat request ended early");
  }
  const bundle = spec.bundle_len && !streamed ? await input.bytes(spec.bundle_len) : null;
  const prompt = await input.bytes(spec.prompt_len);
  if (!prompt || (spec.bundle_len && !bundle && !streamed)) return fail("the seat request ended early");
  const tokenFile = join(dir, SEAT_TOKEN_FILE);
  writeFileSync(tokenFile, spec.token, { mode: 0o600 });
  const dropToken = () => rmSync(tokenFile, { force: true });
  const scope = fakeScope();
  // This run's own runtime configuration, fresh in the fresh home, with Walkie's settings: no hooks, whatever an
  // earlier seat or the repository planted (Codex r4 HIGH 2).
  const claudeConfig = join(dir, "claude-config");
  const codexHome = join(dir, "codex-home");
  mkdirSync(claudeConfig, { mode: 0o700 });
  mkdirSync(codexHome, { mode: 0o700 });
  writeFileSync(join(claudeConfig, "settings.json"), `${JSON.stringify({ disableAllHooks: true }, null, 2)}\n`, { mode: 0o600 });
  if (spec.claude_credentials) writeFileSync(join(claudeConfig, ".credentials.json"), spec.claude_credentials, { mode: 0o600 });
  if (spec.codex_auth) writeFileSync(join(codexHome, "auth.json"), spec.codex_auth, { mode: 0o600 });
  // This user's own identity: nothing of the daemon user's home, whatever the spec says.
  const env: Record<string, string> = {
    ...spec.env, HOME: home, USER: me.username, LOGNAME: me.username, SHELL: me.shell ?? "/bin/sh", TMPDIR: join(dir, "tmp"),
    CLAUDE_CONFIG_DIR: claudeConfig, CODEX_HOME: codexHome,
    WALKIE_SOCKET: spec.socket, WALKIE_SEAT_TOKEN_FILE: tokenFile, ...(scope ? { [FAKE_UID_ENV]: scope } : {}),
  };
  delete env.WALKIE_SEAT_TOKEN;
  delete env.WALKIE_HOME;

  // Control lines are read from here on: a stop may come while the clone runs.
  let child = null as ReturnType<typeof Bun.spawn> | null;
  let ended = false;
  void (async () => {
    for (;;) {
      const cmd = (await input.line(CONTROL_MAX))?.trim();
      const pid = child?.pid;
      if (cmd === undefined) {
        // stdin's end (the daemon is gone) or a broken line: nothing of this seat outlives it.
        abort.abort();
        if (pid) { signalGroup(pid, "SIGCONT"); signalGroup(pid, "SIGKILL"); }
        return;
      }
      if (cmd === "abort") { abort.abort(); continue; }
      if (!pid) { if (cmd === "kill" || cmd === "term") abort.abort(); continue; } // stopped while it prepares
      if (ended) continue;
      if (cmd === "term") { signalGroup(pid, "SIGCONT"); signalGroup(pid, "SIGTERM"); }
      else if (cmd === "kill") { signalGroup(pid, "SIGCONT"); signalGroup(pid, "SIGKILL"); }
    }
  })();

  let cwd = join(dir, "work");
  let base: string | null = null;
  let task: TaskFile | null = null;
  try {
    if (bundle || streamed) {
      const file = streamed ?? join(dir, "input.bundle");
      if (bundle) writeFileSync(file, bundle, { mode: 0o600 });
      const cloned = await cloneBundle(file, dir, env, abort.signal);
      cwd = cloned.repo;
      base = cloned.base;
      if (spec.branch) {
        const co = await git(["checkout", "--quiet", "-B", spec.branch], cwd, env, { signal: abort.signal });
        if (co.code !== 0) throw new Error(`the branch ${spec.branch} could not be made in the seat's clone`);
      }
    } else {
      mkdirSync(cwd, { mode: 0o700 });
    }
    if (spec.task) task = await writeTask(cwd, spec.task, env, abort.signal);
  } catch (err) {
    dropToken();
    return fail(abort.signal.aborted ? "stopped" : (err as Error).message);
  }
  if (abort.signal.aborted) { dropToken(); return fail("stopped"); }
  try { accessSync(spec.bin, constants.X_OK); } catch {
    dropToken();
    return fail(`${spec.bin} can't be run by the seat user ${me.username} (walkie seats setup-user --apply installs the runtimes for the seat users)`);
  }
  // v2: the brief went to .walkie/TASK.md (the tree had a TASK.md of its own): the fixed pointer follows it.
  const alt = task !== null && task.prompt !== SEAT_TASK_PROMPT;
  const args = spec.args.map((a) => (a === "{cwd}" ? cwd : alt && a === SEAT_TASK_PROMPT ? SEAT_TASK_PROMPT_ALT : a));
  const promptBytes = alt ? new TextEncoder().encode(new TextDecoder().decode(prompt).split(SEAT_TASK_PROMPT).join(SEAT_TASK_PROMPT_ALT)) : prompt;
  if (spec.probe_permission_prompts && await knowsPermissionPrompts(spec.bin, env)) args.push("--permission-prompts", "none");
  child = Bun.spawn([spec.bin, ...args], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "inherit", detached: true });
  const runtime = child;
  send({ ready: { dir, cwd, base, pid: runtime.pid } });
  const sink = runtime.stdin as import("bun").FileSink;
  sink.write(promptBytes);
  sink.end();
  const reader = (runtime.stdout as ReadableStream<Uint8Array>).getReader();
  const relay = (async () => {
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (r.done || !r.value) break;
      buf += dec.decode(r.value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        process.stdout.write(`o ${buf.slice(0, i)}\n`);
        buf = buf.slice(i + 1);
      }
      if (buf.length > 8 * 1024 * 1024) buf = "";
    }
    if (buf) process.stdout.write(`o ${buf}\n`);
  })();
  const code = await runtime.exited;
  // Its group is reaped at once, while its output drains (a leftover that inherited stdout would otherwise hold
  // the drain, and so the reap, open: Codex r3 MEDIUM 5); the drain is bounded.
  await reapGroup(runtime.pid);
  await Promise.race([relay, Bun.sleep(DRAIN_MS)]);
  void reader.cancel().catch(() => undefined);
  ended = true;
  send({ exit: code });
  // v2: the result file first (read as this user, no symlink followed; also after an abort: a plain file read),
  // then the brief is taken out of the tree.
  const result = spec.result_file ? readResultFile(cwd, spec.result_file) : null;
  removeTask(cwd, task);
  const file = result ? ("bytes" in result ? { file: Buffer.from(result.bytes).toString("base64") } : { file_error: result.error }) : {};
  if (abort.signal.aborted) { send({ outcome: result ? { commits: 0, dirty: 0, aborted: true, ...file } : null }); dropToken(); return 0; }
  // The post-run git runs as the seat user: nothing a seat planted can run as anyone else.
  // Its scratch space inside the run's own directory (never the user's shared tmpdir: Codex r5 MEDIUM 5).
  // A commit that carries the brief file is never returned (FO-2 r1 MEDIUM 5).
  const out = await seatOutcome(cwd, base, join(dir, "result.bundle"), env, abort.signal, join(dir, "tmp"), undefined, task?.file).catch(() => null);
  let bundleB64: string | undefined;
  if (out?.bundle) {
    try {
      const bytes = readFileSync(out.bundle);
      if (bytes.byteLength <= RUNNER_MAX_BUNDLE) bundleB64 = Buffer.from(bytes).toString("base64");
    } catch { /* no bundle */ }
  }
  send({ outcome: out ? { commits: out.commits, dirty: out.dirty, ...(bundleB64 ? { bundle: bundleB64 } : {}), ...(out.brief ? { brief: true } : {}), ...file } : result ? { commits: 0, dirty: 0, ...file } : null });
  dropToken();
  return 0;
}
