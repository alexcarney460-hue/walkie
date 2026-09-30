// The walkie_cli MCP tool (ORCH-2 fix): one walkie CLI command, run as an argv array with no shell (pipes,
// redirects, `;` and `$(…)` are plain text inside one argument), with this process's environment and identity, a
// timeout and an output cap; its output is redacted. WalkieTalkie's platform access allows the Walkie MCP tools only,
// so this is how it runs `walkie …` without a Bash rule that shell chaining could escape. Refused: commands that run
// another program with a credential, open credentials in plain text, replace or stop this Walkie, or read stdin.
import { walkieArgv } from "../hooks/install.ts";
import { parseArgs, UsageError } from "../cli/args.ts";
import { CLI_BOOLEANS } from "../cli/booleans.ts";
import { MAX_ARG, MAX_ARGV, MAX_REMOTE_OUTPUT } from "../protocol/admin.ts";
import { redactSecrets } from "../protocol/safety.ts";

export const CLI_TIMEOUT_MS = 120_000;
export const CLI_MAX_OUTPUT = MAX_REMOTE_OUTPUT;

/** Whole commands walkie_cli never runs, and why. */
const REFUSED_COMMANDS: Readonly<Record<string, string>> = {
  claude: "runs Claude Code itself", codex: "runs Codex itself", mcp: "is the MCP server", hook: "is the hook entrypoint",
  daemon: "starts or stops this Walkie", update: "replaces this Walkie", upgrade: "opens checkout", setup: "is the installer",
  dashboard: "prints a login link (a credential)", mobile: "pairs a phone (a credential)", token: "rotates the local token",
  init: "creates a team", join: "joins a team", license: "changes the plan",
};
/** Subcommands refused within an allowed command (the remote allow-list's `accounts exec` / `trust-cli`, and more). */
const REFUSED_SUBS: Readonly<Record<string, ReadonlySet<string>>> = {
  accounts: new Set(["exec", "trust-cli", "add", "shims", "allow-proxy"]),
  talkie: new Set(["start", "stop", "say", "log", "model", "access"]),
  orchestrator: new Set(["start", "stop", "say", "log", "model", "access"]),
};
/** Options that read a terminal or stdin, or name a program to run (the remote allow-list's list). */
const REFUSED_FLAGS = new Set(["--claude", "--claude-token-stdin", "--key", "--bin-dir", "--agent"]);

/** Why walkie_cli won't run `args` (without the leading "walkie"), or null. */
export function cliArgvProblem(args: readonly unknown[]): string | null {
  if (!args.length) return "no command";
  if (args.length > MAX_ARGV) return `at most ${MAX_ARGV} arguments`;
  for (const a of args) {
    if (typeof a !== "string") return "every argument is a string";
    if (a.length > MAX_ARG || /[\0\r\n]/.test(a)) return "an argument is too long or has a line break";
  }
  const argv = args as readonly string[];
  const cmd = argv[0] as string;
  if (cmd.startsWith("-")) return "the command comes first (e.g. [\"who\", \"--json\"])";
  if (REFUSED_COMMANDS[cmd]) return `walkie_cli doesn't run walkie ${cmd} (it ${REFUSED_COMMANDS[cmd]}); a person runs it in their terminal`;
  let pos: readonly string[];
  try {
    pos = parseArgs(argv.slice(1), CLI_BOOLEANS).pos; // the subcommand exactly as the walkie that runs it parses it
  } catch (err) {
    return `the arguments don't parse (${err instanceof UsageError ? err.message : "invalid"})`;
  }
  const sub = pos[0] ?? "";
  if (REFUSED_SUBS[cmd]?.has(sub)) return `walkie_cli doesn't run walkie ${cmd} ${sub}; a person runs it in their terminal or dashboard`;
  for (const a of argv) {
    if (REFUSED_FLAGS.has(a.split("=")[0] as string)) return `${a.split("=")[0]} can't be used here (it reads a terminal or names a program)`;
    if (a === "-") return "\"-\" (read stdin) can't be used here";
  }
  return null;
}

export interface CliResult { exit: number | null; stdout: string; stderr: string; truncated: boolean; timed_out: boolean }

/** Reads a stream up to `cap` bytes (the rest is drained and dropped). */
async function capped(stream: ReadableStream<Uint8Array>, cap: number): Promise<{ text: string; cut: boolean }> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (size >= cap) { cut = true; continue; }
    const take = value.subarray(0, cap - size);
    if (take.length < value.length) cut = true;
    parts.push(take);
    size += take.length;
  }
  return { text: new TextDecoder().decode(Buffer.concat(parts)), cut };
}

/** Runs `walkie <args…>` (checked first) with `env`, no shell, no stdin; output capped and redacted. */
export async function runWalkieCli(args: readonly string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = CLI_TIMEOUT_MS): Promise<CliResult> {
  const why = cliArgvProblem(args);
  if (why) throw new Error(why);
  const p = Bun.spawn([...walkieArgv(), ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env, detached: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-p.pid, "SIGKILL"); } catch { p.kill("SIGKILL"); }
  }, timeoutMs);
  try {
    const [out, err, exit] = await Promise.all([capped(p.stdout, CLI_MAX_OUTPUT), capped(p.stderr, CLI_MAX_OUTPUT), p.exited]);
    return {
      exit, stdout: redactSecrets(out.text).text, stderr: redactSecrets(err.text).text,
      truncated: out.cut || err.cut, timed_out: timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The tool's text: the output, then the exit code (and what was cut or timed out). */
export function cliResultText(r: CliResult): string {
  const tail = [`exit ${r.exit ?? "signal"}`, r.truncated ? "output truncated" : "", r.timed_out ? "timed out" : ""].filter(Boolean).join(" · ");
  return [r.stdout.trimEnd(), r.stderr.trim() ? `stderr:\n${r.stderr.trimEnd()}` : "", `(${tail})`].filter(Boolean).join("\n");
}
