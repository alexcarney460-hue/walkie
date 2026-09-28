// SEATS-FIX-3 (docs/audits/2026-09-26-*-seats-r3.md), without daemons: the runner's line limits (Codex LOW 7); who may
// be a seat user, by numeric uid and groups (Codex MEDIUM 4, Opus MEDIUM 4); the person's home (Opus HIGH 1); the
// runner's directory chain (Codex LOW 6); isolation decided from config.json at load and before launch, a legacy
// enabled config included (Codex HIGH 2); the pool plan with one user and one group per seat (Codex MEDIUM 3), the
// installed sudoers checked (Opus INFO); uid-wide stop/cont/reap that a setsid'd process can't leave (Codex HIGH 1).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Input } from "../../src/daemon/seats/runner-io.ts";
import { fakePids, uidOp } from "../../src/daemon/seats/runner-uid.ts";
import {
  homeProblem, makeSeatSocketDir, runnerPathProblem, seatUserProblem, verifySeatSocketDir, type OsUser,
} from "../../src/daemon/seats/seat-user.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } });
}
const user = (name: string, uid: number, gid = uid, groups = [name]): OsUser => ({ name, uid, gid, groups, gids: [gid] });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stat = (pid: number) => Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim();

describe("the runner's input (Codex LOW 7)", () => {
  test("a line longer than its limit is refused, not returned; byte counts still frame what follows", async () => {
    const long = new Input(stream(`${"x".repeat(80)}\n`, "stop\n"));
    expect(await long.line(64)).toBeNull();
    const ok = new Input(stream("{\"rv\":2}\n", "abc", "stop\n"));
    expect(await ok.line(64)).toBe("{\"rv\":2}");
    expect(new TextDecoder().decode((await ok.bytes(3)) as Uint8Array)).toBe("abc");
    expect(await ok.line(64)).toBe("stop");
    expect(await ok.line(64)).toBeNull(); // the end
    // A line with no newline yet, already over the limit, is refused without waiting for more.
    expect(await new Input(stream("y".repeat(100))).line(64)).toBeNull();
  });
});

