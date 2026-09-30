// SEATS-FIX-6 (docs/audits/2026-09-26-*-seats-r6.md), unit level: the seat user's own descriptor-relative sweep on
// real files (Codex r6 CRITICAL 1, HIGH 2), the ledger under two real helper processes (Codex r6 HIGH 3, Opus r6 HIGH
// 1), destroy stages that can run again after partial progress (Codex r6 MEDIUM 5), the real adapter's inspections
// (Codex r6 MEDIUM 6), the sweep's roots (Opus r6 MEDIUM 2), what sudo is spawned with and the build flags (Opus r6
// LOW 3), and the CLI's login and quarantine lines (Codex r6 LOW 9, MEDIUM 8).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loginLines, quarantineLines } from "../../src/cli/commands/seats.ts";
import { createSeatUser, destroySeatUser, removeEmptyHome, type AdminSys } from "../../src/daemon/seats/admin.ts";
import { Ledger } from "../../src/daemon/seats/admin-ledger.ts";
import { realAdminSys } from "../../src/daemon/seats/admin-sys.ts";
import { selfTest } from "../../src/daemon/seats/fsat.ts";
import { adminCall } from "../../src/daemon/seats/runner-child.ts";
import { fakeOwned, realRoots, sweepOp } from "../../src/daemon/seats/runner-sweep.ts";
import { sweepVerified } from "../../src/daemon/seats/sweep.ts";
import type { SeatsLocalView } from "../../src/protocol/seats.ts";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
function tmp(prefix = "walkie-fix6-"): string {
  const d = mkdtempSync(`/tmp/${prefix}`);
  cleanups.push(() => { try { Bun.spawnSync(["chmod", "-R", "u+rwx", d]); } catch { /* */ } rmSync(d, { recursive: true, force: true }); });
  return d;
}
const me = process.getuid?.() ?? -1;
const stripAnsi = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "");
/** The fake seat user of these tests: entries named `seat-…` (and inside them) are its, `other-…` never. */
const owned = fakeOwned("seat", me);

describe("the seat user's own sweep (Codex r6 CRITICAL 1, HIGH 2)", () => {
  test("this platform's layouts check out against node:fs", () => {
    expect(selfTest()).toBeNull();
  });

  test("a directory named with a newline and the victim's path under it: only the seat's own entries go", () => {
    const t = tmp();
    const root = join(t, "tmp");
    const victim = join(t, "victim");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "keep"), "the person's");
    // The old root parse (find -print split on "\n") turned this one name into `…/seat-probe` and the victim's path
    // and each of its ancestors, all rmSync'd recursively as root.
    const deep = join(root, "seat-probe\n", ...victim.split("/").filter(Boolean));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "inside"), "the seat's");
    symlinkSync(victim, join(root, "seat-link")); // its own link to the victim: the link goes, never what it names
    writeFileSync(join(root, "other-file"), "someone else's");
    const r = sweepVerified([{ path: root }], owned);
    expect(r).toMatchObject({ verified: true, left: [], problems: [] });
    expect(readdirSync(root)).toEqual(["other-file"]);
    expect(readFileSync(join(victim, "keep"), "utf8")).toBe("the person's");
  });

  test("an ancestor swapped for a symlink between listing and entering is never followed", () => {
    const t = tmp();
    const root = join(t, "tmp");
    const victim = join(t, "victim");
    mkdirSync(join(root, "seat-dir"), { recursive: true });
    writeFileSync(join(root, "seat-dir", "seat-file"), "x");
    mkdirSync(victim);
    writeFileSync(join(victim, "seat-looks-mine"), "named like the seat's, but the person's directory"); // owned by name
    let swapped = false;
    const r = sweepVerified([{ path: root }], owned, {
      beforeOpen: (p) => {
        if (swapped || !p.endsWith("/seat-dir")) return;
        swapped = true;
        renameSync(join(root, "seat-dir"), join(t, "moved-away"));
        symlinkSync(victim, join(root, "seat-dir"));
      },
    });
    expect(swapped).toBe(true);
    expect(existsSync(join(victim, "seat-looks-mine"))).toBe(true);
    expect(readdirSync(root)).toEqual([]); // the link itself was the seat's: removed on the verifying pass
    expect(r.verified).toBe(true);
  });

  test("another owner's entry inside the seat's directory keeps it: reported, never verified", () => {
    const t = tmp();
    const root = join(t, "tmp");
    mkdirSync(join(root, "seat-shared"), { recursive: true });
    writeFileSync(join(root, "seat-shared", "other-kept"), "not the seat's");
    writeFileSync(join(root, "seat-shared", "mine"), "the seat's");
    const r = sweepVerified([{ path: root }], owned);
    expect(r.verified).toBe(false);
    expect(r.left).toEqual([`${root}/seat-shared (holds entries of others)`]);
    expect(readdirSync(join(root, "seat-shared"))).toEqual(["other-kept"]);
  });

  test("the seat's own unreadable directory is opened up and emptied (it can't hide from its sweep)", () => {
    const t = tmp();
    const root = join(t, "tmp");
    mkdirSync(join(root, "seat-hidden", "deeper"), { recursive: true });
    writeFileSync(join(root, "seat-hidden", "deeper", "f"), "x");
    chmodSync(join(root, "seat-hidden", "deeper"), 0o000);
    chmodSync(join(root, "seat-hidden"), 0o000);
    expect(sweepVerified([{ path: root }], owned).verified).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  });

  test("never as root; in a source build only inside a test's fake scope", () => {
    expect(() => sweepOp("/nonexistent", {})).toThrow(/runs only as a seat user/);
  });

  test("Opus r6 MEDIUM 2: the macOS roots include /Users/Shared, /Library/Caches and its own per-user folder", () => {
    const roots = realRoots("/Users/walkie-s1", 600_001).roots.map((r) => r.path);
    if (process.platform === "darwin") {
      expect(roots).toEqual(expect.arrayContaining(["/private/tmp", "/private/var/tmp", "/Users/Shared", "/Library/Caches", "/Users/walkie-s1"]));
      expect(roots.some((p) => /^\/private\/var\/folders\/[^/]+\/[^/]+$/.test(p))).toBe(true);
    } else {
      expect(roots).toEqual(expect.arrayContaining(["/tmp", "/var/tmp", "/dev/shm", "/Users/walkie-s1"]));
    }
  });
});

