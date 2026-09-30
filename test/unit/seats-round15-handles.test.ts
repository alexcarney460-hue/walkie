import { afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, constants, lstatSync, mkdtempSync, mkdirSync, openSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { retireSeatHomeIn } from "../../src/daemon/seats/admin-sys.ts";
import { hasExtendedAcl } from "../../src/daemon/seats/admin-acl.ts";
import type { HomeRetirement, HomeRetirementStore } from "../../src/daemon/seats/admin-ledger.ts";
import { createHash } from "node:crypto";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync("/tmp/walkie-round15-handles-");
  dirs.push(root);
  const users = join(root, "Users");
  mkdirSync(users, { mode: 0o755 });
  const home = join(users, "walkie-s1");
  mkdirSync(home, { mode: 0o700 });
  return { root, users, home, retired: join(users, ".walkie-retired"), owner: process.getuid!(), group: lstatSync(users).gid };
}
function proofStore(): HomeRetirementStore {
  let record: HomeRetirement | null = null;
  return { op: { pid: 42, start: "fixture" }, read: () => record,
    prepare: (next) => { if (record && JSON.stringify(record) !== JSON.stringify(next)) throw new Error("provenance changed"); record = next; } };
}

test("a symlink or open retirement directory keeps the home in place", () => {
  for (const kind of ["symlink", "open"] as const) {
    const f = fixture();
    if (kind === "symlink") symlinkSync(f.root, f.retired);
    else { mkdirSync(f.retired); chmodSync(f.retired, 0o755); }
    expect(() => retireSeatHomeIn(f.users, f.owner, f.group, f.owner, "walkie-s1")).toThrow();
    expect(lstatSync(f.home).isDirectory()).toBe(true);
  }
});

test("a writable Users directory keeps the home in place", () => {
  const f = fixture();
  chmodSync(f.users, 0o777);
  expect(() => retireSeatHomeIn(f.users, f.owner, f.group, f.owner, "walkie-s1")).toThrow();
  expect(lstatSync(f.home).isDirectory()).toBe(true);
});

test("a retired parent with the wrong owner keeps the home in place", () => {
  const f = fixture();
  mkdirSync(f.retired, { mode: 0o700 });
  expect(() => retireSeatHomeIn(f.users, f.owner + 1, f.group, f.owner, "walkie-s1")).toThrow();
  expect(lstatSync(f.home).isDirectory()).toBe(true);
});

test("a planted tombstone with the expected name is never accepted as a prior retirement", () => {
  const f = fixture();
  rmSync(f.home, { recursive: true });
  mkdirSync(f.retired, { mode: 0o700 });
  mkdirSync(join(f.retired, `walkie-s1-${f.owner}`), { mode: 0o700 });
  expect(() => retireSeatHomeIn(f.users, f.owner, f.group, f.owner, "walkie-s1")).toThrow("provenance");
});

test("an exclusive rename refuses a planted operation-specific tombstone", () => {
  const f = fixture();
  const store = proofStore();
  const suffix = createHash("sha256").update(`${f.owner}\0${store.op.pid}\0${store.op.start}`).digest("hex").slice(0, 32);
  mkdirSync(f.retired, { mode: 0o700 });
  mkdirSync(join(f.retired, `walkie-s1-${f.owner}-${suffix}`), { mode: 0o700 });
  expect(() => retireSeatHomeIn(f.users, f.owner, f.group, f.owner, "walkie-s1", store)).toThrow();
  expect(store.read()?.sourceIno).toBe(lstatSync(f.home).ino);
  expect(lstatSync(f.home).isDirectory()).toBe(true);
});

test("a same-name tombstone with another inode fails a recorded retry", () => {
  const f = fixture();
  const store = proofStore();
  const name = `walkie-s1-${f.owner}-${"a".repeat(32)}`;
  store.prepare({ uid: f.owner, sourceDev: lstatSync(f.home).dev, sourceIno: lstatSync(f.home).ino, tombstone: name });
  rmSync(f.home, { recursive: true });
  mkdirSync(f.retired, { mode: 0o700 });
  mkdirSync(join(f.retired, name), { mode: 0o700 });
  expect(() => retireSeatHomeIn(f.users, f.owner, f.group, f.owner, "walkie-s1", store)).toThrow("provenance");
});

test.skipIf(process.platform !== "darwin")("retirement strips a home ACL and rejects an ACL on Users or retired parent", () => {
  const f = fixture();
  const acl = "everyone allow read,write,execute";
  const add = (path: string) => {
    const r = Bun.spawnSync(["chmod", "+a", acl, path], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  add(f.users);
  const checkFd = openSync(f.users, constants.O_RDONLY | constants.O_DIRECTORY);
  try { expect(hasExtendedAcl(checkFd)).toBe(true); } finally { closeSync(checkFd); }
  expect(() => retireSeatHomeIn(f.users, f.owner, f.group, f.owner, "walkie-s1")).toThrow("users directory");
  const noAcl = Bun.spawnSync(["chmod", "-N", f.users], { stdout: "pipe", stderr: "pipe" });
  expect(noAcl.exitCode).toBe(0);
  const readOnly = Bun.spawnSync(["chmod", "+a", "everyone allow read,execute", f.users], { stdout: "pipe", stderr: "pipe" });
  expect(readOnly.exitCode).toBe(0);
  mkdirSync(f.retired, { mode: 0o700 });
  add(f.retired);
  expect(() => retireSeatHomeIn(f.users, f.owner, f.group, f.owner, "walkie-s1")).toThrow();
  const clean = Bun.spawnSync(["chmod", "-N", f.retired], { stdout: "pipe", stderr: "pipe" });
  expect(clean.exitCode).toBe(0);
  add(f.home);
  const store = proofStore();
  const moved = retireSeatHomeIn(f.users, f.owner, f.group, f.owner, "walkie-s1", store);
  expect(moved?.path).toMatch(new RegExp(`walkie-s1-${f.owner}-[0-9a-f]{32}$`));
  const ls = Bun.spawnSync(["ls", "-lde", moved!.path], { stdout: "pipe", stderr: "pipe" });
  expect(ls.stdout.toString()).not.toContain("everyone allow");
  expect(retireSeatHomeIn(f.users, f.owner, f.group, f.owner, "walkie-s1", store)?.path).toBe(moved?.path);
});
