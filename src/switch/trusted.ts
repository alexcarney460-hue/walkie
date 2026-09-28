// The CLI binaries Walkie hands credentials to (round 1 Codex 1; rounds 2-3). `walkie accounts shims install` (or
// `walkie accounts trust-cli`) records, per CLI, the path found on PATH and the object it resolves to, after checking:
//   · it is a NATIVE executable (Mach-O / ELF): a script launcher, a shebang file, anything an interpreter runs is
//     refused (round 3: an interpreter, its startup files and the scripts it dispatches to cannot all be pinned) — with
//     the install command for the native CLI;
//   · every symlink hop is followed by hand, and every lexical ancestor directory of every hop is checked, as is the
//     final file: not in a git work tree (exact Homebrew prefixes excepted: git checkouts of Homebrew itself), not in a
//     node_modules/.bin, not inside the project the command runs from (when it runs from one — a git work tree or a
//     directory with a project file; from ~ it does not apply);
//   · owned by the person or root; not other-writable; not group-writable (except the macOS `admin` group when the
//     person is its only real member, see unsafe()); on macOS no ACL entry (parsed structurally from `ls -le`,
//     inherited ones included; an unreadable or unrecognised entry refuses) letting anyone else write.
// At EVERY credential-bearing launch the wrapper resolves the CLI on PATH again, re-runs all checks and compares the
// validated object's dev / inode / size / mtime right before it spawns it; it runs the validated real file, never the
// PATH name. An update that replaced the binary in the same trusted place is accepted (re-validated) and the record
// refreshed. Anything else runs without Walkie credentials, with one line saying why. ~/.walkie/trusted-cli.json (0600).
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";

const Id = z.object({ path: z.string(), dev: z.number(), ino: z.number(), size: z.number(), mtimeMs: z.number() });
export type ObjectId = z.infer<typeof Id>;
const Interp = z.object({ name: z.string(), path: z.string(), args: z.array(z.string()) });
const Entry = z.object({
  path: z.string(), realpath: z.string(), dev: z.number(), ino: z.number(), recorded_at: z.number(),
  /** Written by rounds 1-2 (a script's pinned interpreter); read for old records only and ignored since round 3. */
  interp: Interp.optional(),
});
export type TrustedCli = z.infer<typeof Entry>;
const File = z.object({ v: z.literal(1), claude: Entry.optional(), codex: Entry.optional() });
type Name = "claude" | "codex";

/** Exact Homebrew prefixes (git checkouts of Homebrew itself, not projects). Never recognised by their contents. */
export const HOMEBREW_PREFIXES = ["/opt/homebrew", "/usr/local/Homebrew", "/home/linuxbrew/.linuxbrew"] as const;

export interface TrustOptions {
  cwd: string;
  /** Checks stop at this directory (tests); "/" in use. */
  stopAt?: string;
  uid?: number;
  /** The person's user name (for the admin-group rule); the current user in use. */
  user?: string;
  /** macOS `admin` group (gid + members); read with dscl in use, null elsewhere or when it cannot be read. */
  adminGroup?: AdminGroup | null;
  /** Tests: other exact prefixes that count as Homebrew. */
  brewPrefixes?: readonly string[];
  /** Tests: ACL entries of a path (`ls -le` entry lines) or null when unreadable; macOS `ls -led` in use. */
  acl?: (path: string) => string[] | null;
  /** Walkie's shim directory (unused by the checks; accepted for callers). */
  shimDir?: string;
}

export interface AdminGroup {
  gid: number; members: string[]; nested: boolean;
  /** Members that are macOS service accounts, ignored like root: an `_`-name with uid < 500 and no login shell. */
  services?: string[];
}

const NO_LOGIN_SHELLS = new Set(["/usr/bin/false", "/sbin/nologin"]);

/** Whether a user record (dscl UniqueID / UserShell) is a service account that cannot log in (never a person). */
export function isServiceAccount(name: string, uid: number | null, shell: string | null): boolean {
  return name.startsWith("_") && uid !== null && uid < 500 && shell !== null && NO_LOGIN_SHELLS.has(shell);
}

