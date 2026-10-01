// Loaded by bunfig.toml before root tests, first. A test run lives in a throwaway home, never the developer's: a code path
// that defaults to the home (~/.walkie, ~/.claude, ~/.codex, ~/.grok, ~/.hermes, ~/.ssh, ~/.gitconfig) because a test
// omitted a path lands in a directory that is deleted when the run ends, not in a real person's settings.
//
// Bun 1.3.14 reads HOME once, when the process starts: assigning process.env.HOME later does not change os.homedir()
// and does not reach a child process that inherits the environment. So this file does what an assignment cannot:
//   - it replaces node:os for every module loaded after it (named, default and dynamic imports) so homedir() and
//     userInfo().homedir are the throwaway home, and points the environment (HOME, USERPROFILE, XDG_*) at it;
//   - it unsets the variables that name a real directory (WALKIE_HOME, WALKIE_SOCKET, CLAUDE_CONFIG_DIR, CODEX_HOME,
//     KIMI_CODE_HOME, HERMES_HOME): a test that wants one sets it;
//   - git reads an identity-only global config in the throwaway home (never ~/.gitconfig or the system one);
//   - Bun.spawn and Bun.spawnSync hand a child the environment this file built when the call names none (Bun would hand
//     it the one the process started with, the real HOME included);
//   - a child that is a bun process and is given an environment of its own with no HOME in it (the usual CLI-test shape:
//     { PATH, NO_COLOR, WALKIE_HOME, WALKIE_SOCKET }) gets the throwaway home's variables added: such a child would ask the
//     passwd entry for its home, which is the real one (final review B). So does a child started through
//     test/helpers/person-cli.ts (runAsPerson, which goes through a shell). A test that names its own HOME keeps it, and so does
//     every other variable it names.
// Not covered: a module that loaded node:os before this preload, require("node:os"), a Worker thread (no guard of any kind runs
// there), Bun.$ and `new Bun.$.Shell()`, and any child that is not a bun process, which gets exactly the environment its test
// names (some tests assert a child's environment is empty): a shell, or a script run through a shebang (a fake `codex`), given
// an environment with no HOME, resolves the real home if it asks. A test that starts one names a HOME of its own.
import { mock } from "bun:test";
import * as osModule from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const STATE = Symbol.for("walkie.test.home");
export interface TestHome { readonly home: string; readonly realHome: string }
const holder = globalThis as typeof globalThis & { [STATE]?: TestHome };

/** The throwaway home of this test run, and the home it stands in for. */
export function testHome(): TestHome {
  const found = holder[STATE];
  if (!found) throw new Error("test/helpers/test-home.ts was not loaded as a preload (bunfig.toml)");
  return found;
}

/** The variables a home lookup reads, pointing at `home`: what a child needs to land in the throwaway home. */
function homeVariables(home: string): Record<string, string> {
  return {
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"),
    WALKIE_TEST_HOME: home,
  };
}

/**
 * What a child that a test gave an environment of its own, with no HOME, needs added so it cannot resolve the real home through
 * the passwd entry. For a helper that starts its child another way (a shell that starts a bun CLI): the child's own variables win.
 */
export function throwawayHomeEnv(): Record<string, string> {
  return homeVariables(testHome().home);
}

/** Variables that name a real directory a default path would use: unset, so a default is the throwaway home's. */
const REAL_DIRECTORY_VARIABLES = ["WALKIE_HOME", "WALKIE_SOCKET", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME", "HERMES_HOME"] as const;

/** Whether a spawn call starts a bun process (the bun this test run is, or any `bun` by name): `spawn([cmd, ...], opts)` or `spawn({ cmd, ... })`. */
function startsBun(args: unknown[]): boolean {
  const first = args[0];
  const argv = Array.isArray(first) ? first : (first as { cmd?: unknown } | null)?.cmd;
  return Array.isArray(argv) && typeof argv[0] === "string" && (argv[0] === process.execPath || basename(argv[0]) === "bun");
}

/**
 * A spawn call's arguments with the environment settled: none named = the environment this file built; one named = as named,
 * except that a bun child whose environment has no HOME also gets the throwaway home's variables (the child's own win).
 * `spawn(cmd, options)` and `spawn({ cmd, ...options })` are both Bun's.
 */
function withEnv(args: unknown[], env: Record<string, string>, home: Record<string, string>): unknown[] {
  const objectForm = !Array.isArray(args[0]) && typeof args[0] === "object" && args[0] !== null;
  const at = objectForm ? 0 : 1;
  const options = (args[at] ?? {}) as { env?: Record<string, unknown> };
  if (options.env !== undefined) {
    if ("HOME" in options.env || !startsBun(args)) return args;
    const out = [...args];
    out[at] = { ...options, env: { ...home, ...options.env } };
    return out;
  }
  const out = [...args];
  out[at] = { ...options, env };
  return out;
}

function install(): TestHome {
  const real = { ...osModule };
  const realUserInfo = osModule.userInfo as unknown as (options?: unknown) => object;
  const realHome = real.homedir();
  const home = mkdtempSync("/tmp/walkie-th-"); // short: a unix socket path under it must stay under 104 bytes
  const gitConfig = join(home, ".gitconfig");
  writeFileSync(gitConfig, "[user]\n\tname = Walkie Test\n\temail = test@example.com\n"); // the lowest-precedence default: a test's own -c or repo config still wins

  const homeEnv = homeVariables(home);
  const env: Record<string, string> = { ...homeEnv, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  Object.assign(process.env, env);
  for (const name of REAL_DIRECTORY_VARIABLES) delete process.env[name];

  const patched = {
    ...real,
    homedir: () => home,
    userInfo: (options?: unknown) => ({ ...realUserInfo(options), homedir: home }),
  };
  mock.module("node:os", () => ({ ...patched, default: patched }));

  const spawn = Bun.spawn.bind(Bun) as (...args: unknown[]) => unknown;
  const spawnSync = Bun.spawnSync.bind(Bun) as (...args: unknown[]) => unknown;
  const childEnv = (): Record<string, string> => Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  Reflect.set(Bun, "spawn", (...args: unknown[]) => spawn(...withEnv(args, childEnv(), homeEnv)));
  Reflect.set(Bun, "spawnSync", (...args: unknown[]) => spawnSync(...withEnv(args, childEnv(), homeEnv)));

  // bun test ends without running process "exit" handlers, and a hook that runs after every file would take the home
  // away from the next file: a small detached shell removes the directory once this process is gone.
  const watcher = spawn(["/bin/sh", "-c", 'while kill -0 "$1" 2>/dev/null; do sleep 2; done; rm -rf "$2"', "sh", String(process.pid), home],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true, env: { PATH: "/usr/bin:/bin" } }) as { unref(): void };
  watcher.unref();
  return { home, realHome };
}

holder[STATE] ??= install();
