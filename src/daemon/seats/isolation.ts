// Whether seats may run here, and as whom (PROTOCOL §11 "Seat users", SECURITY threat 13). Decided from config.json
// and the OS at daemon start, at every configuration change, when a request is judged and again immediately before
// every launch; every inspection that fails is a reason not to run (Codex r4 MEDIUM 5, Codex r5 MEDIUM 6).
import type { Stats } from "node:fs";
import type { SeatsConfig } from "../config.ts";
import { seatUserUid } from "./admin.ts";
import { aclProblem, homeProblem, runnerPathProblem, schedulerProblem, seatUserProblem, type OsUser } from "./seat-user.ts";

export interface Isolation {
  /** `ephemeral`: every seat as a fresh OS user; `same_user`: as the daemon's user, accepted; `none`: they don't run. */
  mode: "ephemeral" | "same_user" | "none";
  /** Why seats don't run although config.json allows them, with the command that fixes it (null: they may). */
  problem: string | null;
}

export interface IsolationDeps {
  platform: NodeJS.Platform;
  daemonUid: number;
  daemonGid: number;
  /** The person's home (the daemon user's). */
  home: string;
  stat: (path: string) => Pick<Stats, "mode" | "gid"> | null;
  /** A release build must run the root-owned runner and helper; a source build may run itself (tests). */
  release: boolean;
  runnerProblem?: (path: string) => string | null;
  /** `ls -led` / `getfacl -cp` of a path, null when it can't be read. Absent: ACLs aren't inspected (tests). */
  acl?: (path: string) => string | null;
}

export function evaluateIsolation(cfg: SeatsConfig, d: IsolationDeps): Isolation {
  if (cfg.mode === "same_user" && cfg.ephemeral) return { mode: "none", problem: "seat mode conflicts with seat-user setup" };
  if (cfg.mode === "seat_users" && cfg.same_user) return { mode: "none", problem: "seat mode conflicts with same-user consent" };
  if (cfg.mode === "seat_users" && !cfg.ephemeral) return { mode: "none", problem: "seat users are selected but not set up: walkie seats setup-user --apply" };
  if (!cfg.ephemeral) {
    if (cfg.same_user === true || (d.platform !== "darwin" && d.platform !== "linux")) return { mode: "same_user", problem: null };
    return {
      mode: "none",
      problem: "seats now run only as seat users of their own (walkie seats setup-user --apply), or as you when you say so (walkie seats allow --same-user)",
    };
  }
  const none = (problem: string): Isolation => ({ mode: "none", problem });
  if (!cfg.accept_readable_home) {
    const why = homeProblem(d.home, d.stat(d.home), []);
    if (why) return none(`${why} (or accept that seat users read it: walkie seats allow --accept-readable-home)`);
    const acl = d.acl ? aclProblem(d.home, d.acl(d.home), d.platform) : null;
    if (acl) return none(`${acl} (remove it, or accept that: walkie seats allow --accept-readable-home)`);
  }
  if (d.release) {
    const check = (what: string, path: string | undefined) => {
      if (!path) return `no seat ${what} is installed: walkie seats setup-user --apply`;
      const why = (d.runnerProblem ?? runnerPathProblem)(path) ?? (d.acl ? aclProblem(path, d.acl(path), d.platform) : null);
      return why ? `the seat ${what} can't be trusted: ${why} (walkie seats setup-user --apply reinstalls it)` : null;
    };
    const why = check("runner", cfg.runner) ?? check("user helper", cfg.admin);
    if (why) return none(why);
    if (!cfg.runtime_dir) return none("no runtimes are installed for the seat users: walkie seats setup-user --apply");
  }
  return { mode: "ephemeral", problem: null };
}

export interface SeatUserDeps {
  daemonUid: number;
  daemonGid: number;
  /** Numeric ids of the administrative and shared groups, or null when they couldn't all be read (fail closed). */
  adminGids: readonly number[] | null;
  /** The seats' own group (every ephemeral user is in it: the sudo rule runs the runner as its members). */
  seatsGid: number | null;
  schedulerFiles: { cron: [string, string]; at: [string, string] };
  readFile: (path: string) => string | null;
}

/**
 * Why the freshly made seat user `walkie-s<n>` can't run a seat, or null: its uid is 600000+n, it is none of the
 * daemon's or an administrator's groups (by number; the seats' group aside), and cron and at deny it (exactly as the
 * platform parses those files).
 */
export function seatUserCheck(u: OsUser | null, name: string, n: number, d: SeatUserDeps): string | null {
  if (d.adminGids === null) return "can't tell which groups are administrative here: no seat user is used until that can be read";
  if (u && u.uid !== seatUserUid(n)) return `${name} has uid ${u.uid}, not ${seatUserUid(n)}`;
  const own = u ? { ...u, gids: u.gids.filter((g) => g !== d.seatsGid) } : null;
  return seatUserProblem(own, name, d.daemonUid, d.daemonGid, [], d.adminGids)
    ?? schedulerProblem([name], d.schedulerFiles, d.readFile);
}

/**
 * Why a seat user's runtime copy (`<runtime_dir>/<runtime>`) can't be run, or null: in a release build it must exist
 * and be root's like the runner (checked before every launch; never a silent fallback to the person's PATH).
 */
export function runtimeCopyProblem(path: string, d: Pick<IsolationDeps, "acl" | "platform" | "runnerProblem">): string | null {
  return (d.runnerProblem ?? runnerPathProblem)(path) ?? (d.acl ? aclProblem(path, d.acl(path), d.platform) : null);
}
