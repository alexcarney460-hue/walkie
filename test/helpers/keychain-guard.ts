// Loaded by bunfig.toml before root tests. Standing rule: a test never touches the real login Keychain.
// Walkie reads it in exactly three places, each by spawning /usr/bin/security: the Claude Code credentials item
// (src/accounts/adapters/claude.ts systemKeychain, the default of seats, the orchestrator and the accounts service),
// that item's presence (src/daemon/orchestrator/logins.ts keychainHas) and the vault key (src/accounts/vault/keystore.ts
// macKeychain). Under `bun test` that spawn is refused here. A test that needs a reader injects its own (a seats
// `keychain: async () => null` with a temp `env.HOME`, the accounts `keychain`, `keychainHas`, macKeychain's `tool`,
// makeSystemKeychain's `run`), and an injected reader never starts the real program, so it never gets here.
// The callers turn a refused spawn into "unavailable" (or false), so each refusal is also recorded and fails the test it
// happened in: a swallowed refusal cannot pass silently.
//
// What "the real program" means: the FILE /usr/bin/security, however it is named. A program is matched by what it
// resolves to, not by its spelling: a path is normalized (`/usr/bin//security`, `/usr/bin/./security`, `x/../security`), a bare
// name is looked up on the PATH the child would get, and links are followed (a symlink to it is it). A stand-in named
// `security` at another path (what the vault tests use) resolves to itself and runs. Beyond a direct spawn the guard also
// reads, best effort, the programs a shell string, `env` and Bun.$ would start: `sh -c "security ..."`,
// `/usr/bin/env security ...`, Bun.$`security ...`.
// NOT covered (a test that does these on purpose gets the real program, so none should): a Worker thread (it has no guard),
// a shell string that builds the command (`sh -c "$CMD"`, a script file that calls it, an `eval`), `new Bun.$.Shell()`, a
// copy of the binary under another name, a program that starts it by itself (a child bun without these preloads), and native
// code. A CLI a test starts as a child process runs without this guard.
import { afterAll, afterEach } from "bun:test";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

const REAL_SECURITY = "/usr/bin/security";
const STATE = Symbol.for("walkie.test.keychainGuard");

interface GuardState { refusals: string[] }
const holder = globalThis as typeof globalThis & { [STATE]?: GuardState };

/** One state per process: a test that imports this file shares it with the preload. */
function state(): GuardState {
  holder[STATE] ??= { refusals: [] };
  return holder[STATE] as GuardState;
}

/** The refusals recorded since the last call, cleared (the guard's own test uses it; any other test fails on them). */
export function takeKeychainRefusals(): string[] {
  return state().refusals.splice(0);
}

/** The argv a Bun.spawn / Bun.spawnSync call names: `spawn([cmd, ...args], opts)` or `spawn({ cmd: [...], ... })`. */
function argvOf(first: unknown): readonly unknown[] | null {
  if (Array.isArray(first)) return first;
  const cmd = (first as { cmd?: unknown } | null)?.cmd;
  return Array.isArray(cmd) ? cmd : null;
}

/** The PATH a spawn call's child gets: its own environment's, else this process's. Undefined: the child has an environment with none. */
function pathOf(args: readonly unknown[]): string | undefined {
  const objectForm = !Array.isArray(args[0]) && typeof args[0] === "object" && args[0] !== null;
  const options = (objectForm ? args[0] : args[1]) as { env?: Record<string, unknown> } | undefined;
  const own = options?.env?.PATH;
  return typeof own === "string" ? own : options?.env !== undefined ? undefined : process.env.PATH;
}

/** What a shell or the OS searches when the environment names no PATH. */
const DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const realFile = (path: string): string => { try { return realpathSync(path); } catch { return path; } };
const SECURITY_FILE = realFile(REAL_SECURITY);

/** The file `program` would run: a path normalized, a bare name looked up on `path`, links followed. Null when there is none. */
function programFile(program: string, path: string | undefined): string | null {
  const found = program.includes("/") ? resolve(program) : Bun.which(program, { PATH: path ?? DEFAULT_PATH });
  return found === null ? null : realFile(found);
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "csh", "tcsh", "fish"]);
/** Words that run the next command word (`env security ...`, `then security ...`): skipped when finding what a shell segment starts. */
const PREFIXES = new Set(["env", "exec", "command", "builtin", "nohup", "time", "nice", "sudo", "stdbuf", "timeout", "if", "then", "else", "elif", "do", "while", "until", "!"]);

/**
 * The command word of each simple command in a shell string, with the PATH its own assignments leave (best effort: it splits on
 * separators, `$(` and backticks, and skips assignments, prefixes and options; it does not expand anything).
 */