let adminCache: AdminGroup | null | undefined;

/** The macOS `admin` group from Directory Services (`dscl . -read /Groups/admin`), or null. */
export function readAdminGroup(): AdminGroup | null {
  if (adminCache !== undefined) return adminCache;
  adminCache = null;
  if (process.platform !== "darwin") return adminCache;
  try {
    const r = Bun.spawnSync(["/usr/bin/dscl", ".", "-read", "/Groups/admin", "PrimaryGroupID", "GroupMembership", "NestedGroups"], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    const text = r.stdout.toString();
    const gid = Number(/^PrimaryGroupID:\s*(\d+)/m.exec(text)?.[1]);
    const members = (/^GroupMembership:(.*)$/m.exec(text)?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
    const nested = /^NestedGroups:\s*\S/m.test(text);
    const services = members.filter((m) => {
      if (!/^_[A-Za-z0-9_.-]{1,64}$/.test(m)) return false;
      const u = Bun.spawnSync(["/usr/bin/dscl", ".", "-read", `/Users/${m}`, "UniqueID", "UserShell"], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }).stdout.toString();
      const uid = Number(/^UniqueID:\s*(-?\d+)/m.exec(u)?.[1]);
      const shell = /^UserShell:\s*(\S+)/m.exec(u)?.[1] ?? null;
      return isServiceAccount(m, Number.isInteger(uid) ? uid : null, shell);
    });
    if (Number.isInteger(gid)) adminCache = { gid, members, nested, services };
  } catch { /* unreadable: no exception */ }
  return adminCache;
}

function trustedFile(walkieHome: string): string {
  return join(walkieHome, "trusted-cli.json");
}

function within(p: string, dir: string): boolean {
  const d = resolve(dir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

function realpathOr(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/** Every right `chmod` / `ls -le` knows; an entry naming anything else is unrecognised (refused). */
const ACL_RIGHTS = new Set([
  "read", "write", "execute", "delete", "append", "readattr", "writeattr", "readextattr", "writeextattr", "readsecurity",
  "writesecurity", "chown", "list", "search", "add_file", "add_subdirectory", "delete_child", "file_inherit",
  "directory_inherit", "limit_inherit", "only_inherit",
]);
const WRITE_RIGHTS = new Set(["write", "append", "delete", "writeattr", "writeextattr", "writesecurity", "chown", "add_file", "add_subdirectory", "delete_child"]);

export interface Ace { principal: string; inherited: boolean; allow: boolean; rights: string[] }

/**
 * One `ls -le` entry, parsed structurally (round 3, Codex 3): "<n>: <principal>[ inherited] allow|deny <rights>". The
 * principal may contain spaces ("group:Domain Users"); `inherited` sits between it and the disposition. Anything that
 * does not fit, or names a right this does not know, is null — and the caller refuses.
 */
export function parseAce(line: string): Ace | null {
  const m = /^\s*(?:\d+:\s+)?(.+?)(\s+inherited)?\s+(allow|deny)\s+([a-z_]+(?:,[a-z_]+)*)\s*$/.exec(line);
  if (!m) return null;
  const rights = (m[4] as string).split(",");
  if (!rights.every((r) => ACL_RIGHTS.has(r))) return null;
  return { principal: (m[1] as string).trim(), inherited: !!m[2], allow: m[3] === "allow", rights };
}

/** macOS ACL entry lines of a path, from `ls -led`; null when they cannot be read (the caller refuses). */
export function readAcl(path: string): string[] | null {
  if (process.platform !== "darwin") return [];
  const r = Bun.spawnSync(["/bin/ls", "-led", path], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  if (r.exitCode !== 0) return null;
  return r.stdout.toString().split("\n").slice(1).filter((l) => l.trim() !== "");
}

/**
 * Why a directory or file is not a safe place, or null. One exception to "not group-writable" (Homebrew on macOS makes
 * its directories writable by the `admin` group): allowed only when the group is `admin`, every member of it other than
 * root and macOS service accounts (an `_`-name with uid < 500 and shell /usr/bin/false or /sbin/nologin, checked with
 * dscl — so a person cannot hide behind an underscore name) is the person (no nested groups), and the entry is owned by
 * root or the person. Never other-writable; never an ACL entry allowing anyone but the person to write.
 */
function unsafe(p: string, uid: number, o: TrustOptions): string | null {
  const st = statSync(p);
  if (st.uid !== uid && st.uid !== 0) return `${p} is owned by another user`;
  if ((st.mode & 0o002) !== 0) return `${p} is writable by others`;
  if ((st.mode & 0o020) !== 0) {
    const admin = o.adminGroup !== undefined ? o.adminGroup : readAdminGroup();
    const user = o.user ?? userInfo().username;
    const ignored = new Set(["root", ...(admin?.services ?? [])]);
    const onlyMe = !!admin && !admin.nested && st.gid === admin.gid && admin.members.filter((m) => !ignored.has(m)).every((m) => m === user);
    if (!onlyMe) return `${p} is writable by group or others`;
  }
  const user = o.user ?? userInfo().username;
  const lines = (o.acl ?? readAcl)(p);
  if (lines === null) return `${p}: its ACL could not be read`;
  for (const line of lines) {
    const ace = parseAce(line);
    if (!ace) return `${p} has an ACL entry that could not be understood (${line.trim().slice(0, 80)})`;
    if (!ace.allow || !ace.rights.some((r) => WRITE_RIGHTS.has(r)) || ace.principal === `user:${user}`) continue;
    return `${p} has an ACL entry letting ${ace.principal} write${ace.inherited ? " (inherited)" : ""}`;
  }
  return null;
}

/**
 * Follows `path` hop by hop (each symlink read by hand, relative targets resolved against the link's directory).
 * Returns every path the resolution went through (the original, each rewritten path) and the final real file.
 */
function hops(path: string): { paths: string[]; final: string } {
  const paths = [resolve(path)];
  let cur = resolve(path);
  for (let n = 0; n < 40; n++) {
    const parts = cur.split("/").filter(Boolean);
    let prefix = "/";
    let rewritten: string | null = null;
    for (let i = 0; i < parts.length; i++) {
      const next = join(prefix, parts[i] as string);
      const st = lstatSync(next);
      if (st.isSymbolicLink()) {
        const target = readlinkSync(next);
        rewritten = resolve(isAbsolute(target) ? target : join(prefix, target), ...parts.slice(i + 1));
        break;
      }
      prefix = next;
    }
    if (rewritten === null) return { paths, final: cur };
    paths.push(rewritten);
    cur = rewritten;
  }
  throw new Error(`${path}: too many symbolic links`);
}

/** Every lexical ancestor directory of `p` down to (and including) the stop directory. */
function ancestors(p: string, stopAt: string): string[] {
  const out: string[] = [];
  const stops = new Set([resolve(stopAt), realpathOr(stopAt)]);
  let dir = dirname(p);
  for (let i = 0; i < 128; i++) {
    out.push(dir);
    if (stops.has(dir) || dir === dirname(dir)) break;
    dir = dirname(dir);
  }
  return out;
}

function isBrewPrefix(dir: string, o: TrustOptions): boolean {
  return [...HOMEBREW_PREFIXES, ...(o.brewPrefixes ?? [])].some((b) => resolve(b) === dir);
}

function inGitTree(start: string, o: TrustOptions): string | null {
  // The home directory itself as a repository (a dotfiles checkout) does not make everything under ~ a project.
  const home = realpathOr(process.env.HOME ?? userInfo().homedir);
  for (const dir of [start, ...ancestors(join(start, "x"), o.stopAt ?? "/").slice(1)]) {
    if (dir === home || realpathOr(dir) === home) continue;
    if (existsSync(join(dir, ".git")) && !isBrewPrefix(dir, o)) return dir;
  }
  return null;
}

/** Files that mark a project directory (with .git): the cwd rule applies inside one. */
const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile", "composer.json", "deno.json", "bunfig.toml", "pom.xml", "build.gradle"];

/**
 * The project the command runs from (round 3, Opus): the nearest directory at or above the cwd holding a project
 * marker, never the person's home itself. Null when there is none — launching from ~ puts no CLI off limits.
 */
export function projectRoot(cwd: string, o: Pick<TrustOptions, "stopAt">): string | null {
  const home = realpathOr(process.env.HOME ?? userInfo().homedir);
  let dir = realpathOr(cwd);
  for (let i = 0; i < 128; i++) {
    if (dir !== home && PROJECT_MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
    if (dir === home || dir === dirname(dir) || (o.stopAt && dir === realpathOr(o.stopAt))) return null;
    dir = dirname(dir);
  }
  return null;
}

export interface Inspected { real: string; ids: ObjectId[] }

/**
 * All checks for the CLI object: every hop and every lexical ancestor of every hop, then the
 * final file. Returns the problem, or the final real path and the identity of what was validated.
 */
function inspectObject(path: string, o: TrustOptions): { problem: string } | Inspected {
  if (!isAbsolute(path)) return { problem: `${path} is not an absolute path` };
  const uid = o.uid ?? process.getuid?.() ?? 0;
  let chain: { paths: string[]; final: string };
  try { chain = hops(path); } catch (err) { return { problem: `${path} could not be resolved (${(err as Error).message.slice(0, 80)})` }; }
  const project = projectRoot(o.cwd, o);
  const dirs = new Set<string>();
  for (const p of chain.paths) {
    if (p.split(sep).join("/").includes("node_modules/.bin/")) return { problem: `${p} is in a node_modules/.bin (a project's own tools)` };
    if (project && (within(p, project) || within(p, realpathOr(project)))) return { problem: `${p} is inside the project you are running from (${project})` };
    const repo = inGitTree(dirname(p), o);
    if (repo) return { problem: `${p} is inside the git work tree ${repo}` };
    for (const d of ancestors(p, o.stopAt ?? "/")) dirs.add(d);
  }
  try {
    const st = statSync(chain.final);
    if (!st.isFile()) return { problem: `${chain.final} is not a file` };
    const f = unsafe(chain.final, uid, o);
    if (f) return { problem: f };
    for (const d of dirs) {
      const bad = unsafe(d, uid, o);
      if (bad) return { problem: bad };
    }
    return { real: chain.final, ids: [{ path: chain.final, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs }] };
  } catch (err) {
    return { problem: `${chain.final} could not be checked (${(err as Error).message.slice(0, 80)})` };
  }
}

const NATIVE_MAGIC = [
  "feedface", "feedfacf", "cefaedfe", "cffaedfe", // Mach-O 32 / 64, either byte order
  "cafebabe", "bebafeca", // Mach-O universal ("fat")
  "7f454c46", // ELF
];

/** Whether a file is a native executable (Mach-O / ELF), by its first four bytes. */
export function isNative(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(4);
    const n = readSync(fd, buf, 0, 4, 0);
    return n === 4 && NATIVE_MAGIC.includes(buf.toString("hex"));
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export const NATIVE_INSTALL: Record<Name, string> = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash",
  codex: "the standalone codex binary (https://github.com/openai/codex/releases, or: brew install codex)",
};

export interface Resolved { argv: string[]; ids: ObjectId[] }

/** The credential recipient: the CLI's native executable, all checks passed. */
function resolveRecipient(path: string, o: TrustOptions, name?: Name): { problem: string } | Resolved {
  const cli = inspectObject(path, o);
  if ("problem" in cli) return cli;
  if (!isNative(cli.real)) {
    const how = name ? `; install the native ${name}: ${NATIVE_INSTALL[name]}` : "";
    return { problem: `${cli.real} is not a native executable (a script launcher or interpreter-run file)${how}` };
  }
  return { argv: [cli.real], ids: cli.ids };
}

/** Why `path` (as found on PATH) must not receive credentials, or null when it is a trusted native executable. */
export function trustProblem(path: string, o: TrustOptions): string | null {
  const r = resolveRecipient(path, o);
  return "problem" in r ? r.problem : null;
}

function read(walkieHome: string): z.infer<typeof File> {
  try {
    const p = File.safeParse(JSON.parse(readFileSync(trustedFile(walkieHome), "utf8")));
    return p.success ? p.data : { v: 1 };
  } catch {
    return { v: 1 };
  }
}

function write(walkieHome: string, f: z.infer<typeof File>): void {
  writeFileSync(trustedFile(walkieHome), JSON.stringify(f) + "\n", { mode: 0o600 });
}

function entryOf(path: string, r: Resolved): TrustedCli {
  const cli = r.ids[0] as ObjectId;
  return { path, realpath: cli.path, dev: cli.dev, ino: cli.ino, recorded_at: Date.now() };
}

/** Records the native CLI found at `path` as trusted, or throws with the reason it is not. */
export function recordTrusted(walkieHome: string, name: Name, path: string, o: TrustOptions): TrustedCli {
  const r = resolveRecipient(path, o, name);
  if ("problem" in r) throw new Error(`not trusting ${name} at ${path}: ${r.problem}`);
  const e = entryOf(path, r);
  write(walkieHome, { ...read(walkieHome), [name]: e });
  return e;
}

export function trustedEntry(walkieHome: string, name: Name): TrustedCli | null {
  return read(walkieHome)[name] ?? null;
}

export type TrustCheck =
  | { ok: true; argv: string[]; ids: ObjectId[]; refreshed: boolean }
  | { ok: false; why: string };

/**
 * Whether the CLI resolved on PATH right now may receive credentials: the recorded path, a native executable, every
 * check passing now (re-validated at every launch). `argv` is what to run (the validated real file).
 */
export function checkTrusted(walkieHome: string, name: Name, resolved: string, o: TrustOptions): TrustCheck {
  const rec = trustedEntry(walkieHome, name);
  if (!rec) return { ok: false, why: `no trusted ${name} is recorded (run: walkie accounts shims install)` };
  if (resolve(resolved) !== resolve(rec.path)) return { ok: false, why: `${resolved} is not the trusted ${name} (${rec.path})` };
  const r = resolveRecipient(resolved, o, name);
  if ("problem" in r) return { ok: false, why: r.problem };
  const cli = r.ids[0] as ObjectId;
  const changed = cli.path !== rec.realpath || cli.ino !== rec.ino || cli.dev !== rec.dev;
  if (changed) {
    try { write(walkieHome, { ...read(walkieHome), [name]: entryOf(rec.path, r) }); } catch { /* read-only home: still valid now */ }
  }
  return { ok: true, argv: r.argv, ids: r.ids, refreshed: changed };
}

/**
 * The executable a credential-handling command may run (round 4, Codex 2: `walkie accounts add codex` too): the
 * recorded trusted CLI when one is recorded, else the CLI found on PATH if it passes every check (native, in a safe
 * place). `argv` is the validated real file.
 */
export function trustedRecipient(walkieHome: string, name: Name, resolved: string, o: TrustOptions): TrustCheck {
  if (trustedEntry(walkieHome, name)) return checkTrusted(walkieHome, name, resolved, o);
  const r = resolveRecipient(resolved, o, name);
  return "problem" in r ? { ok: false, why: r.problem } : { ok: true, argv: r.argv, ids: r.ids, refreshed: false };
}

/** Right before exec: the validated objects are still exactly those (same dev, inode, size, mtime). */
export function sameObjects(ids: readonly ObjectId[]): boolean {
  try {
    return ids.every((i) => {
      const st = statSync(i.path);
      return st.dev === i.dev && st.ino === i.ino && st.size === i.size && st.mtimeMs === i.mtimeMs;
    });
  } catch {
    return false;
  }
}
