// One `claude -p` child in stream-json mode: spawn, line reader, stdin writes, graceful close. The supervisor
// (host.ts) decides when to start, restart and switch sessions.
import { randomUUID } from "node:crypto";
import { walkieArgv } from "../../hooks/install.ts";
import { HEARTBEAT_MS, OS_USER_RUNNER_PARENT } from "./supervisor.ts";
import { killMarkedProcesses } from "./marked-processes.ts";
import { existsSync, statSync, realpathSync, writeFileSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { PermissionMode } from "../../protocol/orchestrator.ts";
import { redactSecrets } from "../../protocol/safety.ts";
import { parseClaudeLine, type ClaudeSignal } from "./claude-stream.ts";

/** Raw stderr kept for the exit diagnostic (bounded memory); scrubbed as a whole before anything is cut from it. */
const STDERR_WINDOW = 64 * 1024;
/** What onExit gets: the end of the scrubbed diagnostic. */
const STDERR_TAIL = 4 * 1024;
/** A stdout line longer than this is dropped (a runaway tool result must not grow memory without bound). */
const MAX_LINE = 8 * 1024 * 1024;

export interface ArgsSpec {
  session: string;
  /** Resume an existing session (--resume) rather than create it (--session-id). */
  resume: boolean;
  model?: string;
  permissionMode: PermissionMode;
  /** The installed claude knows `--permission-prompts` (then prompts are denied instead of waiting on stdin). */
  permissionPrompts: boolean;
  /** Permission rules allowed without a prompt (ORCH-2: the Walkie tools), sent as one comma-separated value. */
  allowedTools: readonly string[];
  /** An MCP config (JSON) loaded for this session: the walkie server, so its tools exist whatever the hooks say. */
  mcpConfig?: string;
  systemPrompt: string;
  /**
   * `none`: a turn that needs no tool (a duty whose facts are all in its prompt and whose reply the daemon acts on):
   * no built-in tool, no MCP server (so nothing to allow), and never bypassed permissions, so text injected into its
   * prompt has nothing to call. Absent: the ordinary turn.
   */
  tools?: "none";
}

/**
 * The walkie MCP server for the orchestrator's Claude (ORCH-2, Codex RC MEDIUM 5): this daemon's own walkie (`argv`,
 * e.g. the installed binary, or bun + main.ts in development) running `mcp` against this daemon's home and socket.
 * Named "walkie", so `mcp__walkie` in the allowed tools names its tools. Pure; tested.
 */
export function walkieMcpConfig(argv: readonly string[], home: string, socket: string): string {
  const [command, ...pre] = argv;
  return JSON.stringify({ mcpServers: { walkie: { type: "stdio", command, args: [...pre, "mcp"], env: { WALKIE_HOME: home, WALKIE_SOCKET: socket } } } });
}

/**
 * The flags only a tool-less turn's argv carries (claudeArgs `tools: "none"`). A claude that rejects one of them cannot run
 * such a turn; the host then fails that turn alone (host.ts onToollessRejected) instead of giving up on WalkieTalkie.
 */
export const TOOLLESS_FLAGS: readonly string[] = ["--tools", "--strict-mcp-config"];

/** The exact argv after the binary (pure; tested). */
export function claudeArgs(s: ArgsSpec): string[] {
  const none = s.tools === "none";
  return [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    s.resume ? "--resume" : "--session-id", s.session,
    "--permission-mode", none ? "default" : s.permissionMode,
    "--setting-sources", "",
    // `--tools=` (an empty list, claude's documented way to disable every built-in tool) and no MCP server at all.
    ...(none ? ["--tools=", "--strict-mcp-config"] : []),
    // One value, so the variadic option can't swallow what follows it.
    ...(!none && s.allowedTools.length ? [`--allowedTools=${s.allowedTools.join(",")}`] : []),
    ...(!none && s.mcpConfig ? [`--mcp-config=${s.mcpConfig}`] : []),
    ...(s.permissionPrompts ? ["--permission-prompts", "none"] : []),
    ...(s.model ? ["--model", s.model] : []),
    "--append-system-prompt", s.systemPrompt,
  ];
}

/** Claude blocks a tool when its hook exits 2; finish before Claude's own 15-second timeout. */
export function leaseHookCommand(argv: readonly string[], seconds = 10): string {
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  return ["/usr/bin/perl", "-e", `$SIG{ALRM}=sub{exit 2}; alarm ${seconds}; system @ARGV; exit($? == 0 ? 0 : 2)`, "--", ...argv].map(quote).join(" ") + " || exit 2";
}

function executable(p: string): boolean {
  try { return existsSync(p) && statSync(p).isFile() && (statSync(p).mode & 0o111) !== 0; } catch { return false; }
}

/** Where `claude` usually lives when a service's PATH doesn't include it. */
export function fallbackDirs(home = homedir()): string[] {
  return [join(home, ".local", "bin"), join(home, ".claude", "local"), join(home, ".bun", "bin"), join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
}

/** The claude binary: an explicit path, else the first `claude` on `path`, else the usual install locations. */
export function findClaude(explicit: string | undefined, path: string | undefined): string | null {
  if (explicit) return executable(explicit) ? explicit : null;
  for (const dir of [...(path ?? "").split(delimiter).filter(Boolean), ...fallbackDirs()]) {
    const p = join(dir, "claude");
    if (executable(p)) return p;
  }
  return null;
}

/**
 * Variables the child never inherits: every `ANTHROPIC_*` (an API key, token or base URL would bill the API, or
 * another endpoint, instead of the person's subscription) and every `CLAUDE_CODE_*` / `CLAUDECODE` of a parent
 * session, except CLAUDE_CODE_OAUTH_TOKEN: that is the subscription sign-in itself (`claude setup-token`).
 */
export function dropFromChild(name: string): boolean {
  if (name === "CLAUDE_CODE_OAUTH_TOKEN") return false;
  return name === "CLAUDECODE" || name.startsWith("CLAUDE_CODE_") || name.startsWith("ANTHROPIC_");
}

/** The child's environment: ours minus dropFromChild, the given PATH (claude's dir first), and the Walkie variables. */
export function childEnv(base: NodeJS.ProcessEnv, bin: string, path: string | undefined, walkie: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !dropFromChild(k)) env[k] = v;
  const dirs = [dirname(bin), ...(path ?? base.PATH ?? "").split(delimiter).filter(Boolean)];
  env.PATH = [...new Set(dirs)].join(delimiter);
  return { ...env, ...walkie };
}

/** A path can keep its name while an installer atomically replaces the executable behind it. */
export function claudeBinaryIdentity(bin: string): string | null {
  try {
    const path = realpathSync(bin);
    const st = statSync(path);
    return `${path}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch { return null; }
}

const VALUE_FLAGS = new Set(["--permission-prompts"]);

/** Only a flag present in the argv may be removed; never retry an unrelated Claude error. */
export function unsupportedClaudeFlag(args: readonly string[], diagnostic: string): { flag: string; args: string[] } | null {
  const flag = /unknown option\s+['"`]?(-{1,2}[a-zA-Z][\w-]*)/i.exec(diagnostic)?.[1];
  if (flag !== "--permission-prompts") return null;
  const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (index < 0) return null;
  const count = args[index] === flag && VALUE_FLAGS.has(flag) ? 2 : 1;
  return { flag, args: [...args.slice(0, index), ...args.slice(index + count)] };
}

export function withoutUnsupportedClaudeFlag(args: readonly string[], diagnostic: string): string[] | null {
  return unsupportedClaudeFlag(args, diagnostic)?.args ?? null;
}

/** The dedicated uid gets only its runtime, system tools and the credentials meant for this one process. */
export function shellChildEnv(base: NodeJS.ProcessEnv, bin: string, walkie: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: [...new Set([dirname(bin), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(delimiter),
  };
  if (base.LANG) env.LANG = base.LANG;
  if (base.TERM) env.TERM = base.TERM;
  for (const key of ["WALKIE_AGENT", "WALKIE_HOME", "WALKIE_SOCKET", "WALKIE_ORCHESTRATOR_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"])
    if (walkie[key]) env[key] = walkie[key];
  return env;
}

/** Whether this claude understands `--permission-prompts` (older versions exit on unknown options). */
export async function supportsPermissionPrompts(bin: string, env: Record<string, string>, signal?: AbortSignal): Promise<boolean> {
  try {
    // Its own process group, ended as a whole on a timeout or when `signal` aborts (a remote seat stopped while it
    // prepares, PROTOCOL §11).
    const p = Bun.spawn([bin, "--help"], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env, detached: true });
    const kill = () => { try { process.kill(-p.pid, "SIGKILL"); } catch { p.kill("SIGKILL"); } };
    const timer = setTimeout(kill, 10_000);
    signal?.addEventListener("abort", kill, { once: true });
    try {
      const out = await new Response(p.stdout).text();
      return !signal?.aborted && out.includes("--permission-prompts");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      kill();
    }
  } catch {
    return false;
  }
}

export interface ChildHandlers<S = ClaudeSignal> {
  onSignal(s: S): void;
  onExit(code: number | null, stderrTail: string): void;
}

/**
 * The exit diagnostic from Claude's stderr, scrubbed BEFORE it is cut (ORCH-FIX-2, Codex MEDIUM 4: cutting first
 * could drop `password=` and keep the password). `raw` is the last STDERR_WINDOW characters, scrubbed whole by the
 * team-wide scrubber (whole private keys, to their END or the end of the text, provider tokens, labelled values).
 * When earlier output was discarded (`cut`), a value at the window's start may belong to a label or a key block that
 * was discarded with it, which no scrubber can recognise, so nothing of it is shown (ORCH-FIX-12: the conservative
 * form of ORCH-FIX-3/4's window rules, which relied on the older scrubber's bounded reach).
 */
export function stderrDiagnostic(raw: string, cut: boolean): string {
  if (cut) return "";
  return tidy(redactSecrets(raw).text).slice(-STDERR_TAIL);
}

/** The line breaks a redacted key kept, folded to one blank line. */
function tidy(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}


/** After Claude exits, what its tools left running gets this long between SIGTERM and SIGKILL. */
const REAP_GRACE_MS = 2_000;
/** How often a reap checks whether the process group is gone. */
const REAP_POLL_MS = 50;
/** After SIGKILL, how long a reap waits for the group's exits to be collected. */
const REAP_KILL_WAIT_MS = 1_000;

/**
 * Claude runs under a detached supervisor. Tools may create their own sessions; the per-run marker
 * and process-tree cleanup keep them tied to this lease.
 */
export class ClaudeChild<S = ClaudeSignal> {
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly runMarker: string;
  private stderr = "";
  private stderrCut = false;
  private readonly stderrFinished: Promise<void>;
  /** Key blocks in all of stderr, so a window that starts inside one is known (ORCH-FIX-4). */
  private closed = false;
  readonly exited: Promise<number | null>;
  /**
   * Resolves once Claude has exited AND its process group is gone (or was sent SIGKILL): the descendants its tools
   * started are part of stopping it. A daemon shutdown awaits this, so exiting can't abandon the final SIGKILL
   * (ORCH-FIX-2, Codex MEDIUM 5).
   */
  readonly reaped: Promise<void>;

  /**
   * `parse` turns one stdout line into a signal (default: Claude's stream-json; a remote seat passes Codex's JSONL
   * parser too, PROTOCOL §11).
   */
  constructor(
    bin: string, args: string[], cwd: string, env: Record<string, string>, private readonly h: ChildHandlers<S>,
    private readonly parse: (line: string) => S | null = parseClaudeLine as unknown as (line: string) => S | null,
    lease?: { directory: string; expires: () => number; epoch?: number; hook?: boolean;
      osUser?: { name: string; home: string; runner: string; switch?: string[] } },
  ) {
    const file = lease ? join(lease.directory, `orchestrator-lease-${randomUUID()}.json`) : null;
    const run = lease ? `${lease.epoch ?? 0}.${randomUUID()}` : "";
    this.runMarker = run;
    let serial = 0;
    const renew = () => {
      if (!lease || !file) return;
      writeFileSync(`${file}.tmp`, JSON.stringify({ expires: lease.expires(), renewed: Date.now(), serial: serial++, epoch: lease.epoch ?? 0, run }), { mode: lease.osUser ? 0o644 : 0o600 });
      renameSync(`${file}.tmp`, file);
    };
    renew();
    try {
      const internal = lease?.osUser ? [lease.osUser.runner] : walkieArgv();
      const hookCommand = file ? leaseHookCommand([...internal, "--internal-orchestrator-hook", file]) : "";
      const hook = file && lease?.hook ? JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand, timeout: 15 }] }] } }) : null;
      if (lease && !lease.osUser) mkdirSync(join(lease.directory, "talkie"), { recursive: true, mode: 0o700 });
      const command = file ? [...internal, "--internal-orchestrator-supervisor", file,
        lease?.osUser ? OS_USER_RUNNER_PARENT : String(process.pid), bin, ...args, ...(hook ? ["--settings", hook] : [])] : [bin, ...args];
      const spawnEnv = { ...env, ...(file ? { WALKIE_TALKIE_RUN: run } : {}) };
      const os = lease?.osUser;
      this.proc = Bun.spawn(os ? os.switch ?? ["sudo", "-n", "-u", os.name, os.runner, "talkie-runner"] : command,
        { cwd: os ? "/" : lease ? join(lease.directory, "talkie") : cwd,
          env: os ? { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" } : spawnEnv,
          stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
      if (os) {
        const sink = this.proc.stdin as import("bun").FileSink;
        sink.write(`${JSON.stringify({ argv: command, cwd: os.home, env: { ...spawnEnv, HOME: os.home,
          USER: os.name, LOGNAME: os.name, CLAUDE_CONFIG_DIR: join(os.home, ".claude"), TMPDIR: "/tmp" } })}\n`);
        sink.flush();
      }
    } catch (err) {
      if (file) rmSync(file, { force: true });
      throw err;
    }
    const heartbeat = file ? setInterval(() => {
      try { renew(); } catch { this.terminate(); }
    }, HEARTBEAT_MS) : null;
    heartbeat?.unref();
    void this.proc.exited.finally(() => {
      if (heartbeat) clearInterval(heartbeat);
      if (file) { rmSync(file, { force: true }); rmSync(`${file}.tmp`, { force: true }); }
    });
    void this.readStdout();
    this.stderrFinished = this.readStderr();
    this.exited = this.proc.exited.then(async (code) => {
      // Bun reports process exit before its piped stderr reader necessarily sees EOF.
      // A descendant may retain the pipe; bound the wait rather than delaying restart forever.
      await Promise.race([this.stderrFinished, Bun.sleep(1_000)]);
      this.closed = true;
      this.h.onExit(code, stderrDiagnostic(this.stderr, this.stderrCut));
      return code;
    });
    this.reaped = this.exited.then(() => this.reap());
  }

  /** Signals Claude's whole process group; false when no process of it is left. */
  private signalGroup(sig: NodeJS.Signals | 0): boolean {
    try {
      process.kill(-this.proc.pid, sig);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Claude has exited: ends the descendants still in its group: SIGTERM, then SIGKILL once REAP_GRACE_MS pass with
   * any of them left. Resolves when the group is gone or has been sent SIGKILL.
   */
  private async reap(): Promise<void> {
    if (this.runMarker) {
      killMarkedProcesses(this.proc.pid, this.runMarker);
      this.signalGroup("SIGKILL");
      return;
    }
    if (!this.signalGroup("SIGTERM")) return;
    if (await this.groupGone(REAP_GRACE_MS)) return;
    this.signalGroup("SIGKILL");
    await this.groupGone(REAP_KILL_WAIT_MS); // SIGKILL can't be ignored; this only waits for the exits to land
  }

  /** Polls until no process of the group is left (true) or `ms` pass (false). */
  private async groupGone(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await Bun.sleep(REAP_POLL_MS);
      if (!this.signalGroup(0)) return true;
    }
    return false;
  }

  get pid(): number { return this.proc.pid; }
  get marker(): string { return this.runMarker; }
  get alive(): boolean { return !this.closed && this.proc.exitCode === null; }

  write(line: string): boolean {
    if (!this.alive) return false;
    try {
      const stdin = this.proc.stdin as import("bun").FileSink;
      stdin.write(line);
      stdin.flush();
      return true;
    } catch {
      return false;
    }
  }

  /** Ends stdin: the child has everything it will be given (a one-shot seat run reads its prompt to EOF). */
  endInput(): void {
    try { (this.proc.stdin as import("bun").FileSink).end(); } catch { /* already closed */ }
  }

  /**
   * Ends stdin (claude exits after the current turn), then SIGTERM, then SIGKILL, each to the whole process group.
   * Returns once the group is reaped too, also when Claude had already exited on its own.
   */
  /** Lease fencing: stop the process group immediately, without a graceful drain beyond the deadline. */
  terminate(): void {
    if (this.runMarker) killMarkedProcesses(this.proc.pid, this.runMarker);
    this.signalGroup("SIGKILL");
    try { this.proc.kill("SIGKILL"); } catch { /* already exited */ }
  }

  async close(graceMs = 3_000): Promise<void> {
    if (this.closed) { await this.reaped; return; }
    try { (this.proc.stdin as import("bun").FileSink).end(); } catch { /* already closed */ }
    const done = await Promise.race([this.exited.then(() => true), Bun.sleep(graceMs).then(() => false)]);
    if (!done) {
      if (this.runMarker) this.terminate();
      else if (!this.signalGroup("SIGTERM")) this.proc.kill("SIGTERM");
      const termed = await Promise.race([this.exited.then(() => true), Bun.sleep(REAP_GRACE_MS).then(() => false)]);
      if (!termed) this.terminate();
    }
    await this.reaped;
  }

  private async readStdout(): Promise<void> {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const s = this.parse(line);
          if (s) this.h.onSignal(s);
        }
        if (buf.length > MAX_LINE) buf = "";
      }
      const s = this.parse(buf);
      if (s) this.h.onSignal(s);
    } catch { /* the child went away; onExit reports it */ }
  }

  private async readStderr(): Promise<void> {
    const reader = (this.proc.stderr as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        const next = this.stderr + chunk;
        if (next.length > STDERR_WINDOW) this.stderrCut = true;
        this.stderr = next.slice(-STDERR_WINDOW); // raw: stderrDiagnostic scrubs it whole before cutting it further
      }
    } catch { /* gone */ }
  }
}
