// AGENT-SEE-1: which processes are agents, and which are local model servers, from a `ps` row alone (no environment,
// no file access). Discovery (discovery.ts) uses it to find every agent a machine runs, hooked or not: Claude Code
// (interactive, `claude -p`, the SDK's native binary, an ACP adapter), Codex, Kimi Code (whose process renames itself
// "kimi-code", so its argv is gone), Grok, Gemini CLI and opencode. Model servers (ollama, llama.cpp, vLLM, MLX) are
// machine load, not agents: they are counted per machine (MachineStats.model_servers).
//
// Nothing here is sent anywhere: the command line only decides the runtime and whether it runs headless.
import { basename } from "node:path";

export type AgentRuntime = "claude-code" | "codex" | "kimi" | "grok" | "gemini" | "opencode" | "hermes";

/** How an agent was started, when that is known: a one-shot run (`-p`, `exec`, no terminal) or an ACP adapter. */
export type Launch = "headless" | "acp";

export interface AgentKind {
  runtime: AgentRuntime;
  launch?: Launch;
  /** An ACP adapter: an agent only while it runs no agent process of its own (then that process is the agent). */
  host?: true;
}

/** Subcommands that are not an agent session. Hermes keeps its own list, HERMES_MANAGEMENT_COMMANDS (read by hermesRuns). */
const NOT_A_SESSION: Record<Exclude<AgentRuntime, "hermes">, ReadonlySet<string>> = {
  "claude-code": new Set(["mcp", "doctor", "update", "install", "config", "migrate-installer", "setup-token", "--version", "-v", "-h", "--help"]),
  codex: new Set(["app-server", "mcp", "mcp-server", "login", "logout", "completion", "proto", "debug", "apply", "--version", "-V", "-h", "--help"]),
  kimi: new Set(["mcp", "migrate", "--version", "-V", "-h", "--help"]),
  grok: new Set(["login", "logout", "mcp", "update", "completions", "--version", "-V", "-h", "--help"]),
  gemini: new Set(["mcp", "extensions", "--version", "-v", "-h", "--help"]),
  opencode: new Set(["serve", "web", "mcp", "auth", "models", "upgrade", "uninstall", "stats", "export", "import", "github", "--version", "-v", "-h", "--help"]),
};

/** Flags that make a run one-shot (no conversation with a person). */
const HEADLESS_FLAGS: Record<AgentRuntime, ReadonlySet<string>> = {
  "claude-code": new Set(["-p", "--print", "--input-format", "--output-format"]),
  codex: new Set(),
  kimi: new Set(["-p", "--print", "--prompt"]),
  grok: new Set(["-p", "--prompt", "--prompt-file"]),
  gemini: new Set(["-p", "--prompt"]),
  opencode: new Set(),
  hermes: new Set(["-z"]),
};
const HEADLESS_SUBCOMMANDS: Partial<Record<AgentRuntime, ReadonlySet<string>>> = {
  codex: new Set(["exec", "e"]),
  opencode: new Set(["run"]),
};

/** Scripts a Node / Bun runs that are the agent itself (npm installs). */
const SCRIPTS: ReadonlyArray<readonly [RegExp, AgentRuntime]> = [
  [/@anthropic-ai\/claude-(?:code|agent-sdk)\/cli\.m?js$/, "claude-code"],
  [/@google\/gemini-cli\/(?:dist\/)?index\.m?js$|\/gemini-cli\/bundle\/gemini\.m?js$|(?:^|\/)gemini$/, "gemini"],
  [/(?:^|\/)opencode-ai\/bin\/opencode$|(?:^|\/)opencode$/, "opencode"],
  [/(?:^|\/)kimi$/, "kimi"],
];
/** ACP adapters (Zed's Agent Client Protocol): an editor's bridge to Claude Code / Codex. */
const ACP: ReadonlyArray<readonly [RegExp, AgentRuntime]> = [
  [/(?:^|\/)(?:claude-agent-acp|claude-code-acp)(?:\/dist\/index\.m?js)?$/, "claude-code"],
  [/(?:^|\/)codex-acp$/, "codex"],
];

