// WALK-103: only the Walkie that `walkie seats setup-user --apply` registered lists, makes or removes this machine's
// seat users. The record (instance.ts), the root helper's refusal (admin.ts runSeatAdmin), and root's binding of the
// daemon that ran sudo to the registered socket's instance lock (admin-sys.ts), the last one with real processes.
import { afterEach, expect, spyOn, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock } from "../../src/daemon/instance-lock.ts";
import { parseAdminArgv, runSeatAdmin, type AdminSys } from "../../src/daemon/seats/admin.ts";
import { SeatCallerMismatch, checkSeatInstance, fdHoldsFlock, readRegularNoFollow } from "../../src/daemon/seats/admin-sys.ts";
import { doctorChecks, pendingProbeProblem } from "../../src/daemon/seats/doctor.ts";
import type { SeatsLocalView } from "../../src/protocol/seats.ts";
import { DEFAULT_ADMIN, SEAT_INSTANCE_FILE, seatOwnerProblem, seatUserPlan } from "../../src/daemon/seats/seat-user.ts";
import {
  LEGACY_SCOPE_WHY, canonicalPath, parseSeatRegistration, readSeatRegistration, seatRegistrationText, seatScopeFor, type SeatRegistration,
} from "../../src/daemon/seats/instance.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "seat-instance-bind.ts");
const ME = process.getuid?.() ?? 501;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tmp(): string {
  // Short: unix socket paths are limited to about 100 bytes.
  const dir = mkdtempSync(join(tmpdir(), "wsi-"));
  dirs.push(dir);
  return dir;
}
const reg = (socket: string, over: Partial<SeatRegistration> = {}): SeatRegistration =>
  ({ v: 1, user: "arvid", uid: ME, home: "/home/arvid/.walkie", socket, ...over });

/** Every member but the ones named throws: the helper must not read or touch anything else. */
function only(members: Record<string, unknown>): AdminSys {
  return new Proxy(members, {
    get: (target, key) => {
      if (key in target) return target[key as string];
      throw new Error(`the helper touched ${String(key)}`);
    },
  }) as unknown as AdminSys;
}

async function admin(argv: string[], sys: AdminSys): Promise<{ code: number; answer: Record<string, unknown> }> {
  const getuid = spyOn(process, "getuid").mockReturnValue(0);
  try {
    const lines: string[] = [];
    const code = await runSeatAdmin(argv, sys, (line) => lines.push(line));
    return { code, answer: JSON.parse(lines[0] as string) as Record<string, unknown> };
  } finally { getuid.mockRestore(); }
}

test("the record: exactly one plain registration, root's alone when read for real", () => {
  const dir = tmp();
  const socket = join(dir, "walkie.sock");
  expect(parseSeatRegistration(seatRegistrationText(reg(socket)))).toEqual(reg(socket));
  for (const bad of ["", "[]", "{}", JSON.stringify({ ...reg(socket), v: 2 }), JSON.stringify({ ...reg(socket), uid: -1 }),
    JSON.stringify({ ...reg(socket), socket: "walkie.sock" }), JSON.stringify({ ...reg(socket), home: "/a/../b" }),
    JSON.stringify({ ...reg(socket), user: "Root;rm" })]) expect(parseSeatRegistration(bad)).toBeNull();
  const path = join(dir, "seat-instance");
  expect(readSeatRegistration(path, false)).toEqual({ state: "absent" });
  writeFileSync(path, "not json\n");
  expect(readSeatRegistration(path, false).state).toBe("invalid");
  writeFileSync(path, seatRegistrationText(reg(socket)));
  expect(readSeatRegistration(path, false)).toEqual({ state: "present", registration: reg(socket) });
  // A record the person (not root) could have written is never trusted by the real helper or daemon.
  if (ME !== 0) expect(readSeatRegistration(path, true)).toMatchObject({ state: "invalid", why: expect.stringContaining("not owned by root") });
});

