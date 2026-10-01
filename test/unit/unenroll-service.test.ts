// WALK-67 lane 8, round 2 (item 7): un-enrolling a macOS machine, at the person's own terminal, removes Walkie's SSH service
// (dev.walkie.sshd and its files) in the SAME one administrator step that removes the root marker, and says so. Revoking the
// grant leaves the service alone (it holds no key then). Stubbed: no root, launchd or /Library.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { unenrollMacService, unenrollServiceNote } from "../../src/cli/commands/provision.ts";

describe("what un-enroll says about Walkie's macOS SSH service", () => {
  test("before the sudo: the person is told it goes in the same administrator step, but only when it is installed on macOS", () => {
    const note = unenrollServiceNote("darwin", true);
    expect(note).toContain("also removes Walkie's SSH service (dev.walkie.sshd) and its files");
    expect(note).toContain("same administrator step");
    expect(unenrollServiceNote("darwin", false)).toBeNull();
    expect(unenrollServiceNote("linux", true)).toBeNull();
  });
  test("in the root step: removing it is said, nothing to remove is silent, and other platforms are never asked", () => {
    expect(unenrollMacService("darwin", () => ({ removed: true }))).toBe("removed Walkie's SSH service (dev.walkie.sshd) and its files");
    expect(unenrollMacService("darwin", () => ({ removed: false }))).toBeNull();
    let asked = 0;
    expect(unenrollMacService("linux", () => { asked++; return { removed: true }; })).toBeNull();
    expect(unenrollMacService("win32", () => { asked++; return { removed: true }; })).toBeNull();
    expect(asked).toBe(0);
  });
  test("a service that belongs to another person is left in place, and the person is told", () => {
    const text = unenrollMacService("darwin", () => ({ removed: false, kept: "it serves kira, not you" }));
    expect(text).toContain("left in place");
    expect(text).toContain("it serves kira, not you");
  });
  test("a service that could not be removed does not stop the un-enroll: it is said loudly, with what it is and how to remove it by hand", () => {
    const text = unenrollMacService("darwin", () => ({ removed: false, why: "could not stop the SSH service: Boot-out failed: 5" }));
    expect(text).toContain("could not be removed");
    expect(text).toContain("Boot-out failed: 5");
    expect(text).toContain("holds no owner key");
    expect(text).toContain("sudo launchctl bootout system/dev.walkie.sshd");
    expect(text).toContain("sudo rm /Library/LaunchDaemons/dev.walkie.sshd.plist");
    expect(text).toContain("sudo rm -r '/Library/Application Support/Walkie/ssh'");
    const partial = unenrollMacService("darwin", () => ({ removed: true, why: "/x is not a plain directory owned by root; left alone" }));
    expect(partial).toContain("could not be removed");
  });
});

describe("only un-enroll removes it: revoking the grant leaves the service (it has no keys then)", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
    });
  }
  test("removeMacSshService is called from the un-enroll root step and nowhere else", () => {
    const callers = sources(join(import.meta.dir, "../../src"))
      .filter((file) => /removeMacSshService\(/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(file.indexOf("/src/") + 1));
    expect(callers.sort()).toEqual(["src/cli/commands/provision.ts", "src/daemon/ssh/macos-service.ts"]);
    const provision = readFileSync(join(import.meta.dir, "../../src/cli/commands/provision.ts"), "utf8");
    const revokeBranch = provision.slice(provision.indexOf('if (sub === "revoke")'), provision.indexOf('if (sub === "unenroll")'));
    expect(revokeBranch).not.toContain("removeMacSshService");
    expect(revokeBranch).not.toContain("unenrollMacService");
  });
});