function runtimeOfExe(exe: string): AgentRuntime | null {
  if (exe === "claude" || exe === "claude.exe") return "claude-code";
  if (exe === "codex") return "codex";
  if (exe === "kimi" || exe === "kimi-code") return "kimi"; // Kimi Code sets process.title = "kimi-code"
  if (exe === "grok" || /^grok-\d+\.\d+\.\d+-/.test(exe)) return "grok"; // ~/.grok/downloads/grok-<version>-<os>-<arch>
  if (exe === "gemini") return "gemini";
  if (exe === "opencode" || exe === ".opencode") return "opencode";
  if (exe === "hermes" || exe === "hermes-agent" || exe === "hermes-acp") return "hermes"; // hermes-acp = `hermes acp`
  return null;
}

const INTERPRETERS = new Set(["node", "bun", "nodejs"]);

/**
 * Option arity, so that the first positional argument (a subcommand, or an interpreter's script) is found past options
 * and their values (Codex p8 #3): `codex --config x=1 app-server` is the app server, `node --require a.js cli.js` runs
 * cli.js. `value`: one value; `variadic`: values up to the next option (commander's `<x...>`); `optional`: a value when
 * the next word isn't an option (`[x]`). An option not listed takes no value; `--opt=value` is one word.
 */
interface Arity {
  value: ReadonlySet<string>; variadic?: ReadonlySet<string>; optional?: ReadonlySet<string>;
  /** True where the word at `at` starts free text (a prompt, a session name): `ps` joins its words, and none is read as an argument. */
  freeText?: (argv: readonly string[], at: number) => boolean;
}

/**
 * Hermes' top-level options that take a value, and the one that takes a value only when the next word isn't an option:
 * the static snapshot in hermes_cli/_parser.py (`_VALUE_FLAGS_FALLBACK`; Hermes derives the live set from its parser, and
 * the installed version's parser, read 2026-10-01, defines exactly these). The profile selector (`-p`, `--profile`) is
 * not on Hermes' parser: hermes_cli/main.py strips it from argv before argparse runs.
 */
const HERMES_VALUE_FLAGS: readonly string[] = ["-z", "--oneshot", "-m", "--model", "--provider", "--reasoning", "-t", "--toolsets",
  "-r", "--resume", "-s", "--skills", "--usage-file", "--in"];
const HERMES_OPTIONAL_VALUE_FLAGS: readonly string[] = ["-c", "--continue"];
const HERMES_PROFILE_FLAGS: readonly string[] = ["-p", "--profile"];
/**
 * The flags whose value is free text a person typed: a prompt (`-z`, `--oneshot`, `-q`, `--query`) or the name or title of a
 * session to resume (`-r`, `--resume`, and `-c`, `--continue` when it is given one). `ps` joins argv with spaces, so such a
 * value is several words, and it is not known where it ends.
 */
const HERMES_FREE_TEXT_FLAGS: readonly string[] = ["-z", "--oneshot", "-q", "--query", "-r", "--resume", "-c", "--continue"];
/**
 * The top-level subcommands of the `hermes` CLI that manage something or serve, and run no agent session: the 71 names in
 * Hermes' `_BUILTIN_SUBCOMMANDS` (hermes_cli/main.py, hermes-agent 0.21.3, read 2026-10-01) other than `chat` and `acp`, which
 * run one (Hermes' `_AGENT_COMMANDS`, with the bare `hermes`: `--tui`, `-z PROMPT`, `-c`, `-r ID`, `-w`), and `gateway`, whose
 * `run` is the messaging gateway (hermesRuns). A card for one of these would be a ghost for as long as the command runs, and it
 * is no liveness evidence for a hooked session, but for `cron`, `dashboard` and `serve` when they run agent turns in their own
 * process (hermesHostOf). A word that is on no list (a plugin's command, or the value of an option
 * Walkie does not know, such as one a newer Hermes added) fails open: it stays a session, so a session is never dropped for it.
 * Keep the list in step with Hermes' own when `hermes update` adds a subcommand.
 */