test("the daemon's side: its own socket and uid only; a record of another Walkie or none never counts as its own", () => {
  const dir = tmp();
  const mine = join(dir, "a", "walkie.sock");
  mkdirSync(join(dir, "a"));
  const present = (r: SeatRegistration) => ({ state: "present" as const, registration: r });
  expect(seatScopeFor(present(reg(canonicalPath(mine))), mine, ME)).toEqual({ state: "own" });
  const other = seatScopeFor(present(reg(canonicalPath(join(dir, "b", "walkie.sock")), { home: "/home/arvid/.walkie" })), mine, ME);
  // (Read before toMatchObject: Bun 1.3 writes its asymmetric matchers into the received object.)
  expect(other.state === "other" && other.why).toContain("/home/arvid/.walkie");
  expect(other).toMatchObject({ state: "other", why: expect.stringContaining("managed by another Walkie") });
  expect(seatScopeFor(present(reg(canonicalPath(mine), { uid: ME + 1 })), mine, ME).state).toBe("other");
  expect(seatScopeFor({ state: "absent" }, mine, ME)).toEqual({ state: "legacy", why: LEGACY_SCOPE_WHY });
  expect(seatScopeFor({ state: "invalid", why: "x is not a regular file" }, mine, ME).state).toBe("other");
});

test("the helper refuses a daemon that isn't the registered one before it reads or touches anything", async () => {
  for (const state of ["other", "unregistered", "unchecked"] as const) {
    const code = state === "unchecked" ? "busy" : "refused"; // a check that couldn't run now: asked again, not "another Walkie"
    for (const argv of [["destroy", "3"], ["destroy", "3", "idle"], ["create", "4"]]) {
      const sys = only({ caller: () => ME, seatInstance: () => ({ state, why: `not the registered Walkie (${state})` }) });
      const { code: exit, answer } = await admin(argv, sys);
      expect(exit).toBe(1);
      expect(answer).toEqual({ ok: false, code, scope: state, why: `not the registered Walkie (${state})` });
    }
    // `pending` (the doctor's and setup's probe): whether the ledger reads, never what it holds.
    const listed = only({ caller: () => ME, seatInstance: () => ({ state, why: "no" }), pendingReadOnly: () => ({ ids: [5, 6, 7], summary: { homes: 0, vaults: 0, knownBytes: 0 } }) });
    expect((await admin(["pending"], listed)).answer).toEqual({ ok: false, code, scope: state, why: "no", ledger: "ok" });
    const broken = only({ caller: () => ME, seatInstance: () => ({ state, why: "no" }), pendingReadOnly: () => { throw new Error("database disk image is malformed"); } });
    expect((await admin(["pending"], broken)).answer).toEqual({ ok: false, code, scope: state, why: "no", ledger: "the helper's id ledger can't be read: database disk image is malformed" });
  }
  // A check that throws fails closed.
  const sys = only({ caller: () => ME, seatInstance: () => { throw new Error("ps failed"); } });
  expect((await admin(["destroy", "3"], sys)).answer).toMatchObject({ ok: false, code: "refused", scope: "other" });
});

test("a leftover is removed only while idle: `destroy <n> idle` refuses while any process of it runs", async () => {
  const dir = tmp();
  const sys = only({ caller: () => ME, seatInstance: () => ({ state: "registered" }), seatAdminLockPath: join(dir, "outer.lock"),
    talkieLockRoot: false, procs: (uid: number) => (uid === 600_003 ? [{ pid: 4242, stat: "S" }] : []) });
  const { code, answer } = await admin(["destroy", "3", "idle"], sys);
  expect(code).toBe(1);
  expect(answer).toMatchObject({ ok: false, code: "running", name: "walkie-s3", processesGone: false, why: expect.stringContaining("still has 1 running process") });
  // Unknown is not idle.
  const unsure = only({ caller: () => ME, seatInstance: () => ({ state: "registered" }), seatAdminLockPath: join(dir, "outer.lock"),
    talkieLockRoot: false, procs: () => { throw new Error("ps failed"); } });
  expect((await admin(["destroy", "3", "idle"], unsure)).answer).toMatchObject({ ok: false, why: expect.stringContaining("can't tell whether walkie-s3 still runs anything") });
  expect(parseAdminArgv(["destroy", "3", "idle"])).toEqual({ verb: "destroy", n: 3, idle: true });
  for (const bad of [["destroy", "3", "now"], ["create", "3", "idle"], ["pending", "idle"], ["destroy", "0", "idle"], ["destroy", "3", "idle", "x"]])
    expect(parseAdminArgv(bad)).toBeNull();
});

