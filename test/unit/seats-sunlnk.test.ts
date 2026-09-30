import { afterEach, expect, test } from "bun:test";
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FsatError, SF_NOUNLINK, SF_RESTRICTED, UF_DATAVAULT, fdIdentity, isDir, listDir, openDirAt, openFileAt, statAt, unlinkAt } from "../../src/daemon/seats/fsat.ts";
import { RESIDUE_RECORD_CAP, sweep, sweepVerified, verifyProtectedResidue } from "../../src/daemon/seats/sweep.ts";
import { realRoots } from "../../src/daemon/seats/runner-sweep.ts";
import { createSeatUser, destroySeatUser } from "../../src/daemon/seats/admin.ts";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";
import { doctorChecks } from "../../src/daemon/seats/doctor.ts";
import type { SeatsLocalView } from "../../src/protocol/seats.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("macOS runner treats the seat home as a protected residue root", () => {
  if (process.platform !== "darwin") return;
  const roots = realRoots("/Users/walkie-s1", 600001).roots;
  expect(roots.find((r) => r.path === "/Users/walkie-s1")).toMatchObject({ owned: true, sunlnk: true });
});

function folder(flags: number, content = false) {
  const base = mkdtempSync("/tmp/walkie-sunlnk-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(join(root, "0"), { recursive: true });
  if (content) writeFileSync(join(root, "0", "other-file"), "belongs to another user");
  const uid = process.getuid?.() ?? -1;
  return sweepVerified([{ path: root, owned: true, sunlnk: true }], (st, name) => st.uid === uid && Buffer.from(name).toString() !== "other-file", {
    statAt: (fd, name) => {
      const st = statAt(fd, name);
      return { ...st, flags: isDir(st) ? flags : 0 };
    },
    unlinkAt: (fd, name, dir) => {
      if (dir) throw new FsatError("EPERM", "sunlnk");
      unlinkAt(fd, name, dir);
    },
  });
}

test("empty per-user folder with only sunlnk is verified and recorded", () => {
  const r = folder(0x00100000);
  expect(r.verified).toBe(true);
  expect(r.left).toEqual([]);
  expect(r.leftoverDirs).toHaveLength(2);
});

test("nested trees of only empty sunlnk directories are verified", () => {
  for (const nested of ["T/SandboxHelper", "C/a/b"]) {
    const base = mkdtempSync("/tmp/walkie-sunlnk-nested-");
    dirs.push(base);
    const root = join(base, "per-user");
    mkdirSync(join(root, nested), { recursive: true });
    const uid = process.getuid?.() ?? -1;
    const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === uid, {
      statAt: (fd, name) => { const st = statAt(fd, name); return { ...st, flags: isDir(st) ? 0x00100000 : 0 }; },
      unlinkAt: (fd, name, dir) => { if (dir) throw new FsatError("EPERM", "sunlnk"); unlinkAt(fd, name, dir); },
    });
    expect(r.verified).toBe(true);
    expect(r.leftoverDirs.some((s) => s.startsWith(`${join(root, nested)} (`))).toBe(true);
  }
});

test("nested leftovers reject files, symlinks, other flags, and other owners", () => {
  for (const kind of ["file", "symlink", "flags", "owner"]) {
    const base = mkdtempSync("/tmp/walkie-sunlnk-reject-");
    dirs.push(base);
    const root = join(base, "per-user");
    mkdirSync(join(root, "T", "SandboxHelper"), { recursive: true });
    if (kind === "file") writeFileSync(join(root, "T", "SandboxHelper", "data"), "x");
    if (kind === "symlink") symlinkSync("/tmp", join(root, "T", "SandboxHelper", "link"));
    const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st, name) =>
      st.uid === (process.getuid?.() ?? -1) && !(kind === "owner" && Buffer.from(name).toString() === "SandboxHelper"), {
      statAt: (fd, name) => { const st = statAt(fd, name); return { ...st, flags: isDir(st) ? (kind === "flags" ? 0x00000002 : 0x00100000) : 0 }; },
      unlinkAt: (fd, name, dir) => { if (dir || kind === "file" || kind === "symlink") throw new FsatError("EPERM", "sunlnk"); unlinkAt(fd, name, dir); },
    });
    expect(r.verified).toBe(false);
  }
});

test("other flags and another user's entry still block verification", () => {
  expect(folder(0x00000002).verified).toBe(false);
  expect(folder(0x00100002).verified).toBe(false);
  expect(folder(SF_NOUNLINK | 0x00008000).verified).toBe(true);
  expect(folder(0x00100000, true).verified).toBe(false);
});

test("an unlistable owned per-user directory is recorded, while a removable neighbor is swept", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-unlistable-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(join(root, "0"), { recursive: true });
  writeFileSync(join(root, "removable"), "x");
  const blocked = statAt(-100, join(root, "0")).ino;
  const uid = process.getuid?.() ?? -1;
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === uid, {
    statAt: (fd, name) => { const st = statAt(fd, name); return { ...st, flags: isDir(st) ? 0x00100000 : 0 }; },
    listDir: (fd) => { if (fdIdentity(fd).ino === blocked) throw new FsatError("EPERM", "readdir"); return listDir(fd); },
    unlinkAt: (fd, name, dir) => { if (dir) throw new FsatError("EPERM", "sunlnk"); unlinkAt(fd, name, dir); },
  });
  expect(r.verified).toBe(true);
  expect(r.removed).toBe(1);
  expect(r.leftoverDirs.some((s) => s.includes("/0") && s.includes("EPERM"))).toBe(true);
});