const HERMES_MANAGEMENT_COMMANDS: ReadonlySet<string> = new Set([
  "approvals", "auth", "backup", "bundles", "checkpoints", "claw", "completion", "computer-use", "config", "console",
  "cron", "curator", "dashboard", "serve", "debug", "doctor", "dump", "egress", "fallback", "hooks", "import",
  "import-agent", "insights", "gui", "desktop", "kanban", "login", "logout", "logs", "lsp", "mcp", "memory",
  "migrate", "moa", "journey", "memory-graph", "learning", "model", "monitoring", "pairing", "pause", "peer", "pets",
  "plugins", "portal", "profile", "project", "proxy", "prompt-size", "resume", "send", "sessions", "setup", "skin",
  "skills", "slack", "status", "sync", "tools", "uninstall", "update", "vault", "webhook", "whatsapp",
  "whatsapp-cloud", "worktree", "secrets", "security", "browser", "verify", "help",
]);
/** The options of `hermes acp` and `hermes-acp` that start no ACP server: they print, check or set something up, then exit. */
const ACP_MANAGEMENT_FLAGS: ReadonlySet<string> = new Set(["--version", "--check", "--setup", "--setup-browser"]);

const ARITY: Record<AgentRuntime | "node" | "bun", Arity> = {
  "claude-code": {
    value: new Set(["--agent", "--agents", "--append-system-prompt", "--autocompact", "--client-data-url", "--debug-file", "--effort",
      "--environment", "--fallback-model", "--input-format", "--json-schema", "--max-budget-usd", "--model", "-n", "--name",
      "--output-format", "--permission-mode", "--permission-prompts", "--plugin-dir", "--plugin-url", "--remote-control-session-name-prefix",
      "--session-id", "--setting-sources", "--settings", "--system-prompt", "--system-prompt-snapshot", "--append-system-prompt-file",
      "--system-prompt-file", "--permission-prompt-tool", "--max-turns"]),
    variadic: new Set(["--add-dir", "--allowedTools", "--allowed-tools", "--betas", "--disallowedTools", "--disallowed-tools", "--file",
      "--mcp-config", "--tools"]),
    optional: new Set(["-r", "--resume", "-d", "--debug", "--cloud", "--from-pr", "--prompt-suggestions", "--remote-control", "-w", "--worktree"]),
  },
  codex: {
    value: new Set(["-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env", "-m", "--model", "--local-provider",
      "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval", "--output-last-message", "-o",
      "--output-schema", "--color"]),
    variadic: new Set(["-i", "--image"]),
  },
  kimi: { value: new Set(["-m", "--model", "-w", "--work-dir", "--agent", "--agent-file", "--mcp-config-file", "-S", "--session", "--config", "--config-file"]) },
  grok: { value: new Set(["-m", "--model", "--prompt-file", "--cwd", "--permission-mode", "--reasoning-effort", "-p", "--prompt"]) },
  gemini: { value: new Set(["-m", "--model", "-p", "--prompt", "-i", "--prompt-interactive", "--approval-mode", "--proxy", "-e", "--extensions"]) },
  opencode: { value: new Set(["-m", "--model", "--agent", "-s", "--session", "--port", "--hostname", "--log-level", "--prompt"]) },
  hermes: { value: new Set([...HERMES_VALUE_FLAGS, ...HERMES_PROFILE_FLAGS]), optional: new Set(HERMES_OPTIONAL_VALUE_FLAGS) },
  node: { value: new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--inspect-port",
    "--title", "--env-file", "--env-file-if-exists", "--input-type", "--icu-data-dir", "--openssl-config", "--redirect-warnings",
    "--report-dir", "--diagnostic-dir", "--secure-heap", "--disable-warning", "--watch-path", "--experimental-config-file"]) },
  bun: { value: new Set(["-r", "--preload", "--cwd", "-c", "--config", "--env-file", "--tsconfig-override", "-d", "--define",
    "-l", "--loader", "--main-fields", "--conditions", "--port", "--inspect-port"]) },
};

/** Node / Bun options that run code given inline, not a script file. */
const EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);

