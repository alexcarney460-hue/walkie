import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createSeatUser, destroySeatUser } from "../../src/daemon/seats/admin.ts";
import { Ledger } from "../../src/daemon/seats/admin-ledger.ts";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("scheduler edits and a slow sweep leave the id ledger writable by another helper", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".ledger-short-"));
  dirs.push(dir);
  const world = fakeSeatWorld(dir, join(dir, "walkie-home"));
  const ledgerPath = join(dir, "seat-admin.sqlite");
  const probe = () => {
    const db = new Database(ledgerPath);
    try {
      db.exec("PRAGMA busy_timeout = 1");
      db.exec("BEGIN IMMEDIATE");
      db.exec("ROLLBACK");
    } finally { db.close(); }
  };
  let edits = 0;
  let sweeps = 0;
  const sys = {
    ...world.sys,
    denySchedulers: (name: string) => { probe(); edits++; world.sys.denySchedulers(name); },
    sweepAsUser: async (...args: Parameters<typeof world.sys.sweepAsUser>) => {
      probe();
      await Bun.sleep(5);
      sweeps++;
      return world.sys.sweepAsUser(...args);
    },
  };
  expect((await createSeatUser(1, sys)).ok).toBe(true);
  expect((await destroySeatUser(1, sys)).ok).toBe(true);
  expect([edits, sweeps]).toEqual([1, 1]);
  expect(world.sys.ledger().pending(world.sys.caller())).toEqual([]);
}, 120_000);

test("verified OS removal is still unverified to the daemon when the ledger result cannot be recorded", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".ledger-finish-"));
  dirs.push(dir);
  const world = fakeSeatWorld(dir, join(dir, "walkie-home"));
  expect((await createSeatUser(1, world.sys)).ok).toBe(true);
  const ledger = world.sys.ledger();
  const finish = ledger.finish.bind(ledger);
  ledger.finish = (n, op, state) => {
    if (state === "destroyed") throw new Error("ledger write failed");
    finish(n, op, state);
  };
  const result = await destroySeatUser(1, world.sys);
  expect(result.ok).toBe(false);
  expect(result.why).toContain("ledger write failed");
  expect(ledger.pending(world.sys.caller())).toEqual([1]);
}, 120_000);

test("operation liveness probes run outside seat and Talkie write transactions", () => {
  const dir = mkdtempSync(join(import.meta.dir, ".ledger-liveness-"));
  dirs.push(dir);
  const path = join(dir, "ids.sqlite");
  const probe = () => {
    const db = new Database(path);
    try { db.exec("PRAGMA busy_timeout = 1"); db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK"); }
    finally { db.close(); }
    return false;
  };
  const ledger = new Ledger(path, false, probe);
  const old = { pid: 111, start: "old" };
  const next = { pid: 222, start: "next" };
  expect(ledger.reserve(1, 501, old).ok).toBe(true);
  expect(ledger.takeForDestroy(1, 501, next).ok).toBe(true);
  expect(ledger.claimTalkie(550_000, 501, "generation", "test-instance", old)).toBe(true);
  expect(ledger.takeTalkieForDestroy(550_000, 501, "generation", next).ok).toBe(true);
  ledger.close();
}, 120_000);

test("a holder change during the out-of-transaction probe stays busy", () => {
  const dir = mkdtempSync(join(import.meta.dir, ".ledger-holder-race-"));
  dirs.push(dir);
  const path = join(dir, "ids.sqlite");
  const ledger = new Ledger(path, false, () => {
    const db = new Database(path);
    try { db.query("UPDATE ids SET op_pid = ?, op_start = ? WHERE n = 1").run(333, "new-holder"); }
    finally { db.close(); }
    return false;
  });
  const old = { pid: 111, start: "old" };
  expect(ledger.reserve(1, 501, old).ok).toBe(true);
  expect(ledger.takeForDestroy(1, 501, { pid: 222, start: "next" })).toMatchObject({ ok: false, busy: true });
  ledger.close();
}, 120_000);