describe("the ledger (Codex r6 HIGH 3, Opus r6 HIGH 1)", () => {
  test("two real helper processes racing: no id twice, every id made is recorded, the mark never goes down", async () => {
    const root = tmp();
    const script = join(import.meta.dir, "..", "helpers", "ledger-race.ts");
    const procs = [0, 1].map(() => Bun.spawn([process.execPath, script, root, "25"], { stdout: "pipe", stderr: "pipe" }));
    const outs = await Promise.all(procs.map(async (p) => {
      const [text] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      return JSON.parse(text.trim()) as { made: number[]; used: number[]; other: unknown[] };
    }));
    const [a, b] = outs as [typeof outs[0], typeof outs[0]];
    expect(a.other).toEqual([]);
    expect(b.other).toEqual([]);
    expect(a.made.filter((n) => b.made.includes(n))).toEqual([]); // never both
    const all = [...a.made, ...b.made].sort((x, y) => x - y);
    expect(all.length).toBeGreaterThan(0);
    const ledger = new Ledger(join(root, "seat-admin.sqlite"));
    try {
      for (const n of all) expect(ledger.state(n)).toBe("created"); // each one destroyable later
      expect(ledger.high()).toBe(Math.max(...ledger.used()));
      expect(ledger.used()).toEqual(all); // nothing reserved but not made (no id was refused after its reservation)
    } finally { ledger.close(); }
    // One home per id made, and the deny files hold every one of them exactly once (edited under the lock).
    expect(readdirSync(join(root, "seat-users")).sort()).toEqual(all.map((n) => `walkie-s${n}`).sort());
    const deny = readFileSync(join(root, "cron.deny"), "utf8").trim().split("\n").sort();
    expect(deny).toEqual(all.map((n) => `walkie-s${n}`).sort());
  }, 60_000);

  test("Codex r6's interleaving: create 2, destroy 2, then create 1 and create 2 are both refused", async () => {
    const w = fakeSeatWorld(tmp(), "/nonexistent-walkie-home");
    expect((await createSeatUser(2, w.sys)).ok).toBe(true);
    expect((await destroySeatUser(2, w.sys)).ok).toBe(true);
    expect(await createSeatUser(1, w.sys)).toMatchObject({ ok: false, code: "used", high: 2 });
    expect(await createSeatUser(2, w.sys)).toMatchObject({ ok: false, code: "used", high: 2 });
    expect(w.sys.ledger().high()).toBe(2);
  });

  test("an id whose name exists already is recorded but nothing is made, and destroy leaves that user alone", async () => {
    const w = fakeSeatWorld(tmp(), "/nonexistent-walkie-home");
    w.users.set("walkie-s3", { uid: 600_003, gid: 600_003, gids: [600_003] });
    expect(await createSeatUser(3, w.sys)).toMatchObject({ ok: false, code: "used" });
    expect(w.sys.ledger().state(3)).toBe("cancelled"); // nothing was made, and nothing ever will be for it
    expect((await destroySeatUser(3, w.sys)).ok).toBe(true);
    expect(w.users.has("walkie-s3")).toBe(true);
    expect(w.destroyed).toEqual([]);
  });
});

