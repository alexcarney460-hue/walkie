// Is this CLI serving a model rather than a person (WALKIE-ADD-MACHINE-3)? Two signals, each chosen so a person's own
// terminal never matches:
//
// 1. Environment markers that an agent runtime sets for the commands its tools run, never configuration. Matched on
//    a non-empty value that isn't "0"/"false"/"no" (a key that is merely present, or empty, is not a marker):
//      CLAUDECODE                      Claude Code: "1" in every Bash-tool command (seen live).
//      AI_AGENT                        Claude Code: "claude-code_<version>_agent" in the same commands (seen live).
//      CODEX_THREAD_ID, CODEX_SESSION_ID, CODEX_CI
//                                      Codex: set for commands it runs, sandboxed or not (captured live from an
//                                      unsandboxed `codex exec` child, Codex 0.156.1).
//      CODEX_SANDBOX, CODEX_SANDBOX_NETWORK_DISABLED
//                                      Codex: its sandboxed commands (names in the 0.156.1 binary).
//      WALKIE_AGENT                    Walkie's own agent identity (the MCP server's name, seats, scripts that say so).
//      GEMINI_CLI, CURSOR_AGENT, OPENCODE
//                                      best-effort, not verified here (documented by those tools for their shells).
//    Not markers: CODEX_HOME, OPENCODE_CONFIG, AIDER_*, KIMI_* and the like are configuration a person exports in
//    their own shell. Kimi Code (0.43.1) sets no variable at all for the commands its tools run (seen live).
// 2. The process's ancestors: an agent runtime's executable above this CLI (claude, codex, kimi, cursor-agent,
//    gemini, aider, …, also as `node …/claude-code/cli.js` or `python …/aider`). This covers runtimes without an
//    environment marker (Kimi), and markers a person's terminal inherited by accident (a tmux server started from an
//    agent's shell hands CLAUDECODE to every later pane: a pane's ancestors are tmux and launchd, not claude, but the
//    variable remains; the person unsets it).
//
// Neither is a boundary against a hostile agent running as the same OS user (it can clean its environment, or call
// the socket directly): see SECURITY.md "Known limits". They keep honest agents from acting as the person.
import { remoteRunToken } from "../client/remote-run.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

type Env = Record<string, string | undefined>;

/** Exact environment variable names (see above), in the order they are reported. */
export const AGENT_ENV_MARKERS = [
  "WALKIE_AGENT", "CLAUDECODE", "AI_AGENT", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_CI", "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED", "GEMINI_CLI", "CURSOR_AGENT", "OPENCODE",
] as const;

/**
 * Agent runtime CLIs (lowercase basenames; interpreters are looked through, see agentProcessOf). Kimi Code 0.43.1
 * renames its process "kimi-code" (seen live in a `kimi -p` tool call's ancestors). GUI apps are never matched
 * (ADD-MACHINE-4): anything inside an app bundle (`*.app/Contents/…`: Claude.app, Codex.app, Cursor.app, Windsurf.app)
 * hosts a person's terminals too, so Windsurf and editors are not on this list.
 */
export const AGENT_PROCESSES: ReadonlySet<string> = new Set([
  "claude", "codex", "kimi", "kimi-code", "cursor-agent", "gemini", "aider", "opencode", "goose", "amp", "crush", "qwen", "copilot",
  "cline", "hermes",
]);

const INTERPRETERS = /^(node|nodejs|bun|deno|python[23]?(\.\d+)?|pypy3?|sh|bash|zsh|dash)$/;
const PYTHON = /^(python[23]?(\.\d+)?|pypy3?)$/;
/** Interpreter options that take the next argument as their value (so it isn't the script). */
const VALUE_OPTIONS = new Set(["-W", "-X", "-c", "-r", "--require", "--import", "--loader", "--experimental-loader", "-e", "--eval", "--config", "--cwd"]);
/** Runner subcommands before the script (`bun run x.js`, `deno run -A npm:…`, `npx`/`bunx`-style `x`/`exec`). */
const RUNNER_SUBCOMMANDS = new Set(["run", "x", "exec"]);
/** Python modules / npm packages that are an agent runtime. */
const MODULES: Readonly<Record<string, string>> = { hermes_cli: "hermes", aider: "aider", kimi_cli: "kimi", "kimi-cli": "kimi" };
const PACKAGE_PATHS: ReadonlyArray<[RegExp, string]> = [
  [/@anthropic-ai\/claude-code(\/|@|$)/, "claude"], [/@openai\/codex(\/|@|$)/, "codex"], [/@google\/gemini-cli(\/|@|$)/, "gemini"],
];

function isSet(v: string | undefined): boolean {
  const t = (v ?? "").trim().toLowerCase();
  return t !== "" && t !== "0" && t !== "false" && t !== "no";
}

/** The first environment marker set in `env` ("CLAUDECODE"), or null. */
export function envAgentMarker(env: Env = process.env): string | null {
  for (const k of AGENT_ENV_MARKERS) if (isSet(env[k])) return k;
  return null;
}

