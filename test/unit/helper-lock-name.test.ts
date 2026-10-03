import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sameLockName } from "../../src/daemon/seats/admin-sys.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "walkie-lock-name-"));
  roots.push(root);
  const candidate = join(root, "candidate");
  mkdirSync(candidate);
  return { root, candidate, lock: join(candidate, "walkie.sock.lock") };
}

test("lock names match through a parent alias, but other names and parents do not", () => {
  const { root, candidate, lock } = fixture();
  const alias = join(root, "alias");
  symlinkSync(candidate, alias);
  expect(sameLockName(join(alias, "walkie.sock.lock"), lock)).toBe(true);
  expect(sameLockName(join(candidate, "other.lock"), lock)).toBe(false);
  expect(sameLockName(join(root, "walkie.sock.lock"), lock)).toBe(false);
  expect(sameLockName("relative/walkie.sock.lock", lock)).toBe(false);
});

test("an unlinked lock's old name remains a match while its parent exists", () => {
  const { lock } = fixture();
  writeFileSync(lock, "");
  rmSync(lock);
  expect(sameLockName(`${lock} (deleted)`, lock)).toBe(true);
});

test("an unrelated listed file whose parent disappeared is not a match", () => {
  const { root, lock } = fixture();
  const vanished = join(root, "vanished");
  mkdirSync(vanished);
  const listed = join(vanished, "walkie.sock.lock");
  rmSync(vanished, { recursive: true });
  expect(sameLockName(listed, lock)).toBe(false);
});

test("an unrelated listed file below a non-directory parent is not a match", () => {
  const { root, lock } = fixture();
  const file = join(root, "plain-file");
  writeFileSync(file, "");
  expect(sameLockName(join(file, "child", "walkie.sock.lock"), lock)).toBe(false);
});

test("a missing candidate parent still refuses the comparison", () => {
  const { root, candidate, lock } = fixture();
  rmSync(candidate, { recursive: true });
  expect(() => sameLockName(join(root, "walkie.sock.lock"), lock)).toThrow(/ENOENT/);
});

test("an unavailable candidate is checked even when the listed parent is also gone", () => {
  const { root, candidate, lock } = fixture();
  rmSync(candidate, { recursive: true });
  expect(() => sameLockName(join(root, "also-gone", "walkie.sock.lock"), lock)).toThrow(/ENOENT/);
});

test("a non-directory candidate parent still refuses the comparison", () => {
  const { root, lock } = fixture();
  const file = join(root, "plain-file");
  writeFileSync(file, "");
  expect(() => sameLockName(lock, join(file, "child", "walkie.sock.lock"))).toThrow(/ENOTDIR/);
});

test("other filesystem errors still refuse the comparison", () => {
  const { root, lock } = fixture();
  const loop = join(root, "loop");
  symlinkSync("loop", loop);
  expect(() => sameLockName(join(loop, "walkie.sock.lock"), lock)).toThrow(/ELOOP/);
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable unrelated parent still refuses the comparison", () => {
  const { root, lock } = fixture();
  const blocked = join(root, "unavailable");
  const nested = join(blocked, "child");
  mkdirSync(nested, { recursive: true });
  chmodSync(blocked, 0);
  try {
    expect(() => sameLockName(join(nested, "walkie.sock.lock"), lock)).toThrow(/EACCES|EPERM/);
    expect(() => sameLockName(lock, join(nested, "walkie.sock.lock"))).toThrow(/EACCES|EPERM/);
  } finally {
    chmodSync(blocked, 0o700);
  }
});
