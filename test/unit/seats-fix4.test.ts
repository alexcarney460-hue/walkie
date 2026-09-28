// SEATS-FIX-4 (docs/audits/2026-09-26-*-seats-r4.md), without daemons: a reaper that can't be signalled into failure
// and says whether it verified (Opus HIGH 1, Codex MEDIUM 6); a verified wipe of the whole pool home, refused on an
// unmarked one (Codex HIGH 2, Opus HIGH 2); schedulers denied (Codex HIGH 1); every group checked by number (Codex
// MEDIUM 4); inspection failures and ACLs fail closed (Codex MEDIUM 5, Opus LOW 4).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateIsolation, type IsolationDeps } from "../../src/daemon/seats/isolation.ts";
import { aclProblem, homeProblem, schedulerProblem, seatUserProblem, type OsUser } from "../../src/daemon/seats/seat-user.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const user = (name: string, uid: number, gid = uid, gids = [gid], groups = [name]): OsUser => ({ name, uid, gid, groups, gids });
const tmp = (p: string) => { const d = mkdtempSync(p); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d; };

describe("schedulers (Codex HIGH 1)", () => {
  test("each pool user must be denied cron and at: listed in deny, or absent from an existing allow", () => {
    const d = tmp("/tmp/walkie-cron-");
    const files = { cron: [join(d, "cron.allow"), join(d, "cron.deny")] as [string, string], at: [join(d, "at.allow"), join(d, "at.deny")] as [string, string] };
    const read = (p: string) => (existsSync(p) ? (Bun.spawnSync(["cat", p], { stdout: "pipe" }).stdout.toString()) : null);
    expect(schedulerProblem(["walkie-seat1"], files, read)).toMatch(/walkie-seat1 may schedule jobs with cron/);
    writeFileSync(files.cron[1], "walkie-seat1\n");
    expect(schedulerProblem(["walkie-seat1"], files, read)).toMatch(/with at/);
    writeFileSync(files.at[0], "alex\n"); // an allow file that doesn't list it denies it
    expect(schedulerProblem(["walkie-seat1"], files, read)).toBeNull();
    writeFileSync(files.cron[0], "walkie-seat1\n"); // allowed by name: refused
    expect(schedulerProblem(["walkie-seat1"], files, read)).toMatch(/with cron/);
    expect(schedulerProblem(["walkie-seat1"], files, () => { throw new Error("EACCES"); })).toMatch(/can't read cron/);
  });
});

describe("groups by number (Codex MEDIUM 4)", () => {
  test("a supplementary group equal to the daemon's, an admin gid, or a primary group shared with another seat user is refused", () => {
    expect(seatUserProblem(user("s1", 451, 451, [451, 20]), "s1", 501, 20)).toMatch(/in your primary group \(gid 20\)/);
    expect(seatUserProblem(user("s1", 451, 451, [451, 80]), "s1", 501, 20, [], [80])).toMatch(/administrative or shared group \(gid 80\)/);
    expect(seatUserProblem(user("s2", 452, 451), "s2", 501, 20, [user("s1", 451)])).toMatch(/same primary group \(gid 451\)/);
    expect(seatUserProblem(user("s2", 452), "s2", 501, 20, [user("s1", 451)], [80])).toBeNull();
  });
});

describe("inspection fails closed; ACLs count (Codex MEDIUM 5, Opus LOW 4)", () => {
  test("an unreadable home or ACL is a reason not to run; an ACL allow entry is extra access, a deny entry is not", () => {
    expect(homeProblem("/Users/arvid", null, [])).toMatch(/can't inspect your home/);
    expect(aclProblem("/Users/arvid", null)).toMatch(/can't read the access control list/);
    const macHome = "drwx------+ 60 arvid  staff  1920 Sep 26 12:00 /Users/arvid\n 0: group:everyone deny delete\n";
    expect(aclProblem("/Users/arvid", macHome, "darwin")).toBeNull();
    expect(aclProblem("/Users/arvid", `${macHome} 1: user:walkie-seat1 allow list,search,readattr\n`, "darwin")).toMatch(/lets others in/);
    expect(aclProblem("/home/arvid", "user::rwx\ngroup::---\nother::---\n", "linux")).toBeNull();
    expect(aclProblem("/home/arvid", "user::rwx\nuser:walkie-seat1:r-x\ngroup::---\n", "linux")).toMatch(/lets others in/);
    const deps: IsolationDeps = { platform: "darwin", daemonUid: 501, daemonGid: 20, home: "/Users/arvid", release: false, stat: () => null };
    expect(evaluateIsolation({ allow: true, ephemeral: true }, deps).problem).toMatch(/can't inspect your home/);
    const acl = { ...deps, stat: () => ({ mode: 0o40700, gid: 20 }), acl: () => `${macHome} 1: user:walkie-s1 allow read\n` };
    expect(evaluateIsolation({ allow: true, ephemeral: true }, acl).problem).toMatch(/access control list/);
    const rel = { ...deps, stat: () => ({ mode: 0o40700, gid: 20 }), release: true, runnerProblem: () => null };
    expect(evaluateIsolation({ allow: true, ephemeral: true }, rel).problem).toMatch(/no seat runner is installed/);
    expect(evaluateIsolation({ allow: true, ephemeral: true, runner: "/r" }, rel).problem).toMatch(/no seat user helper is installed/);
    expect(evaluateIsolation({ allow: true, ephemeral: true, runner: "/r", admin: "/a" }, rel).problem).toMatch(/no runtimes are installed/);
  });
});