test("macOS home Library protections are accepted only after the seat sweep removes readable neighbors", () => {
  const base = mkdtempSync("/tmp/walkie-home-residue-");
  dirs.push(base);
  const home = join(base, "walkie-s1");
  const library = join(home, "Library");
  for (const path of ["Mail", "Preferences", "ContainerManager", "Containers/com.apple.ImageIO.imageimporter"])
    mkdirSync(join(library, path), { recursive: true });
  writeFileSync(join(library, "Containers/com.apple.ImageIO.imageimporter/.com.apple.containermanagerd.metadata.plist"), "protected");
  writeFileSync(join(home, "readable"), "removed by sweep");
  const blocked = new Set(["Mail", "Preferences", "ContainerManager"]);
  const r = sweepVerified([{ path: home, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    statAt: (fd, name) => {
      const st = statAt(fd, name);
      return { ...st, flags: Buffer.from(name).toString().endsWith("metadata.plist") ? SF_RESTRICTED : 0 };
    },
    openDirAt: (fd, name) => { if (blocked.has(Buffer.from(name).toString())) throw new FsatError("EPERM", "openat"); return openDirAt(fd, name); },
    openFileAt: (fd, name, write) => { if (Buffer.from(name).toString().endsWith("metadata.plist")) throw new FsatError("EPERM", "openat"); return openFileAt(fd, name, write); },
    unlinkAt: (fd, name, dir) => {
      if (blocked.has(Buffer.from(name).toString()) || Buffer.from(name).toString().endsWith("metadata.plist")) throw new FsatError("EPERM", "unlinkat");
      unlinkAt(fd, name, dir);
    },
  });
  expect(r.verified).toBe(true);
  expect(r.leftoverDirs.join(" ")).toContain("Library/Mail");
  expect(existsSync(join(home, "readable"))).toBe(false);
});

test("an unflagged Library itself may be opaque while the home stays inspectable", () => {
  const base = mkdtempSync("/tmp/walkie-home-library-");
  dirs.push(base);
  const home = join(base, "walkie-s1");
  const library = join(home, "Library");
  mkdirSync(join(library, "Caches"), { recursive: true });
  const r = sweepVerified([{ path: home, owned: true, sunlnk: true, homeRoot: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    statAt: (fd, name) => ({ ...statAt(fd, name), flags: 0 }),
    openDirAt: (fd, name) => { if (Buffer.from(name).toString() === "Library") throw new FsatError("EPERM", "openat"); return openDirAt(fd, name); },
  });
  expect(r.verified).toBe(true);
  expect(r.residuePaths).toContain(library);
});

test("direct Apple cache vaults need seat EPERM and root-observed protection flags", () => {
  for (const flags of [UF_DATAVAULT, SF_RESTRICTED, 0]) {
    const base = mkdtempSync("/tmp/walkie-cache-vault-");
    dirs.push(base);
    const cache = join(base, "Caches");
    mkdirSync(cache);
    for (const name of ["com.apple.amsengagementd.classicdatavault", "com.apple.aneuserd", "com.apple.aned"])
      mkdirSync(join(cache, name));
    const r = sweepVerified([{ path: cache, systemVaults: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
      statAt: (fd, name) => {
        const st = statAt(fd, name);
        return { ...st, flags: Buffer.from(name).toString().startsWith("com.apple.") ? flags : 0 };
      },
      openDirAt: (fd, name) => {
        if (Buffer.from(name).toString().startsWith("com.apple.")) throw new FsatError("EPERM", "openat");
        return openDirAt(fd, name);
      },
    });
    expect(r.verified).toBe(flags !== 0);
    if (flags !== 0) expect(r.residuePaths).toHaveLength(3);
  }
});

test("a readable owned file in the system cache cannot be retained as a vault", () => {
  const base = mkdtempSync("/tmp/walkie-cache-readable-");
  dirs.push(base);
  const cache = join(base, "Caches");
  mkdirSync(cache);
  writeFileSync(join(cache, "readable"), "escape");
  const r = sweepVerified([{ path: cache, systemVaults: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    statAt: (fd, name) => ({ ...statAt(fd, name), flags: SF_RESTRICTED }),
    unlinkAt: (fd, name, dir) => {
      if (Buffer.from(name).toString() === "readable") throw new FsatError("EPERM", "unlinkat");
      unlinkAt(fd, name, dir);
    },
  });
  expect(r.verified).toBe(false);
  expect(readFileSync(join(cache, "readable"), "utf8")).toBe("escape");
});

test("an empty flagged cache vault refused at unlink is retained", () => {
  const base = mkdtempSync("/tmp/walkie-cache-unlink-");
  dirs.push(base);
  const cache = join(base, "Caches");
  mkdirSync(join(cache, "com.apple.aned"), { recursive: true });
  const r = sweepVerified([{ path: cache, systemVaults: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    statAt: (fd, name) => ({ ...statAt(fd, name), flags: Buffer.from(name).toString() === "com.apple.aned" ? UF_DATAVAULT : 0 }),
    unlinkAt: (fd, name, dir) => { if (dir) throw new FsatError("EPERM", "unlinkat"); unlinkAt(fd, name, dir); },
  });
  expect(r.verified).toBe(true);
  expect(r.residuePaths).toContain(join(cache, "com.apple.aned"));
});

test("opaque entries require EPERM and owned ancestry, with system flags on the root", () => {
  for (const kind of ["open", "list", "root-open", "root-list"] as const) {
    for (const flags of [0, 0x00000002, SF_NOUNLINK, SF_RESTRICTED, UF_DATAVAULT,
      SF_NOUNLINK | 0x00008000, SF_NOUNLINK | 0x00000002]) {
      const base = mkdtempSync("/tmp/walkie-sunlnk-opaque-");
      dirs.push(base);
      const root = join(base, "per-user");
      mkdirSync(join(root, "0"), { recursive: true });
      writeFileSync(join(root, "0", "secret.txt"), "x");
      const blocked = statAt(-100, kind.startsWith("root") ? root : join(root, "0")).ino;
      const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
        statAt: (fd, name) => {
          const st = statAt(fd, name);
          return { ...st, flags: st.ino === blocked ? flags : (isDir(st) ? SF_NOUNLINK : 0) };
        },
        openDirAt: (fd, name) => {
          if (kind.endsWith("open") && Buffer.from(name).toString() === (kind.startsWith("root") ? root : "0"))
            throw new FsatError("EPERM", "openat");
          return openDirAt(fd, name);
        },
        listDir: (fd) => { if (kind.endsWith("list") && fdIdentity(fd).ino === blocked) throw new FsatError("EPERM", "readdir"); return listDir(fd); },
        unlinkAt: (fd, name, dir) => { if (dir) throw new FsatError("EPERM", "sunlnk"); unlinkAt(fd, name, dir); },
      });
      const expected = !kind.startsWith("root") || [SF_NOUNLINK, SF_RESTRICTED, UF_DATAVAULT,
        SF_NOUNLINK | 0x00008000].includes(flags);
      if (r.verified !== expected || (expected && !r.leftoverDirs.some((s) => s.includes(`flags=0x${flags.toString(16).padStart(8, "0")}`))))
        throw new Error(`${kind} flags=0x${flags.toString(16)}: ${JSON.stringify(r)}`);
      expect(readFileSync(join(root, "0", "secret.txt"), "utf8")).toBe("x");
    }
  }
});

test("a stat-visible unflagged vault records the operation that returned EPERM", () => {
  for (const kind of ["open", "list"] as const) for (const flags of [0, 0x8000]) {
    const base = mkdtempSync("/tmp/walkie-sunlnk-visible-vault-");
    dirs.push(base);
    const root = join(base, "per-user");
    const vault = join(root, "0", "com.apple.LaunchServices.dv");
    mkdirSync(vault, { recursive: true });
    const uid = process.getuid?.() ?? -1;
    const blocked = statAt(-100, vault).ino;
    const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === uid, {
      statAt: (fd, name) => { const st = statAt(fd, name); return { ...st, flags: Buffer.from(name).toString() === "com.apple.LaunchServices.dv" ? flags : isDir(st) ? SF_NOUNLINK : 0 }; },
      openDirAt: (fd, name) => { if (kind === "open" && Buffer.from(name).toString() === "com.apple.LaunchServices.dv") throw new FsatError("EPERM", "openat"); return openDirAt(fd, name); },
      listDir: (fd) => { if (kind === "list" && fdIdentity(fd).ino === blocked) throw new FsatError("EPERM", "readdir"); return listDir(fd); },
      unlinkAt: (fd, name, dir) => { if (dir) throw new FsatError("EPERM", "sunlnk"); unlinkAt(fd, name, dir); },
    });
    expect(r.verified).toBe(true);
    expect(r.leftoverDirs.some((s) => s.includes(vault) && s.includes(`EPERM ${kind}`) && !s.includes("stat denied"))).toBe(true);
  }
});

test("read-only residue verification accepts protected entries and rejects ordinary files", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-readonly-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(join(root, "0"), { recursive: true });
  const uid = process.getuid?.() ?? -1;
  const options = { statAt: (fd: number, name: Uint8Array | string) => {
    const st = statAt(fd, name);
    return { ...st, flags: isDir(st) ? SF_NOUNLINK : 0 };
  } };
  expect(verifyProtectedResidue(root, uid, options).verified).toBe(true);
  writeFileSync(join(root, "0", "payload"), "not residue");
  expect(verifyProtectedResidue(root, uid, options).verified).toBe(false);
  expect(existsSync(join(root, "0", "payload"))).toBe(true);
});

test("read-only residue verification rejects an empty protected file with extended attributes", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-verify-xattr-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(root);
  writeFileSync(join(root, "payload"), "");
  const r = verifyProtectedResidue(root, process.getuid?.() ?? -1, {
    statAt: (fd, name) => ({ ...statAt(fd, name), flags: SF_NOUNLINK }),
    hasExtendedAttributes: () => true,
  });
  expect(r.verified).toBe(false);
});

