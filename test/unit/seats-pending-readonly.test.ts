import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pendingSeatUsers } from "../../src/daemon/seats/admin.ts";
import { readSeatPendingReadOnly } from "../../src/daemon/seats/admin-sys.ts";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = () => { const dir = mkdtempSync(join(import.meta.dir, ".pending-readonly-")); dirs.push(dir); return dir; };

test("pending uses only the read-only probe", () => {
  const dir = fixture();
  const world = fakeSeatWorld(dir, join(dir, "walkie"));
  const sys = { ...world.sys, ledger: () => { throw new Error("mutating ledger opened"); },
    pendingReadOnly: () => ({ ids: [3], summary: { homes: 0, vaults: 0, knownBytes: 0 } }) };
  expect(pendingSeatUsers(sys)).toMatchObject({ ok: true, ids: [3] });
});

test("read-only pending does not create a missing database or migrate an old schema", () => {
  const path = join(fixture(), "seat-admin.sqlite");
  expect(readSeatPendingReadOnly(path, 501, false)).toEqual({ ids: [], summary: { homes: 0, vaults: 0, knownBytes: 0 } });
  expect(existsSync(path)).toBe(false);
  const db = new Database(path);
  db.exec("CREATE TABLE ids (n INTEGER PRIMARY KEY, owner INTEGER, state TEXT)");
  db.query("INSERT INTO ids VALUES (1, 501, 'created')").run();
  db.close();
  expect(() => readSeatPendingReadOnly(path, 501, false)).toThrow();
  const check = new Database(path, { readonly: true, create: false });
  expect(check.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()).toEqual([{ name: "ids" }]);
  check.close();
});
