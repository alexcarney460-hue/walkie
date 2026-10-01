import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditStrict, auditPath } from "../../src/daemon/admin/audit.ts";
import type { Core } from "../../src/daemon/core.ts";

test("strict SSH audit creates a private file and appends complete entries", () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-audit-"));
  try {
    const core = { paths: { home } } as Core;
    const entry = { actor: "@alex/owner/person", action: "SSH tunnel opened", machine: "target", via: "remote" as const };
    appendAuditStrict(core, entry);
    appendAuditStrict(core, { ...entry, action: "SSH tunnel closed" });
    const lines = readFileSync(auditPath(home), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { action: string });
    expect(lines.map((line) => line.action)).toEqual(["SSH tunnel opened", "SSH tunnel closed"]);
    expect(statSync(auditPath(home)).mode & 0o777).toBe(0o600);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("strict SSH audit syncs the parent directory on every open", () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-audit-sync-"));
  const realSync = fs.fsyncSync;
  const synced: string[] = [];
  const sync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    synced.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file");
    realSync(fd);
  });
  try {
    const core = { paths: { home } } as Core;
    const entry = { actor: "@alex/node", action: "SSH tunnel opened", machine: "target", via: "remote" as const };
    appendAuditStrict(core, entry);
    appendAuditStrict(core, entry);
    expect(synced).toEqual(["file", "directory", "file", "directory"]);
  } finally {
    sync.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
});