test("root open EPERM and stat recheck EPERM cannot verify protected residue", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-root-race-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(root);
  let rootStats = 0;
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    statAt: (fd, name) => {
      if (name === root && ++rootStats > 1) throw new FsatError("EPERM", "fstatat");
      return { ...statAt(fd, name), flags: SF_NOUNLINK };
    },
    openDirAt: (fd, name) => { if (name === root) throw new FsatError("EPERM", "openat"); return openDirAt(fd, name); },
  });
  expect(r.verified).toBe(false);
  expect(rootStats).toBeGreaterThan(1);
});

test("read-only residue verification accepts a stat-denied Apple vault", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-readonly-vault-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(join(root, "0", "com.apple.LaunchServices.dv"), { recursive: true });
  const uid = process.getuid?.() ?? -1;
  const r = verifyProtectedResidue(root, uid, { statAt: (fd, name) => {
    if (Buffer.from(name).toString() === "com.apple.LaunchServices.dv") throw new FsatError("EPERM", "fstatat");
    const st = statAt(fd, name);
    return { ...st, flags: isDir(st) ? SF_NOUNLINK : 0 };
  } });
  expect(r.verified).toBe(true);
  expect(r.leftoverDirs.some((path) => path.includes("com.apple.LaunchServices.dv") && path.includes("EPERM stat"))).toBe(true);
});