test("the real check: unregistered without a record, another person's record, a binding that fails", () => {
  const dir = tmp();
  const path = join(dir, "seat-instance");
  const socket = join(dir, "walkie.sock");
  const bound: string[] = [];
  const bind = (_owner: number, s: string) => { bound.push(s); return { pid: 1, start: "x" }; };
  expect(checkSeatInstance(ME, path, bind, false).state).toBe("unregistered");
  writeFileSync(path, seatRegistrationText(reg(socket, { uid: ME + 1, user: "kira" })));
  expect(checkSeatInstance(ME, path, bind, false)).toMatchObject({ state: "other", why: expect.stringContaining("kira's") });
  expect(bound).toEqual([]);
  writeFileSync(path, seatRegistrationText(reg(socket)));
  expect(checkSeatInstance(ME, path, bind, false)).toEqual({ state: "registered" });
  expect(bound).toEqual([socket]);
  expect(checkSeatInstance(ME, path, () => { throw new SeatCallerMismatch("the Walkie that asked doesn't hold the registered Walkie's socket"); }, false))
    .toMatchObject({ state: "other", why: expect.stringContaining("doesn't hold the registered Walkie's socket") });
  // ps or lsof failing for a moment is not "another Walkie": asked again later.
  expect(checkSeatInstance(ME, path, () => { throw new Error("the invoking daemon's process chain could not be checked"); }, false))
    .toMatchObject({ state: "unchecked", why: expect.stringContaining("couldn't check which Walkie asked right now") });
  writeFileSync(path, "{");
  expect(checkSeatInstance(ME, path, bind, false).state).toBe("other");
});

/** Hold `socket` as a daemon does: its instance lock first, then the listening socket. */
function holdDaemonSocket(socket: string): () => void {
  const lock = acquireInstanceLock(socket);
  const server = Bun.listen({ unix: socket, socket: { data() { /* nothing */ } } });
  return () => { server.stop(true); lock.release(); };
}