function shellCommands(text: string, path: string | undefined): Array<{ word: string; path: string | undefined }> {
  const commands: Array<{ word: string; path: string | undefined }> = [];
  for (const segment of text.split(/\$\(|[;&|\n`(){}]/)) {
    let segmentPath = path;
    for (const raw of segment.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []) {
      const word = raw.replace(/["']/g, "");
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word);
      if (assignment) { if (assignment[1] === "PATH") segmentPath = assignment[2] as string; continue; }
      if (PREFIXES.has(word) || word.startsWith("-")) continue;
      commands.push({ word, path: segmentPath });
      break;
    }
  }
  return commands;
}

/** The program `env [options] [NAME=VALUE...] program args...` starts, its args, and the PATH its assignments leave. Null: none named. */
function envProgram(args: readonly string[], path: string | undefined): { program: string; rest: readonly string[]; path: string | undefined } | null {
  let list = args;
  let at = 0;
  let searchPath = path;
  while (at < list.length) {
    const arg = list[at] as string;
    if (arg === "-S" || arg === "--split-string") { list = [...(list[at + 1] ?? "").split(/\s+/).filter(Boolean), ...list.slice(at + 2)]; at = 0; continue; }
    if (arg === "-u" || arg === "-C" || arg === "-P" || arg === "--unset" || arg === "--chdir") { at += 2; continue; }
    if (arg.startsWith("-")) { at++; continue; }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(arg);
    if (assignment) { if (assignment[1] === "PATH") searchPath = assignment[2] as string; at++; continue; }
    return { program: arg, rest: list.slice(at + 1), path: searchPath };
  }
  return null;
}

/** The command line, as given, when `program args...` would start the real program: itself, through `env`, or in a shell string. */
function startsSecurity(program: string, args: readonly string[], path: string | undefined): string | null {
  const file = programFile(program, path);
  const spelled = `${program} ${args.join(" ")}`.trim();
  if (file === SECURITY_FILE) return spelled;
  const name = basename(file ?? program);
  if (name === "env") {
    const inner = envProgram(args, path);
    return inner && startsSecurity(inner.program, inner.rest, inner.path) !== null ? spelled : null;
  }
  if (SHELLS.has(name)) {
    const at = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    const text = at >= 0 ? args[at + 1] : undefined;
    return typeof text === "string" && shellCommands(text, path).some((c) => programFile(c.word, c.path) === SECURITY_FILE) ? spelled : null;
  }
  return null;
}

/** The first stack frames outside this file, to find the code that asked. */
function callers(): string {
  const frames = (new Error().stack ?? "").split("\n").slice(1).map((line) => line.trim())
    .filter((line) => line.startsWith("at ") && !line.includes("helpers/keychain-guard.ts"));
  return frames.slice(0, 3).join(" <- ");
}

function refusal(what: string): never {
  state().refusals.push(`${what} (${callers()})`);
  throw new Error(`test run: ${what} is refused; tests never touch the real login Keychain (inject a reader instead)`);
}

/**
 * The command line, as given, when starting `argv` (the program first) on `path` would start the real program: itself under any
 * spelling, through `env`, or in a shell string. Pure: nothing is started. `path` undefined means an environment with no PATH.
 */
export function wouldStartSecurity(argv: readonly string[], path: string | undefined = process.env.PATH): string | null {
  return typeof argv[0] === "string" ? startsSecurity(argv[0], argv.slice(1), path) : null;
}

/** Whether a shell string (or a Bun.$ template's text) starts the real program as one of its commands. Pure. */
export function shellTextStartsSecurity(text: string, path: string | undefined = process.env.PATH): boolean {
  return shellCommands(text, path).some((c) => programFile(c.word, c.path) === SECURITY_FILE);
}

function refuse(args: readonly unknown[]): void {
  const argv = argvOf(args[0]);
  if (!argv || typeof argv[0] !== "string") return;
  const found = startsSecurity(argv[0], argv.slice(1).map(String), pathOf(args));
  if (found !== null) refusal(found);
}

/** What a Bun.$ template says to run: its strings with the interpolated values between them. */
function templateText(strings: unknown, values: readonly unknown[]): string {
  const parts = Array.isArray(strings) ? strings.map(String) : [String(strings)];
  const text = (value: unknown): string => Array.isArray(value) ? value.map(text).join(" ")
    : typeof value === "object" && value !== null && "raw" in value ? String((value as { raw: unknown }).raw) : String(value);
  return parts.map((part, i) => part + (i < values.length ? text(values[i]) : "")).join("");
}

function refuseShellTemplate(strings: unknown, values: readonly unknown[]): void {
  const text = templateText(strings, values);
  if (shellTextStartsSecurity(text)) refusal(`Bun.$ ${text}`);
}

/** The error a test that touched the Keychain fails with. */
function refusalFailure(): void {
  const found = takeKeychainRefusals();
  if (!found.length) return;
  throw new Error(
    `this test tried to read the real macOS Keychain ${found.length} time(s), and the test run refused it:\n  ${found.join("\n  ")}\n`
    + "Tests never touch the real login Keychain. Inject a reader instead: seats `keychain: async () => null` with a temp `env.HOME`; the accounts "
    + "`keychain`; the orchestrator's `keychainHas`; macKeychain's `tool`; makeSystemKeychain's `run`.",
  );
}

function install(): void {
  const spawn = Bun.spawn.bind(Bun) as (...args: unknown[]) => unknown;
  const spawnSync = Bun.spawnSync.bind(Bun) as (...args: unknown[]) => unknown;
  Reflect.set(Bun, "spawn", (...args: unknown[]) => { refuse(args); return spawn(...args); });
  Reflect.set(Bun, "spawnSync", (...args: unknown[]) => { refuse(args); return spawnSync(...args); });
  // Bun's shell runs its commands itself, never through Bun.spawn: its template is what can be read. `.env()`, `.cwd()` and
  // `.nothrow()` return the same function, so one trap covers every chained form.
  const shell = Bun.$;
  Reflect.set(Bun, "$", new Proxy(shell, {
    apply(target, thisArg, args: unknown[]) { refuseShellTemplate(args[0], args.slice(1)); return Reflect.apply(target, thisArg, args); },
  }));
  afterEach(refusalFailure);
  afterAll(refusalFailure);
}

const INSTALLED = Symbol.for("walkie.test.keychainGuard.installed");
const once = globalThis as typeof globalThis & { [INSTALLED]?: true };
if (!once[INSTALLED]) {
  once[INSTALLED] = true;
  install();
}