describe("who may be a seat user (Codex MEDIUM 4, Opus MEDIUM 4)", () => {
  const daemonUid = 501;
  const daemonGid = 20;
  test("by numeric uid and groups: never root, the daemon's own uid (any name), an administrator, a shared group", () => {
    expect(seatUserProblem(null, "ghost", daemonUid, daemonGid)).toMatch(/no user ghost/);
    expect(seatUserProblem(user("toor", 0), "toor", daemonUid, daemonGid)).toMatch(/root \(uid 0\)/);
    expect(seatUserProblem(user("alias", 501, 700), "alias", daemonUid, daemonGid)).toMatch(/daemon's own user \(uid 501\)/);
    expect(seatUserProblem(user("adm1", 460, 460, ["adm1", "admin"]), "adm1", daemonUid, daemonGid)).toMatch(/administrator/);
    expect(seatUserProblem(user("st", 461, 20), "st", daemonUid, daemonGid)).toMatch(/in your primary group \(gid 20\)/);
    const a = user("walkie-seat1", 451);
    expect(seatUserProblem(a, "walkie-seat1", daemonUid, daemonGid)).toBeNull();
    expect(seatUserProblem(user("walkie-seat2", 451, 452), "walkie-seat2", daemonUid, daemonGid, [a])).toMatch(/same uid/);
  });
});

describe("the person's home (Opus HIGH 1)", () => {
  test("refused when other users can read or enter it, or its group can and a seat user is in that group", () => {
    expect(homeProblem("/Users/arvid", { mode: 0o40755, gid: 20 }, [451])).toMatch(/can be read by other users/);
    expect(homeProblem("/Users/arvid", { mode: 0o40701, gid: 20 }, [451])).toMatch(/can be entered/);
    expect(homeProblem("/Users/arvid", { mode: 0o40750, gid: 20 }, [451])).toBeNull();
    expect(homeProblem("/Users/arvid", { mode: 0o40750, gid: 20 }, [451, 20])).toMatch(/open to its group/);
    expect(homeProblem("/Users/arvid", { mode: 0o40700, gid: 20 }, [20])).toBeNull();
  });
});

describe("the runner's path (Codex LOW 6)", () => {
  test("every directory up to / must be root's, not group/other-writable, no symlink", () => {
    expect(runnerPathProblem("/usr/bin/true")).toBeNull(); // root's all the way
    const d = mkdtempSync("/tmp/walkie-runner-path-");
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    writeFileSync(join(d, "runner"), "#!/bin/sh\n");
    chmodSync(join(d, "runner"), 0o755);
    expect(runnerPathProblem(join(d, "runner"))).toMatch(/not owned by root/);
    symlinkSync("/usr/bin/true", join(d, "link"));
    expect(runnerPathProblem(join(d, "link"))).toMatch(/is a symlink/);
    expect(runnerPathProblem("relative/runner")).toMatch(/not an absolute path/);
    // A root-owned file in a group-writable (or someone else's) directory can be replaced: refused.
    const fake = (p: string) => ({ isSymbolicLink: () => false, isFile: () => p.endsWith("runner"), uid: 0, mode: p === "/opt/w" ? 0o40775 : 0o40755 }) as never;
    expect(runnerPathProblem("/opt/w/runner", fake)).toMatch(/\/opt\/w is writable by its group/);
  });
});

describe("the seats' socket directory (Opus LOW 5)", () => {
  test("fresh and unpredictable each time, 0711, and a squatted path is refused", () => {
    const root = mkdtempSync("/tmp/walkie-sockroot-");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const a = makeSeatSocketDir(root);
    const b = makeSeatSocketDir(root);
    expect(a).not.toBe(b);
    expect(a).toMatch(/walkie-seats-\d+-[0-9a-f]{16}$/);
    expect(Bun.spawnSync(["stat", "-f", "%Lp", a], { stdout: "pipe" }).stdout.toString().trim()).toBe("711");
    // A symlink where the directory should be (or anything not a plain directory of this user) is refused.
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(root, "link"));
    expect(() => verifySeatSocketDir(join(root, "link"))).toThrow(/not a directory of this user/);
  });
});

describe("uid-wide busy control (Codex HIGH 1, Opus HIGH 2)", () => {
  test("stop and cont reach every process of the (fake) user, a setsid'd one and its supervisor included, and nothing else", async () => {
    const marker = `fix3-${process.pid}-${Date.now() % 100000}`;
    const env = { PATH: "/usr/bin:/bin", WALKIE_SEAT_FAKE_UID: marker };
    // A "runner", a runtime in its own group, and a worker that left it for its own session. (bun, not /bin/sh: macOS
    // hides the environment of its platform binaries from ps, which the fake scope reads; the real one is kill(-1).)
    const loop = [process.execPath, "-e", "setInterval(() => {}, 1000)"];
    const runner = Bun.spawn(loop, { env, stdout: "ignore", stderr: "ignore" });
    const runtime = Bun.spawn(loop, { env, stdout: "ignore", stderr: "ignore", detached: true });
    const escaped = Bun.spawn(loop, { env, stdout: "ignore", stderr: "ignore", detached: true });
    const other = Bun.spawn(loop, { env: { PATH: "/usr/bin:/bin" }, stdout: "ignore", stderr: "ignore" });
    const all = [runner.pid, runtime.pid, escaped.pid];
    cleanups.push(() => { for (const p of [...all, other.pid]) try { process.kill(p, "SIGCONT"); process.kill(p, "SIGKILL"); } catch { /* gone */ } });
    await Bun.sleep(400);
    const found = fakePids(marker);
    for (const p of all) expect(found).toContain(p);
    expect(found).not.toContain(other.pid);
    expect(await uidOp("stop", marker)).toEqual({ left: 0, verified: true });
    for (const p of all) expect(stat(p)).toStartWith("T");
    expect(stat(other.pid)).not.toStartWith("T"); // nothing outside the user
    expect(await uidOp("cont", marker)).toEqual({ left: 0, verified: true });
    for (const p of all) expect(stat(p)).not.toStartWith("T");
  });
});
