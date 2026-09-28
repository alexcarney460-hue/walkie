// The real system calls of the root helper `walkie-seat-admin` (admin.ts): macOS (dscl, launchctl) and Linux
// (useradd/userdel, systemd). Runs as root, from the root-owned copy only, with cwd `/` and a fixed environment.
// Every inspection that can't tell throws (Codex r6 MEDIUM 6): "absent" is only ever a verified absence. Root never
// deletes a file outside a seat's home by path: the seat user's own sweep does that (sweepAsUser). The one exception is
// its crontab in the cron spool (a directory only root and cron itself write), when crontab refuses the
// cron-denied user (removeSpoolCrontab).
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Ledger } from "./admin-ledger.ts";
import { forceUnmount, userMounts, writeDurably } from "./fsat.ts";
import { validRoots } from "./runner-sweep.ts";
import { SEATS_GROUP, SEAT_HOME_MARKER, SEAT_USER_PREFIX, type AdminSys } from "./admin.ts";
import { DS_GROUP_ATTRS, macImplicitGids, parseDsGroups, parseDsUser } from "./mac-groups.ts";
import { runnerOp } from "./runner-child.ts";
import { SCHEDULER_FILES, SEAT_ROOTS_FILE, listAcl } from "./seat-user.ts";

const PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function run(argv: string[], timeoutMs = 60_000): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore", cwd: "/", env: { PATH, LC_ALL: "C" }, timeout: timeoutMs });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

function must(argv: string[]): string {
  const r = run(argv);
  if (r.code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed (${r.code}): ${r.err.trim().slice(0, 200)}`);
  return r.out;
}

/**
 * A file replaced atomically and durably: an exclusive temporary file, flushed to the disk itself (F_FULLFSYNC on
 * macOS: Opus r7 INFO 9), renamed, the directory flushed too.
 */
export function writeRoot(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeDurably(path, text, mode);
}



/** A user of this name: true, false (verified absent), or throws. */
function userExists(name: string): boolean {
  const r = run(["id", "-u", name]);
  if (r.code === 0) return true;
  if (r.code === 1 && /no such user/i.test(r.err)) return false;
  throw new Error(`id ${name} failed (${r.code}): ${r.err.trim().slice(0, 120)}`);
}

/** A group of this name: true, false (verified absent), or throws. */
function groupExists(name: string, mac: boolean): boolean {
  if (mac) {
    const r = run(["dscl", ".", "-read", `/Groups/${name}`, "PrimaryGroupID"]);
    if (r.code === 0) return true;
    if (/eDSRecordNotFound|-14136/.test(r.err + r.out)) return false;
    throw new Error(`dscl -read /Groups/${name} failed (${r.code})`);
  }
  const r = run(["getent", "group", name]);
  if (r.code === 0) return true;
  if (r.code === 2) return false;
  throw new Error(`getent group ${name} failed (${r.code})`);
}

/** Entries of `dir` owned by `uid` (read-only; a missing directory holds none; anything else unreadable throws). */
function ownedIn(dir: string, uid: number): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  return names.filter((n) => {
    try { return lstatSync(join(dir, n)).uid === uid; } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") return false;
      throw err;
    }
  });
}

/** The cron spool directories that hold a user's crontab as `<dir>/<name>` (macOS: /usr/lib/cron is /var/at). */
export const CRON_TABS: Record<"darwin" | "linux", string[]> = {
  darwin: ["/usr/lib/cron/tabs", "/var/at/tabs"],
  linux: ["/var/spool/cron/crontabs", "/var/spool/cron"],
};

const errCode = (err: unknown) => (err as { code?: string }).code ?? (err as Error).message;

/**
 * A crontab of `name` removed from the spool by root directly: `crontab -u <name> -r` refuses a user in cron.deny
 * (every seat user is: denySchedulers), so root unlinks `<dir>/<name>` (never following a link; the spool directories
 * are root's) and verifies it gone. None there: nothing to remove. The problem, or null.
 */
export function removeSpoolCrontab(name: string, tabs: readonly string[]): string | null {
  for (const d of tabs) {
    const p = join(d, name);
    let st: ReturnType<typeof lstatSync>;
    try { st = lstatSync(p); } catch (err) {
      if (errCode(err) === "ENOENT") continue;
      return `${p} can't be checked (${errCode(err)})`;
    }
    if (st.isDirectory()) return `${p} is a directory, not a crontab`;
    try { unlinkSync(p); } catch (err) {
      if (errCode(err) !== "ENOENT") return `${p} could not be removed (${errCode(err)})`;
    }
    try { lstatSync(p); return `${p} is still there after it was removed`; } catch (err) {
      if (errCode(err) !== "ENOENT") return `${p} can't be checked after it was removed (${errCode(err)})`;
    }
  }
  return null;
}

