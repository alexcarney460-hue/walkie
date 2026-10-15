import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CRON_SOURCE_TABS, CRON_TABS, realAdminSys, removeSeatSchedules, removeSpoolCrontab } from "../../src/daemon/seats/admin-sys.ts";

const temps: string[] = [];
const seatUid = (process.getuid?.() ?? 0) + 10_000;
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

for (const platform of ["linux", "darwin"] as const) {
  test(`${platform}: cronie's missing-spool error cannot block cleanup because crontab is never called`, () => {
    const root = mkdtempSync("/tmp/walkie-cron-missing-");
    temps.push(root);
    const tabs = platform === "linux" ? [join(root, "cron", "crontabs"), join(root, "cron")] : [join(root, "usr", "lib", "cron", "tabs"), join(root, "var", "at", "tabs")];
    for (const dir of tabs) mkdirSync(dir, { recursive: true });
    const stderr = "Could not find environment variable XDG_CACHE_HOME or HOME to save the backup / /var/spool/cron/walkie-s1: No such file";
    const fakeCronie = spyOn(Bun, "spawnSync").mockImplementation(() => ({
      exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr),
    } as unknown as ReturnType<typeof Bun.spawnSync>));
    try {
      expect(removeSeatSchedules("walkie-s1", seatUid, true, tabs, [])).toBeNull();
      expect(fakeCronie).not.toHaveBeenCalled();
    } finally { fakeCronie.mockRestore(); }
  });

  test(`${platform}: missing crontab and empty fake spools verify no schedules`, () => {
    const root = mkdtempSync("/tmp/walkie-cron-missing-");
    temps.push(root);
    const tabs = platform === "linux" ? [join(root, "cron", "crontabs"), join(root, "cron")] : [join(root, "usr", "lib", "cron", "tabs"), join(root, "var", "at", "tabs")];
    for (const dir of tabs) mkdirSync(dir, { recursive: true });
    expect(removeSeatSchedules("walkie-s1", seatUid, true, tabs, [])).toBeNull();
  });

  test(`${platform}: every known spool location is removed directly and verified`, () => {
    const root = mkdtempSync("/tmp/walkie-cron-missing-");
    temps.push(root);
    const tabs = platform === "linux" ? [join(root, "cron", "crontabs"), join(root, "cron")] : [join(root, "usr", "lib", "cron", "tabs"), join(root, "var", "at", "tabs")];
    for (const dir of tabs) mkdirSync(dir, { recursive: true });
    for (const dir of tabs) writeFileSync(join(dir, "walkie-s1"), "* * * * * /tmp/job\n");
    expect(removeSeatSchedules("walkie-s1", seatUid, true, tabs, [])).toBeNull();
    for (const dir of tabs) expect(existsSync(join(dir, "walkie-s1"))).toBe(false);
  });

  test(`${platform}: failed direct spool removal and a deleted account's spool remain quarantined`, () => {
    const root = mkdtempSync("/tmp/walkie-cron-missing-");
    temps.push(root);
    const tabs = [join(root, "tabs")];
    mkdirSync(join(tabs[0]!, "walkie-s1"), { recursive: true });
    expect(removeSeatSchedules("walkie-s1", seatUid, true, tabs, [])).toContain("is a directory, not a crontab");
    expect(removeSeatSchedules("walkie-s1", seatUid, false, tabs, [])).toContain("scheduled jobs of it remain");
  });

  test(`${platform}: a symlink spool entry is refused without following its target`, () => {
    const root = mkdtempSync("/tmp/walkie-cron-missing-");
    temps.push(root);
    const tabs = [join(root, "tabs")];
    mkdirSync(tabs[0]!);
    const target = join(root, "target");
    writeFileSync(target, "keep\n");
    symlinkSync(target, join(tabs[0]!, "walkie-s1"));
    expect(removeSeatSchedules("walkie-s1", seatUid, true, tabs, [])).toContain("is a symbolic link, not a crontab");
    expect(existsSync(join(tabs[0]!, "walkie-s1"))).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("keep\n");
  });
}

test("post-check catches a spool entry owned by the seat uid under another name", () => {
  const root = mkdtempSync("/tmp/walkie-cron-missing-");
  temps.push(root);
  const tabs = [join(root, "tabs")];
  mkdirSync(tabs[0]!);
  const leftover = join(tabs[0]!, "renamed-tab");
  writeFileSync(leftover, "keep\n");
  expect(removeSeatSchedules("walkie-s1", process.getuid!(), true, tabs, [])).toContain(leftover);
});