/**
 * Scans argv[from..] past options and their values. `at` is the index of the first positional argument, -1 when there is none;
 * `end` is where the scan stopped: `at`, the word that starts free text (arity.freeText), or the end of the words. The words
 * before `end` are what the command line says to the program itself; from `end` on they are not options (an argument, or text a
 * person typed, which `ps` flattens into words).
 */
function scanOptions(argv: readonly string[], from: number, arity: Arity): { at: number; end: number } {
  for (let i = from; i < argv.length && i < 64; i++) {
    const a = argv[i] as string;
    if (a === "--") return i + 1 < argv.length ? { at: i + 1, end: i + 1 } : { at: -1, end: argv.length };
    if (arity.freeText?.(argv, i)) return { at: -1, end: i };
    if (!a.startsWith("-") || a === "-") return { at: i, end: i };
    if (a.includes("=")) continue; // --opt=value
    if (arity.value.has(a)) { i++; continue; }
    if (arity.variadic?.has(a)) { while (i + 1 < argv.length && !(argv[i + 1] as string).startsWith("-")) i++; continue; }
    if (arity.optional?.has(a) && i + 1 < argv.length && !(argv[i + 1] as string).startsWith("-")) { i++; continue; }
  }
  return { at: -1, end: argv.length };
}

/** The index of the first positional argument in argv[from..], past options and their values; -1 when there is none. */
export function firstPositional(argv: readonly string[], from: number, arity: Arity): number {
  return scanOptions(argv, from, arity).at;
}

/** The script a `node [options] <script>` / `bun [run] [options] <script>` runs, and the index after it. */
function scriptOf(argv: readonly string[], exe: string): { script: string; next: number } | null {
  const arity = exe === "bun" ? ARITY.bun : ARITY.node;
  let from = 1;
  let at = firstPositional(argv, from, arity);
  if (exe === "bun" && at > 0 && (argv[at] === "run" || argv[at] === "x")) { from = at + 1; at = firstPositional(argv, from, arity); }
  if (at < 0) return null;
  // An inline program (`node -e …`) runs no script of its own: the word after its options is not one.
  if (argv.slice(from, at).some((x) => EVAL_FLAGS.has(x))) return null;
  return { script: argv[at] as string, next: at + 1 };
}

/** A Python interpreter by name; a macOS framework build runs as `Python.app/Contents/MacOS/Python`. */
const PYTHON = /^python(?:[0-9.]+)?$/i;

/**
 * Where Hermes' own arguments start in a command line that reaches Hermes through a Python interpreter, or -1: the
 * interpreter running Hermes' console script, or `python -m hermes_cli.main`. The installed `hermes` is a Python script
 * with a `#!<venv>/bin/python3` shebang, so `ps` prints `<venv>/bin/python3 <venv>/bin/hermes chat`: never a bare
 * `hermes` (the wrapper on PATH execs the script) and not `-m` either.
 */
function pythonHermesArgsAt(argv: readonly string[]): number {
  if (!PYTHON.test(basename(argv[0] ?? ""))) return -1;
  if (argv[1] !== undefined && runtimeOfExe(basename(argv[1])) === "hermes") return 2;
  const moduleAt = argv.indexOf("-m");
  return moduleAt > 0 && argv[moduleAt + 1] === "hermes_cli.main" ? moduleAt + 2 : -1;
}

/**
 * The agent a process is, from its command line (never its environment, which children inherit). `tty` (ProcRow.tty):
 * null = no controlling terminal, which marks a run headless even when its arguments are gone (Kimi's title).
 */
