import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeSeatSchedules } from "../../src/daemon/seats/admin-sys.ts";

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
