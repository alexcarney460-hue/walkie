// `walkie accounts shims install|uninstall` (ACCOUNTS-2): tiny `claude` and `codex` scripts in ~/.walkie/bin. Put that
// directory first on PATH and every terminal, launcher and agent that runs `claude` or `codex` goes through the
// switcher — no new habit. Each shim:
//   · runs the REAL CLI unchanged when WALKIE_NO_SWITCH=1, when there is no vault yet, or when it is already inside a
//     shim (WALKIE_SHIM_ACTIVE: never a loop), finding it on PATH while skipping its own directory and any file
//     that is itself a Walkie shim;
//   · otherwise execs `walkie claude|codex "$@"` (which also passes straight through when the vault has no account
//     for that provider).
// The Walkie side resolves the real CLI the same way (realCli below) and never execs a shim.
import { RELEASE_BUILD } from "../license/service.ts";
import { accessSync, chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { walkieArgv } from "../hooks/install.ts";

export const SHIM_MARK = "walkie-shim";
export const SHIM_NAMES = ["claude", "codex"] as const;
export type ShimName = (typeof SHIM_NAMES)[number];

export function shimDir(walkieHome: string): string {
  return join(walkieHome, "bin");
}

/** Single-quoted for sh. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function shimScript(name: ShimName, walkieHome: string, walkie: readonly string[] = walkieArgv()): string {
  const dir = shimDir(walkieHome);
  const target = walkie[walkie.length - 1] as string; // the binary, or main.ts in a source checkout
  return `#!/bin/sh
# ${SHIM_MARK} v2 (walkie-managed): runs \`walkie ${name}\`, which moves this session to the next account before a
# usage limit. WALKIE_NO_SWITCH=1 runs the real ${name} unchanged. Remove with: walkie accounts shims uninstall
real() {
  self=${sq(dir)}
  IFS=:
  for d in $PATH; do
    [ -z "$d" ] && continue
    [ "$d" = "$self" ] && continue
    [ -f "$d/${name}" ] && [ -x "$d/${name}" ] || continue
    head -c 256 "$d/${name}" 2>/dev/null | grep -q ${SHIM_MARK} && continue
    exec "$d/${name}" "$@"
  done
  echo "walkie: no real ${name} found on PATH (outside $self)" >&2
  exit 127
}
if [ "\${WALKIE_NO_SWITCH:-}" = "1" ] || [ -n "\${WALKIE_SHIM_ACTIVE:-}" ] || [ ! -f ${sq(join(walkieHome, "trusted-cli.json"))} ]; then
  real "$@"
fi
if [ ! -e ${sq(target)} ]; then
  echo "walkie: ${sq(target)} is gone; running the real ${name} (re-run: walkie accounts shims install)" >&2
  real "$@"
fi
WALKIE_SHIM_ACTIVE=1 exec ${walkie.map(sq).join(" ")} ${name} "$@"
`;
}

/** Whether a file starts like one of our shims (the first 256 bytes; a CLI binary never does). */
export function isShim(path: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, 256, 0);
    return buf.subarray(0, n).toString("latin1").includes(SHIM_MARK);
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function canon(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/**
 * The real `claude` / `codex`: WALKIE_REAL_CLAUDE / WALKIE_REAL_CODEX when set (an absolute path; source runs only), else the first
 * executable on PATH that is neither in ~/.walkie/bin nor a shim. Null when there is none: the caller reports it and
 * never falls back to the shim (no recursion).
 */
export function realCli(name: ShimName, walkieHome: string, env: NodeJS.ProcessEnv = process.env): string | null {
  // The override is for tests and source runs only: a release binary never takes the CLI's path from the environment.
  const override = RELEASE_BUILD ? undefined : env[name === "claude" ? "WALKIE_REAL_CLAUDE" : "WALKIE_REAL_CODEX"];
  if (override && override.startsWith("/") && existsSync(override) && !isShim(override)) return override;
  const skip = canon(shimDir(walkieHome));
  for (const d of (env.PATH ?? "").split(delimiter)) {
    if (!d || canon(d) === skip) continue;
    const f = join(d, name);
    try {
      if (!statSync(f).isFile()) continue;
      accessSync(f, constants.X_OK);
    } catch { continue; }
    if (isShim(f)) continue;
    return f;
  }
  return null;
}

export interface ShimResult { dir: string; written: string[]; removed: string[]; pathLine: string; onPath: boolean; profile?: string }

export function pathLine(walkieHome: string): string {
  const dir = shimDir(walkieHome);
  const home = homedir();
  const shown = dir.startsWith(home + "/") ? `$HOME${dir.slice(home.length)}` : dir;
  return `export PATH="${shown}:$PATH"  # walkie-managed: account switching (walkie accounts shims)`;
}

/** Whether the shim directory is on PATH ahead of every other `claude` / `codex`. */
export function shimsFirst(walkieHome: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const skip = canon(shimDir(walkieHome));
  for (const d of (env.PATH ?? "").split(delimiter)) {
    if (!d) continue;
    if (canon(d) === skip) return true;
    if (SHIM_NAMES.some((n) => existsSync(join(d, n)))) return false;
  }
  return false;
}

/** The shell profile the PATH line goes in (zsh: ~/.zshrc, bash: ~/.bashrc, else ~/.profile). */
export function profileFile(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const shell = env.SHELL ?? "";
  if (shell.endsWith("/zsh")) return join(home, ".zshrc");
  if (shell.endsWith("/bash")) return join(home, ".bashrc");
  return join(home, ".profile");
}

export function installShims(walkieHome: string, opts: { profile?: string | null; walkie?: readonly string[]; env?: NodeJS.ProcessEnv } = {}): ShimResult {
  const dir = shimDir(walkieHome);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  for (const name of SHIM_NAMES) {
    const path = join(dir, name);
    if (existsSync(path) && !isShim(path)) throw new Error(`${path} exists and is not a Walkie shim; move it away first`);
    writeFileSync(path, shimScript(name, walkieHome, opts.walkie), { mode: 0o755 });
    chmodSync(path, 0o755);
    written.push(path);
  }
  const line = pathLine(walkieHome);
  let profile: string | undefined;
  if (opts.profile) {
    const cur = existsSync(opts.profile) ? readFileSync(opts.profile, "utf8") : "";
    if (!cur.includes("walkie-managed: account switching")) writeFileSync(opts.profile, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${line}\n`);
    profile = opts.profile;
  }
  return { dir, written, removed: [], pathLine: line, onPath: shimsFirst(walkieHome, opts.env), ...(profile ? { profile } : {}) };
}

export function uninstallShims(walkieHome: string, opts: { profile?: string | null } = {}): ShimResult {
  const dir = shimDir(walkieHome);
  const removed: string[] = [];
  for (const name of SHIM_NAMES) {
    const path = join(dir, name);
    if (existsSync(path) && isShim(path)) { rmSync(path, { force: true }); removed.push(path); }
  }
  let profile: string | undefined;
  if (opts.profile && existsSync(opts.profile)) {
    const cur = readFileSync(opts.profile, "utf8");
    const next = cur.split("\n").filter((l) => !l.includes("walkie-managed: account switching")).join("\n");
    if (next !== cur) { writeFileSync(opts.profile, next); profile = opts.profile; }
  }
  return { dir, written: [], removed, pathLine: pathLine(walkieHome), onPath: false, ...(profile ? { profile } : {}) };
}
