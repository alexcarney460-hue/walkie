// Seat users (PROTOCOL §11 "Seat users", SECURITY threat 13): every seat runs as a fresh OS user made for it and
// destroyed after it by the root helper (admin.ts), never as the daemon's user and never twice. The daemon reaches that
// only through two sudo rules: the runner as a member of the seats' group, and the helper's `create`/`destroy` verbs.
// `walkie seats setup-user [--apply]` prints (and runs, with the person's sudo) what sets that up.
import { randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, readdirSync, rmSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import { RELEASE_BUILD } from "../../license/service.ts";
import { SEATS_GROUP } from "./admin.ts";

/** A root-owned directory holding the root-owned runner copy and the seat users' runtimes. */
export const RUNNER_DIR = "/usr/local/libexec/walkie";
export const DEFAULT_RUNNER = `${RUNNER_DIR}/walkie-seat-runner`;
export const RUNTIMES_DIR = `${RUNNER_DIR}/runtimes`;
export const SEAT_USER_RE = /^_?[a-z][a-z0-9_-]{0,30}$/;
/** Groups whose members are administrators (a seat user must be in none). */
const ADMIN_GROUPS = new Set(["admin", "wheel", "sudo", "root", "adm"]);

/** `sudo -n -u <user> <runner…>`: never a password prompt, never a shell; the sudo rule allows exactly this argv. */
export function sudoSwitch(user: string, runner: string[]): string[] {
  return ["sudo", "-n", "-u", user, ...runner];
}

/** This walkie as the user helper (release: the binary; from source: bun and the CLI entry point). */
export function selfAdminArgv(): string[] {
  return RELEASE_BUILD ? [process.execPath, "seat-admin"] : [process.execPath, join(import.meta.dir, "..", "..", "cli", "main.ts"), "seat-admin"];
}

/** This walkie as a runner: the release binary itself, or (from source) bun and the CLI's entry point. */
export function selfRunnerArgv(): string[] {
  return RELEASE_BUILD ? [process.execPath, "seat-runner"] : [process.execPath, join(import.meta.dir, "..", "..", "cli", "main.ts"), "seat-runner"];
}

// ---- the seats' socket directory (Opus r3 LOW 5) -------------------------------------------------------------

/**
 * A fresh directory for the seats' socket when seats run as seat users (they can't enter the daemon's 0700 home):
 * `/tmp/walkie-seats-<daemon uid>-<16 random hex>`, created exclusively (an existing path, a symlink or someone
 * else's directory is refused) and 0711 (enterable, not listable). The socket in it is 0666; every request needs a
 * live per-seat token.
 */
export function makeSeatSocketDir(root = "/tmp"): string {
  const dir = join(root, `walkie-seats-${process.getuid?.() ?? 0}-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { mode: 0o711 }); // not recursive: fails if anything is there already
  verifySeatSocketDir(dir);
  return dir;
}

/** The directory is a real directory (never a symlink), this user's, 0711. Throws otherwise. */
export function verifySeatSocketDir(dir: string): void {
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== (process.getuid?.() ?? st.uid)) {
    throw new Error(`${dir} is not a directory of this user: the seats' socket can't live there`);
  }
  if ((st.mode & 0o777) !== 0o711) chmodSync(dir, 0o711);
}

export function removeSeatSocketDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
}

// ---- who may be a seat user (Codex r3 MEDIUM 4, Opus r3 MEDIUM 4) ---------------------------------------------

export interface OsUser { name: string; uid: number; gid: number; groups: string[]; gids: number[] }

/** An OS user by name (`id`), or null when there is none. */
export function lookupOsUser(name: string): OsUser | null {
  if (!SEAT_USER_RE.test(name)) return null;
  const id = (flag: string) => {
    const r = Bun.spawnSync(["id", flag, name], { stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin" } });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  };
  const uid = id("-u");
  const gid = id("-g");
  const groups = id("-Gn");
  const gids = id("-G");
  if (uid === null || gid === null || groups === null || gids === null || !/^\d+$/.test(uid) || !/^\d+$/.test(gid)) return null;
  return {
    name, uid: Number(uid), gid: Number(gid), groups: groups.split(/\s+/).filter(Boolean),
    gids: gids.split(/\s+/).filter((g) => /^\d+$/.test(g)).map(Number),
  };
}

/**
 * Why `u` can't be a seat user for a daemon running as uid `daemonUid` with primary group `daemonGid`, or null.
 * Checked by numeric id, at configuration and at every start: never root, never the daemon's own uid (a name alias
 * of it included), never an administrator, never sharing the daemon's primary group (a seat user in the person's
 * group reads what the person shares with it: macOS staff).
 */
export function seatUserProblem(
  u: OsUser | null, name: string, daemonUid: number, daemonGid: number, others: readonly OsUser[] = [], adminGids: readonly number[] = [],
): string | null {
  if (!u) return `there is no user ${name} on this machine (walkie seats setup-user --apply sets seat users up)`;
  if (u.uid === 0) return `${name} is root (uid 0): seats never run as root`;
  if (u.uid === daemonUid) return `${name} is the daemon's own user (uid ${u.uid}): seats would act as you`;
  if (u.groups.some((g) => ADMIN_GROUPS.has(g))) return `${name} is an administrator (in ${u.groups.filter((g) => ADMIN_GROUPS.has(g)).join(", ")})`;
  // Every effective group, by number (Codex r4 MEDIUM 4): the primary and each supplementary one.
  const gids = [...new Set([u.gid, ...u.gids])];
  if (gids.includes(daemonGid)) return `${name} is in your primary group (gid ${daemonGid}): give each seat user only its own group`;
  const admin = gids.filter((g) => adminGids.includes(g) || (process.platform === "darwin" && g === 20));
  if (admin.length) return `${name} is in an administrative or shared group (gid ${admin.join(", ")}): give each seat user only its own group`;
  if (others.some((o) => o.name !== name && o.uid === u.uid)) return `${name} has the same uid as another seat user`;
  if (others.some((o) => o.name !== name && o.gid === u.gid)) return `${name} has the same primary group (gid ${u.gid}) as another seat user`;
  return null;
}

/** The numeric ids of the administrative and shared groups (admin, wheel, staff, sudo, root, adm) on this machine. */
export function adminGroupIds(): number[] | null {
  const out: number[] = [];
  for (const g of [...ADMIN_GROUPS, "staff"]) {
    const argv = process.platform === "darwin" ? ["dscl", ".", "-read", `/Groups/${g}`, "PrimaryGroupID"] : ["getent", "group", g];
    try {
      const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin:/usr/sbin" } });
      const t = r.stdout.toString();
      const m = process.platform === "darwin" ? /PrimaryGroupID:\s*(\d+)/.exec(t) : /^[^:]*:[^:]*:(\d+):/.exec(t);
      if (m) { out.push(Number(m[1])); continue; }
      // A group that doesn't exist is fine; anything else (a failed lookup, output we can't read) is not (Codex r5 MEDIUM 6).
      const missing = process.platform === "darwin" ? /eDSRecordNotFound|not found/i.test(r.stderr.toString()) : r.exitCode === 2;
      if (!missing) return null;
    } catch {
      return null;
    }
  }
  return out;
}

// ---- ACLs (Codex r4 MEDIUM 5, Opus r4 LOW 4) ---------------------------------------------------------------------

/**
 * Why `path`'s access control list lets someone in beyond its mode, or null. `listing` is `ls -led <path>` (macOS:
 * one numbered line per entry; only `deny` entries, like a home's default `group:everyone deny delete`, are
 * harmless) or `getfacl -cp <path>` (Linux: any named user/group entry is extra access). Null input = can't tell.
 */
export function aclProblem(path: string, listing: string | null, platform: NodeJS.Platform = process.platform): string | null {
  if (listing === null) return `can't read the access control list of ${path}`;
  const lines = listing.split("\n").map((l) => l.trim()).filter(Boolean);
  if (platform === "darwin") {
    const allow = lines.filter((l) => /^\d+:\s/.test(l) && /\sallow\s/.test(l));
    return allow.length ? `${path} has an access control list that lets others in (${allow[0]})` : null;
  }
  const extra = lines.filter((l) => /^(user|group):[^:]+:/.test(l));
  return extra.length ? `${path} has an access control list that lets others in (${extra[0]})` : null;
}

/** `ls -led` (macOS) or `getfacl -cp` (Linux) of `path`, or null when it can't be read (fail closed). */
export function listAcl(path: string): string | null {
  const argv = process.platform === "darwin" ? ["ls", "-led", path] : ["getfacl", "-cp", path];
  try {
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin" } });
    if (r.exitCode === 0) return r.stdout.toString();
    if (process.platform !== "darwin") {
      // No getfacl: a `+` after the mode in `ls -ld` means an ACL we can't read.
      const l = Bun.spawnSync(["ls", "-ld", path], { stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin" } });
      if (l.exitCode === 0 && !/^\S{10}\+/.test(l.stdout.toString())) return "";
    }
    return null;
  } catch {
    return null;
  }
}

// ---- schedulers (Codex r4 HIGH 1) ---------------------------------------------------------------------------------

export const SCHEDULER_FILES: Record<"darwin" | "linux", { cron: [string, string]; at: [string, string] }> = {
  darwin: { cron: ["/usr/lib/cron/cron.allow", "/usr/lib/cron/cron.deny"], at: ["/usr/lib/cron/at.allow", "/usr/lib/cron/at.deny"] },
  linux: { cron: ["/etc/cron.allow", "/etc/cron.deny"], at: ["/etc/at.allow", "/etc/at.deny"] },
};

/**
 * Why a seat user could register work with cron or at (which would run after its seat was reaped), or null. Denied
 * means: an allow file exists and doesn't list it, or there is none and the deny file lists it. `read` returns a
 * file's text, null when it doesn't exist, and throws when it can't be read (fail closed).
 */
export function schedulerProblem(users: readonly string[], files: { cron: [string, string]; at: [string, string] }, read: (p: string) => string | null): string | null {
  for (const [service, [allowPath, denyPath]] of Object.entries(files) as Array<[string, [string, string]]>) {
    let allow: string | null;
    let deny: string | null;
    try { allow = read(allowPath); deny = read(denyPath); } catch { return `can't read ${service}'s allow/deny files: seat users might schedule jobs`; }
    // As cron parses them (Codex r5 MEDIUM 4): each line, its newline removed, compared exactly. A line that only
    // trimming would make equal (a trailing space, a CR) is ambiguous: refused rather than guessed either way.
    const lines = (text: string | null) => (text ?? "").split("\n");
    const ambiguous = (text: string | null, u: string) => lines(text).some((l) => l !== u && l.trim() === u);
    const listed = (text: string | null, u: string) => lines(text).includes(u);
    for (const u of users) {
      if (ambiguous(allow, u) || ambiguous(deny, u)) return `${service}'s allow/deny files list ${u} with extra spaces or a CR: fix the entry (exactly "${u}")`;
      const denied = allow !== null ? !listed(allow, u) : listed(deny, u);
      if (!denied) return `${u} may schedule jobs with ${service}, which would run after its seat ended: list it in ${denyPath} (walkie seats setup-user --apply does)`;
    }
  }
  return null;
}

// ---- the person's home (Opus r3 HIGH 1) --------------------------------------------------------------------------

/**
 * Why a seat user could read or enter the person's home, or null: other users may (`o+r`/`o+x`), or its group may
 * and a seat user is in that group. (ACLs are not inspected; macOS's default home ACL only denies deleting it.)
 */
export function homeProblem(home: string, st: Pick<Stats, "mode" | "gid"> | null, seatGids: readonly number[]): string | null {
  if (!st) return `can't inspect your home ${home}: seats run only when it is known to be closed`; // fail closed (Codex r4 MEDIUM 5)
  if (st.mode & 0o005) return `your home ${home} can be ${st.mode & 0o004 ? "read" : "entered"} by other users, seat users included: chmod 700 ${home}`;
  if (st.mode & 0o050 && seatGids.includes(st.gid)) return `your home ${home} is open to its group (gid ${st.gid}), which a seat user is in: chmod 700 ${home}`;
  return null;
}

// ---- the runner's path (Codex r3 LOW 6) ---------------------------------------------------------------------------

/**
 * Why sudo's command at `path` isn't immutable for everyone but root, or null: the file and every directory up to
 * `/` must be root-owned, not group- or other-writable, and no symlink; the file must be executable.
 */
export function runnerPathProblem(path: string, stat: (p: string) => Stats = lstatSync): string | null {
  if (!path.startsWith("/")) return `${path} is not an absolute path`;
  let p = path;
  for (;;) {
    let st: Stats;
    try { st = stat(p); } catch { return `${p} doesn't exist`; }
    if (st.isSymbolicLink()) return `${p} is a symlink`;
    if (st.uid !== 0) return `${p} is not owned by root (uid ${st.uid})`;
    if (st.mode & 0o022) return `${p} is writable by its group or other users (mode ${(st.mode & 0o777).toString(8)})`;
    if (p === path && !st.isFile()) return `${p} is not a file`;
    if (p === "/") break;
    p = dirname(p);
  }
  try { accessSync(path, constants.X_OK); } catch { return `${path} is not executable`; }
  return null;
}

// ---- the setup plan ----------------------------------------------------------------------------------------------

export const DEFAULT_ADMIN = `${RUNNER_DIR}/walkie-seat-admin`;

export interface SeatUserPlan {
  /** Each step: what it does, and its argv (run with the person's sudo unless `sudo` is false). */
  steps: Array<{ what: string; argv: string[]; sudo: boolean; /** Makes the seats' group (skipped when it exists). */ group?: true }>;
  sudoers: string;
  sudoersPath: string;
  runner: string;
  admin: string;
  runtimesDir: string;
  /** Runtimes copied for the seat users (name → source), and the ones that can't be (a script, not a binary). */
  runtimes: Record<string, string>;
  skippedRuntimes: string[];
  /** Why this must not be applied as is (the person's home is readable), unless accepted. */
  blocked: string | null;
  warnings: string[];
}

/**
 * What lets this machine give every seat a fresh OS user of its own (admin.ts), pure: the seats' group (`groupId` a
 * free id the caller found), a root-owned directory chain with the runner and the user helper (root-owned copies of
 * the walkie binary) and the runtimes, and a sudoers file with exactly two rules: the runner as any member of the
 * seats' group, and the helper's two verbs as root.
 */
export function seatUserPlan(o: {
  platform: NodeJS.Platform; daemonUser: string; source: string; groupId: number; walkieHome: string; sudoersTmp: string;
  runtimes?: Record<string, string | null>; home: string; homeProblem: string | null; acceptReadableHome?: boolean;
  /** The world-writable directories found on this machine (worldWritableDirs) and where their list was written. */
  extraRoots?: string[]; rootsTmp?: string;
  /** A file holding the daemon user's name: installed as SEAT_OWNER_FILE (one person per machine). */
  ownerTmp?: string;
}): SeatUserPlan {
  if (!/^[a-z_][a-z0-9._-]{0,31}$/.test(o.daemonUser)) throw new Error(`unexpected daemon user name: ${o.daemonUser}`);
  const mac = o.platform === "darwin";
  if (!mac && o.platform !== "linux") throw new Error(`seat users are set up on macOS and Linux only (this is ${o.platform})`);
  const rootGroup = mac ? "wheel" : "root";
  const steps: SeatUserPlan["steps"] = mac
    ? [
        { what: "the seats' group", argv: ["dscl", ".", "-create", `/Groups/${SEATS_GROUP}`], sudo: true, group: true },
        { what: "its id", argv: ["dscl", ".", "-create", `/Groups/${SEATS_GROUP}`, "PrimaryGroupID", String(o.groupId)], sudo: true, group: true },
      ]
    : [{ what: "the seats' group", argv: ["groupadd", "--system", SEATS_GROUP], sudo: true, group: true },
       { what: "where seat users' homes go (root's)", argv: ["install", "-d", "-m", "0755", "-o", "root", "-g", "root", "/var/lib/walkie-seats"], sudo: true }];
  steps.push(
    { what: "a root-owned directory for the runner and the user helper", argv: ["mkdir", "-p", RUNTIMES_DIR], sudo: true },
    { what: "owned by root", argv: ["chown", "-R", `root:${rootGroup}`, RUNNER_DIR], sudo: true },
    { what: "writable by root only", argv: ["chmod", "755", RUNNER_DIR, RUNTIMES_DIR], sudo: true },
    { what: "a root-owned copy of walkie as the runner", argv: ["install", "-m", "0755", "-o", "root", "-g", rootGroup, o.source, DEFAULT_RUNNER], sudo: true },
    { what: "a root-owned copy of walkie as the user helper (create/destroy a seat user)", argv: ["install", "-m", "0755", "-o", "root", "-g", rootGroup, o.source, DEFAULT_ADMIN], sudo: true },
  );
  const runtimes: Record<string, string> = {};
  const skippedRuntimes: string[] = [];
  for (const [name, src] of Object.entries(o.runtimes ?? {})) {
    if (!src) { skippedRuntimes.push(name); continue; }
    runtimes[name] = src;
    steps.push({ what: `${name} for the seat users (root-owned copy)`, argv: ["install", "-m", "0755", "-o", "root", "-g", rootGroup, src, `${RUNTIMES_DIR}/${name}`], sudo: true });
  }
  const sudoersPath = "/etc/sudoers.d/walkie-seats";
  const sudoers = [
    `# Walkie (walkie seats setup-user): ${o.daemonUser}'s daemon may make a fresh user for each seat, run the seat as it, and destroy it.`,
    `Defaults!${DEFAULT_RUNNER} !requiretty`,
    `Defaults!${DEFAULT_ADMIN} !requiretty`,
    `${o.daemonUser} ALL=(%${SEATS_GROUP}) NOPASSWD: ${DEFAULT_RUNNER} seat-runner`,
    `${o.daemonUser} ALL=(root) NOPASSWD: ${DEFAULT_ADMIN} seat-admin create *, ${DEFAULT_ADMIN} seat-admin destroy *, ${DEFAULT_ADMIN} seat-admin pending`,
    "",
  ].join("\n");
  if (o.ownerTmp) {
    steps.push({ what: `whose seats this machine takes (one person per machine: ${o.daemonUser})`, argv: ["install", "-m", "0644", "-o", "root", "-g", rootGroup, o.ownerTmp, SEAT_OWNER_FILE], sudo: true });
  }
  if (o.rootsTmp) {
    steps.push({
      what: `the world-writable directories every seat user's files are also swept from (${(o.extraRoots ?? []).length} found)`,
      argv: ["install", "-m", "0644", "-o", "root", "-g", rootGroup, o.rootsTmp, `${RUNNER_DIR}/${SEAT_ROOTS_FILE}`], sudo: true,
    });
  }
  steps.push(
    { what: "check the sudo rules", argv: ["visudo", "-c", "-f", o.sudoersTmp], sudo: true },
    { what: "install the sudo rules", argv: ["install", "-m", "0440", "-o", "root", "-g", rootGroup, o.sudoersTmp, sudoersPath], sudo: true },
    { what: "check the installed sudo rules", argv: ["visudo", "-c", "-f", sudoersPath], sudo: true },
    { what: "keep the Walkie home private", argv: ["chmod", "700", o.walkieHome], sudo: false },
  );
  const warnings: string[] = [];
  if (skippedRuntimes.length) warnings.push(`not a single binary, so not copied: ${skippedRuntimes.join(", ")}; install it where the seat users can run it`);
  if (o.homeProblem && o.acceptReadableHome) warnings.push(`${o.homeProblem} (accepted with --accept-readable-home: seat users can read what your home shows them)`);
  return {
    steps, sudoers, sudoersPath, runner: DEFAULT_RUNNER, admin: DEFAULT_ADMIN, runtimesDir: RUNTIMES_DIR, runtimes, skippedRuntimes,
    blocked: o.homeProblem && !o.acceptReadableHome ? o.homeProblem : null, warnings,
  };
}

export const SEAT_ROOTS_FILE = "seat-roots.json";

/**
 * The person whose daemon this machine's seat users are set up for (Opus r8 LOW): the sudo rules name one daemon user,
 * so a second person's setup would replace the first's; it is refused instead (SeatOwnerProblem).
 */
export const SEAT_OWNER_FILE = `${RUNNER_DIR}/seat-owner`;

/** Why `user` can't set up seat users here (another person's are), or null. */
export function seatOwnerProblem(user: string, read: (p: string) => string | null): string | null {
  const owner = read(SEAT_OWNER_FILE)?.trim();
  if (!owner || owner === user) return null;
  return `this machine's seat users are set up for ${owner}: one person per machine takes seats for now (the sudo rules name one daemon user); ${owner} can turn seats off (walkie seats deny) and an administrator can remove ${SEAT_OWNER_FILE} and /etc/sudoers.d/walkie-seats to hand it over`;
}

/** Where every seat user's sweep goes anyway (runner-sweep.ts realRoots): found directories under these are covered. */
const SWEPT = ["/private/tmp", "/private/var/tmp", "/tmp", "/var/tmp", "/Users/Shared", "/Library/Caches", "/dev/shm", "/private/var/folders"];

/**
 * World-writable directories on this machine outside the places every sweep already covers (Opus r7 6: on macOS e.g.
 * /private/var/db/DiagnosticsReporter, /private/var/db/PanicReporter, /private/var/db/UpdateMetrics/Events), where
 * a seat user could leave files: at most two levels below each of `parents`, bounded, never following a link.
 */
export function worldWritableDirs(parents: readonly string[] = process.platform === "darwin"
  ? ["/private/var", "/private/var/db", "/Library", "/Library/Application Support", "/Users", "/usr/local", "/opt", "/Applications"]
  : ["/var", "/var/lib", "/var/cache", "/srv", "/opt", "/usr/local", "/run", "/home"], maxEntries = 20_000): string[] {
  const found = new Set<string>();
  let seen = 0;
  const covered = (p: string) => SWEPT.some((r) => p === r || p.startsWith(`${r}/`));
  const visit = (dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (++seen > maxEntries) return;
      const p = `${dir}/${n}`;
      let st: ReturnType<typeof lstatSync>;
      try { st = lstatSync(p); } catch { continue; }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if ((st.mode & 0o002) && !covered(p)) found.add(p);
      if (depth < 1) visit(p, depth + 1);
    }
  };
  for (const p of parents) visit(p, 0);
  return [...found].sort().slice(0, 64);
}
