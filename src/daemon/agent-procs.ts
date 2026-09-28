// AGENT-SEE-1: which processes are agents, and which are local model servers, from a `ps` row alone (no environment,
// no file access). Discovery (discovery.ts) uses it to find every agent a machine runs, hooked or not: Claude Code
// (interactive, `claude -p`, the SDK's native binary, an ACP adapter), Codex, Kimi Code (whose process renames itself
// "kimi-code", so its argv is gone), Grok, Gemini CLI and opencode. Model servers (ollama, llama.cpp, vLLM, MLX) are
// machine load, not agents: they are counted per machine (MachineStats.model_servers).
//
// Nothing here is sent anywhere: the command line only decides the runtime and whether it runs headless.
import { basename } from "node:path";

export type AgentRuntime = "claude-code" | "codex" | "kimi" | "grok" | "gemini" | "opencode";

/** How an agent was started, when that is known: a one-shot run (`-p`, `exec`, no terminal) or an ACP adapter. */
export type Launch = "headless" | "acp";

export interface AgentKind {
  runtime: AgentRuntime;
  launch?: Launch;
  /** An ACP adapter: an agent only while it runs no agent process of its own (then that process is the agent). */
  host?: true;
}

/** Subcommands that are not an agent session. */
const NOT_A_SESSION: Record<AgentRuntime, ReadonlySet<string>> = {
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
  return null;
}

const INTERPRETERS = new Set(["node", "bun", "nodejs"]);

/**
 * Option arity, so that the first positional argument (a subcommand, or an interpreter's script) is found past options
 * and their values (Codex p8 #3): `codex --config x=1 app-server` is the app server, `node --require a.js cli.js` runs
 * cli.js. `value`: one value; `variadic`: values up to the next option (commander's `<x...>`); `optional`: a value when
 * the next word isn't an option (`[x]`). An option not listed takes no value; `--opt=value` is one word.
 */
interface Arity { value: ReadonlySet<string>; variadic?: ReadonlySet<string>; optional?: ReadonlySet<string> }
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
  node: { value: new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--inspect-port",
    "--title", "--env-file", "--env-file-if-exists", "--input-type", "--icu-data-dir", "--openssl-config", "--redirect-warnings",
    "--report-dir", "--diagnostic-dir", "--secure-heap", "--disable-warning", "--watch-path", "--experimental-config-file"]) },
  bun: { value: new Set(["-r", "--preload", "--cwd", "-c", "--config", "--env-file", "--tsconfig-override", "-d", "--define",
    "-l", "--loader", "--main-fields", "--conditions", "--port", "--inspect-port"]) },
};

/** Node / Bun options that run code given inline, not a script file. */
const EVAL_FLAGS = new Set(["-e", "--eval", "-p", "--print"]);

/** The index of the first positional argument in argv[from..], past options and their values; -1 when there is none. */
export function firstPositional(argv: readonly string[], from: number, arity: Arity): number {
  for (let i = from; i < argv.length && i < 64; i++) {
    const a = argv[i] as string;
    if (a === "--") return i + 1 < argv.length ? i + 1 : -1;
    if (!a.startsWith("-") || a === "-") return i;
    if (a.includes("=")) continue; // --opt=value
    if (arity.value.has(a)) { i++; continue; }
    if (arity.variadic?.has(a)) { while (i + 1 < argv.length && !(argv[i + 1] as string).startsWith("-")) i++; continue; }
    if (arity.optional?.has(a) && i + 1 < argv.length && !(argv[i + 1] as string).startsWith("-")) { i++; continue; }
  }
  return -1;
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
  // A help / version flag anywhere before the first positional is no session.
  const at = firstPositional(argv, rest, ARITY[runtime]);
  const before = at < 0 ? args : argv.slice(rest, at);
  if (before.some((a) => a === "-h" || a === "--help" || a === "--version" || a === "-V" || (a === "-v" && runtime !== "codex"))) return null;
  const printFlag = before.some((a) => flags.has(a.split("=")[0] as string));
  const sub = at < 0 ? undefined : argv[at];
  // The first positional is a subcommand, unless a print flag before it makes it the prompt (`claude -p mcp`).
  if (sub && !printFlag && NOT_A_SESSION[runtime].has(sub)) return null;
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
  return rt === "grok" || rt === "gemini" || rt === "opencode" ? "other" : rt;
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