export function classifyAgent(command: string, tty?: string | null): AgentKind | null {
  const argv = command.trim().split(/\s+/);
  const exe = basename(argv[0] ?? "");
  let runtime = runtimeOfExe(exe);
  let rest = 1;
  let host = false;
  const acpExe = ACP.find(([re]) => re.test(argv[0] ?? ""));
  if (acpExe) { runtime = acpExe[1]; host = true; }
  if (!runtime) {
    const hermesAt = pythonHermesArgsAt(argv);
    if (hermesAt >= 0) { runtime = "hermes"; rest = hermesAt; }
  }
  if (!runtime && INTERPRETERS.has(exe)) {
    const s = scriptOf(argv, exe === "nodejs" ? "node" : exe);
    if (s) {
      const acp = ACP.find(([re]) => re.test(s.script));
      const hit = acp ?? SCRIPTS.find(([re]) => re.test(s.script));
      if (hit) { runtime = hit[1]; rest = s.next; host = !!acp; }
    }
  }
  if (!runtime) return null;
  if (host) return { runtime, launch: "acp", host: true };
  const args = argv.slice(rest);
  const flags = HEADLESS_FLAGS[runtime];
  // A help / version flag anywhere before the first positional is no session. Text a person typed is no flag: Hermes' arity knows
  // which options take a prompt or a session title, and the scan stops where one starts (`hermes -z git --version` is a prompt).
  const { at, end } = scanOptions(argv, rest, runtime === "hermes" ? HERMES_COMMAND_ARITY : ARITY[runtime]);
  const before = argv.slice(rest, end);
  if (before.some((a) => a === "-h" || a === "--help" || a === "--version" || a === "-V" || (a === "-v" && runtime !== "codex"))) return null;
  const printFlag = before.some((a) => flags.has(a.split("=")[0] as string));
  const sub = at < 0 ? undefined : argv[at];
  // The first positional is a subcommand, unless a print flag before it makes it the prompt (`claude -p mcp`).
  if (runtime !== "hermes" && sub && !printFlag && NOT_A_SESSION[runtime].has(sub)) return null;
  // Hermes' CLI runs a session for a bare `hermes`, `chat` and `acp`, not for a management command (hermesRuns); `hermes-agent` has
  // no subcommands, and `hermes-acp` runs the ACP server unless one of its management options says otherwise.
  if (runtime === "hermes") {
    const entry = hermesEntry(argv);
    if (entry === "cli" && hermesRuns(args) !== "session") return null;
    if (entry === "acp" && args.some((a) => ACP_MANAGEMENT_FLAGS.has(a))) return null;
  }
  const headless = (sub !== undefined && !printFlag && !!HEADLESS_SUBCOMMANDS[runtime]?.has(sub))
    || args.some((a) => flags.has(a.split("=")[0] as string))
    || tty === null;
  return { runtime, ...(headless ? { launch: "headless" as const } : {}) };
}

/** The runtime alone (discovery's older entry point). */
export function runtimeOf(command: string): AgentRuntime | null {
  return classifyAgent(command)?.runtime ?? null;
}

/**
 * Runtimes whose launcher starts a second process of the same runtime that does the work (Gemini CLI relaunches Node
 * with a bigger heap; opencode's npm wrapper starts its native binary): the child is not a second agent.
 */
export const RELAUNCHING: ReadonlySet<AgentRuntime> = new Set(["gemini", "opencode"]);

/** The runtime as the wire carries it: Grok, Gemini and opencode have no value of their own yet (older peers would reject one). */
export function wireRuntime(rt: AgentRuntime): "claude-code" | "codex" | "kimi" | "other" {
  return rt === "grok" || rt === "gemini" || rt === "opencode" || rt === "hermes" ? "other" : rt;
}

/** The profile names Walkie can carry (hooks and the status route accept no other). */
const WALKIE_PROFILE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Most words of one command line read for a profile selector: a longer line leaves the process unresolved. */
const HERMES_ARGV_SCAN_MAX = 256;

/** What Hermes itself sees (its `sys.argv[1:]`) when this command line is a Hermes entry point; null for anything else. */
function hermesArgs(argv: readonly string[]): string[] | null {
  if (runtimeOfExe(basename(argv[0] ?? "")) === "hermes") return argv.slice(1);
  const hermesAt = pythonHermesArgsAt(argv);
  return hermesAt >= 0 ? argv.slice(hermesAt) : null;
}

/**
 * Which Hermes entry point a command line runs: the `hermes` CLI (hermes_cli.main, which has the subcommands: a launcher, the
 * console script, or `-m hermes_cli.main`), `hermes-acp` (the ACP adapter an editor starts) or `hermes-agent` (run_agent's own
 * CLI). The last two have no subcommands.
 */