test("stat-denied entries at any depth require a stable owned ancestor chain", () => {
  const cases = [
    { name: "valid 0", parent: "0", accepted: true },
    { name: "valid T", parent: "T", accepted: true },
    { name: "valid C", parent: "C", accepted: true },
    { name: "non-Apple", parent: "0", child: "seat-owned", accepted: true },
    { name: "nested", parent: "0", nested: "inside", accepted: true },
    { name: "no sunlnk", parent: "0", parentFlags: 0, accepted: true },
    { name: "user flag with sunlnk", parent: "0", parentFlags: SF_NOUNLINK | 0x2, accepted: false },
    { name: "other uid", parent: "0", otherUid: true, accepted: false },
    { name: "parent swapped", parent: "0", swapped: true, accepted: false },
  ] as const;
  for (const c of cases) {
    const base = mkdtempSync("/tmp/walkie-sunlnk-datavault-");
    dirs.push(base);
    const root = join(base, "per-user");
    const parent = join(root, c.parent, "nested" in c ? c.nested : "");
    mkdirSync(parent, { recursive: true });
    const child = "child" in c ? c.child : "com.apple.LaunchServices.dv";
    mkdirSync(join(parent, child));
    const uid = process.getuid?.() ?? -1;
    let parentChecks = 0;
    const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === uid, {
      statAt: (fd, name) => {
        if (Buffer.from(name).toString() === child) throw new FsatError("EPERM", "fstatat");
        const st = statAt(fd, name);
        if (Buffer.from(name).toString() === c.parent) {
          parentChecks++;
          return { ...st, uid: "otherUid" in c ? uid + 1 : st.uid,
            ino: "swapped" in c && parentChecks % 2 === 0 ? st.ino + 1 : st.ino,
            flags: "parentFlags" in c ? c.parentFlags : SF_NOUNLINK };
        }
        return { ...st, flags: isDir(st) ? SF_NOUNLINK : 0 };
      },
      unlinkAt: (fd, name, dir) => { if (dir) throw new FsatError("EPERM", "sunlnk"); unlinkAt(fd, name, dir); },
    });
    expect(r.verified).toBe(c.accepted);
    if (r.leftoverDirs.some((s) => s.includes(join(parent, child)) && s.includes("EPERM stat")) !== (c.accepted || c.name === "user flag with sunlnk"))
      throw new Error(`${c.name}: ${JSON.stringify(r)}`);
  }
});

test("an opaque directory swapped between walk and protection check stays unverified", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-swap-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(join(root, "0"), { recursive: true });
  let checks = 0;
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    statAt: (fd, name) => {
      const st = statAt(fd, name);
      return { ...st, ino: Buffer.from(name).toString() === "0" && ++checks % 2 === 0 ? st.ino + 1 : st.ino,
        flags: isDir(st) ? SF_NOUNLINK : 0 };
    },
    openDirAt: (fd, name) => { if (Buffer.from(name).toString() === "0") throw new FsatError("EPERM", "openat"); return openDirAt(fd, name); },
    unlinkAt: (fd, name, dir) => { if (dir) throw new FsatError("EPERM", "sunlnk"); unlinkAt(fd, name, dir); },
  });
  expect(checks).toBeGreaterThanOrEqual(2);
  expect(r.verified).toBe(false);
  expect(r.leftoverDirs.some((s) => s.includes("/0"))).toBe(false);
});

test("a user-flagged directory is retried and removed after its own protection is cleared", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-uchg-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(join(root, "0"), { recursive: true });
  let attempts = 0;
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    statAt: (fd, name) => { const st = statAt(fd, name); return { ...st, flags: Buffer.from(name).toString() === "0" ? 0x00000002 : 0 }; },
    unlinkAt: (fd, name, dir) => {
      if (dir && Buffer.from(name).toString() === "0" && ++attempts === 1) throw new FsatError("EPERM", "uchg");
      unlinkAt(fd, name, dir);
    },
  });
  expect(attempts).toBe(2);
  expect(r.verified).toBe(true);
  expect(r.leftoverDirs).toEqual([]);
});

