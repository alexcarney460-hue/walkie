import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Vault } from "../../src/accounts/vault/vault.ts";

test("vault key liveness check leaves its write transaction available", () => {
  const home = mkdtempSync(join(import.meta.dir, ".vault-claim-tx-"));
  const vault = Vault.open(home);
  const db = new Database(join(home, "vault.db"));
  db.query("INSERT INTO meta (k, v) VALUES ('key_claim', ?)").run("987654:old");
  db.close();
  const original = process.kill;
  let writable = false;
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid !== 987654) return original(pid, signal);
    const other = new Database(join(home, "vault.db"));
    try {
      other.exec("PRAGMA busy_timeout = 1");
      other.exec("BEGIN IMMEDIATE");
      writable = true;
      other.exec("ROLLBACK");
    } catch { /* the assertion below reports the held transaction */ }
    finally { other.close(); }
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  }) as typeof process.kill;
  try {
    expect((vault as unknown as { claimKey: (mine: string) => boolean }).claimKey("mine")).toBe(true);
    expect(writable).toBe(true);
  } finally {
    process.kill = original;
    vault.close();
    rmSync(home, { recursive: true, force: true });
  }
});
