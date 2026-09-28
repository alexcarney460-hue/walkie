// Reading and rewriting a Claude Code / Codex command line for the account switcher (ACCOUNTS-2). The parser mirrors
// how each CLI reads its own options (Commander for Claude, clap for Codex): a value option takes the next word, an
// optional-value option takes it unless it starts with "-", a variadic option takes words until the next option.
// It only has to find three things: a subcommand (then the wrapper stays out of the way), the prompt, and the
// resume/session options it replaces when it relaunches the same session on another account.

export type Mode = "interactive" | "headless" | "passthrough";

export interface Parsed {
  mode: Mode;
  /** Everything except the prompt and the session options the wrapper manages. */
  kept: string[];
  prompt: string | null;
  /** A session id given on the command line (Claude --resume <id> / --session-id <id>; Codex resume <id>). */
  session: string | null;
  /** Claude -c / --continue, -r without an id, Codex resume --last / without an id: the id comes from the session. */
  sessionFromRun: boolean;
  /** Claude --fork-session: the resumed session gets a new id (learned from the session). */
  fork: boolean;
  model: string | null;
  /** Claude: --settings was given (the wrapper then does not add its own). */
  settings: boolean;
  /** Claude -w / --worktree: a relaunch must not create another worktree. */
  worktree: boolean;
  /** The command line as given (the first launch uses it unchanged, plus a pinned session id for a new session). */
  original: string[];
  /** Claude --output-format (text / json / stream-json), when given. */
  outputFormat?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- Claude Code (claude --help, 2.1.x) ------------------------------------------------

const CLAUDE_VALUE = new Set([
  "--agent", "--agents", "--append-system-prompt", "--append-system-prompt-file", "--autocompact", "--client-data-url",
  "--debug-file", "--effort", "--environment", "--fallback-model", "--input-format", "--json-schema", "--max-budget-usd",
  "--max-turns", "--model", "-n", "--name", "--output-format", "--permission-mode", "--permission-prompts", "--plugin-dir",
  "--plugin-url", "--remote-control-session-name-prefix", "--session-id", "--setting-sources", "--settings",
  "--system-prompt", "--system-prompt-file", "--system-prompt-snapshot",
]);
const CLAUDE_VARIADIC = new Set([
  "--add-dir", "--allowedTools", "--allowed-tools", "--betas", "--disallowedTools", "--disallowed-tools", "--file",
  "--mcp-config", "--tools",
]);
const CLAUDE_OPTIONAL = new Set(["-r", "--resume", "-d", "--debug", "--cloud", "--from-pr", "--prompt-suggestions", "--remote-control", "--teleport", "-w", "--worktree"]);
export const CLAUDE_SUBCOMMANDS = new Set([
  "agents", "attach", "auth", "auto-mode", "config", "doctor", "gateway", "import", "install", "logs", "mcp", "migrate-installer",
  "plugin", "plugins", "project", "respawn", "rm", "setup-token", "stop", "kill", "ultrareview", "update", "upgrade",
]);
const HELPISH = new Set(["-h", "--help", "-v", "--version", "-V"]);

function base(): Parsed {
  return { mode: "interactive", kept: [], prompt: null, session: null, sessionFromRun: false, fork: false, model: null, settings: false, worktree: false, original: [] };
}

export function parseClaude(argv: readonly string[]): Parsed {
  const p = { ...base(), original: [...argv] };
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (positional || a === "--") {
      if (a === "--") { positional = true; continue; }
      if (p.prompt === null) p.prompt = a; else p.kept.push(a);
      continue;
    }
    if (HELPISH.has(a)) return { ...p, mode: "passthrough" };
    if (a.startsWith("-") && a.length > 1) {
      const eq = a.startsWith("--") ? a.indexOf("=") : -1;
      const name = eq > 0 ? a.slice(0, eq) : a;
      const inline = eq > 0 ? a.slice(eq + 1) : null;
      if (name === "-p" || name === "--print") { p.mode = "headless"; p.kept.push(a); continue; }
      if (name === "-c" || name === "--continue") { p.sessionFromRun = true; continue; }
      if (name === "--fork-session") { p.fork = true; continue; }
      if (CLAUDE_VALUE.has(name)) {
        const v = inline ?? argv[++i];
        if (v === undefined) { p.kept.push(a); continue; }
        if (name === "--session-id") { p.session = v; continue; }
        if (name === "--model") p.model = v;
        if (name === "--output-format") p.outputFormat = v;
        if (name === "--settings") p.settings = true;
        p.kept.push(...(inline !== null ? [a] : [a, v]));
        continue;
      }
      if (CLAUDE_OPTIONAL.has(name)) {
        const next = argv[i + 1];
        const v = inline ?? (next !== undefined && !next.startsWith("-") ? next : null);
        if (inline === null && v !== null) i++;
        if (name === "-r" || name === "--resume") {
          // An id resumes it; no id or a search term opens Claude's picker (the id is learned from the session).
          if (v && UUID_RE.test(v)) p.session = v; else p.sessionFromRun = true;
          continue;
        }
        if (name === "-w" || name === "--worktree") p.worktree = true;
        p.kept.push(...(inline !== null ? [a] : v !== null ? [a, v] : [a]));
        continue;
      }
      if (CLAUDE_VARIADIC.has(name)) {
        p.kept.push(a);
        if (inline !== null) continue;
        while (i + 1 < argv.length && !(argv[i + 1] as string).startsWith("-")) p.kept.push(argv[++i] as string);
        continue;
      }
      p.kept.push(a); // a boolean flag (or one this parser does not know: kept as is)
      continue;
    }
    if (p.prompt === null && p.kept.length === 0 && CLAUDE_SUBCOMMANDS.has(a)) return { ...p, mode: "passthrough" };
    if (p.prompt === null) p.prompt = a; else p.kept.push(a);
  }
  return p;
}