function hermesEntry(argv: readonly string[]): "cli" | "acp" | "agent" {
  const program = PYTHON.test(basename(argv[0] ?? "")) && argv[1] !== undefined && runtimeOfExe(basename(argv[1])) === "hermes" ? argv[1] : argv[0];
  const name = basename(program ?? "");
  return name === "hermes-acp" ? "acp" : name === "hermes-agent" ? "agent" : "cli";
}

/** Hermes' `_inside_mcp_add_args`: after `mcp add … --args`, flags belong to the child command, not to Hermes. */
function insideMcpAddArgs(args: readonly string[], index: number): boolean {
  const mcp = args.indexOf("mcp");
  return mcp >= 0 && mcp < index && args.slice(mcp + 1, index).includes("add");
}

/** A selector's value as Hermes reads it (`strip` + `casefold`, as normalize_profile_name), when Walkie can name it. */
function profileNamed(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return WALKIE_PROFILE.test(name) ? name : null;
}

/**
 * Whether args[at] starts a value that is free text (HERMES_FREE_TEXT_FLAGS): spaced, attached with `=`, or, for a short
 * option, attached to it (argparse reads `-zPROMPT`, `-qPROMPT`, `-rTITLE` and `-cNAME` as that option and its value).
 */
function startsFreeText(args: readonly string[], at: number): boolean {
  const arg = args[at] as string;
  if (/^-[zqrc]./.test(arg)) return true;
  if (!HERMES_FREE_TEXT_FLAGS.includes(arg.split("=")[0] as string)) return false;
  if (arg.includes("=")) return true;
  // `-c` / `--continue` name a session only when the next word is not an option.
  const next = args[at + 1];
  return !HERMES_OPTIONAL_VALUE_FLAGS.includes(arg) || (next !== undefined && !next.startsWith("-"));
}

/**
 * The profile a Hermes process names in its command line, read the way hermes_cli/main.py `_scan_profile_flag` reads
 * its argv: `-p X`, `--profile X` and `--profile=X`, before or after the subcommand, the value of each top-level value
 * flag skipped, nothing read past `--` or `mcp add … --args`, the first selector deciding. Null when it names none (a
 * bare `hermes` runs the default, the sticky active or the HERMES_HOME profile) or names one Walkie cannot carry (a
 * name over 32 characters or with an underscore; Python's `casefold` also folds a few non-ASCII letters, such as ß,
 * onto ASCII, which `toLowerCase` does not, so such a spelling stays unresolved here).
 * Nothing is read after a flag whose value is free text (startsFreeText): `ps` joins argv with spaces, so Hermes' one
 * quoted prompt arrives as many words, and `mkdir -p build`, `ssh -p 22` or `git log -p` inside it would read as a
 * selector, which Hermes itself never sees. A wrong name is not harmless: the process would match no row of its real
 * profile and count as unresolved for none, so those rows would be retired at every scan while it runs. Left unresolved,
 * the process serves every profile until the ten-minute TTL, as a bare `hermes` does. A selector before the free text
 * still counts, and so does one after `-c` when it names no session.
 */
export function hermesProfileOf(command: string): string | null {
  const args = hermesArgs(command.trim().split(/\s+/))?.slice(0, HERMES_ARGV_SCAN_MAX);
  if (!args) return null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--" || (arg === "--args" && insideMcpAddArgs(args, i)) || startsFreeText(args, i)) return null;
    if (HERMES_PROFILE_FLAGS.includes(arg) && i + 1 < args.length) return profileNamed(args[i + 1] as string);
    if (arg.startsWith("--profile=")) return profileNamed(arg.slice("--profile=".length));
    const next = args[i + 1];
    const takesValue = !arg.includes("=") && next !== undefined && (HERMES_VALUE_FLAGS.includes(arg)
      || (HERMES_OPTIONAL_VALUE_FLAGS.includes(arg) && !next.startsWith("-")));
    if (takesValue) i++;
  }
  return null;
}