test("a protected nonempty trustd tree is recorded, including an entry that cannot be opened", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-trustd-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(join(root, "T", "com.apple.trustd", "TemporaryItems"), { recursive: true });
  writeFileSync(join(root, "T", "removable"), "x");
  const uid = process.getuid?.() ?? -1;
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === uid, {
    statAt: (fd, name) => { const st = statAt(fd, name); return { ...st, flags: isDir(st) && Buffer.from(name).toString() !== "TemporaryItems" ? 0x00100000 : 0 }; },
    openDirAt: (fd, name) => { if (Buffer.from(name).toString() === "TemporaryItems") throw new FsatError("EPERM", "openat"); return openDirAt(fd, name); },
    unlinkAt: (fd, name, dir) => { if (dir) throw new FsatError("EPERM", "sunlnk"); unlinkAt(fd, name, dir); },
  });
  expect(r.verified).toBe(true);
  expect(r.removed).toBe(1);
  expect(r.leftoverDirs.some((s) => s.includes("com.apple.trustd"))).toBe(true);
});

test("EPERM residue accepts unflagged TemporaryItems and non-Apple stat-denied entries at any depth", () => {
  for (const path of ["T/TemporaryItems", "T/com.apple.trustd/TemporaryItems", "0/dmd", "0/com.apple.routined/dv"]) {
    const base = mkdtempSync("/tmp/walkie-sunlnk-real-shape-");
    dirs.push(base);
    const root = join(base, "per-user");
    mkdirSync(join(root, path), { recursive: true });
    const leaf = path.split("/").at(-1)!;
    const statDenied = leaf === "dmd" || leaf === "dv";
    const uid = process.getuid?.() ?? -1;
    const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === uid, {
      statAt: (fd, name) => {
        if (statDenied && Buffer.from(name).toString() === leaf) throw new FsatError("EPERM", "fstatat");
        const st = statAt(fd, name);
        const n = Buffer.from(name).toString();
        return { ...st, flags: ["per-user", "0", "T", "com.apple.trustd"].includes(n) ? SF_NOUNLINK : 0 };
      },
      openDirAt: (fd, name) => { if (Buffer.from(name).toString() === leaf) throw new FsatError("EPERM", "openat"); return openDirAt(fd, name); },
      unlinkAt: (fd, name, dir) => { if (dir && ["per-user", "0", "T", "com.apple.trustd", leaf].includes(Buffer.from(name).toString())) throw new FsatError("EPERM", "rmdir"); unlinkAt(fd, name, dir); },
    });
    expect(r.verified).toBe(true);
    expect(r.leftoverDirs.some((s) => s.includes(path) && s.includes(statDenied ? "EPERM stat" : "EPERM open"))).toBe(true);
  }
});

test("EACCES, mount points and a changed ancestor still block; symlinks are removed", () => {
  for (const kind of ["EACCES", "mount", "ancestor", "symlink"] as const) {
    const base = mkdtempSync("/tmp/walkie-sunlnk-boundary-");
    dirs.push(base);
    const root = join(base, "per-user");
    mkdirSync(join(root, "T", "app", "TemporaryItems"), { recursive: true });
    if (kind === "symlink") symlinkSync("/tmp", join(root, "T", "app", "link"));
    let appChecks = 0;
    const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
      statAt: (fd, name) => {
        const st = statAt(fd, name);
        const n = Buffer.from(name).toString();
        return { ...st, dev: kind === "mount" && n === "app" ? st.dev + 1 : st.dev,
          ino: kind === "ancestor" && n === "app" && ++appChecks > 1 ? st.ino + 1 : st.ino,
          flags: ["per-user", "T"].includes(n) ? SF_NOUNLINK : 0 };
      },
      openDirAt: (fd, name) => {
        if (Buffer.from(name).toString() === "TemporaryItems") throw new FsatError(kind === "EACCES" ? "EACCES" : "EPERM", "openat");
        return openDirAt(fd, name);
      },
      unlinkAt: (fd, name, dir) => {
        if (dir && ["T", "app", "TemporaryItems"].includes(Buffer.from(name).toString())) throw new FsatError("EPERM", "rmdir");
        unlinkAt(fd, name, dir);
      },
    });
    expect(r.verified).toBe(kind === "symlink");
    if (kind === "symlink") expect(existsSync(join(root, "T", "app", "link"))).toBe(false);
  }
});

test("a listable Apple directory is swept before its protected shell is accepted", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-listable-");
  dirs.push(base);
  const root = join(base, "per-user");
  const apple = join(root, "T", "com.apple.trustd");
  mkdirSync(apple, { recursive: true });
  const planted = join(apple, "planted");
  writeFileSync(planted, "x");
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    statAt: (fd, name) => { const st = statAt(fd, name); return { ...st, flags: isDir(st) ? SF_NOUNLINK : 0 }; },
    unlinkAt: (fd, name, dir) => { if (dir) throw new FsatError("EPERM", "rmdir"); unlinkAt(fd, name, dir); },
  });
  expect(r.verified).toBe(true);
  expect(r.removed).toBe(1);
  expect(existsSync(planted)).toBe(false);
  expect(r.leftoverDirs.some((entry) => entry.startsWith(`${apple} (`))).toBe(true);
});

test("the protected residue record cap is reported once and stops recording", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-cap-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(root);
  for (let n = 0; n < RESIDUE_RECORD_CAP + 3; n++) writeFileSync(join(root, `opaque-${n}`), "");
  const r = sweep([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    remove: false, residueOnly: true,
    statAt: (fd, name) => {
      if (Buffer.from(name).toString().startsWith("opaque-")) throw new FsatError("EPERM", "fstatat");
      const st = statAt(fd, name);
      return { ...st, flags: SF_NOUNLINK };
    },
  });
  const cap = `protected per-user residue cap hit (${RESIDUE_RECORD_CAP} entries)`;
  expect(r.leftoverDirs).toHaveLength(RESIDUE_RECORD_CAP);
  expect(r.problems.filter((p) => p === cap)).toHaveLength(1);
  expect(r.left[0]).toBe(cap);
});

