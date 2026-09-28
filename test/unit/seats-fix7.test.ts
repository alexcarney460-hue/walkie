// SEATS-FIX-7 (docs/audits/2026-09-26-*-seats-r7.md), unit level: a create and a destroy of the same id never run at
// once, across real processes (Codex r7 HIGH 1); a destroy stops where a process survives SIGKILL (Codex r7 MEDIUM
// 2); an interrupted home creation is recovered (Codex r7 MEDIUM 4); the seat's mounts and the world-writable
// directories setup found (Opus r7 4, 6); the sweep clears the owner's own flags and ACLs and keeps nothing else
// (Opus r7 1, 2), walks only where the seat could have written and limits only its own subtree (Opus r7 3); a
// failing getconf is a problem (Codex r7 MEDIUM 5); no chmod through a symlink (Codex r7 LOW 7); durable writes
// (Opus r7 INFO 9); the CLI's texts (Codex r7 LOW 8, Opus r7 7).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirtyText, quarantineLines } from "../../src/cli/commands/seats.ts";
import { createSeatUser, destroySeatUser, removeUnusedHome, type AdminSys } from "../../src/daemon/seats/admin.ts";
import { Ledger, processStart } from "../../src/daemon/seats/admin-ledger.ts";
import { AT_FDCWD, chmodAt, closeFd, openDirAt, userMounts, writeDurably } from "../../src/daemon/seats/fsat.ts";
import { darwinUserFolder, fakeOwned } from "../../src/daemon/seats/runner-sweep.ts";
import { worldWritableDirs } from "../../src/daemon/seats/seat-user.ts";
import { sweepVerified } from "../../src/daemon/seats/sweep.ts";
import type { SeatsLocalView } from "../../src/protocol/seats.ts";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";

const mac = process.platform === "darwin";
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
function tmp(parent = "/tmp"): string {
  const d = mkdtempSync(join(parent, "walkie-fix7-"));
  cleanups.push(() => {
    if (mac) Bun.spawnSync(["chflags", "-R", "nouchg,nouappnd", d]);
    Bun.spawnSync(["chmod", "-R", "u+rwx", d]);
    if (mac) Bun.spawnSync(["chmod", "-R", "-N", d]);
    rmSync(d, { recursive: true, force: true });
  });
  return d;
}
const me = process.getuid?.() ?? -1;
const owned = fakeOwned("seat", me);
const plain = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "");
const HELPER = join(import.meta.dir, "..", "helpers", "ledger-op.ts");
const run = (args: string[]) => Bun.spawn([process.execPath, HELPER, ...args], { stdout: "pipe", stderr: "pipe" });
const answer = async (p: ReturnType<typeof run>) => JSON.parse((await new Response(p.stdout).text()).trim()) as Record<string, unknown>;