/**
 * What `crontab -u <name> -r` (exit `code`, stderr `err`) leaves to do: nothing (removed, or "no crontab for"), the
 * spool entry removed directly when crontab refuses the user ("not allowed to use this program": it is in cron.deny,
 * SEATS-MACOS-FIX), or the failure. The problem, or null.
 */
export function crontabRemoval(name: string, code: number, err: string, tabs: readonly string[]): string | null {
  if (code === 0 || /no crontab/i.test(err)) return null;
  const failed = `crontab -u ${name} -r failed (${code}): ${err.trim().slice(0, 120)}`;
  if (!/not allowed to use this program/i.test(err)) return failed;
  const why = removeSpoolCrontab(name, tabs);
  return why ? `${failed}; ${why}` : null;
}

export function realAdminSys(): AdminSys {
  const mac = process.platform === "darwin";
  const platform = mac ? "darwin" : "linux";
  const ledgerPath = mac ? "/var/db/walkie-seat-admin.sqlite" : "/var/lib/walkie/seat-admin.sqlite";
  const files = SCHEDULER_FILES[platform];
  // The runner is the helper's sibling in the root-owned install directory (walkie seats setup-user --apply).
  const runnerPath = join(dirname(process.execPath), "walkie-seat-runner");
  const rootsPath = join(dirname(process.execPath), SEAT_ROOTS_FILE);
  let ledger: Ledger | null = null;
  return {
    platform,
    schedulerFiles: files,
    caller() {
      // sudo sets SUDO_UID itself (the caller can't): the person whose daemon asked.
      const v = process.env.SUDO_UID;
      if (!v || !/^\d{1,10}$/.test(v)) throw new Error("walkie seat-admin runs through sudo only (no SUDO_UID)");
      return Number(v);
    },
    userMounts,
    unmount: forceUnmount,
    extraRoots() {
      const st = lstatSync(rootsPath); // missing: throws (setup-user --apply writes it)
      if (!st.isFile() || st.uid !== 0 || (st.mode & 0o022) !== 0) throw new Error(`${rootsPath} is not a file only root can write`);
      const roots = validRoots(JSON.parse(readFileSync(rootsPath, "utf8")));
      if (!roots) throw new Error(`${rootsPath} doesn't hold a list of directories (re-run: walkie seats setup-user --apply)`);
      return roots;
    },
    ledger() {
      if (!ledger) { mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o755 }); ledger = new Ledger(ledgerPath, true); }
      return ledger;
    },
    nameTaken(name) { return userExists(name) || groupExists(name, mac); },
    idTaken(id) {
      if (mac) {
        const u = must(["dscl", ".", "-search", "/Users", "UniqueID", String(id)]);
        const g = must(["dscl", ".", "-search", "/Groups", "PrimaryGroupID", String(id)]);
        return u.trim() !== "" || g.trim() !== "";
      }
      const found = (db: string) => {
        const r = run(["getent", db, String(id)]);
        if (r.code === 0) return true;
        if (r.code === 2) return false;
        throw new Error(`getent ${db} ${id} failed (${r.code})`);
      };
      return found("passwd") || found("group");
    },
    lookup(name) {
      if (name === SEATS_GROUP && !userExists(name)) {
        if (!groupExists(name, mac)) return null;
        const g = mac ? must(["dscl", ".", "-read", `/Groups/${name}`, "PrimaryGroupID"]) : must(["getent", "group", name]);
        const m = mac ? /PrimaryGroupID:\s*(\d+)/.exec(g) : /^[^:]*:[^:]*:(\d+):/.exec(g);
        if (!m) throw new Error(`the ${name} group has no id`);
        return { uid: -1, gid: Number(m[1]), gids: [] };
      }
      if (!userExists(name)) return null;
      return { uid: Number(must(["id", "-u", name]).trim()), gid: Number(must(["id", "-g", name]).trim()), gids: must(["id", "-G", name]).trim().split(/\s+/).map(Number) };
    },
    implicitGroups(name, gids) {
      if (!mac) return [];
      // Direct membership in the local directory, not `id -G` (which also counts nesting of everyone/localaccounts).
      const user = parseDsUser(must(["dscl", ".", "-read", `/Users/${name}`, "GeneratedUID", "PrimaryGroupID"]));
      const groups = parseDsGroups(must(["dscl", ".", "-readall", "/Groups", ...DS_GROUP_ATTRS]));
      if (!groups.length) throw new Error("dscl listed no local groups");
      return macImplicitGids({ name, ...user }, gids, groups);
    },
    createUser({ name, uid, home }) {
      if (mac) {
        const g = `/Groups/${name}`;
        const u = `/Users/${name}`;
        must(["dscl", ".", "-create", g]);
        must(["dscl", ".", "-create", g, "PrimaryGroupID", String(uid)]);
        must(["dscl", ".", "-create", u]);
        for (const [k, v] of [["UserShell", "/usr/bin/false"], ["RealName", `Walkie seat ${name.slice(SEAT_USER_PREFIX.length)}`], ["UniqueID", String(uid)],
          ["PrimaryGroupID", String(uid)], ["NFSHomeDirectory", home], ["Password", "*"], ["IsHidden", "1"]] as const) {
          must(["dscl", ".", "-create", u, k, v]);
        }
        must(["dseditgroup", "-o", "edit", "-a", name, "-t", "user", SEATS_GROUP]);
      } else {
        must(["groupadd", "-g", String(uid), name]);
        must(["useradd", "-u", String(uid), "-g", String(uid), "-G", SEATS_GROUP, "-M", "-d", home, "-s", "/usr/sbin/nologin", name]);
      }
    },
    deleteUser(name) {
      if (mac) {
        if (userExists(name)) {
          run(["dseditgroup", "-o", "edit", "-d", name, "-t", "user", SEATS_GROUP]);
          must(["dscl", ".", "-delete", `/Users/${name}`]);
        }
        if (groupExists(name, true)) must(["dscl", ".", "-delete", `/Groups/${name}`]);
      } else {
        if (userExists(name)) must(["userdel", name]);
        if (groupExists(name, false)) must(["groupdel", name]);
      }
    },
    makeHome(home, uid) {
      // Root's until the very end: an interruption leaves a home the user never wrote in (Codex r7 MEDIUM 4).
      mkdirSync(home, { mode: 0o700 }); // not recursive: fresh
      chmodSync(home, 0o700);
      mkdirSync(join(home, "walkie-seats"), { mode: 0o700 });
      writeFileSync(join(home, SEAT_HOME_MARKER), "", { mode: 0o444, flag: "wx" }); // root's
      chownSync(join(home, "walkie-seats"), uid, uid);
      chownSync(home, uid, uid);
    },
    acl: listAcl,
    stat(path) {
      try {
        const st = lstatSync(path);
        return { uid: st.uid, mode: st.mode, dir: st.isDirectory(), file: st.isFile(), symlink: st.isSymbolicLink() };
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") return null;
        throw err;
      }
    },
    denySchedulers(name) {
      for (const f of [files.cron[1], files.at[1]]) {
        const text = existsSync(f) ? readFileSync(f, "utf8") : "";
        if (text.split("\n").includes(name)) continue;
        writeRoot(f, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${name}\n`, 0o644);
      }
    },
    readSchedulerFile(p) { return existsSync(p) ? readFileSync(p, "utf8") : null; },
    procs(uid) {
      const r = run(["ps", "-U", String(uid), "-o", "pid=,stat="]);
      if (r.code === 1 && r.out.trim() === "" && r.err.trim() === "") return []; // none (Opus r8 LOW: not a failure)
      if (r.code !== 0) throw new Error(`ps failed (${r.code})`);
      return r.out.split("\n").map((l) => /^\s*(\d+)\s+(\S+)/.exec(l)).filter((m): m is RegExpExecArray => !!m && !(m[2] as string).startsWith("Z"))
        .map((m) => ({ pid: Number(m[1]), stat: m[2] as string }));
    },
    signal(pid, sig) { process.kill(pid, sig); },
    stopUserServices(uid) {
      if (mac) {
        const problems: string[] = [];
        for (const domain of [`gui/${uid}`, `user/${uid}`]) {
          const r = run(["launchctl", "bootout", domain]);
          // No such domain (none was ever made for it, or it is gone already) is the usual case.
          if (r.code !== 0 && !/no such process|could not find domain|boot-out failed: 3:|boot-out failed: 113:/i.test(r.err + r.out)) {
            problems.push(`launchctl bootout ${domain} (${r.code}): ${r.err.trim().slice(0, 120)}`);
          }
        }
        return problems.length ? problems.join("; ") : null;
      }
      if (!existsSync("/usr/bin/systemctl") && !existsSync("/bin/systemctl")) return null; // no systemd: no user manager
      const unit = `user@${uid}.service`;
      const stop = run(["systemctl", "stop", unit]);
      if (stop.code !== 0 && !(stop.code === 5 && /not loaded/i.test(stop.err))) return `systemctl stop ${unit} failed (${stop.code}): ${stop.err.trim().slice(0, 120)}`;
      // `is-active` exits 0 only when active; otherwise it names the state. Anything else can't tell (Codex r7 MEDIUM 5).
      const r = run(["systemctl", "is-active", unit]);
      const active = r.out.trim();
      if (r.code !== 0 && ["inactive", "failed", "unknown"].includes(active)) return null;
      return r.code === 0 ? `${unit} is ${active || "active"}` : `systemctl is-active ${unit} couldn't tell (${r.code}: ${JSON.stringify(active)})`;
    },
    removeSchedules(name, uid, exists) {
      const tabs = CRON_TABS[platform];
      if (exists) {
        const r = run(["crontab", "-u", name, "-r"]);
        const why = crontabRemoval(name, r.code, r.err, tabs);
        if (why) return why;
      }
      // Read-only, by name and uid, whether or not the account still exists (Codex r6 MEDIUM 5, 6).
      const jobs = mac ? ["/usr/lib/cron/jobs"] : ["/var/spool/cron/atjobs", "/var/spool/at"];
      const left: string[] = [];
      for (const d of tabs) {
        const st = (() => { try { return lstatSync(join(d, name)); } catch (err) { if ((err as { code?: string }).code === "ENOENT") return null; throw err; } })();
        if (st && !st.isDirectory()) left.push(`${d}/${name}`);
        left.push(...ownedIn(d, uid).map((f) => `${d}/${f}`));
      }
      for (const d of jobs) left.push(...ownedIn(d, uid).map((f) => `${d}/${f}`));
      return left.length ? `scheduled jobs of it remain (${[...new Set(left)].slice(0, 5).join(", ")})` : null;
    },
    async sweepAsUser(name, _uid, roots) {
      // root → the seat user through sudo (initgroups: its own groups only), cwd /, a fixed environment.
      const r = await runnerOp(["sudo", "-n", "-u", name, "--", runnerPath, "seat-runner"], "sweep", 30 * 60_000, { roots });
      if (!r) return { ok: false, left: ["the seat user's sweep didn't answer"] };
      return { ok: r.verified, left: r.verified ? [] : [...(r.samples ?? []), ...(r.why ? [r.why] : []), ...(r.left !== undefined ? [`${r.left} left`] : [])], leftoverDirs: r.verified ? r.leftoverDirs : [] };
    },
    sleep: (ms) => Bun.sleep(ms),
  };
}