test("a protected directory owned by another uid still fails", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-other-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(join(root, "T", "other"), { recursive: true });
  const uid = process.getuid?.() ?? -1;
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === uid, {
    statAt: (fd, name) => { const st = statAt(fd, name); return { ...st, uid: Buffer.from(name).toString() === "other" ? uid + 1 : uid, flags: 0x00100000 }; },
    openDirAt: (fd, name) => { if (Buffer.from(name).toString() === "other") throw new FsatError("EPERM", "openat"); return openDirAt(fd, name); },
    unlinkAt: (fd, name, dir) => { if (dir) throw new FsatError("EPERM", "sunlnk"); unlinkAt(fd, name, dir); },
  });
  expect(r.verified).toBe(false);
});

test("a protected file is residue only inside the owned per-user folder", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-file-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(root);
  writeFileSync(join(root, "protected-file"), "x");
  const uid = process.getuid?.() ?? -1;
  const options = {
    hasExtendedAttributes: () => false, // macOS adds com.apple.provenance to local test fixtures
    statAt: (fd: number, name: Uint8Array | string) => {
      const st = statAt(fd, name);
      return { ...st, flags: Buffer.from(name).toString() === "protected-file" ? 0x00080000 : 0 };
    },
    unlinkAt: (fd: number, name: Uint8Array, dir: boolean) => {
      if (Buffer.from(name).toString() === "protected-file") throw new FsatError("EPERM", "restricted");
      unlinkAt(fd, name, dir);
    },
  };
  expect(sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === uid, options).verified).toBe(true);
  expect(sweepVerified([{ path: root, owned: true }], (st) => st.uid === uid, options).verified).toBe(false);
});

test("readable sunlnk files are emptied before accepted, including on residue recheck", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-content-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(root);
  const file = join(root, "payload");
  writeFileSync(file, "private content");
  const uid = process.getuid?.() ?? -1;
  const opts = {
    hasExtendedAttributes: () => false, // model a plain file without the host's provenance xattr
    statAt: (fd: number, name: Uint8Array | string) => ({ ...statAt(fd, name), flags: SF_NOUNLINK }),
    unlinkAt: (fd: number, name: Uint8Array, dir: boolean) => { throw new FsatError("EPERM", "sunlnk"); },
  };
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === uid, opts);
  expect(r.verified).toBe(true);
  expect(statSync(file).size).toBe(0);
  expect(r.leftoverDirs.some((s) => s.includes(file) && s.includes("truncated"))).toBe(true);
  expect(verifyProtectedResidue(root, uid, opts).verified).toBe(true);
  writeFileSync(file, "planted again");
  expect(verifyProtectedResidue(root, uid, opts).verified).toBe(false);
});

test("write descriptor extended attributes block truncation after a clean read descriptor", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-write-xattr-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(root);
  const file = join(root, "payload");
  writeFileSync(file, "private content");
  const writes = new Set<number>();
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    statAt: (fd, name) => ({ ...statAt(fd, name), flags: SF_NOUNLINK }),
    unlinkAt: () => { throw new FsatError("EPERM", "sunlnk"); },
    openFileAt: (fd, name, write) => {
      const opened = openFileAt(fd, name, write);
      if (write) writes.add(opened);
      return opened;
    },
    hasExtendedAttributes: (fd) => writes.has(fd),
  });
  expect(writes.size).toBeGreaterThan(0);
  expect(r.verified).toBe(false);
  expect(readFileSync(file, "utf8")).toBe("private content");
});

test.skipIf(process.platform !== "darwin")("owned protected shells lose user extended attributes before residue acceptance", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-dir-xattr-");
  dirs.push(base);
  const root = join(base, "per-user");
  const shells = [root, join(root, "0"), join(root, "T"), join(root, "C"), join(root, "T", "shell")];
  for (const dir of shells) mkdirSync(dir, { recursive: true });
  for (const dir of shells) expect(Bun.spawnSync(["/usr/bin/xattr", "-w", "user.leak", "private", dir]).exitCode).toBe(0);
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    statAt: (fd, name) => ({ ...statAt(fd, name), flags: SF_NOUNLINK }),
    unlinkAt: () => { throw new FsatError("EPERM", "sunlnk"); },
  });
  expect(r.verified).toBe(true);
  for (const dir of shells) expect(Bun.spawnSync(["/usr/bin/xattr", "-p", "user.leak", dir]).exitCode).not.toBe(0);
});

test("a kept directory with an unremovable user attribute stays quarantined", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-dir-xattr-denied-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(root);
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    statAt: (fd, name) => ({ ...statAt(fd, name), flags: SF_NOUNLINK }),
    listExtendedAttributes: () => [Buffer.from("user.secret")],
    removeExtendedAttribute: () => { throw new FsatError("EPERM", "fremovexattr"); },
  });
  expect(r.verified).toBe(false);
  expect(r.problems.some((p) => p.includes('"user.secret" could not be removed (EPERM)'))).toBe(true);
});