/**
 * Hermes' scan for the subcommand, and for the help and version flags before it (classifyAgent): the options' values are
 * skipped (a profile selector's too), and nothing is read from where free text starts. `ps` joins argv with spaces, so the one
 * quoted prompt or session name is several words, and one of them can spell a subcommand or a flag: `hermes -z please update the
 * docs` is a one-shot prompt, never `hermes update`, and `hermes -z git --version` is one, never `hermes --version`.
 */
const HERMES_COMMAND_ARITY: Arity = { ...ARITY.hermes, freeText: startsFreeText };

/** The subcommands whose invocations can host hooked agent turns (hermesHostOf); every other word is a session or a management command. */
const HERMES_HOST_COMMANDS: ReadonlySet<string> = new Set(["gateway", "cron", "dashboard", "serve"]);
/**
 * The options of `hermes dashboard` and `hermes serve` that take a value (hermes_cli/subcommands/dashboard.py), on top of the
 * profile selector and the top-level ones: the first word past them is the nested `register`, or one argparse rejects.
 */
const BACKEND_ARITY: Arity = { value: new Set([...ARITY.hermes.value, "--port", "--host", "--open-profile", "--ssh-session-token-file", "--ssh-owner-nonce"]) };

/** What a Hermes process hosts without being a session (hermesHostOf). */
type HermesHost = "gateway" | "cron" | "backend";

/**
 * Which host of hooked agent turns `hermes <sub> ...` is, from the arguments after the subcommand (`after` is where they start), or
 * null when this invocation hosts none: it prints help, or acts on something and exits. Read from Hermes (0.21.3, 2026-10-01): it
 * registers its shell hooks, and so fires them, in the commands that run agent turns (hermes_cli/main.py `_AGENT_SUBCOMMANDS`:
 * `cron run|tick`, `gateway run` and `mcp serve`, the last a stdio bridge to messaging conversations that creates no agent) and in
 * the servers that host sessions in-process (tui_gateway/server.py `_make_agent`).
 *  - "gateway": `gateway run`, or a bare `gateway`, which runs.
 *  - "cron": `cron run` and `cron tick` run the profile's jobs in their own process (cron/scheduler.py `run_one_job`, an agent turn
 *    unless the job is a script); the other verbs manage jobs.
 *  - "backend": `dashboard` and `serve` (the headless server the desktop app starts). `--stop` and `--status` act on servers that
 *    run and exit; a word after the options is the nested `register`, or one argparse rejects.
 * `desktop` and `gui` are no host: they build and launch the Electron app, which starts a `serve` of its own.
 */
function hermesHostOf(sub: string, args: readonly string[], after: number): HermesHost | null {
  const rest = args.slice(after);
  if (rest.some((a) => a === "-h" || a === "--help")) return null;
  if (sub === "dashboard" || sub === "serve") {
    return rest.some((a) => a === "--stop" || a === "--status") || firstPositional(args, after, BACKEND_ARITY) >= 0 ? null : "backend";
  }
  const at = firstPositional(args, after, ARITY.hermes);
  const verb = at < 0 ? undefined : args[at];
  if (sub === "cron") return verb === "run" || verb === "tick" ? "cron" : null;
  return verb === undefined || verb === "run" ? "gateway" : null;
}

/**
 * What a `hermes` CLI invocation runs, from its own arguments (Hermes' `sys.argv[1:]`): a "session" (no subcommand, `chat`,
 * `acp` unless an option of its own asks only for a check or a setup, or a word that is no known management command), a host of
 * hooked agent turns that is no session (hermesHostOf), or null for a management command (HERMES_MANAGEMENT_COMMANDS) and for an
 * invocation of a host's subcommand that runs nothing (a help flag only prints usage and exits).
 */
function hermesRuns(args: readonly string[]): "session" | HermesHost | null {
  const at = firstPositional(args, 0, HERMES_COMMAND_ARITY);
  if (at < 0) return "session";
  const sub = args[at] as string;
  if (HERMES_HOST_COMMANDS.has(sub)) return hermesHostOf(sub, args, at + 1);
  if (HERMES_MANAGEMENT_COMMANDS.has(sub)) return null;
  return sub === "acp" && args.slice(at + 1).some((a) => ACP_MANAGEMENT_FLAGS.has(a)) ? null : "session";
}