/** The runtime an environment marker names, for the admin audit trail (AGENT-ADMIN-1); null without a marker. */
const MARKER_RUNTIME: Readonly<Record<string, string>> = {
  WALKIE_AGENT: "walkie-agent", CLAUDECODE: "claude-code", AI_AGENT: "claude-code", CODEX_THREAD_ID: "codex", CODEX_SESSION_ID: "codex",
  CODEX_CI: "codex", CODEX_SANDBOX: "codex", CODEX_SANDBOX_NETWORK_DISABLED: "codex", GEMINI_CLI: "gemini", CURSOR_AGENT: "cursor-agent",
  OPENCODE: "opencode",
};

export function runtimeLabel(env: Env = process.env): string | null {
  if (env === process.env && remoteRunToken()) return "remote-admin";
  const m = envAgentMarker(env);
  return m ? MARKER_RUNTIME[m] ?? "agent" : null;
}

/** Whether `env` carries an agent runtime's marker (the CLI's output is then shaped for a model, PROTOCOL §6). */
export function underAgent(env: Env = process.env): boolean {
  return envAgentMarker(env) !== null || (env === process.env && remoteRunToken() !== null);
}

function runtimeName(path: string): string | null {
  // Claude Code's native install runs as ~/.local/share/claude/versions/<version>.
  if (/\/claude\/versions\/[^/\s]+$/.test(path.trim())) return "claude";
  const s = basename(path.trim()).toLowerCase().replace(/\.(m?js|cjs|ts|py)$/, "");
  if (AGENT_PROCESSES.has(s)) return s;
  if (MODULES[s]) return MODULES[s] as string;
  return /^grok(-\d+\.\d+\.\d+-.*)?$/.test(s) ? "grok" : null;
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

/**
 * An app bundle's GUI binary or helper (Claude.app/Contents/MacOS/Claude, "…/Frameworks/Windsurf Helper (Plugin).app/…",
 * "Grok Bot.app"): never an agent CLI. A CLI shipped inside a bundle's Resources (Codex.app/Contents/Resources/codex)
 * is judged by its own name.
 */
function inAppBundle(path: string): boolean {
  return /\.app\/Contents\/(MacOS|Frameworks)\//.test(path);
}

/**
 * A `ps` command line as argv. `ps` can't say where an argument with spaces ends ("/Applications/Grok Bot.app/…"),
 * so the executable is the longest prefix that is a file on this machine; when none is, it runs to the first
 * option-looking word (so an app bundle path with spaces is still seen whole). Linux gives exact argv instead.
 */
function psArgv(command: string): string[] {
  const words = command.trim().split(/\s+/);
  for (let i = words.length; i >= 1; i--) {
    const cand = words.slice(0, i).join(" ");
    if (cand.startsWith("/") && isFile(cand)) return [cand, ...words.slice(i)];
  }
  const opt = words.findIndex((w, k) => k > 0 && w.startsWith("-"));
  const head = words.slice(0, opt < 0 ? words.length : opt).join(" ");
  return inAppBundle(head) ? [head, ...words.slice(opt < 0 ? words.length : opt)] : words;
}

/**
 * The agent runtime CLI a process is ("claude"), or null. `argv` is exact when the platform gives it (Linux:
 * /proc/<pid>/cmdline); a `ps` line (macOS) goes through psArgv. Interpreters are looked through: their options,
 * `-m module`, runner subcommands (`bun run`, `deno run -A npm:@google/gemini-cli`), then the script.
 */
export function agentProcessOf(cmd: string | readonly string[]): string | null {
  const argv = (typeof cmd === "string" ? psArgv(cmd) : [...cmd]).map((a) => a.trim()).filter((a, i) => i > 0 || a !== "");
  const exe0 = argv[0] ?? "";
  const exe = basename(exe0).toLowerCase();
  const interpreter = INTERPRETERS.test(exe);
  // A GUI app and its helpers hosts people's terminals. An interpreter living in a bundle (Homebrew's Python
  // re-execs as …/Python.app/Contents/MacOS/Python) is still looked through.
  if (inAppBundle(exe0) && !interpreter) return null;
  if (!interpreter) return runtimeName(exe0);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-m" || (PYTHON.test(exe) && /^-m\S/.test(a))) {
      const mod = (a === "-m" ? argv[i + 1] : a.slice(2)) ?? "";
      return runtimeName(mod.split(".")[0] ?? "");
    }
    if (a === "-c" && PYTHON.test(exe)) {
      // `python -c "from hermes_cli.main import main; main()"`: the program is named in the code.
      const code = typeof cmd === "string" ? argv.slice(i + 1).join(" ") : argv[i + 1] ?? ""; // a ps line split the code
      const m = /\b(hermes_cli|aider|kimi_cli)\b/.exec(code);
      return m ? runtimeName(m[1] as string) : null;
    }
    if (VALUE_OPTIONS.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    if (i === 1 && RUNNER_SUBCOMMANDS.has(a) && /^(bun|deno)$/.test(exe)) continue;
    for (const [re, name] of PACKAGE_PATHS) if (re.test(a)) return name;
    if (inAppBundle(a)) return null;
    const script = typeof cmd === "string" ? scriptPath(argv, i) : a;
    return runtimeName(script);
  }
  return null;
}