test("read-only residue check rejects user attributes on kept directories and records system attributes", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-dir-xattr-verify-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(root);
  const options = {
    statAt: (fd: number, name: Uint8Array | string) => ({ ...statAt(fd, name), flags: SF_NOUNLINK }),
  };
  const uid = process.getuid?.() ?? -1;
  expect(verifyProtectedResidue(root, uid, { ...options, listExtendedAttributes: () => [Buffer.from("user.secret")] }).verified).toBe(false);
  expect(verifyProtectedResidue(root, uid, { ...options, listExtendedAttributes: () => [Buffer.from("com.apple.provenance")] }).verified).toBe(true);
});

test.skipIf(process.platform !== "darwin")("protected files with xattrs or resource forks stay quarantined", () => {
  for (const channel of ["xattr", "resource fork"] as const) {
    const base = mkdtempSync("/tmp/walkie-sunlnk-xattr-");
    dirs.push(base);
    const root = join(base, "per-user");
    mkdirSync(root);
    const file = join(root, "payload");
    writeFileSync(file, "private content");
    if (channel === "xattr") {
      const set = Bun.spawnSync(["/usr/bin/xattr", "-w", "user.leak", "secret", file]);
      expect(set.exitCode).toBe(0);
    } else writeFileSync(`${file}/..namedfork/rsrc`, "secret fork");
    const r = sweepVerified([{ path: root, owned: true, sunlnk: true }],
      (st) => st.uid === (process.getuid?.() ?? -1), {
        statAt: (fd, name) => ({ ...statAt(fd, name), flags: SF_NOUNLINK }),
        unlinkAt: () => { throw new FsatError("EPERM", "sunlnk"); },
      });
    expect(r.verified).toBe(false);
    expect(r.problems.some((s) => s.includes("protected file carries extended attributes"))).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("private content");
    if (channel === "xattr") {
      const get = Bun.spawnSync(["/usr/bin/xattr", "-p", "user.leak", file]);
      expect(get.exitCode).toBe(0);
      expect(get.stdout.toString().trim()).toBe("secret");
    } else expect(readFileSync(`${file}/..namedfork/rsrc`, "utf8")).toBe("secret fork");
  }
});

test("a failed extended-attribute listing keeps a protected file quarantined", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-xattr-error-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(root);
  const file = join(root, "payload");
  writeFileSync(file, "private content");
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }],
    (st) => st.uid === (process.getuid?.() ?? -1), {
      statAt: (fd, name) => ({ ...statAt(fd, name), flags: SF_NOUNLINK }),
      unlinkAt: () => { throw new FsatError("EPERM", "sunlnk"); },
      hasExtendedAttributes: () => { throw new FsatError("EIO", "flistxattr"); },
    });
  expect(r.verified).toBe(false);
  expect(r.problems.some((s) => s.includes("protected file extended attribute listing failed"))).toBe(true);
  expect(readFileSync(file, "utf8")).toBe("private content");
});

test("readable protected file that refuses truncation stays quarantined", () => {
  for (const denial of ["EPERM", "EACCES"]) {
    const base = mkdtempSync("/tmp/walkie-sunlnk-denied-");
    dirs.push(base);
    const root = join(base, "per-user");
    mkdirSync(root);
    const file = join(root, "payload");
    writeFileSync(file, "private content");
    const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
      statAt: (fd, name) => ({ ...statAt(fd, name), flags: SF_NOUNLINK }),
      openFileAt: (fd, name, write) => {
        if (write) throw new FsatError(denial, "openat");
        return openFileAt(fd, name, write);
      },
      unlinkAt: () => { throw new FsatError("EPERM", "sunlnk"); },
    });
    expect(r.verified).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("private content");
  }
});

test("a file with read-open EPERM is accepted without a qualifying flag", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-read-eperm-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(root);
  writeFileSync(join(root, "opaque"), "x");
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    openFileAt: (fd, name, write) => { throw new FsatError("EPERM", "openat"); },
    unlinkAt: () => { throw new FsatError("EPERM", "sunlnk"); },
  });
  expect(r.verified).toBe(true);
  expect(r.leftoverDirs.some((s) => s.includes("opaque") && s.includes("EPERM read-open"))).toBe(true);
});

test("read-open EACCES does not qualify protected file content", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-read-eacces-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(root);
  writeFileSync(join(root, "payload"), "private content");
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    statAt: (fd, name) => ({ ...statAt(fd, name), flags: SF_NOUNLINK }),
    openFileAt: () => { throw new FsatError("EACCES", "openat"); },
    unlinkAt: () => { throw new FsatError("EPERM", "sunlnk"); },
  });
  expect(r.verified).toBe(false);
});

test("a file with stat EPERM is accepted under the checked parent", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-stat-eperm-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(root);
  writeFileSync(join(root, "opaque"), "x");
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    statAt: (fd, name) => {
      if (Buffer.from(name).toString() === "opaque") throw new FsatError("EPERM", "fstatat");
      return statAt(fd, name);
    },
  });
  expect(r.verified).toBe(true);
  expect(r.leftoverDirs.some((s) => s.includes("opaque") && s.includes("EPERM stat"))).toBe(true);
});

