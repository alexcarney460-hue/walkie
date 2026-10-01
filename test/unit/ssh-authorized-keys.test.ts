import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeOwnerKey, revokeOwnerKeys, hasOwnerKey, ownerKeyLine, restoreOwnerKeys, snapshotOwnerKeys } from "../../src/daemon/ssh/authorized-keys.ts";
import { withOwnerKeysLock } from "../../src/daemon/ssh/keys-lock.ts";

const sshBlob = (fill: number): string => {
  const name = Buffer.from("ssh-ed25519");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(name.length);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(32);
  return Buffer.concat([header, name, length, Buffer.alloc(32, fill)]).toString("base64");
};
const key = `ssh-ed25519 ${sshBlob(7)} owner`;

describe("owner authorized_keys", () => {
  test("adds one loopback-only key, preserves other lines, and revokes exactly tagged lines", () => {
    const home = mkdtempSync(join(tmpdir(), "walkie-ssh-"));
    try {
      const dir = join(home, ".ssh");
      mkdirSync(dir);
      const path = join(dir, "authorized_keys");
      const original = `# keep\nssh-ed25519 ${sshBlob(8)} friend\n`;
      writeFileSync(path, original, { mode: 0o600 });
      authorizeOwnerKey(home, "team1", "alex", key);
      const first = readFileSync(path, "utf8");
      expect(first).toContain('from="127.0.0.1,::1"');
      expect(first).toContain("walkie-owner:team1:alex");
      authorizeOwnerKey(home, "team1", "alex", key);
      expect(readFileSync(path, "utf8")).toBe(first);
      authorizeOwnerKey(home, "team1", "other", `ssh-ed25519 ${sshBlob(9)}`);
      expect(hasOwnerKey(home, "team1", "alex", key)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      revokeOwnerKeys(home, "team1", "alex");
      expect(readFileSync(path, "utf8")).toContain(original);
      expect(hasOwnerKey(home, "team1", "other")).toBe(true);
      revokeOwnerKeys(home, "team1", "other");
      expect(readFileSync(path, "utf8")).toBe(original);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("refuses an authorized_keys symlink", () => {
    const home = mkdtempSync(join(tmpdir(), "walkie-ssh-"));
    try {
      mkdirSync(join(home, ".ssh"));
      writeFileSync(join(home, "other"), "keep\n");
      symlinkSync(join(home, "other"), join(home, ".ssh", "authorized_keys"));
      expect(() => authorizeOwnerKey(home, "team1", "alex", key)).toThrow();
      expect(readFileSync(join(home, "other"), "utf8")).toBe("keep\n");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("preserves a personal key with the same comment and restores a missing final newline", () => {
    const home = mkdtempSync(join(tmpdir(), "walkie-ssh-"));
    try {
      const dir = join(home, ".ssh");
      mkdirSync(dir);
      const path = join(dir, "authorized_keys");
      const original = `ssh-ed25519 ${sshBlob(8)} walkie-owner:team1:alex`;
      writeFileSync(path, original, { mode: 0o600 });
      authorizeOwnerKey(home, "team1", "alex", key);
      expect(readFileSync(path, "utf8")).toContain(original);
      expect(revokeOwnerKeys(home, "team1", "alex")).toBe(1);
      expect(readFileSync(path, "utf8")).toBe(original);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("add then revoke preserves invalid UTF-8 and every unrelated byte", () => {
    const home = mkdtempSync(join(tmpdir(), "walkie-ssh-"));
    try {
      const dir = join(home, ".ssh");
      mkdirSync(dir);
      const path = join(dir, "authorized_keys");
      const original = Buffer.concat([Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from(`# keep\nssh-ed25519 ${sshBlob(8)} friend`)]);
      writeFileSync(path, original, { mode: 0o600 });
      authorizeOwnerKey(home, "team1", "alex", key);
      expect(hasOwnerKey(home, "team1", "alex", key)).toBe(true);
      expect(revokeOwnerKeys(home, "team1", "alex")).toBe(1);
      expect(readFileSync(path)).toEqual(original);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("a personal key appended before rename survives install and revoke", () => {
    const home = mkdtempSync(join(tmpdir(), "walkie-ssh-"));
    try {
      const path = join(home, ".ssh", "authorized_keys");
      const personal = `ssh-ed25519 ${sshBlob(8)} personal\n`;
      let injected = false;
      authorizeOwnerKey(home, "team1", "alex", key, (step) => {
        if (step !== "before_rename" || injected) return;
        injected = true;
        writeFileSync(path, personal, { flag: "a" });
      });
      expect(injected).toBe(true);
      expect(readFileSync(path, "utf8")).toContain(personal);
      expect(hasOwnerKey(home, "team1", "alex", key)).toBe(true);
      expect(revokeOwnerKeys(home, "team1", "alex")).toBe(1);
      expect(readFileSync(path, "utf8")).toBe(personal);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("a personal append during revoke and a failed install rollback is preserved", () => {
    const home = mkdtempSync(join(tmpdir(), "walkie-ssh-"));
    try {
      const path = join(home, ".ssh", "authorized_keys");
      const personal = `ssh-ed25519 ${sshBlob(8)} personal\n`;
      const later = `ssh-ed25519 ${sshBlob(9)} later\n`;
      mkdirSync(join(home, ".ssh"));
      writeFileSync(path, personal, { mode: 0o600 });
      const snapshot = snapshotOwnerKeys(home);
      authorizeOwnerKey(home, "team1", "alex", key);
      writeFileSync(path, later, { flag: "a" });
      restoreOwnerKeys(home, snapshot);
      expect(readFileSync(path, "utf8")).toBe(personal + later);
      authorizeOwnerKey(home, "team1", "alex", key);
      let injected = false;
      expect(revokeOwnerKeys(home, "team1", "alex", () => {
        if (injected) return;
        injected = true;
        writeFileSync(path, `ssh-ed25519 ${sshBlob(10)} newest\n`, { flag: "a" });
      })).toBe(1);
      expect(injected).toBe(true);
      expect(readFileSync(path, "utf8")).toContain("newest\n");
      expect(readFileSync(path, "utf8")).not.toContain("walkie-owner:team1:alex");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("a second Walkie key edit refuses the held advisory lock", () => {
    const home = mkdtempSync(join(tmpdir(), "walkie-ssh-"));
    try {
      const path = join(home, ".ssh", "authorized_keys");
      mkdirSync(join(home, ".ssh"));
      withOwnerKeysLock(path, () => {
        expect(() => authorizeOwnerKey(home, "team1", "alex", key)).toThrow("already in progress");
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("a rotation interrupted before rewriting still revokes the previously managed key", () => {
    const home = mkdtempSync(join(tmpdir(), "walkie-ssh-"));
    try {
      const dir = join(home, ".ssh");
      mkdirSync(dir);
      const path = join(dir, "authorized_keys");
      const personal = `ssh-ed25519 ${sshBlob(8)} walkie-owner:team1:alex`;
      const old = ownerKeyLine("team1", "alex", key);
      writeFileSync(path, `${personal}\n${old}\n`, { mode: 0o600 });
      writeFileSync(join(dir, "walkie-owner-keys.json"), JSON.stringify({ "walkie-owner:team1:alex": {
        line: ownerKeyLine("team1", "alex", `ssh-ed25519 ${sshBlob(9)}`), added_separator: false,
        previous: { line: old, added_separator: false },
      } }), { mode: 0o600 });
      expect(revokeOwnerKeys(home, "team1", "alex")).toBe(1);
      expect(readFileSync(path, "utf8")).toBe(`${personal}\n`);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe("owner authorized_keys durability and mode", () => {
  const fixture = (): { home: string; dir: string; path: string; original: string } => {
    const home = mkdtempSync(join(tmpdir(), "walkie-ssh-durable-"));
    const dir = join(home, ".ssh");
    mkdirSync(dir);
    const original = `ssh-ed25519 ${sshBlob(8)} friend\n`;
    return { home, dir, path: join(dir, "authorized_keys"), original };
  };
  const tempFiles = (dir: string): string[] => readdirSync(dir).filter((name) => name.includes(".walkie-"));

  /** An fsync that records whether it saw the finished temp file (data) or the renamed target (directory), and checks both. */
  const recorder = (dir: string, path: string, before: string, expected: (contents: string) => boolean): { sync: (fd: number) => void; events: string[] } => {
    const events: string[] = [];
    return { events, sync: () => {
      const temp = tempFiles(dir)[0];
      if (temp) {
        events.push("file");
        expect(expected(readFileSync(join(dir, temp), "utf8"))).toBe(true); // the data is complete before it is synced
        expect(readFileSync(path, "utf8")).toBe(before); // and the person's file is still the old one
      } else {
        events.push("directory");
        expect(expected(readFileSync(path, "utf8"))).toBe(true); // the rename has happened
      }
    } };
  };

  test("an install syncs the new file before the rename and the directory after it", () => {
    const { home, dir, path, original } = fixture();
    try {
      writeFileSync(path, original, { mode: 0o600 });
      const seen = recorder(dir, path, original, (contents) => contents.includes("walkie-owner:team1:alex"));
      authorizeOwnerKey(home, "team1", "alex", key, undefined, seen.sync);
      expect(seen.events).toEqual(["file", "directory"]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("a removal and a rollback sync the same way", () => {
    const { home, dir, path, original } = fixture();
    try {
      writeFileSync(path, original, { mode: 0o600 });
      const snapshot = snapshotOwnerKeys(home);
      authorizeOwnerKey(home, "team1", "alex", key);
      const installed = readFileSync(path, "utf8");
      const removal = recorder(dir, path, installed, (contents) => !contents.includes("walkie-owner") || contents === installed);
      revokeOwnerKeys(home, "team1", "alex", undefined, removal.sync);
      expect(removal.events).toEqual(["file", "directory"]);
      authorizeOwnerKey(home, "team1", "alex", key);
      const again = readFileSync(path, "utf8");
      const rollback = recorder(dir, path, again, (contents) => contents === original || contents === again);
      restoreOwnerKeys(home, snapshot, rollback.sync);
      expect(rollback.events).toEqual(["file", "directory"]);
      expect(readFileSync(path, "utf8")).toBe(original);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("a failed sync of the new file leaves the person's file as it was, with no temp file", () => {
    const { home, dir, path, original } = fixture();
    try {
      writeFileSync(path, original, { mode: 0o600 });
      expect(() => authorizeOwnerKey(home, "team1", "alex", key, undefined, () => { throw new Error("injected fsync failure"); }))
        .toThrow("injected fsync failure");
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(tempFiles(dir)).toEqual([]);
      expect(hasOwnerKey(home, "team1", "alex", key)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("the person's file mode is kept; only a file others can write is tightened to 0600", () => {
    const cases: Array<[number, number]> = [[0o600, 0o600], [0o644, 0o644], [0o640, 0o640], [0o664, 0o600], [0o666, 0o600], [0o620, 0o600]];
    for (const [before, after] of cases) {
      const { home, path, original } = fixture();
      try {
        writeFileSync(path, original);
        chmodSync(path, before);
        authorizeOwnerKey(home, "team1", "alex", key);
        expect(statSync(path).mode & 0o777, `install over ${before.toString(8)}`).toBe(after);
        authorizeOwnerKey(home, "team1", "alex", key); // nothing to change: the mode is still not forced
        expect(statSync(path).mode & 0o777, `repeat over ${before.toString(8)}`).toBe(after);
        revokeOwnerKeys(home, "team1", "alex");
        expect(statSync(path).mode & 0o777, `removal over ${before.toString(8)}`).toBe(after);
        expect(readFileSync(path, "utf8")).toBe(original);
      } finally { rmSync(home, { recursive: true, force: true }); }
    }
  });

  test("a file Walkie creates is private", () => {
    const home = mkdtempSync(join(tmpdir(), "walkie-ssh-durable-"));
    try {
      authorizeOwnerKey(home, "team1", "alex", key);
      expect(existsSync(join(home, ".ssh", "authorized_keys"))).toBe(true);
      expect(statSync(join(home, ".ssh", "authorized_keys")).mode & 0o777).toBe(0o600);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