async function fixture(args: string[]): Promise<{ ok: boolean; pid?: number; why?: string }> {
  const child = Bun.spawn([process.execPath, FIXTURE, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited).toBe(0);
  if (!out.trim()) throw new Error(`no answer from the fixture: ${err}`);
  return JSON.parse(out) as { ok: boolean; pid?: number; why?: string };
}

test("root's binding, for real: the daemon that ran the helper must itself hold the registered socket's instance lock", async () => {
  const dir = tmp();
  const registered = join(dir, "real", "walkie.sock");
  const fresh = join(dir, "fresh", "walkie.sock");
  mkdirSync(join(dir, "real"));
  mkdirSync(join(dir, "fresh"));
  const release = holdDaemonSocket(registered);
  try {
    // This test process is the registered daemon: its helper child is answered.
    expect(await fixture(["check", String(ME), registered])).toEqual({ ok: true, pid: process.pid });
    // A daemon whose home is elsewhere (it holds only its own socket): refused, though the registered one runs.
    const freshAnswer = await fixture(["nest", fresh, String(ME), registered]);
    expect(freshAnswer.ok).toBe(false);
    expect(freshAnswer.why).toContain("doesn't hold the registered Walkie's socket");
    // And the registered socket nobody here holds: refused.
    const elsewhere = join(dir, "fresh", "other.sock");
    const releaseOther = holdDaemonSocket(elsewhere);
    releaseOther();
    expect((await fixture(["check", String(ME), elsewhere])).ok).toBe(false);
  } finally { release(); }
}, 30_000);

test("setup-user records the Walkie before it copies the helper; the doctor's own probe still counts as answered", () => {
  const p = seatUserPlan({
    platform: "linux", daemonUser: "arvid", source: "/usr/local/bin/walkie", groupId: 0, walkieHome: "/home/arvid/.walkie",
    sudoersTmp: "/tmp/x/walkie-seats", home: "/home/arvid", homeProblem: null, runtimes: {}, instanceTmp: "/tmp/x/seat-instance", instanceHome: "/home/arvid/.walkie",
  });
  const argv = p.steps.map((s) => s.argv.join(" "));
  const record = argv.indexOf(`install -m 0644 -o root -g root /tmp/x/seat-instance ${SEAT_INSTANCE_FILE}`);
  expect(record).toBeGreaterThan(-1);
  expect(record).toBeLessThan(argv.indexOf(`install -m 0755 -o root -g root /usr/local/bin/walkie ${DEFAULT_ADMIN}`));
  expect(p.steps[record]?.what).toContain("/home/arvid/.walkie");
  // The sudo rules are unchanged: `destroy *` already covers `destroy <n> idle`, `pending` takes nothing.
  expect(p.sudoers).toContain(`${DEFAULT_ADMIN} seat-admin destroy *, ${DEFAULT_ADMIN} seat-admin pending,`);
  expect(seatOwnerProblem("arvid", () => "kira\n")).toContain(SEAT_INSTANCE_FILE);
  expect(pendingProbeProblem(JSON.stringify({ ok: true, ids: [] }))).toBeNull();
  expect(pendingProbeProblem(JSON.stringify({ ok: false, code: "refused", scope: "other", why: "x", ledger: "ok" }))).toBeNull();
  expect(pendingProbeProblem(JSON.stringify({ ok: false, code: "busy", scope: "unchecked", why: "x", ledger: "ok" }))).toBeNull();
  expect(pendingProbeProblem(JSON.stringify({ ok: false, code: "refused", scope: "unregistered", why: "x", ledger: "the helper's id ledger can't be read: locked" })))
    .toBe("the helper's id ledger can't be read: locked");
  expect(pendingProbeProblem(JSON.stringify({ ok: false, code: "refused", why: "the helper's id ledger can't be read" }))).toBe("no answer");
  expect(pendingProbeProblem("sudo: a password is required")).toBe("no answer");
});

test("the doctor names a record of another Walkie as a failure and a missing one as a warning", () => {
  const facts = { team: "t", release: false, runnerProblem: null, helper: "ok", rootsFile: "ok", runtimes: { claude: "/c", codex: "/x" } };
  const base = { allow: true, ephemeral: true, channel_ok: true, claude_login: "machine", codex_login: "machine" };
  const other = doctorChecks({ ...base, seat_scope: { state: "other", why: "seat users on this machine are managed by another Walkie (x)" } } as SeatsLocalView, facts);
  expect(other.find((c) => c.what.includes("managed by another Walkie"))?.ok).toBe(false);
  const legacy = doctorChecks({ ...base, seat_scope: { state: "legacy", why: LEGACY_SCOPE_WHY } } as SeatsLocalView, facts);
  expect(legacy.find((c) => c.what === LEGACY_SCOPE_WHY)?.ok).toBe("warn");
  expect(doctorChecks(base as SeatsLocalView, facts).some((c) => c.what.includes("another Walkie") || c.what === LEGACY_SCOPE_WHY)).toBe(false);
  const left = doctorChecks({ ...base, seat_scope: { state: "legacy", why: LEGACY_SCOPE_WHY }, foreign_users: ["walkie-s6", "walkie-s7"],
    leftovers_running: ["walkie-s3"] } as SeatsLocalView, facts);
  const foreign = left.find((c) => c.what.startsWith("2 seat users here aren't this Walkie's to remove (walkie-s6, walkie-s7)"));
  expect(foreign?.ok).toBe("warn");
  expect(foreign?.fix).toContain("setup-user --apply, then restart");
  const running = left.find((c) => c.what.startsWith("walkie-s3 is a leftover seat user that still runs processes"));
  expect(running?.fix).toBe("to end them now: sudo pkill -KILL -u walkie-s3 (Walkie removes the user at its next retry)");
});

test("fdinfo: only a lock taken through that very open file, by the asking process, counts; never a waiter or a global line", () => {
  const info = (...locks: string[]) => ["pos:\t0", "flags:\t02400001", "mnt_id:\t36", "ino:\t524619", ...locks, ""].join("\n");
  expect(fdHoldsFlock(1111, info("lock:\t1: FLOCK  ADVISORY  WRITE 1111 103:02:524619 0 EOF"))).toBe(true);
  expect(fdHoldsFlock(1111, info())).toBe(false); // the file open, the lock held through another open file
  expect(fdHoldsFlock(2222, info("lock:\t1: FLOCK  ADVISORY  WRITE 1111 103:02:524619 0 EOF"))).toBe(false); // taken by another process
  expect(fdHoldsFlock(2222, info("lock:\t1: -> FLOCK  ADVISORY  WRITE 2222 103:02:524619 0 EOF"))).toBe(false); // waiting for it
  expect(fdHoldsFlock(3333, info("lock:\t1: FLOCK  ADVISORY  READ  3333 103:02:524619 0 EOF"))).toBe(false); // not exclusive
  expect(fdHoldsFlock(4242, info("lock:\t1: POSIX  ADVISORY  WRITE 4242 103:02:524619 0 EOF"))).toBe(false); // not a flock
  // A /proc/locks-style line (the same inode on another device, in the review's probe) is not this file's lock.
  expect(fdHoldsFlock(1111, info("1: FLOCK  ADVISORY  WRITE 1111 00:2a:524619 0 EOF"))).toBe(false);
});

// Linux only: there root checks that the lock is taken by the very process it asks about (/proc/<pid>/fdinfo). macOS can't
// name a flock's holder, so a process that merely has the lock file open while the registered daemon holds the lock passes
// there (admin-sys.ts holdsSeatInstanceLock; SECURITY.md threat 16, "Remote seats"). WALK-106 adds a listening-socket check for macOS.
test.skipIf(process.platform === "darwin")("root's binding, for real: a second daemon that merely has the registered lock file open is refused", async () => {
  const dir = tmp();
  const registered = join(dir, "real", "walkie.sock");
  mkdirSync(join(dir, "real"));
  const release = holdDaemonSocket(registered);
  try {
    const answer = await fixture(["nest", join(dir, "fresh", "walkie.sock"), String(ME), registered, "open"]);
    expect(answer.ok).toBe(false);
    expect(answer.why).toContain("doesn't hold the registered Walkie's socket");
  } finally { release(); }
}, 30_000);

/** instanceLockHeld in a child, killed after 5 s: a hang (a FIFO opened) shows as a timeout, never a stuck test. */
async function held(args: string[]): Promise<{ held?: boolean; error?: string; timedOut?: true }> {
  const child = Bun.spawn([process.execPath, FIXTURE, "held", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  const out = await new Response(child.stdout).text();
  const code = await child.exited;
  clearTimeout(timer);
  if (code !== 0) return { timedOut: true };
  return JSON.parse(out) as { held?: boolean; error?: string };
}

test("the lock check root runs never follows a link, never waits on a FIFO, and counts only the inode found open", async () => {
  const dir = tmp();
  const socket = join(dir, "walkie.sock");
  const lock = acquireInstanceLock(socket);
  const lockPath = `${socket}.lock`;
  try {
    const st = lstatSync(lockPath);
    expect(await held([lockPath, String(st.dev), String(st.ino)])).toEqual({ held: true });
    // Another regular file at the path (the inode root saw open is gone from it): not held.
    renameSync(lockPath, join(dir, "genuine"));
    writeFileSync(lockPath, "");
    expect(await held([lockPath, String(st.dev), String(st.ino)])).toEqual({ held: false });
    // A symlink swapped in (to a FIFO, which a plain open would wait on forever): refused at once.
    rmSync(lockPath);
    Bun.spawnSync(["mkfifo", join(dir, "fifo")]);
    symlinkSync(join(dir, "fifo"), lockPath);
    expect(await held([lockPath, String(st.dev), String(st.ino)])).toEqual({ error: "ELOOP" });
    // The FIFO itself renamed onto the path: opened without waiting, and not a regular file.
    rmSync(lockPath);
    renameSync(join(dir, "fifo"), lockPath);
    expect(await held([lockPath, String(st.dev), String(st.ino)])).toEqual({ held: false });
  } finally { lock.release(); }
}, 30_000);

test("the daemon's instance lock is close-on-exec: nothing it starts inherits it", () => {
  if (process.platform !== "linux") return; // /proc is Linux's
  const dir = tmp();
  const socket = join(dir, "walkie.sock");
  const lock = acquireInstanceLock(socket);
  try {
    const fds = readdirSync("/proc/self/fd").filter((fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`) === `${socket}.lock`; } catch { return false; } });
    expect(fds.length).toBe(1);
    const flags = Number.parseInt(/flags:\s*(\d+)/.exec(readFileSync(`/proc/self/fdinfo/${fds[0]}`, "utf8"))?.[1] ?? "0", 8);
    expect(flags & 0o2000000).toBe(0o2000000);
  } finally { lock.release(); }
});

test("root reads the WalkieTalkie daemon's executable only as the inode it checked, never through a link or a FIFO", () => {
  const dir = tmp();
  const exe = join(dir, "walkie");
  writeFileSync(exe, "binary");
  const st = lstatSync(exe);
  expect(readRegularNoFollow(exe, st.dev, st.ino).toString()).toBe("binary");
  renameSync(exe, join(dir, "walkie.old"));
  symlinkSync(join(dir, "walkie.old"), exe);
  expect(() => readRegularNoFollow(exe, st.dev, st.ino)).toThrow();
  rmSync(exe);
  writeFileSync(exe, "another");
  expect(() => readRegularNoFollow(exe, st.dev, st.ino)).toThrow("changed during inspection");
  rmSync(exe);
  Bun.spawnSync(["mkfifo", exe]);
  expect(() => readRegularNoFollow(exe, st.dev, st.ino)).toThrow("changed during inspection");
});