/** From a ps line: the script argument, as the longest run of words from `i` that is a file ("/home/Alex Smith/…"). */
function scriptPath(argv: readonly string[], i: number): string {
  for (let j = argv.length; j > i + 1; j--) {
    const cand = argv.slice(i, j).join(" ");
    if (cand.startsWith("/") && isFile(cand)) return cand;
  }
  return argv[i] as string;
}

export interface ProcRow { ppid: number; command: string; argv?: string[] }

/** A process's exact argv on Linux (/proc/<pid>/cmdline, NUL-separated), or undefined. */
function procArgv(pid: number): string[] | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`);
    const parts = raw.toString("utf8").split("\0");
    if (parts.at(-1) === "") parts.pop();
    return parts.length ? parts : undefined;
  } catch {
    return undefined;
  }
}

/** Linux: the process table from /proc (ppid from stat, exact argv from cmdline), or null. */
function procTable(): Map<number, ProcRow> | null {
  if (process.platform !== "linux") return null;
  try {
    const table = new Map<number, ProcRow>();
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]); // after "(comm) state"
        const argv = procArgv(Number(name));
        table.set(Number(name), { ppid, command: (argv ?? []).join(" "), ...(argv ? { argv } : {}) });
      } catch { /* exited meanwhile */ }
    }
    return table.size ? table : null;
  } catch {
    return null;
  }
}

/**
 * This machine's process table: /proc on Linux (exact argv; no `ps`, which a sandbox may forbid), else `ps -ww -A`.
 * Null when neither can be read: a diagnostic ("process inspection unavailable"), never the decision (the gate is
 * the terminal confirmation).
 */
export function readProcessTable(): Map<number, ProcRow> | null {
  const proc = procTable();
  if (proc) return proc;
  try {
    const r = Bun.spawnSync(["ps", "-ww", "-A", "-o", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore", env: { PATH: "/bin:/usr/bin" }, timeout: 3_000 });
    if (r.exitCode !== 0) return null;
    const table = new Map<number, ProcRow>();
    for (const line of r.stdout.toString().split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] as string });
    }
    return table.size ? table : null;
  } catch {
    return null;
  }
}

/**
 * The nearest agent runtime above `pid` (its parent first), or null; `incomplete` when the walk stopped before init
 * (a parent missing from the table, or one whose command line couldn't be read).
 */
export function walkAncestors(table: ReadonlyMap<number, ProcRow>, pid: number): { found: { name: string; pid: number } | null; incomplete: boolean } {
  const seen = new Set<number>();
  let incomplete = false;
  for (let p = pid, depth = 0; p > 1 && depth < 64 && !seen.has(p); depth++) {
    seen.add(p);
    const row = table.get(p);
    if (!row) return { found: null, incomplete: true };
    if (!(row.argv?.length || row.command.trim())) incomplete = true;
    const name = agentProcessOf(row.argv ?? row.command); // exact argv when the table came from /proc
    if (name) return { found: { name, pid: p }, incomplete };
    p = row.ppid;
  }
  return { found: null, incomplete };
}

/** The nearest agent runtime above `pid` (its parent first), or null. */
export function agentAncestor(table: ReadonlyMap<number, ProcRow> | null, pid: number): { name: string; pid: number } | null {
  return table ? walkAncestors(table, pid).found : null;
}

export interface AgentSignals {
  /** Why this CLI counts as an agent's ("CLAUDECODE is set in its environment", "it runs under kimi (pid 812)"), or null. */
  marker: string | null;
  /**
   * Whether the ancestors could be examined: "unavailable" (no process table: only the environment was checked) or
   * "incomplete" (a parent or its command line couldn't be read). A diagnostic, never the decision.
   */
  inspection: "ok" | "unavailable" | "incomplete";
}

/**
 * The extra signals for person-only commands (the gate is the terminal confirmation, src/cli/context.ts): the flag,
 * then the environment, then the ancestors. Best effort: a runtime this doesn't know passes it.
 */
export function agentSignals(o: { forAgentFlag?: boolean; env?: Env; table?: () => ReadonlyMap<number, ProcRow> | null; ppid?: number } = {}): AgentSignals {
  if (o.forAgentFlag) return { marker: "--for-agent was given", inspection: "ok" };
  if (!o.env && remoteRunToken()) return { marker: "it is a remote admin run (walkie admin --machine)", inspection: "ok" };
  const env = envAgentMarker(o.env ?? process.env);
  if (env) return { marker: `${env} is set in its environment`, inspection: "ok" };
  const table = (o.table ?? readProcessTable)();
  if (!table) return { marker: null, inspection: "unavailable" };
  const { found, incomplete } = walkAncestors(table, o.ppid ?? process.ppid);
  return { marker: found ? `it runs under ${found.name} (pid ${found.pid})` : null, inspection: found || !incomplete ? "ok" : "incomplete" };
}

/** agentSignals' marker only. */
export function agentMarker(o: Parameters<typeof agentSignals>[0] = {}): string | null {
  return agentSignals(o).marker;
}