describe("one operation per id (Codex r7 HIGH 1)", () => {
  test("a destroy started during a create waits for it, then destroys what it made", async () => {
    const db = join(tmp(), "ledger.sqlite");
    new Ledger(db).close();
    const create = run(["create", db, "5", "1500"]);
    await Bun.sleep(400);
    const destroy = run(["destroy", db, "5"]);
    const [c, d] = await Promise.all([answer(create), answer(destroy)]);
    expect(c).toMatchObject({ reserved: true, advanced: true });
    expect(d.takenAt as number).toBeGreaterThanOrEqual(c.doneAt as number);
    expect(d).toMatchObject({ saw: "created", final: "destroyed" }); // never "nothing was made" while it was being made
  }, 30_000);

  test("Codex r7's interleaving: a destroy while the create holds a reserved id is busy; once that create is gone, the id is cancelled and can never be made", async () => {
    const t = tmp();
    const db = join(t, "ledger.sqlite");
    new Ledger(db).close();
    const create = run(["create", db, "7", "60000"]);
    const ledger = new Ledger(db);
    cleanups.push(() => ledger.close());
    for (let i = 0; i < 100 && ledger.state(7) !== "reserved"; i++) await Bun.sleep(50);
    const w = fakeSeatWorld(t, "/nonexistent-walkie-home");
    const sys: AdminSys = { ...w.sys, ledger: () => ledger, busyWaitMs: 300 };
    expect(await destroySeatUser(7, sys)).toMatchObject({ ok: false, code: "busy" });
    expect(ledger.state(7)).toBe("reserved");
    create.kill("SIGKILL"); // exactly the process this test started
    await create.exited;
    expect((await destroySeatUser(7, sys)).ok).toBe(true);
    expect(ledger.state(7)).toBe("cancelled");
    const dead = { pid: create.pid, start: "gone" };
    expect(ledger.advance(7, dead, "reserved", "making")).toBe(false);
  }, 30_000);

  test("only the person whose daemon made a seat user may destroy it or see it pending", async () => {
    const w = fakeSeatWorld(tmp(), "/nonexistent-walkie-home");
    expect((await createSeatUser(1, w.sys)).ok).toBe(true);
    const other: AdminSys = { ...w.sys, caller: () => me + 1 };
    expect(await destroySeatUser(1, other)).toMatchObject({ ok: false, why: expect.stringMatching(/not a seat user of this person's/) });
    expect(w.sys.ledger().pending(me + 1)).toEqual([]);
    expect(w.sys.ledger().pending(me)).toEqual([1]);
    expect((await destroySeatUser(1, w.sys)).ok).toBe(true);
    expect(w.sys.ledger().pending(me)).toEqual([]);
  });
});

describe("destroy stops where it can't verify (Codex r7 MEDIUM 2, 4; Opus r7 4, 6)", () => {
  test("a process surviving SIGKILL stops the destroy before the sweep: the account and home stay, quarantined", async () => {
    const w = fakeSeatWorld(tmp(), "/nonexistent-walkie-home");
    await createSeatUser(1, w.sys);
    const sys: AdminSys = { ...w.sys, procs: () => [{ pid: 999_999_9, stat: "S" }], signal: () => undefined, killWaitMs: 200 };
    const r = await destroySeatUser(1, sys);
    expect(r.ok).toBe(false);
    expect(r.left?.join(" ")).toMatch(/survived SIGKILL/);
    expect(w.sweeps).toEqual([]);
    expect(w.users.has("walkie-s1")).toBe(true);
    expect(existsSync(join(w.homes, "walkie-s1"))).toBe(true);
    expect((await destroySeatUser(1, w.sys)).ok).toBe(true); // once they are gone
  });

  test("a home never handed to its user (creation interrupted) is recovered from what setup makes, nothing else", async () => {
    const w = fakeSeatWorld(tmp(), "/nonexistent-walkie-home");
    const home = join(w.homes, "walkie-s1");
    const sys: AdminSys = {
      ...w.sys,
      // Everything still root's: the chowns never ran.
      makeHome: (h, uid) => { w.sys.makeHome(h, uid); w.rootOwned.add(h).add(join(h, "walkie-seats")); throw new Error("power lost before the chown"); },
    };
    const r = await createSeatUser(1, sys);
    expect(r).toMatchObject({ ok: false, code: "failed" });
    expect(existsSync(home)).toBe(false);
    expect(w.users.has("walkie-s1")).toBe(false);
    // Anything setup didn't make is never removed by root.
    mkdirSync(join(w.homes, "walkie-s9"));
    writeFileSync(join(w.homes, "walkie-s9", "not-setups"), "x");
    w.rootOwned.add(join(w.homes, "walkie-s9"));
    expect(removeUnusedHome(join(w.homes, "walkie-s9"), 600_009, w.sys)).toMatch(/holds "not-setups", which setup didn't make/);
    expect(existsSync(join(w.homes, "walkie-s9", "not-setups"))).toBe(true);
  });

  test("its mounts are force-unmounted before the sweep; one that won't go keeps the account", async () => {
    const w = fakeSeatWorld(tmp(), "/nonexistent-walkie-home");
    await createSeatUser(1, w.sys);
    w.mounts.add("/Volumes/its-disk-image");
    w.broken.add("unmount");
    const r = await destroySeatUser(1, w.sys);
    expect(r.left?.join(" ")).toMatch(/mounts of it remain: \/Volumes\/its-disk-image/);
    expect(w.sweeps).toEqual([]);
    expect(w.users.has("walkie-s1")).toBe(true);
    w.broken.delete("unmount");
    expect((await destroySeatUser(1, w.sys)).ok).toBe(true);
    expect(w.unmounted).toEqual(["/Volumes/its-disk-image"]);
  });

  test("the world-writable directories setup found are swept too; without their list nothing is deleted", async () => {
    const t = tmp();
    const w = fakeSeatWorld(t, "/nonexistent-walkie-home");
    const reporter = join(t, "DiagnosticsReporter");
    mkdirSync(reporter, { mode: 0o777 });
    w.extraRoots.push(reporter);
    await createSeatUser(1, w.sys);
    writeFileSync(join(reporter, `${w.markers.get("walkie-s1")}-report`), "the seat's");
    writeFileSync(join(reporter, "someone-elses"), "not the seat's");
    w.broken.add("roots");
    expect((await destroySeatUser(1, w.sys)).left?.join(" ")).toMatch(/seat-roots\.json is missing/);
    expect(w.users.has("walkie-s1")).toBe(true);
    w.broken.delete("roots");
    expect((await destroySeatUser(1, w.sys)).ok).toBe(true);
    expect(readdirSync(reporter)).toEqual(["someone-elses"]);
  });

  test("the real mount table is read (statfs owners)", () => {
    expect(userMounts(600_001)).toEqual([]);
    if (mac) expect(userMounts(0)).toContain("/");
  });
});

describe.if(mac)("the owner's own protections (Opus r7 1, 2)", () => {
  test("uchg files and directories, a deny-delete ACL and a uchg home are cleared and removed; nothing is kept", () => {
    const t = tmp();
    const root = join(t, "tmp");
    const home = join(t, "home");
    mkdirSync(join(root, "seat-locked-dir"), { recursive: true });
    writeFileSync(join(root, "seat-locked-dir", "inside"), "x");
    writeFileSync(join(root, "seat-locked-file"), "x");
    writeFileSync(join(root, "seat-acl-file"), "x");
    mkdirSync(join(root, "seat-empty-locked"));
    mkdirSync(join(home, "stuff"), { recursive: true });
    writeFileSync(join(home, "stuff", "f"), "x");
    const sh = (...a: string[]) => expect(Bun.spawnSync(a).exitCode).toBe(0);
    sh("chflags", "uchg", join(root, "seat-locked-dir", "inside"), join(root, "seat-locked-dir"), join(root, "seat-locked-file"), join(root, "seat-empty-locked"));
    sh("chmod", "+a", "everyone deny delete", join(root, "seat-acl-file"));
    sh("chflags", "uchg", home);
    const r = sweepVerified([{ path: root }, { path: home, owned: true }], owned);
    expect(r).toMatchObject({ verified: true, left: [], problems: [] });
    expect(readdirSync(root)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  });

  test("another owner's locked entry in the seat's directory: reported as another's, not verified", () => {
    const t = tmp();
    const root = join(t, "tmp");
    mkdirSync(join(root, "seat-dir"), { recursive: true });
    writeFileSync(join(root, "seat-dir", "other-locked"), "x");
    Bun.spawnSync(["chflags", "uchg", join(root, "seat-dir", "other-locked")]);
    const r = sweepVerified([{ path: root }], owned);
    expect(r.verified).toBe(false);
    expect(r.left).toEqual([`${root}/seat-dir (holds entries of others)`]);
  });
});

describe("where the sweep walks (Opus r7 3)", () => {
  test("another owner's tree it can't write is not walked, however deep or big; its own deep tree is not verified", () => {
    const t = tmp();
    const root = join(t, "tmp");
    let deep = join(root, "other-deep");
    for (let i = 0; i < 12; i++) deep = join(deep, `d${i}`);
    mkdirSync(deep, { recursive: true });
    for (let i = 0; i < 30; i++) writeFileSync(join(root, "other-deep", `f${i}`), "x");
    chmodSync(join(root, "other-deep"), 0o555);
    writeFileSync(join(root, "seat-mine"), "x");
    expect(sweepVerified([{ path: root }], owned, { maxDepth: 5, maxEntries: 10 })).toMatchObject({ verified: true, left: [] });
    chmodSync(join(root, "other-deep"), 0o755); // writable: walked, its depth only reported
    const again = sweepVerified([{ path: root }], owned, { maxDepth: 5, maxEntries: 10 });
    expect(again.verified).toBe(true);
    expect(again.notes.join(" ")).toMatch(/another owner's tree deeper than 5, not walked/);
    let mine = join(root, "seat-deep");
    for (let i = 0; i < 12; i++) mine = join(mine, `d${i}`);
    mkdirSync(mine, { recursive: true });
    const own = sweepVerified([{ path: root }], owned, { maxDepth: 5 });
    expect(own.verified).toBe(false);
    expect(own.problems.join(" ")).toMatch(/its own tree is deeper than 5/);
  });

  test("setup finds world-writable directories (two levels, no links), outside what every sweep covers", () => {
    const t = tmp(join(import.meta.dir, ".."));
    mkdirSync(join(t, "ww"));
    chmodSync(join(t, "ww"), 0o777);
    mkdirSync(join(t, "a", "ww2"), { recursive: true });
    chmodSync(join(t, "a", "ww2"), 0o1777);
    mkdirSync(join(t, "a", "b", "too-deep"), { recursive: true });
    chmodSync(join(t, "a", "b", "too-deep"), 0o777);
    symlinkSync(join(t, "ww"), join(t, "link"));
    expect(worldWritableDirs([t])).toEqual([join(t, "a", "ww2"), join(t, "ww")]);
  });

  test("Codex r7 MEDIUM 5: a getconf that fails or says something unexpected is a problem, never a folder left out", () => {
    expect(darwinUserFolder(() => ({ exitCode: 1, stdout: "" }))).toMatchObject({ problem: expect.stringMatching(/couldn't be found/) });
    expect(darwinUserFolder(() => ({ exitCode: 0, stdout: "/somewhere/else/\n" }))).toMatchObject({ problem: expect.any(String) });
    expect(darwinUserFolder(() => ({ exitCode: 0, stdout: "/var/folders/ab/xyz123/0/\n" }))).toEqual({ folder: "/private/var/folders/ab/xyz123" });
  });
});

describe("links, durability, texts", () => {
  test("Codex r7 LOW 7: chmod of an entry never goes through a symlink", () => {
    const t = tmp();
    mkdirSync(join(t, "target"));
    chmodSync(join(t, "target"), 0o755);
    symlinkSync(join(t, "target"), join(t, "link"));
    const fd = openDirAt(AT_FDCWD(), t);
    try { try { chmodAt(fd, Buffer.from("link"), 0o700); } catch { /* refused: fine */ } } finally { closeFd(fd); }
    expect(statSync(join(t, "target")).mode & 0o777).toBe(0o755);
  });

  test("Opus r7 INFO 9 / Codex r7 MEDIUM 3: a durable write replaces the file whole, leaves no temporary file, and keeps its mode", () => {
    const t = tmp();
    const f = join(t, "seats.json");
    writeFileSync(f, "old");
    writeDurably(f, "new\n", 0o600);
    expect(readFileSync(f, "utf8")).toBe("new\n");
    expect(lstatSync(f).mode & 0o777).toBe(0o600);
    expect(readdirSync(t)).toEqual(["seats.json"]);
  });

  test("Codex r7 LOW 8 / Opus r7 7: discarded work, and why a seat user is quarantined with what to do", () => {
    expect(dirtyText({ dirty: 2, dir: "~walkie-s4/walkie-seats/x" })).toMatch(/discarded with its seat user/);
    expect(dirtyText({ dirty: 2, dir: "~/walkie-seats/x" })).toMatch(/left in ~\/walkie-seats\/x/);
    const l = { quarantined: ["walkie-s4"], quarantine_why: { "walkie-s4": "processes (before anything else): 1 process of it survived SIGKILL for 10 s" } } as unknown as SeatsLocalView;
    const text = quarantineLines(l).map(plain).join("\n");
    expect(text).toContain("walkie-s4: processes (before anything else): 1 process of it survived SIGKILL");
    expect(text).toContain("https://github.com/alexcarney460-hue/walkie/blob/main/docs/INSTALL.md#8-remote-seats-optional");
  });

  test("a process's identity is its pid and start time", () => {
    expect(processStart(process.pid)).toBeTruthy();
    const gone = Bun.spawnSync(["/usr/bin/true"]).pid; // exited and reaped
    expect(processStart(gone)).toBeNull();
    expect(() => processStart(999_999_9)).toThrow(/failed/); // ps can't tell (a pid out of range): never "gone"
  });
});
