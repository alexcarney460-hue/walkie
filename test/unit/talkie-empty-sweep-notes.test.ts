import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyUidSweepVerification } from "../../src/daemon/seats/admin-sys.ts";
import { sweep } from "../../src/daemon/seats/sweep.ts";
import { FsatError, openDirAt } from "../../src/daemon/seats/fsat.ts";

test("empty uid repair refuses a skipped other-owner subtree", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-empty-note-"));
  try {
    mkdirSync(join(root, "other", "deep"), { recursive: true });
    const result = sweep([{ path: root }], () => false, { remove: false, canWrite: () => true, maxDepth: 1 });
    expect(result.left).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(result.notes.join(" ")).toContain("not walked");
    expect(emptyUidSweepVerification(result)).toMatchObject({ ok: false, left: [expect.stringContaining("not walked")] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("empty uid repair refuses EACCES and EPERM opening another owner's subtree", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-empty-denied-"));
  try {
    mkdirSync(join(root, "other"));
    for (const denied of ["EACCES", "EPERM"]) {
      const result = sweep([{ path: root }], () => false, { remove: false, canWrite: () => true, verifySkippedSubtrees: true,
        openDirAt: (fd, name) => Buffer.from(name).toString() === "other"
          ? (() => { throw new FsatError(denied, "denied subtree"); })() : openDirAt(fd, name),
      });
      expect(result.notes.join(" ")).toContain(denied);
      expect(emptyUidSweepVerification(result).ok).toBe(false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
