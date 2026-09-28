// SEATS-FIX-5 (docs/audits/2026-09-26-*-seats-r5.md): ephemeral seat users. The root helper's REAL logic (admin.ts:
// its argv grammar, create's id rules and verification, destroy's kill/remove/verify) run over a fake system
// (test/helpers/fake-seat-users.ts: tests can't create OS users; Opus r5 LOW 3); scheduler files parsed as cron does
// (Codex r5 MEDIUM 4); administrative groups that can't be read fail closed (Codex r5 MEDIUM 6); the setup plan.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSeatUser, destroySeatUser, parseAdminArgv, runSeatAdmin, seatUserName } from "../../src/daemon/seats/admin.ts";
import { seatUserCheck } from "../../src/daemon/seats/isolation.ts";
import { schedulerProblem, seatUserPlan } from "../../src/daemon/seats/seat-user.ts";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function world() {
  const root = mkdtempSync("/tmp/walkie-fix5-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return fakeSeatWorld(root, join(root, "walkie-home"));
}

describe("the helper's grammar (the sudo rule allows exactly this)", () => {
  test("create|destroy and a positive integer, nothing else", () => {
    expect(parseAdminArgv(["create", "7"])).toEqual({ verb: "create", n: 7 });
    expect(parseAdminArgv(["destroy", "99999"])).toEqual({ verb: "destroy", n: 99_999 });
    for (const bad of [[], ["create"], ["create", "0"], ["create", "07"], ["create", "100000"], ["create", "7", "x"], ["create", "-1"],
      ["create", "7;rm"], ["delete", "7"], ["create", " 7"], ["create", "1e3"]]) {
      expect(parseAdminArgv(bad)).toBeNull();
    }
  });

  test("it refuses to run as anyone but root", async () => {
    const w = world();
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
    try { expect(await runSeatAdmin(["create", "1"], w.sys)).toBe(1); } finally { process.stdout.write = write; }
    expect(out.join("")).toContain("runs as root (through sudo) only");
    expect(w.created).toEqual([]);
  });
});

describe("create: a fresh user, never an id used before (Codex r5 HIGH 1-2, Opus r5 HIGH 1)", () => {
  test("its own uid and group, a 0700 home without ACL, the marker, denied cron and at; ids only go up", async () => {
    const w = world();
    const a = await createSeatUser(1, w.sys);
    expect(a).toMatchObject({ ok: true, name: "walkie-s1", uid: 600_001 });
    expect(readdirSync(join(w.homes, "walkie-s1")).sort()).toEqual([".walkie-seat-home", "walkie-seats"]);
    expect(schedulerProblem(["walkie-s1"], w.schedulerFiles, (p) => w.sys.readSchedulerFile(p))).toBeNull();
    // Never again, even after it is destroyed, and never below the high-water mark.
    expect((await destroySeatUser(1, w.sys)).ok).toBe(true);
    expect(await createSeatUser(1, w.sys)).toMatchObject({ ok: false, code: "used", why: expect.stringMatching(/not above every seat user id ever used/) });
    expect((await createSeatUser(3, w.sys)).ok).toBe(true);
    expect(await createSeatUser(2, w.sys)).toMatchObject({ ok: false, high: 3 });
  });

  test("a name or id that exists already is refused (recorded as used all the same)", async () => {
    const w = world();
    w.users.set("walkie-s5", { uid: 600_005, gid: 600_005, gids: [600_005] });
    expect(await createSeatUser(5, w.sys)).toMatchObject({ ok: false, why: expect.stringMatching(/exists already/) });
    expect(await createSeatUser(6, w.sys)).toMatchObject({ ok: true });
  });
});

describe("destroy: everything of the user, verified (Codex r5 HIGH 1-2, MEDIUM 5; Opus r5 HIGH 1-2)", () => {
  test("a SIGTERM-ignoring respawner, a forker, and its files outside the home all go; the user and home are gone", async () => {
    const w = world();
    await createSeatUser(1, w.sys);
    const marker = w.markers.get("walkie-s1") as string;
    const env = { PATH: "/usr/bin:/bin", WALKIE_SEAT_FAKE_UID: marker };
    const stubborn = `process.on("SIGTERM", () => Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)"], { stdout: "ignore", stderr: "ignore" })); setInterval(() => {}, 1000);`;
    const forker = `setInterval(() => Bun.spawn([process.execPath, "-e", "setTimeout(()=>{},30000)"], { stdout: "ignore", stderr: "ignore" }), 20);`;
    const a = Bun.spawn([process.execPath, "-e", stubborn], { env, stdout: "ignore", stderr: "ignore", detached: true });
    const b = Bun.spawn([process.execPath, "-e", forker], { env, stdout: "ignore", stderr: "ignore", detached: true });
    cleanups.push(() => { for (const p of [a.pid, b.pid]) try { process.kill(p, "SIGKILL"); } catch { /* gone */ } });
    // What it leaves outside its home (the per-uid /var/folders/…/T, /var/tmp …): a copied login among them.
    writeFileSync(join(w.outside, `${marker}-copied-credentials.json`), '{"claudeAiOauth":{}}');
    writeFileSync(join(w.outside, "someone-elses-file"), "keep");
    await Bun.sleep(600);
    expect(w.sys.procs(600_001).length).toBeGreaterThan(2);
    const r = await destroySeatUser(1, w.sys);
    expect(r).toEqual({ ok: true, name: "walkie-s1", uid: 600_001 });
    expect(w.sys.procs(600_001)).toEqual([]);
    expect(alive(a.pid) || alive(b.pid)).toBe(false);
    expect(readdirSync(w.outside)).toEqual(["someone-elses-file"]);
    expect(existsSync(join(w.homes, "walkie-s1"))).toBe(false);
    expect(w.users.has("walkie-s1")).toBe(false);
  });

  test("what it can't verify is reported (never 'done'), and only users this helper made are destroyed", async () => {
    const w = world();
    await createSeatUser(1, w.sys);
    writeFileSync(join(w.outside, `${w.markers.get("walkie-s1")}-left`), "x");
    w.broken.add("destroy-files");
    const r = await destroySeatUser(1, w.sys);
    expect(r.ok).toBe(false);
    expect(r.left?.[0]).toMatch(/^files it owns remain or couldn't be checked/);
    expect(w.users.has("walkie-s1")).toBe(true); // the account is kept until its files are verified gone
    w.broken.delete("destroy-files");
    expect((await destroySeatUser(1, w.sys)).ok).toBe(true); // the retry
    expect(await destroySeatUser(9, w.sys)).toMatchObject({ ok: false, why: expect.stringMatching(/never made by this helper/) });
  });
});

describe("scheduler files as cron parses them (Codex r5 MEDIUM 4)", () => {
  test("an entry with a trailing space or a CR is ambiguous: refused, never read as denied", () => {
    const d = mkdtempSync("/tmp/walkie-cron5-");
    cleanups.push(() => rmSync(d, { recursive: true, force: true }));
    const files = { cron: [join(d, "cron.allow"), join(d, "cron.deny")] as [string, string], at: [join(d, "at.allow"), join(d, "at.deny")] as [string, string] };
    const read = (p: string) => (existsSync(p) ? Bun.spawnSync(["cat", p], { stdout: "pipe" }).stdout.toString() : null);
    writeFileSync(files.at[1], "walkie-s1\n");
    writeFileSync(files.cron[1], "walkie-s1 \n");
    expect(schedulerProblem(["walkie-s1"], files, read)).toMatch(/extra spaces or a CR/);
    writeFileSync(files.cron[1], "walkie-s1\r\n");
    expect(schedulerProblem(["walkie-s1"], files, read)).toMatch(/extra spaces or a CR/);
    writeFileSync(files.cron[1], "walkie-s1\n");
    expect(schedulerProblem(["walkie-s1"], files, read)).toBeNull();
  });
});

describe("the new user checked by the daemon (Codex r5 MEDIUM 6)", () => {
  const deps = { daemonUid: 501, daemonGid: 20, adminGids: [80], seatsGid: 599_999, schedulerFiles: { cron: ["/nx/a", "/nx/d"] as [string, string], at: ["/nx/a2", "/nx/d2"] as [string, string] } };
  test("administrative groups that couldn't be read block it; its uid, groups and schedulers are checked", () => {
    const u = { name: "walkie-s4", uid: 600_004, gid: 600_004, groups: ["walkie-s4", "walkie-seats"], gids: [600_004, 599_999] };
    const denied = (p: string) => (p.endsWith("d") || p.endsWith("d2") ? "walkie-s4\n" : null);
    expect(seatUserCheck(u, "walkie-s4", 4, { ...deps, readFile: denied })).toBeNull();
    expect(seatUserCheck(u, "walkie-s4", 4, { ...deps, adminGids: null, readFile: denied })).toMatch(/can't tell which groups are administrative/);
    expect(seatUserCheck({ ...u, uid: 501 }, "walkie-s4", 4, { ...deps, readFile: denied })).toMatch(/uid 501, not 600004/);
    expect(seatUserCheck({ ...u, gids: [600_004, 599_999, 80] }, "walkie-s4", 4, { ...deps, readFile: denied })).toMatch(/administrative/);
    expect(seatUserCheck(u, "walkie-s4", 4, { ...deps, readFile: () => null })).toMatch(/may schedule jobs with cron/);
    expect(seatUserName(4)).toBe("walkie-s4");
  });
});

describe("the setup plan: the group, the runner and the helper, two sudo rules", () => {
  test("root-owned copies; the runner as the seats' group only; the helper's two verbs as root only", () => {
    const p = seatUserPlan({
      platform: "darwin", daemonUser: "arvid", source: "/usr/local/bin/walkie", groupId: 590_001, walkieHome: "/Users/arvid/.walkie",
      sudoersTmp: "/tmp/x/walkie-seats", home: "/Users/arvid", homeProblem: null, runtimes: { claude: "/opt/claude", codex: null },
    });
    const argv = p.steps.map((s) => s.argv.join(" "));
    expect(argv).toContain("dscl . -create /Groups/walkie-seats PrimaryGroupID 590001");
    expect(argv).toContain("install -m 0755 -o root -g wheel /usr/local/bin/walkie /usr/local/libexec/walkie/walkie-seat-runner");
    expect(argv).toContain("install -m 0755 -o root -g wheel /usr/local/bin/walkie /usr/local/libexec/walkie/walkie-seat-admin");
    expect(argv).toContain("visudo -c -f /etc/sudoers.d/walkie-seats");
    expect(p.sudoers).toContain("arvid ALL=(%walkie-seats) NOPASSWD: /usr/local/libexec/walkie/walkie-seat-runner seat-runner\n");
    expect(p.sudoers).toContain("arvid ALL=(root) NOPASSWD: /usr/local/libexec/walkie/walkie-seat-admin seat-admin create *, /usr/local/libexec/walkie/walkie-seat-admin seat-admin destroy *, /usr/local/libexec/walkie/walkie-seat-admin seat-admin pending\n");
    expect(p.sudoers).not.toMatch(/NOPASSWD: ALL/);
    expect(p.skippedRuntimes).toEqual(["codex"]);
  });
});