/**
 * The argv for launch number `n` of a wrapped Claude session: the first launch pins a session id when none was given
 * (so the wrapper always knows which transcript is its own); a relaunch resumes that id with the same options and,
 * after a limit cut a turn short, a continuation prompt. `fresh` = a new session (the summary fallback).
 */
export function claudeArgv(p: Parsed, o: { session: string; relaunch: boolean; prompt: string | null; fresh?: boolean }): string[] {
  if (!o.relaunch) return p.session || p.sessionFromRun || p.fork ? [...p.original] : ["--session-id", o.session, ...p.original];
  const kept = p.worktree ? dropWorktree(p.kept) : p.kept;
  if (o.fresh) return [...kept, "--session-id", o.session, ...(o.prompt !== null ? [o.prompt] : [])];
  return [...kept, "--resume", o.session, ...(o.prompt !== null ? [o.prompt] : [])];
}

function dropWorktree(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "-w" || a === "--worktree") {
      const n = args[i + 1];
      if (n !== undefined && !n.startsWith("-")) i++;
      continue;
    }
    if (a.startsWith("--worktree=")) continue;
    out.push(a);
  }
  return out;
}

// ---- Codex (codex --help, 0.15x) -------------------------------------------------------

export const CODEX_VALUE: ReadonlySet<string> = new Set([
  "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env", "-m", "--model", "--local-provider",
  "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval",
]);
const CODEX_VARIADIC = new Set(["-i", "--image"]);
/** Subcommands that run a session without a terminal UI: the wrapper only injects the account. */
const CODEX_HEADLESS = new Set(["exec", "e", "review"]);
export const CODEX_SUBCOMMANDS = new Set([
  "agents", "exec", "e", "review", "login", "logout", "mcp", "mcp-server", "plugin", "app-server", "remote-control", "app",
  "completion", "update", "doctor", "sandbox", "debug", "apply", "a", "resume", "queue", "archive", "delete",
  "migrate-rollouts", "unarchive", "fork", "cloud", "exec-server", "features", "help", "proto",
]);

export function parseCodex(argv: readonly string[]): Parsed {
  const p = { ...base(), original: [...argv] };
  let sub: string | null = null;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") { positionals.push(...argv.slice(i + 1)); break; }
    if (HELPISH.has(a)) return { ...p, mode: "passthrough" };
    if (a.startsWith("-") && a.length > 1) {
      const eq = a.startsWith("--") ? a.indexOf("=") : -1;
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (sub === "resume" && name === "--last") { p.sessionFromRun = true; continue; }
      if (sub === "resume" && name === "--all") { p.kept.push(a); continue; }
      if (CODEX_VALUE.has(name)) {
        const v = eq > 0 ? null : argv[++i];
        if (name === "-m" || name === "--model") p.model = eq > 0 ? a.slice(eq + 1) : v ?? null;
        p.kept.push(...(v === undefined || v === null ? [a] : [a, v]));
        continue;
      }
      if (CODEX_VARIADIC.has(name)) {
        p.kept.push(a);
        while (eq < 0 && i + 1 < argv.length && !(argv[i + 1] as string).startsWith("-")) p.kept.push(argv[++i] as string);
        continue;
      }
      p.kept.push(a);
      continue;
    }
    if (sub === null && positionals.length === 0 && CODEX_SUBCOMMANDS.has(a)) {
      sub = a;
      if (a !== "resume") return { ...p, mode: CODEX_HEADLESS.has(a) ? "headless" : "passthrough" };
      continue;
    }
    positionals.push(a);
  }
  if (sub === "resume") {
    const [first, second] = positionals;
    if (first && !p.sessionFromRun) { p.session = first; p.prompt = second ?? null; }
    else { p.sessionFromRun = true; p.prompt = first ?? null; }
    return p;
  }
  p.prompt = positionals[0] ?? null;
  p.kept.push(...positionals.slice(1));
  return p;
}

/**
 * Codex launch argv: a new session with the prompt, or `resume <id> [prompt]` with the same options. Round 10 (Opus
 * r8): the id and prompt come after `--`, so an image list among the kept options (`-i a.png`, which takes every
 * following word) cannot swallow them, and a prompt starting with "-" is not read as an option (checked on codex
 * 0.156.1: `codex resume -i a.png -- <id> <prompt>` resumes <id> with the image and the prompt).
 */
export function codexArgv(p: Parsed, o: { session: string | null; relaunch: boolean; prompt: string | null; fresh?: boolean }): string[] {
  if (o.relaunch && !o.fresh && o.session) return ["resume", ...p.kept, "--", o.session, ...(o.prompt !== null ? [o.prompt] : [])];
  if (o.relaunch) return [...p.kept, ...(o.prompt !== null ? ["--", o.prompt] : [])];
  return [...p.original];
}