test("a hard-linked sunlnk file stays quarantined without truncation", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-hardlink-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(root);
  const file = join(root, "payload");
  const other = join(base, "other");
  writeFileSync(file, "shared content");
  linkSync(file, other);
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    statAt: (fd, name) => ({ ...statAt(fd, name), flags: SF_NOUNLINK }),
    unlinkAt: () => { throw new FsatError("EPERM", "sunlnk"); },
  });
  expect(r.verified).toBe(false);
  expect(readFileSync(other, "utf8")).toBe("shared content");
});

test("TemporaryItems with UF_NODUMP and open EPERM qualifies", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-nodump-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(join(root, "T", "TemporaryItems"), { recursive: true });
  const r = sweepVerified([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    statAt: (fd, name) => ({ ...statAt(fd, name), flags: Buffer.from(name).toString() === "TemporaryItems" ? 0x1 : SF_NOUNLINK }),
    openDirAt: (fd, name) => { if (Buffer.from(name).toString() === "TemporaryItems") throw new FsatError("EPERM", "openat"); return openDirAt(fd, name); },
    unlinkAt: () => { throw new FsatError("EPERM", "sunlnk"); },
  });
  expect(r.verified).toBe(true);
});

test("a directory whose open EPERM disappears before parent verification is rejected", () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-transient-");
  dirs.push(base);
  const root = join(base, "per-user");
  mkdirSync(join(root, "T", "TemporaryItems"), { recursive: true });
  writeFileSync(join(root, "T", "TemporaryItems", "payload"), "private content");
  let opens = 0;
  const r = sweep([{ path: root, owned: true, sunlnk: true }], (st) => st.uid === (process.getuid?.() ?? -1), {
    remove: true,
    statAt: (fd, name) => ({ ...statAt(fd, name), flags: SF_NOUNLINK }),
    openDirAt: (fd, name) => {
      if (Buffer.from(name).toString() === "TemporaryItems" && ++opens === 1) throw new FsatError("EPERM", "openat");
      return openDirAt(fd, name);
    },
    unlinkAt: () => { throw new FsatError("EPERM", "sunlnk"); },
  });
  expect(opens).toBeGreaterThanOrEqual(2);
  expect(r.left.length).toBeGreaterThan(0);
  expect(readFileSync(join(root, "T", "TemporaryItems", "payload"), "utf8")).toBe("private content");
});

test("helper deletes the account and records only verified empty leftovers", async () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-helper-");
  dirs.push(base);
  const w = fakeSeatWorld(base, join(base, "walkie-home"));
  expect((await createSeatUser(1, w.sys)).ok).toBe(true);
  const path = "/private/var/folders/ab/seat/0";
  const r = await destroySeatUser(1, { ...w.sys, sweepAsUser: async (name, uid, roots) => {
    const swept = await w.sys.sweepAsUser(name, uid, roots);
    return { ...swept, leftoverDirs: [path] };
  } });
  expect(r).toMatchObject({ ok: true, leftoverDirs: [path] });
  expect(w.users.has("walkie-s1")).toBe(false);
  expect(w.sys.ledger().pending(w.sys.caller())).toEqual([]);
});

test("the next destroy retry retires a formerly quarantined uid and clears the doctor failure", async () => {
  const base = mkdtempSync("/tmp/walkie-sunlnk-retry-");
  dirs.push(base);
  const w = fakeSeatWorld(base, join(base, "walkie-home"));
  expect((await createSeatUser(1, w.sys)).ok).toBe(true);
  const original = w.sys.sweepAsUser;
  let attempts = 0;
  const sys = { ...w.sys, sweepAsUser: async (name: string, uid: number, roots: string[]) => {
    if (++attempts === 1) return { ok: false, left: ["/private/var/folders/ab/seat/0: EPERM"] };
    const swept = await original(name, uid, roots);
    return { ...swept, leftoverDirs: ["/private/var/folders/ab/seat/0 (EPERM listing)"] };
  } };
  const first = await destroySeatUser(1, sys);
  expect(first.ok).toBe(false);
  expect(w.users.has("walkie-s1")).toBe(true);
  const second = await destroySeatUser(1, sys);
  expect(second).toMatchObject({ ok: true, leftoverDirs: ["/private/var/folders/ab/seat/0 (EPERM listing)"] });
  expect(w.users.has("walkie-s1")).toBe(false);
  expect(w.sys.ledger().pending(w.sys.caller())).toEqual([]);
  expect(w.sys.ledger().high()).toBe(1);
  expect((await createSeatUser(1, w.sys)).ok).toBe(false);
  expect((await createSeatUser(2, w.sys)).ok).toBe(true);
  const facts = { team: "test", release: false, runnerProblem: null, helper: "ok" as const, rootsFile: "ok" as const,
    runtimes: { claude: "/x", codex: "/x" } };
  const checks = doctorChecks({ quarantined: [] } as unknown as SeatsLocalView, facts);
  expect(checks.some((x) => x.what.includes("seat users not verified removed"))).toBe(false);
});

test("doctor gives an openable troubleshooting URL", () => {
  const checks = doctorChecks({ quarantined: ["walkie-s1"] } as SeatsLocalView, {
    team: "test", release: false, runnerProblem: null, helper: "ok", rootsFile: "ok",
    runtimes: { claude: "/x", codex: "/x" },
  });
  expect(checks.find((x) => x.what.includes("awaiting cleanup"))?.fix)
    .toContain("https://github.com/alexcarney460-hue/walkie/blob/main/docs/INSTALL.md#8-remote-seats-optional");
});