/** A running Hermes process that can serve hooked sessions (see hermesProcessOf). */
export interface HermesProcessKind {
  /**
   * The profile it serves, as its command line names it; null when it names none, and for a dashboard or serve backend, which
   * serves whichever profile each session names (Hermes scopes a session to its client's profile, and a named-profile launch is
   * re-exec'd as `-p default`), so no argument says which.
   */
  profile: string | null;
  /**
   * A host of hooked agent turns that never is an agent of its own, gateway-style liveness evidence: a `gateway run`, which serves
   * bots, a `cron run` or `cron tick`, or a dashboard or serve backend (hermesHostOf). The name is the first such host's.
   */
  gateway: boolean;
}

/**
 * Whether a process can be what a hooked Hermes session runs in, for the liveness census (hermes-status.ts): an
 * interactive or one-shot session (an agent, see classifyAgent), or a host of hooked turns (hermesHostOf: a gateway run, a cron run
 * or tick, a dashboard or serve backend). A host is evidence for the profile it serves, or for any profile when it names none (a bare
 * gateway serves the default profile and may multiplex others; a cron process names the profile whose jobs it runs); it is still no
 * agent (classifyAgent skips it). Null for anything else: every other subcommand (`logs`, `update`, `doctor`, `gateway status`,
 * `cron list`, `dashboard --stop`, `desktop`, ...) is neither (hermesRuns).
 */
export function hermesProcessOf(command: string, tty?: string | null): HermesProcessKind | null {
  if (!command.includes("hermes")) return null;
  if (classifyAgent(command, tty)?.runtime === "hermes") return { profile: hermesProfileOf(command), gateway: false };
  const argv = command.trim().split(/\s+/);
  const args = hermesArgs(argv);
  const runs = args && hermesEntry(argv) === "cli" ? hermesRuns(args) : null;
  if (runs === "gateway" || runs === "cron") return { profile: hermesProfileOf(command), gateway: true };
  return runs === "backend" ? { profile: null, gateway: true } : null;
}

/** The runtime's own name for a status whose wire runtime is "other" (AgentStatus.runtime_name). */
export function runtimeName(rt: AgentRuntime): string | undefined {
  return wireRuntime(rt) === "other" ? rt : undefined;
}

// ---- local model servers --------------------------------------------------------------------------------------

/** Model servers per machine that are reported, and the name grammar. */
export const MAX_MODEL_SERVERS = 8;
export const MODEL_SERVER_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,23}$/;

const LLAMA = new Set(["llama-server", "rpc-server", "llama-cli", "llama-run", "llama-box"]);

/** A local model server this process is (ollama, llama.cpp, vLLM, MLX), by name; null for anything else. */
export function modelServerOf(command: string): string | null {
  const argv = command.trim().split(/\s+/);
  const exe = basename(argv[0] ?? "").replace(/\.exe$/i, "");
  if (exe === "ollama") return argv[1] === "serve" ? "ollama" : null; // `ollama runner` children are the loaded models
  if (LLAMA.has(exe)) return exe;
  if (exe === "vllm" && argv[1] === "serve") return "vllm";
  if (/^python[0-9.]*$/.test(exe)) {
    const m = argv.indexOf("-m");
    const mod = m > 0 ? argv[m + 1] ?? "" : "";
    if (mod.startsWith("vllm.entrypoints")) return "vllm";
    if (mod === "mlx_lm.server" || mod === "mlx_lm" && argv[m + 2] === "server") return "mlx-lm";
    if (mod === "llama_cpp.server") return "llama-cpp-python";
  }
  return null;
}

/** Model servers running on the machine, counted by name (any user's: ollama runs as its own user on Linux). */
export function modelServers(commands: Iterable<string>): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const cmd of commands) {
    const name = modelServerOf(cmd);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_MODEL_SERVERS)
    .map(([name, count]) => ({ name, count: Math.min(count, 1_000) }));
}
