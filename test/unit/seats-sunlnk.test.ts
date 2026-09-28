import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FsatError, isDir, statAt, unlinkAt } from "../../src/daemon/seats/fsat.ts";
import { sweepVerified } from "../../src/daemon/seats/sweep.ts";
import { createSeatUser, destroySeatUser } from "../../src/daemon/seats/admin.ts";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";
import { doctorChecks } from "../../src/cli/commands/seats-enable.ts";
import type { SeatsLocalView } from "../../src/protocol/seats.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

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
    expect(r.leftoverDirs).toContain(join(root, nested));
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
      statAt: (fd, name) => { const st = statAt(fd, name); return { ...st, flags: isDir(st) ? (kind === "flags" ? 0x00100002 : 0x00100000) : 0 }; },
      unlinkAt: (fd, name, dir) => { if (dir || kind === "file" || kind === "symlink") throw new FsatError("EPERM", "sunlnk"); unlinkAt(fd, name, dir); },
    });
    expect(r.verified).toBe(false);
  }
});

test("other flags and another user's entry still block verification", () => {
  expect(folder(0x00100002).verified).toBe(false);
  expect(folder(0x00100000, true).verified).toBe(false);
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

test("doctor gives an openable troubleshooting URL", () => {
  const checks = doctorChecks({ quarantined: ["walkie-s1"] } as SeatsLocalView, {
    team: "test", release: false, runnerProblem: null, helper: "ok", rootsFile: "ok",
    runtimes: { claude: "/x", codex: "/x" },
  });
  expect(checks.find((x) => x.what.includes("seat users not verified removed"))?.fix)
    .toContain("https://github.com/alexcarney460-hue/walkie/blob/main/docs/INSTALL.md#8-remote-seats-optional");
});