// WALK-118: the Linux layouts beyond Debian/RHEL cron. SUSE's cronie keeps `<user>` in /var/spool/cron/tabs; fcron keeps
// the compiled `<user>` and its source text `<user>.orig` in /var/spool/fcron.
describe("Linux SUSE and fcron spool layouts", () => {
  /** A fake machine with the real Linux layout's shape: the dirs `CRON_TABS.linux` names, rooted in a temp dir. */
  function layout() {
    const root = mkdtempSync("/tmp/walkie-cron-layouts-");
    temps.push(root);
    const at = (p: string) => join(root, p.slice(1));
    const tabs = CRON_TABS.linux.map(at);
    const sources = CRON_SOURCE_TABS.linux.map(at);
    for (const dir of new Set([...tabs, ...sources])) mkdirSync(dir, { recursive: true });
    return { root, at, tabs, sources, suse: at("/var/spool/cron/tabs"), fcron: at("/var/spool/fcron") };
  }

  test("the Linux list names SUSE's tabs and fcron's spool; macOS keeps its own", () => {
    expect(CRON_TABS.linux).toEqual(["/var/spool/cron/crontabs", "/var/spool/cron", "/var/spool/cron/tabs", "/var/spool/fcron"]);
    expect(CRON_SOURCE_TABS.linux).toEqual(["/var/spool/fcron"]);
    expect(CRON_TABS.darwin).toEqual(["/usr/lib/cron/tabs", "/var/at/tabs"]);
    expect(CRON_SOURCE_TABS.darwin).toEqual([]);
  });

  test("SUSE: the tab in /var/spool/cron/tabs is removed and a neighbor with a longer name is kept", () => {
    const l = layout();
    writeFileSync(join(l.suse, "walkie-s1"), "* * * * * /tmp/job\n");
    writeFileSync(join(l.suse, "walkie-s10"), "keep\n");
    expect(removeSeatSchedules("walkie-s1", seatUid, true, l.tabs, [], l.sources)).toBeNull();
    expect(existsSync(join(l.suse, "walkie-s1"))).toBe(false);
    expect(readFileSync(join(l.suse, "walkie-s10"), "utf8")).toBe("keep\n");
  });

  test("fcron: the compiled tab and its .orig source are both removed; other users' files stay", () => {
    const l = layout();
    for (const f of ["walkie-s1", "walkie-s1.orig"]) writeFileSync(join(l.fcron, f), "x\n");
    for (const f of ["walkie-s10", "walkie-s10.orig", "root", "root.orig", "systab"]) writeFileSync(join(l.fcron, f), "keep\n");
    expect(removeSeatSchedules("walkie-s1", seatUid, true, l.tabs, [], l.sources)).toBeNull();
    expect(existsSync(join(l.fcron, "walkie-s1"))).toBe(false);
    expect(existsSync(join(l.fcron, "walkie-s1.orig"))).toBe(false);
    for (const f of ["walkie-s10", "walkie-s10.orig", "root", "root.orig", "systab"]) expect(readFileSync(join(l.fcron, f), "utf8")).toBe("keep\n");
  });

  test("fcron: only the .orig is there (the compiled tab was already gone): it is removed", () => {
    const l = layout();
    writeFileSync(join(l.fcron, "walkie-s1.orig"), "* * * * * /tmp/job\n");
    expect(removeSeatSchedules("walkie-s1", seatUid, true, l.tabs, [], l.sources)).toBeNull();
    expect(existsSync(join(l.fcron, "walkie-s1.orig"))).toBe(false);
  });

  test("a .orig is looked for only where fcron keeps it, not beside the other cron spools", () => {
    const l = layout();
    const stray = join(l.suse, "walkie-s1.orig");
    writeFileSync(stray, "keep\n");
    expect(removeSeatSchedules("walkie-s1", seatUid, true, l.tabs, [], l.sources)).toBeNull();
    expect(readFileSync(stray, "utf8")).toBe("keep\n");
  });

  test("absent SUSE and fcron directories are fine, and the old call shape (no source dirs) still works", () => {
    const root = mkdtempSync("/tmp/walkie-cron-layouts-");
    temps.push(root);
    const tabs = [join(root, "nope", "tabs"), join(root, "nope", "fcron")];
    const sources = [join(root, "nope", "fcron")];
    expect(removeSpoolCrontab("walkie-s1", tabs, sources)).toBeNull();
    expect(removeSeatSchedules("walkie-s1", seatUid, true, tabs, [], sources)).toBeNull();
    expect(removeSeatSchedules("walkie-s1", seatUid, true, tabs, [])).toBeNull();
  });

  test("fcron: a symlinked compiled tab or .orig is refused without following it, and is reported", () => {
    for (const entry of ["walkie-s1", "walkie-s1.orig"]) {
      const l = layout();
      const target = join(l.root, "target");
      writeFileSync(target, "keep\n");
      symlinkSync(target, join(l.fcron, entry));
      expect(removeSeatSchedules("walkie-s1", seatUid, true, l.tabs, [], l.sources)).toContain(`${join(l.fcron, entry)} is a symbolic link, not a crontab`);
      expect(existsSync(join(l.fcron, entry))).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("keep\n");
    }
  });

  test("SUSE: a symlinked tab is refused without following it", () => {
    const l = layout();
    const target = join(l.root, "target");
    writeFileSync(target, "keep\n");
    symlinkSync(target, join(l.suse, "walkie-s1"));
    expect(removeSeatSchedules("walkie-s1", seatUid, true, l.tabs, [], l.sources)).toContain("is a symbolic link, not a crontab");
    expect(readFileSync(target, "utf8")).toBe("keep\n");
  });

  test("fcron: a .orig that is a directory is refused and left", () => {
    const l = layout();
    mkdirSync(join(l.fcron, "walkie-s1.orig", "inner"), { recursive: true });
    expect(removeSeatSchedules("walkie-s1", seatUid, true, l.tabs, [], l.sources)).toContain("walkie-s1.orig is a directory, not a crontab");
    expect(existsSync(join(l.fcron, "walkie-s1.orig", "inner"))).toBe(true);
  });

  test("a tab of a deleted account (exists=false) in a new location is not touched, and is reported as remaining", () => {
    const l = layout();
    for (const p of [join(l.suse, "walkie-s1"), join(l.fcron, "walkie-s1"), join(l.fcron, "walkie-s1.orig"), join(l.fcron, "new.walkie-s1")]) {
      writeFileSync(p, "x\n");
      const why = removeSeatSchedules("walkie-s1", seatUid, false, l.tabs, [], l.sources);
      expect(why).toContain("scheduled jobs of it remain");
      expect(why).toContain(p);
      expect(existsSync(p)).toBe(true);
      rmSync(p);
    }
  });

  test("only what is attributable to the seat goes: by its exact name, or reported when its uid owns another entry", () => {
    const l = layout();
    // These files are owned by the test's own uid. Seat uid != that uid: nothing here is the seat's but its named tabs.
    for (const f of ["walkie-s1", "new.walkie-s10", "walkie-s1.orig.bak", "walkie-s1.old"]) writeFileSync(join(l.fcron, f), "x\n");
    expect(removeSeatSchedules("walkie-s1", seatUid, true, l.tabs, [], l.sources)).toBeNull();
    expect(existsSync(join(l.fcron, "walkie-s1"))).toBe(false);
    for (const f of ["new.walkie-s10", "walkie-s1.orig.bak", "walkie-s1.old"]) expect(existsSync(join(l.fcron, f))).toBe(true);
    // Same files, but now the seat's uid is the one that owns them: the named tab goes, the strays are reported, none removed.
    writeFileSync(join(l.fcron, "walkie-s1"), "x\n");
    const why = removeSeatSchedules("walkie-s1", process.getuid!(), true, l.tabs, [], l.sources);
    expect(why).toContain("scheduled jobs of it remain");
    expect(why).toContain(join(l.fcron, "new.walkie-s10"));
    expect(existsSync(join(l.fcron, "new.walkie-s10"))).toBe(true);
    expect(existsSync(join(l.fcron, "walkie-s1"))).toBe(false);
  });
  // WALK-118 review M1: fcrontab writes the pending tab `new.<user>` into fcron's spool (owned by the user, or by fcron).
  test("fcron: the pending tab new.<name> is removed whoever owns it, and cleanup then reports clean", () => {
    // Seat-owned: the seat's uid is the test's own uid, so a leftover would also be found by the owner sweep. Only
    // fcron's directory is swept (the fake layout's other directories are themselves owned by this uid).
    const owned = layout();
    for (const f of ["walkie-s1", "walkie-s1.orig", "new.walkie-s1"]) writeFileSync(join(owned.fcron, f), "x\n");
    expect(removeSeatSchedules("walkie-s1", process.getuid!(), true, [owned.fcron], [], owned.sources)).toBeNull();
    for (const f of ["walkie-s1", "walkie-s1.orig", "new.walkie-s1"]) expect(existsSync(join(owned.fcron, f))).toBe(false);
    // Other-owned (fcron's own uid, here a uid that is not the seat's): attributed by its exact name.
    const other = layout();
    writeFileSync(join(other.fcron, "new.walkie-s1"), "x\n");
    for (const f of ["new.walkie-s10", "new.root"]) writeFileSync(join(other.fcron, f), "keep\n");
    expect(removeSeatSchedules("walkie-s1", seatUid, true, other.tabs, [], other.sources)).toBeNull();
    expect(existsSync(join(other.fcron, "new.walkie-s1"))).toBe(false);
    for (const f of ["new.walkie-s10", "new.root"]) expect(readFileSync(join(other.fcron, f), "utf8")).toBe("keep\n");
  });

  test("fcron: only the pending tab is there: it is removed", () => {
    const l = layout();
    writeFileSync(join(l.fcron, "new.walkie-s1"), "* * * * * /tmp/job\n");
    expect(removeSpoolCrontab("walkie-s1", l.tabs, l.sources)).toBeNull();
    expect(existsSync(join(l.fcron, "new.walkie-s1"))).toBe(false);
  });

  test("fcron: a pending tab that is a symlink or a directory is refused and left, and is reported", () => {
    for (const kind of ["symlink", "directory"] as const) {
      const l = layout();
      const entry = join(l.fcron, "new.walkie-s1");
      const target = join(l.root, "target");
      writeFileSync(target, "keep\n");
      if (kind === "symlink") symlinkSync(target, entry);
      else mkdirSync(join(entry, "inner"), { recursive: true });
      const why = removeSeatSchedules("walkie-s1", seatUid, true, l.tabs, [], l.sources);
      expect(why).toContain(`${entry} is a ${kind === "symlink" ? "symbolic link" : "directory"}, not a crontab`);
      expect(existsSync(entry)).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("keep\n");
      if (kind === "directory") expect(existsSync(join(entry, "inner"))).toBe(true);
    }
  });

  test("new.<name> is the seat's tab only in fcron's spool: beside the other cron spools it is just another file", () => {
    for (const dir of ["/var/spool/cron/crontabs", "/var/spool/cron", "/var/spool/cron/tabs"]) {
      const l = layout();
      const stray = join(l.at(dir), "new.walkie-s1");
      writeFileSync(stray, "keep\n");
      expect(removeSeatSchedules("walkie-s1", seatUid, true, l.tabs, [], l.sources)).toBeNull();
      expect(readFileSync(stray, "utf8")).toBe("keep\n");
      // Owned by the seat's uid, a stray is still found by the owner sweep, and still not removed.
      expect(removeSeatSchedules("walkie-s1", process.getuid!(), true, l.tabs, [], l.sources)).toContain(stray);
      expect(existsSync(stray)).toBe(true);
    }
  });

  test("another user's tab named new.<x> beside the cron spools is left alone, and such a name is not a helper user", () => {
    const l = layout();
    const tab = join(l.suse, "new.something");
    writeFileSync(tab, "keep\n");
    expect(removeSeatSchedules("walkie-s1", seatUid, true, l.tabs, [], l.sources)).toBeNull();
    expect(readFileSync(tab, "utf8")).toBe("keep\n");
    for (const name of ["something", "new.something"]) expect(() => removeSeatSchedules(name, seatUid, false, l.tabs, [], [])).toThrow(/not a user this helper made/);
  });

  // WALK-118 review S3: one refused entry no longer stops the other layouts' tabs from being removed.
  test("a symlink in crontabs/ does not stop the SUSE and fcron tabs from being removed, and is still reported", () => {
    const l = layout();
    const link = join(l.at("/var/spool/cron/crontabs"), "walkie-s1");
    const target = join(l.root, "target");
    writeFileSync(target, "keep\n");
    symlinkSync(target, link);
    const gone = [join(l.suse, "walkie-s1"), join(l.fcron, "walkie-s1"), join(l.fcron, "walkie-s1.orig"), join(l.fcron, "new.walkie-s1"), join(l.at("/var/spool/cron"), "walkie-s1")];
    for (const f of gone) writeFileSync(f, "x\n");
    const why = removeSeatSchedules("walkie-s1", seatUid, true, l.tabs, [], l.sources);
    expect(why).toContain(`${link} is a symbolic link, not a crontab`);
    expect(existsSync(link)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("keep\n");
    for (const f of gone) expect(existsSync(f)).toBe(false);
  });

  test("every refused entry is reported, not only the first", () => {
    const l = layout();
    const link = join(l.suse, "walkie-s1");
    const dir = join(l.fcron, "walkie-s1.orig");
    symlinkSync(join(l.root, "nowhere"), link);
    mkdirSync(dir);
    const why = removeSpoolCrontab("walkie-s1", l.tabs, l.sources);
    expect(why).toContain(`${link} is a symbolic link, not a crontab`);
    expect(why).toContain(`${dir} is a directory, not a crontab`);
  });

  // WALK-118 review L1: only the helper's own users have a spool tab it removes; anything else throws before any fs call.
  test("a name that is not a seat user or the WalkieTalkie user is refused before any filesystem call", () => {
    const root = mkdtempSync("/tmp/walkie-cron-names-");
    temps.push(root);
    const tabs = [join(root, "tabs")];
    mkdirSync(tabs[0]!);
    const victim = join(root, "victim");
    writeFileSync(victim, "keep\n");
    const calls = [spyOn(fs, "lstatSync"), spyOn(fs, "unlinkSync"), spyOn(fs, "readdirSync")];
    try {
      for (const bad of ["../victim", "root", "", "walkie-s0", "walkie-s", "walkie-s01", "walkie-s100000", "walkie-sx", "walkie-s1/../x", "walkie-talkie2", "Walkie-s1"]) {
        expect(() => removeSpoolCrontab(bad, tabs, tabs)).toThrow(/not a user this helper made/);
        // WALK-118 round 3 (L-d): the same through the entry point, with the account present or already gone.
        for (const exists of [true, false]) expect(() => removeSeatSchedules(bad, seatUid, exists, tabs, tabs, tabs)).toThrow(/not a user this helper made/);
      }
      for (const c of calls) expect(c).not.toHaveBeenCalled();
    } finally { for (const c of calls) c.mockRestore(); }
    expect(readFileSync(victim, "utf8")).toBe("keep\n");
  });

  test("the seat users' names and the WalkieTalkie user are accepted", () => {
    const l = layout();
    for (const name of ["walkie-s1", "walkie-s99999", "walkie-talkie"]) {
      writeFileSync(join(l.suse, name), "x\n");
      expect(removeSpoolCrontab(name, l.tabs, l.sources)).toBeNull();
      expect(existsSync(join(l.suse, name))).toBe(false);
    }
  });

  // WALK-118 review S1: the production wiring picks the platform's spool lists. A temp spool root stands in for `/`.
  describe("the helper's own removeSchedules", () => {
    const seed = (at: (p: string) => string, paths: string[]) => paths.forEach((p) => { mkdirSync(join(at(p), ".."), { recursive: true }); writeFileSync(at(p), "x\n"); });

    test("linux: every layout's tab, fcron's .orig and fcron's pending tab go, through the real wiring", () => {
      const root = mkdtempSync("/tmp/walkie-cron-real-");
      temps.push(root);
      const at = (p: string) => join(root, p);
      const mine = ["/var/spool/cron/crontabs/walkie-s1", "/var/spool/cron/walkie-s1", "/var/spool/cron/tabs/walkie-s1", "/var/spool/fcron/walkie-s1", "/var/spool/fcron/walkie-s1.orig", "/var/spool/fcron/new.walkie-s1"];
      seed(at, [...mine, "/var/spool/fcron/walkie-s10", "/var/spool/fcron/new.walkie-s10"]);
      const sys = realAdminSys({ platform: "linux", spoolRoot: root });
      expect(sys.removeSchedules("walkie-s1", seatUid, true)).toBeNull();
      for (const p of mine) expect(existsSync(at(p))).toBe(false);
      for (const p of ["/var/spool/fcron/walkie-s10", "/var/spool/fcron/new.walkie-s10"]) expect(existsSync(at(p))).toBe(true);
    });

    test("linux: after the account is gone, a tab of it left in any layout is reported", () => {
      const root = mkdtempSync("/tmp/walkie-cron-real-");
      temps.push(root);
      const at = (p: string) => join(root, p);
      seed(at, ["/var/spool/fcron/walkie-s1.orig"]);
      expect(realAdminSys({ platform: "linux", spoolRoot: root }).removeSchedules("walkie-s1", seatUid, false)).toContain(at("/var/spool/fcron/walkie-s1.orig"));
    });

    test("the at-job directories are re-rooted too, and a job owned by the seat's uid is reported (linux and darwin)", () => {
      for (const [platform, jobs] of [["linux", ["/var/spool/cron/atjobs/a0001", "/var/spool/at/a0002"]], ["darwin", ["/usr/lib/cron/jobs/j0001"]]] as const) {
        const root = mkdtempSync("/tmp/walkie-cron-real-");
        temps.push(root);
        const at = (p: string) => join(root, p);
        seed(at, [...jobs]);
        const why = realAdminSys({ platform, spoolRoot: root }).removeSchedules("walkie-s1", process.getuid!(), false);
        for (const j of jobs) expect(why).toContain(at(j));
      }
    });

    // The helper runs only the branch with no spoolRoot, so its absolute paths are pinned here without touching any disk:
    // every filesystem call the function makes is stubbed to find nothing, and unlinkSync is unreachable.
    test("with no seam override, it asks for exactly the real absolute spool paths and touches nothing", () => {
      const absent = () => { throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }); };
      const asked = (platform: "linux" | "darwin") => {
        const sys = realAdminSys({ platform });
        const dirs = [...CRON_TABS[platform], ...(platform === "linux"
          ? ["/var/spool/cron/atjobs", "/var/spool/at", "/var/spool/atjobs"] : ["/usr/lib/cron/jobs"])];
        const lstat = spyOn(fs, "lstatSync").mockImplementation(((p: string) => dirs.includes(String(p))
          ? { isDirectory: () => true, isFile: () => false } : absent()) as never);
        const open = spyOn(fs, "openSync").mockImplementation(absent as never);
        const readdir = spyOn(fs, "readdirSync").mockImplementation(absent as never);
        const unlink = spyOn(fs, "unlinkSync").mockImplementation(absent as never);
        try {
          const result = sys.removeSchedules("walkie-s1", seatUid, false);
          return { result, lstat: [...new Set(lstat.mock.calls.map((c) => String(c[0])))].sort(), readdir: readdir.mock.calls.map((c) => String(c[0])).sort(), unlinks: unlink.mock.calls.length };
        } finally { open.mockRestore(); lstat.mockRestore(); readdir.mockRestore(); unlink.mockRestore(); }
      };
      const linux = asked("linux");
      expect(linux.result).toBeNull();
      expect(linux.unlinks).toBe(0);
      expect(linux.lstat).toEqual([
        ...CRON_TABS.linux, "/var/spool/cron/atjobs", "/var/spool/at", "/var/spool/atjobs",
        "/var/spool/cron/crontabs/walkie-s1", "/var/spool/cron/walkie-s1", "/var/spool/cron/tabs/walkie-s1",
        "/var/spool/fcron/walkie-s1", "/var/spool/fcron/walkie-s1.orig", "/var/spool/fcron/new.walkie-s1",
      ].sort());
      expect(linux.readdir).toEqual([
        "/var/spool/cron/crontabs", "/var/spool/cron", "/var/spool/cron/tabs", "/var/spool/fcron", "/var/spool/cron/atjobs", "/var/spool/at", "/var/spool/atjobs",
      ].sort());
      const darwin = asked("darwin");
      expect(darwin.result).toBeNull();
      expect(darwin.unlinks).toBe(0);
      expect(darwin.lstat).toEqual([...CRON_TABS.darwin, "/usr/lib/cron/jobs", "/usr/lib/cron/tabs/walkie-s1", "/var/at/tabs/walkie-s1"].sort());
      expect(darwin.readdir).toEqual(["/usr/lib/cron/tabs", "/var/at/tabs", "/usr/lib/cron/jobs"].sort());
    });

    test("darwin: its own tab locations are used, and fcron's files are not looked for", () => {
      const root = mkdtempSync("/tmp/walkie-cron-real-");
      temps.push(root);
      const at = (p: string) => join(root, p);
      const mine = ["/usr/lib/cron/tabs/walkie-s1", "/var/at/tabs/walkie-s1"];
      const notMine = ["/var/spool/fcron/walkie-s1", "/var/spool/fcron/walkie-s1.orig"];
      seed(at, [...mine, ...notMine]);
      expect(realAdminSys({ platform: "darwin", spoolRoot: root }).removeSchedules("walkie-s1", seatUid, true)).toBeNull();
      for (const p of mine) expect(existsSync(at(p))).toBe(false);
      for (const p of notMine) expect(existsSync(at(p))).toBe(true);
    });
  });
});