describe("destroy after partial progress (Codex r6 MEDIUM 5)", () => {
  test("services failing: nothing past them is done (the account stays); fixed, a retry finishes and verifies", async () => {
    const w = fakeSeatWorld(tmp(), "/nonexistent-walkie-home");
    await createSeatUser(1, w.sys);
    w.broken.add("services");
    const sys: AdminSys = { ...w.sys, dropClaudeProjection: async () => false };
    const r = await destroySeatUser(1, sys);
    expect(r.ok).toBe(false);
    expect(r.left?.[0]).toMatch(/^services:/);
    expect(w.users.has("walkie-s1")).toBe(true);
    expect(w.sweeps).toHaveLength(1); // projection cleanup failed; general sweep still runs
    w.broken.delete("services");
    expect((await destroySeatUser(1, w.sys)).ok).toBe(true);
    expect(w.users.has("walkie-s1")).toBe(false);
    expect(w.sys.ledger().state(1)).toBe("destroyed");
  });

  test("the account already deleted (a crash before the answer): the retry verifies, with spool checks by name and uid only", async () => {
    const w = fakeSeatWorld(tmp(), "/nonexistent-walkie-home");
    await createSeatUser(1, w.sys);
    const calls: boolean[] = [];
    const sys: AdminSys = { ...w.sys, removeSchedules: (name, uid, exists) => { calls.push(exists); return w.sys.removeSchedules(name, uid, exists); } };
    let lost = true;
    const once: AdminSys = { ...sys, idTaken: (id) => { if (lost && !w.users.has("walkie-s1")) { lost = false; throw new Error("killed"); } return w.sys.idTaken(id); } };
    const first = await destroySeatUser(1, once);
    expect(first.ok).toBe(false); // the account went, the verification didn't answer
    expect(w.users.has("walkie-s1")).toBe(false);
    calls.length = 0;
    const sweeps = w.sweeps.length;
    expect((await destroySeatUser(1, sys)).ok).toBe(true);
    expect(calls.every((e) => e === false)).toBe(true); // no crontab -u for a deleted account
    expect(w.sweeps.length).toBe(sweeps); // its files were verified before the account went
  });

  test("its home is removed only as an empty directory of its user (root's marker aside), never a link", () => {
    const t = tmp();
    const home = join(t, "walkie-s1");
    mkdirSync(home);
    writeFileSync(join(home, ".walkie-seat-home"), "");
    writeFileSync(join(home, "left"), "x");
    const sys = { stat: (p: string) => { const w = realAdminSys().stat(p); return w && { ...w, uid: p === home ? 600_001 : p.endsWith(".walkie-seat-home") ? 0 : w.uid }; } };
    expect(removeEmptyHome(home, 600_001, sys)).toMatch(/still holds 1 entry/);
    rmSync(join(home, "left"));
    expect(removeEmptyHome(home, 600_002, sys)).toMatch(/not the seat user's/);
    expect(removeEmptyHome(home, 600_001, sys)).toBeNull();
    expect(existsSync(home)).toBe(false);
    symlinkSync(t, home);
    expect(removeEmptyHome(home, 600_001, sys)).toMatch(/not a directory/);
    expect(existsSync(t)).toBe(true);
  });
});

describe("the real adapter's inspections (Codex r6 MEDIUM 6)", () => {
  test("absent only when verified absent; an unreadable path throws", () => {
    const sys = realAdminSys();
    expect(sys.stat("/nonexistent-walkie-path")).toBeNull();
    const t = tmp();
    mkdirSync(join(t, "closed"));
    writeFileSync(join(t, "closed", "f"), "x");
    chmodSync(join(t, "closed"), 0o000);
    expect(() => sys.stat(join(t, "closed", "f"))).toThrow(/EACCES/);
    expect(sys.nameTaken("walkie-no-such-user-xyz")).toBe(false);
    expect(sys.nameTaken("root")).toBe(true);
    expect(sys.lookup("walkie-no-such-user-xyz")).toBeNull();
  });
});

describe("what the helper and runner start with (Opus r6 LOW 3)", () => {
  test("sudo is spawned from / with a fixed environment", async () => {
    const r = await adminCall(["/bin/sh", "-c", 'printf \'{"ok":true,"why":"%s|%s|%s"}\\n\' "$(pwd)" "${HOME-}" "${WALKIE_HOME-}"']);
    expect(r?.why).toBe("/||");
  });

  test("the release binary never autoloads bunfig.toml, .env, tsconfig or package.json", () => {
    const build = readFileSync(join(import.meta.dir, "..", "..", "scripts", "build.ts"), "utf8");
    for (const f of ["--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv", "--no-compile-autoload-tsconfig", "--no-compile-autoload-package-json"]) {
      expect(build).toContain(f);
    }
  });
});

describe("the CLI (Codex r6 LOW 9, MEDIUM 8)", () => {
  const base = { allow: false, claude_login: "machine", quarantined: ["walkie-s7"] } as unknown as SeatsLocalView;
  test("an unavailable login is never described as the machine's", () => {
    const text = loginLines({ ...base, claude_login: "unavailable" }).map(stripAnsi).join("\n");
    expect(text).toMatch(/can't start here yet: this machine has no usable Claude access token/);
    expect(text).not.toMatch(/run on this machine's own Claude login/);
  });
  test("quarantined seat users are shown with seats off", () => {
    expect(quarantineLines(base).map(stripAnsi)[0]).toContain("walkie-s7");
  });
});
