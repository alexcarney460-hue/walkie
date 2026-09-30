import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";
import { Ledger } from "../../src/daemon/seats/admin-ledger.ts";
import { createTalkieUser as createWithOwner, destroyTalkieUser, reconcileTalkieUser as reconcileWithOwner, talkieStatus, TALKIE_UID } from "../../src/daemon/seats/talkie-user.ts";
import type { AdminSys } from "../../src/daemon/seats/admin.ts";
import { TalkieOsUser } from "../../src/daemon/orchestrator/os-user.ts";
import { unsafeTalkieLockPermissions } from "../../src/daemon/seats/talkie-lock.ts";
import { openTalkieLedgerReadOnly, readTalkieOwnerReadOnly } from "../../src/daemon/seats/admin-sys.ts";
const TEST_INSTANCE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const createTalkieUser = (sys: AdminSys, generation: string = randomUUID()) => createWithOwner(sys, generation, TEST_INSTANCE);
const reconcileTalkieUser = (sys: AdminSys) => reconcileWithOwner(sys,
  sys.ledger().talkieOwner(TALKIE_UID)?.generation ?? randomUUID(), TEST_INSTANCE);

test("the real root lock rejects group or other read access", () => {
  expect(unsafeTalkieLockPermissions(0o600, 0, true)).toBe(false);
  expect(unsafeTalkieLockPermissions(0o640, 0, true)).toBe(true);
  expect(unsafeTalkieLockPermissions(0o604, 0, true)).toBe(true);
  expect(unsafeTalkieLockPermissions(0o600, 501, true)).toBe(true);
});

test("the read-only ownership ledger waits five seconds for a writer", () => {
  const root = mkdtempSync("/tmp/walkie-talkie-readonly-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    const path = world.sys.ledger().path;
    const db = openTalkieLedgerReadOnly(path);
    try { expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 }); }
    finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("read-only status treats an older owner row without instance as unowned", () => {
  const root = mkdtempSync("/tmp/walkie-talkie-legacy-");
  try {
    const path = join(root, "owner.sqlite");
    const writer = new Database(path);
    writer.exec("CREATE TABLE talkie_owner (uid INTEGER PRIMARY KEY, owner INTEGER NOT NULL, state TEXT NOT NULL, generation TEXT)");
    writer.query("INSERT INTO talkie_owner (uid, owner, state, generation) VALUES (?, ?, ?, ?)")
      .run(TALKIE_UID, 501, "created", "11111111-1111-4111-8111-111111111111");
    writer.close();
    const reader = openTalkieLedgerReadOnly(path);
    try { expect(readTalkieOwnerReadOnly(reader, TALKIE_UID)?.instance).toBeNull(); }
    finally { reader.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Talkie scheduler edits leave the ledger writable", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-schedulers-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    const sys = { ...world.sys, denySchedulers: (name: string) => {
      const db = new Database(world.sys.ledger().path);
      try { db.exec("PRAGMA busy_timeout = 1"); db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK"); }
      finally { db.close(); }
      world.sys.denySchedulers(name);
    } };
    expect((await createTalkieUser(sys)).ok).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy single-folder residue migrates to per-folder ledger rows", () => {
  const root = mkdtempSync("/tmp/walkie-talkie-migrate-");
  try {
    const path = join(root, "ledger.sqlite");
    const old = new Database(path, { create: true });
    old.exec("CREATE TABLE talkie_residue (uid INTEGER PRIMARY KEY, owner INTEGER NOT NULL, folder TEXT NOT NULL, paths TEXT NOT NULL)");
    old.query("INSERT INTO talkie_residue VALUES (?, ?, ?, ?)")
      .run(TALKIE_UID, 501, "/private/var/folders/ab/old-talkie", JSON.stringify(["/private/var/folders/ab/old-talkie/0/dmd (EPERM stat)"]));
    old.close();
    const ledger = new Ledger(path);
    try {
      expect(ledger.talkieResidues(TALKIE_UID)).toHaveLength(1);
      expect(ledger.talkieResidues(TALKIE_UID)[0]?.folder).toBe("/private/var/folders/ab/old-talkie");
    } finally { ledger.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("each Talkie destroy sweeps every older folder as the dedicated user and preserves each ledger row", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-residue-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    world.sys.acl = () => "";
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const third = "33333333-3333-4333-8333-333333333333";
    const folder = "/private/var/folders/ab/old-talkie";
    const newer = "/private/var/folders/ab/new-talkie";
    const residue = `${folder}/0/dmd (EPERM stat)`;
    const nextResidue = `${newer}/T/TemporaryItems (EPERM open; flags=0x00000000)`;
    const sweep = world.sys.sweepAsUser;
    const inspected: string[][] = [];
    let generation = 0;
    const sys = { ...world.sys,
      sweepAsUser: async (name: string, uid: number, roots: string[], old: string[] = []) => {
        inspected.push(old);
        const result = await sweep(name, uid, roots);
        generation++;
        return { ...result, leftoverDirs: generation === 1 ? [residue] : generation === 2 ? [residue, nextResidue] : [nextResidue] };
      },
    };
    expect((await createTalkieUser(sys, first)).ok).toBe(true);
    expect((await destroyTalkieUser(sys, first)).ok).toBe(true);
    expect(world.sys.ledger().talkieResidues(TALKIE_UID)).toEqual([{ owner: world.sys.caller(), folder, paths: [residue] }]);
    const reopened = new Ledger(world.sys.ledger().path);
    try { expect(reopened.talkieResidues(TALKIE_UID)[0]?.paths).toEqual([residue]); }
    finally { reopened.close(); }
    expect((await createTalkieUser(sys, second)).ok).toBe(true);
    expect((await destroyTalkieUser(sys, second)).ok).toBe(true);
    expect(inspected).toEqual([[], [folder]]);
    expect(world.sys.ledger().talkieResidues(TALKIE_UID).map((r) => r.folder)).toEqual([newer, folder]);
    expect((await createTalkieUser(sys, third)).ok).toBe(true);
    expect((await destroyTalkieUser(sys, third)).ok).toBe(true);
    expect(inspected[2]).toEqual([newer, folder]);
    expect(world.sys.ledger().talkieResidues(TALKIE_UID).map((r) => r.folder)).toEqual([newer]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("destroy accepts a real sweep's per-user root entry after child residue", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-root-residue-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    world.sys.acl = () => "";
    const folder = "/private/var/folders/ab/old-talkie";
    const paths = [`${folder}/T/TemporaryItems (EPERM open; flags=0x00000000)`,
      `${folder} (macOS system protection; SF_NOUNLINK; flags=0x00100000)`];
    const original = world.sys.sweepAsUser;
    const sys = { ...world.sys, sweepAsUser: async (name: string, uid: number, roots: string[], old?: string[]) =>
      ({ ...(await original(name, uid, roots, old)), leftoverDirs: paths }) };
    expect((await createTalkieUser(sys)).ok).toBe(true);
    const destroyed = await reconcileTalkieUser(sys);
    if (!destroyed.ok) throw new Error(destroyed.why);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("planted content in an older folder keeps the account for a retry that sweeps that folder", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-old-folder-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    world.sys.acl = () => "";
    const folder = "/private/var/folders/ab/old-talkie";
    const residue = `${folder}/T/TemporaryItems (EPERM open; flags=0x00000000)`;
    const original = world.sys.sweepAsUser;
    const inspected: string[][] = [];
    let attempt = 0;
    const sys = { ...world.sys, sweepAsUser: async (name: string, uid: number, roots: string[], old: string[] = []) => {
      inspected.push(old);
      if (++attempt === 2) return { ok: false, left: [`${folder}/planted`], leftoverDirs: [] };
      return { ...(await original(name, uid, roots, old)), leftoverDirs: [residue] };
    } };
    expect((await createTalkieUser(sys)).ok).toBe(true);
    expect((await reconcileTalkieUser(sys)).ok).toBe(true);
    expect((await createTalkieUser(sys)).ok).toBe(true);
    expect((await reconcileTalkieUser(sys)).ok).toBe(false);
    expect(world.users.has("walkie-talkie")).toBe(true);
    expect((await reconcileTalkieUser(sys)).ok).toBe(true);
    expect(inspected).toEqual([[], [folder], [folder]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("read-only talkie status reports every repair fact through the helper", () => {
  const root = mkdtempSync("/tmp/walkie-talkie-status-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    world.users.set("walkie-talkie", { uid: TALKIE_UID, gid: TALKIE_UID, gids: [TALKIE_UID] });
    const sys = { ...world.sys, procs: () => [{ pid: 42, stat: "S" }] };
    const before = [...world.users];
    expect(talkieStatus(sys)).toEqual({ ok: true, status: {
      accountUid: TALKIE_UID, uidTaken: true, processes: [42], homeExists: false, ledgerOwner: null,
      generation: null, instance: null,
    } });
    expect([...world.users]).toEqual(before);
    expect(world.destroyed).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("lease cleanup ends every process of the dedicated uid, including a reparented orphan", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-user-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    world.sys.acl = () => "";
    const processes = new Map([[101, { stat: "S", parent: 1 }], [102, { stat: "S", parent: 101 }]]);
    const signals: Array<[number, string]> = [];
    const sys = { ...world.sys,
      procs: (uid: number) => uid === TALKIE_UID ? [...processes].map(([pid, p]) => ({ pid, stat: p.stat })) : [],
      signal: (pid: number, sig: "SIGSTOP" | "SIGKILL") => {
        signals.push([pid, sig]);
        if (sig === "SIGSTOP") processes.get(pid)!.stat = "T";
        else processes.delete(pid);
      },
      sleep: async () => undefined,
      sweepAsUser: async () => { rmSync(join(world.homes, "walkie-talkie", "walkie-seats"), { recursive: true, force: true }); return { ok: true, left: [] }; },
    };
    expect((await createTalkieUser(sys)).ok).toBe(true);
    processes.get(102)!.parent = 1; // the shell exited before the lease was lost
    const result = await reconcileTalkieUser(sys);
    expect(result.ok).toBe(true);
    expect(processes.size).toBe(0);
    expect(signals).toContainEqual([102, "SIGKILL"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unreadable account registry never triggers cleanup of an uncreated uid", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-user-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    let inspected = false;
    const sys = { ...world.sys,
      nameTaken: () => { throw new Error("account registry unavailable"); },
      procs: () => { inspected = true; return []; },
    };
    expect((await createTalkieUser(sys)).ok).toBe(false);
    expect(inspected).toBe(false);
    expect(world.created).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unrecognized dedicated account is never killed or deleted", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-user-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    world.users.set("walkie-talkie", { uid: TALKIE_UID, gid: TALKIE_UID, gids: [TALKIE_UID] });
    writeFileSync(world.sys.talkieLockPath!, "", { mode: 0o600 });
    let killed = false;
    const result = await reconcileTalkieUser({ ...world.sys, signal: () => { killed = true; } });
    expect(result.ok).toBe(false);
    expect(result.why).toContain("not created by Walkie");
    expect(killed).toBe(false);
    expect(world.users.has("walkie-talkie")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed account creation cannot authorize uid-wide cleanup", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-user-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    let killed = false;
    const sys = { ...world.sys,
      createUser: () => { world.users.set("walkie-talkie", { uid: TALKIE_UID, gid: TALKIE_UID, gids: [TALKIE_UID] }); throw new Error("partial create"); },
      signal: () => { killed = true; },
    };
    expect((await createTalkieUser(sys)).ok).toBe(false);
    expect((await reconcileTalkieUser(sys)).ok).toBe(false);
    expect(killed).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a stale monitor cannot destroy a newer run's live uid", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-generation-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    world.sys.platform = "linux";
    world.sys.acl = () => "";
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    expect((await createTalkieUser(world.sys, first)).ok).toBe(true);
    expect((await reconcileTalkieUser(world.sys)).ok).toBe(true);
    expect((await createTalkieUser(world.sys, second)).ok).toBe(true);
    const live = new Map([[9001, { stat: "S" }]]);
    const killed: number[] = [];
    const sys = { ...world.sys,
      procs: (uid: number) => uid === TALKIE_UID ? [...live].map(([pid, p]) => ({ pid, stat: p.stat })) : [],
      signal: (pid: number, sig: "SIGSTOP" | "SIGKILL") => {
        if (sig === "SIGSTOP") live.get(pid)!.stat = "T";
        else { live.delete(pid); killed.push(pid); }
      },
    };
    const stale = await destroyTalkieUser(sys, first);
    expect(stale.ok).toBe(false);
    expect(killed).toEqual([]);
    expect(live.has(9001)).toBe(true);
    expect(world.users.has("walkie-talkie")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed destroy claim still stops the recorded generation's uid without deleting its account", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-full-ledger-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    world.sys.platform = "linux";
    world.sys.acl = () => "";
    const generation = "11111111-1111-4111-8111-111111111111";
    expect((await createTalkieUser(world.sys, generation)).ok).toBe(true);
    const ledger = world.sys.ledger();
    ledger.takeTalkieForDestroy = () => { throw new Error("SQLITE_FULL"); };
    const processes = new Map([[301, "S"], [302, "S"]]);
    const killed: number[] = [];
    const actions: string[] = [];
    const sys = { ...world.sys,
      talkieOwnerReadOnly: (uid: number) => ledger.talkieOwner(uid),
      stopUserServices: (uid: number) => { actions.push(`services:${uid}`); return null; },
      procs: (uid: number) => uid === TALKIE_UID ? [...processes].map(([pid, stat]) => ({ pid, stat })) : [],
      signal: (pid: number, sig: "SIGSTOP" | "SIGKILL") => {
        actions.push(`signal:${pid}:${sig}`);
        if (sig === "SIGSTOP") processes.set(pid, "T");
        else { processes.delete(pid); killed.push(pid); }
      },
      sleep: async () => undefined,
    };
    const result = await destroyTalkieUser(sys, generation);
    expect(result.ok).toBe(false);
    expect(result.why).toContain("SQLITE_FULL");
    expect(actions.indexOf(`services:${TALKIE_UID}`)).toBeGreaterThan(actions.indexOf("signal:301:SIGKILL"));
    expect(killed.sort()).toEqual([301, 302]);
    expect(world.users.has("walkie-talkie")).toBe(true);
    expect(ledger.talkieOwner(TALKIE_UID)?.state).toBe("created");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed destroy claim cannot stop a newer generation", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-full-ledger-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    world.sys.platform = "linux";
    world.sys.acl = () => "";
    const current = "22222222-2222-4222-8222-222222222222";
    expect((await createTalkieUser(world.sys, current)).ok).toBe(true);
    const ledger = world.sys.ledger();
    ledger.takeTalkieForDestroy = () => { throw new Error("SQLITE_FULL"); };
    let killed = false;
    const sys = { ...world.sys,
      talkieOwnerReadOnly: (uid: number) => ledger.talkieOwner(uid),
      signal: () => { killed = true; },
    };
    const result = await destroyTalkieUser(sys, "11111111-1111-4111-8111-111111111111");
    expect(result.ok).toBe(false);
    expect(killed).toBe(false);
    expect(world.users.has("walkie-talkie")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed service stop in the read-only fallback still kills the uid and reports the error", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-service-failure-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    world.sys.platform = "linux";
    world.sys.acl = () => "";
    const generation = "11111111-1111-4111-8111-111111111111";
    expect((await createTalkieUser(world.sys, generation)).ok).toBe(true);
    const ledger = world.sys.ledger();
    ledger.takeTalkieForDestroy = () => { throw new Error("SQLITE_FULL"); };
    const processes = new Map([[301, "S"]]);
    const killed: number[] = [];
    const actions: string[] = [];
    const result = await destroyTalkieUser({ ...world.sys,
      talkieOwnerReadOnly: (uid: number) => ledger.talkieOwner(uid),
      stopUserServices: () => { actions.push("services"); processes.set(302, "S"); return "bootout failed"; },
      procs: () => [...processes].map(([pid, stat]) => ({ pid, stat })),
      signal: (pid: number, sig: "SIGSTOP" | "SIGKILL") => {
        actions.push(`${sig}:${pid}`);
        if (sig === "SIGSTOP") processes.set(pid, "T");
        else { processes.delete(pid); killed.push(pid); }
      },
      sleep: async () => undefined,
    }, generation);
    expect(result.ok).toBe(false);
    expect(result.why).toContain("bootout failed");
    expect(killed).toEqual([301, 302]);
    expect(actions.indexOf("SIGKILL:301")).toBeLessThan(actions.indexOf("services"));
    expect(actions.indexOf("services")).toBeLessThan(actions.indexOf("SIGKILL:302"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed destroy claim stops signaling when the generation changes between kill passes", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-generation-race-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    world.sys.platform = "linux";
    world.sys.acl = () => "";
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    expect((await createTalkieUser(world.sys, first)).ok).toBe(true);
    const ledger = world.sys.ledger();
    ledger.takeTalkieForDestroy = () => { throw new Error("SQLITE_FULL"); };
    let generation = first;
    const processes = new Map([[301, "S"]]);
    const signals: number[] = [];
    const sys = { ...world.sys,
      talkieOwnerReadOnly: (uid: number) => {
        const record = ledger.talkieOwner(uid);
        return record && { ...record, generation };
      },
      procs: (uid: number) => uid === TALKIE_UID ? [...processes].map(([pid, stat]) => ({ pid, stat })) : [],
      signal: (pid: number, sig: "SIGSTOP" | "SIGKILL") => {
        signals.push(pid);
        if (sig === "SIGSTOP") processes.set(pid, "T");
        else processes.delete(pid);
      },
      sleep: async () => { generation = second; processes.set(302, "S"); },
    };
    const result = await destroyTalkieUser(sys, first);
    expect(result.ok).toBe(false);
    expect(result.why).toContain("generation changed");
    expect(signals).not.toContain(302);
    expect(processes.has(302)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("create waits for the failed-claim fallback's lock through service stop and both kill passes", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-interleave-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    world.sys.platform = "linux";
    world.sys.acl = () => "";
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    expect((await createTalkieUser(world.sys, first)).ok).toBe(true);
    const ledger = world.sys.ledger();
    ledger.takeTalkieForDestroy = () => { throw new Error("SQLITE_FULL"); };
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let live = true;
    const fallback = destroyTalkieUser({ ...world.sys,
      talkieOwnerReadOnly: (uid: number) => ledger.talkieOwner(uid),
      procs: () => live ? [{ pid: 301, stat: "S" }] : [],
      signal: (_pid: number, sig: "SIGSTOP" | "SIGKILL") => { if (sig === "SIGKILL") live = false; },
      sleep: async () => { entered(); await gate; },
    }, first);
    await paused;
    let checked = false;
    let settled = false;
    const create = createTalkieUser({ ...world.sys, nameTaken: (name) => { checked = true; return world.sys.nameTaken(name); } }, second)
      .then((result) => { settled = true; return result; });
    await Bun.sleep(20);
    expect(checked).toBe(false);
    expect(settled).toBe(false);
    resume();
    expect((await fallback).ok).toBe(false);
    expect((await create).ok).toBe(false);
    expect(checked).toBe(true);
    expect(ledger.talkieOwner(TALKIE_UID)?.generation).toBe(first);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("destroy rejects an unsafe lock and recreates a missing lock before cleanup", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-unsafe-lock-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    world.sys.platform = "linux";
    world.sys.acl = () => "";
    const generation = "11111111-1111-4111-8111-111111111111";
    expect((await createTalkieUser(world.sys, generation)).ok).toBe(true);
    const lockPath = world.sys.talkieLockPath!;
    let checked = false;
    const sys = { ...world.sys, procs: () => { checked = true; return []; } };
    chmodSync(lockPath, 0o666);
    const unsafe = await destroyTalkieUser(sys, generation);
    expect(unsafe.ok).toBe(false);
    expect(unsafe.why).toContain("unsafe");
    expect(checked).toBe(false);
    unlinkSync(lockPath);
    const missing = await destroyTalkieUser(sys, generation);
    expect(missing.ok).toBe(true);
    expect(checked).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    expect(world.users.has("walkie-talkie")).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cleanup can stop the recorded uid when opening the write ledger fails", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-full-ledger-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    world.sys.platform = "linux";
    world.sys.acl = () => "";
    const generation = "11111111-1111-4111-8111-111111111111";
    expect((await createTalkieUser(world.sys, generation)).ok).toBe(true);
    const ledger = world.sys.ledger();
    let live = true;
    const sys = { ...world.sys,
      ledger: () => { throw new Error("SQLITE_FULL"); },
      talkieOwnerReadOnly: (uid: number) => ledger.talkieOwner(uid),
      procs: (uid: number) => uid === TALKIE_UID && live ? [{ pid: 303, stat: "S" }] : [],
      signal: (_pid: number, sig: "SIGSTOP" | "SIGKILL") => { if (sig === "SIGKILL") live = false; },
      sleep: async () => undefined,
    };
    const result = await destroyTalkieUser(sys, generation);
    expect(result.ok).toBe(false);
    expect(result.why).toContain("SQLITE_FULL");
    expect(live).toBe(false);
    expect(world.users.has("walkie-talkie")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a repeated generation-qualified destroy verifies an already empty uid", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-empty-retry-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    const run = "11111111-1111-4111-8111-111111111111";
    expect((await destroyTalkieUser(world.sys, run)).ok).toBe(true);
    expect(world.created).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing lock creation can be skipped only for a verified empty uid and ledger", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-no-lock-space-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    const sys = { ...world.sys, talkieLockPath: join(root, "missing-directory", "talkie.lock"),
      talkieOwnerReadOnly: () => null };
    expect((await reconcileTalkieUser(sys)).ok).toBe(true);
    expect((await destroyTalkieUser(sys, "11111111-1111-4111-8111-111111111111")).ok).toBe(true);
    world.users.set("walkie-talkie", { uid: TALKIE_UID, gid: TALKIE_UID, gids: [TALKIE_UID] });
    const occupied = await reconcileTalkieUser(sys);
    expect(occupied.ok).toBe(false);
    expect(occupied.why).toContain("ENOENT");
    world.users.delete("walkie-talkie");
    const unknown = await reconcileTalkieUser({ ...sys, talkieOwnerReadOnly: () => { throw new Error("ledger unreadable"); } });
    expect(unknown.ok).toBe(false);
    expect(unknown.why).toContain("ledger unreadable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("prepare reconciles then creates the dedicated user on a fresh machine", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-fresh-");
  const world = fakeSeatWorld(root, join(root, "walkie"));
  world.sys.platform = "linux";
  world.sys.acl = () => "";
  const calls: string[] = [];
  const user = new TalkieOsUser(join(root, "daemon.sock"), () => false, {
    ready: () => true, privateHome: () => null, socketRoot: root,
    existing: () => world.users.has("walkie-talkie"),
    monitor: () => ({ kill: () => undefined }),
    admin: async (verb, generation) => {
      calls.push(verb);
      return verb === "talkie-status" ? talkieStatus(world.sys)
        : verb === "talkie-reconcile" ? reconcileWithOwner(world.sys, generation as string, TEST_INSTANCE)
        : verb === "talkie-create" ? createTalkieUser(world.sys, generation)
          : destroyTalkieUser(world.sys, generation as string);
    },
  });
  try {
    expect(existsSync(world.sys.talkieLockPath!)).toBe(false);
    await user.prepare();
    expect(calls).toEqual(["talkie-status", "talkie-reconcile", "talkie-create"]);
    expect(world.created).toEqual(["walkie-talkie"]);
    expect(statSync(world.sys.talkieLockPath!).mode & 0o777).toBe(0o600);
    await user.destroy();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the ownership ledger holds create and destroy operations exclusively", () => {
  const root = mkdtempSync("/tmp/walkie-talkie-lock-");
  const ledger = new Ledger(join(root, "owner.sqlite"), false, () => true);
  const create = { pid: 101, start: "create" };
  const destroy = { pid: 102, start: "destroy" };
  const concurrent = { pid: 103, start: "concurrent" };
  const run = "11111111-1111-4111-8111-111111111111";
  try {
    expect(ledger.claimTalkie(TALKIE_UID, 501, run, TEST_INSTANCE, create)).toBe(true);
    expect(ledger.takeTalkieForDestroy(TALKIE_UID, 501, run, destroy).ok).toBe(false);
    ledger.markTalkieCreated(TALKIE_UID, 501, run, create);
    ledger.releaseTalkieOp(TALKIE_UID, create);
    expect(ledger.takeTalkieForDestroy(TALKIE_UID, 501, run, destroy).ok).toBe(true);
    expect(ledger.takeTalkieForDestroy(TALKIE_UID, 501, run, concurrent).ok).toBe(false);
    expect(ledger.claimTalkie(TALKIE_UID, 501, "22222222-2222-4222-8222-222222222222", TEST_INSTANCE, concurrent)).toBe(false);
  } finally { ledger.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an unreadable helper identity refuses account work", async () => {
  const root = mkdtempSync("/tmp/walkie-talkie-op-");
  try {
    const world = fakeSeatWorld(root, join(root, "walkie"));
    const sys = { ...world.sys, self: () => { throw new Error("ps unavailable"); } };
    expect((await createTalkieUser(sys)).why).toContain("ps unavailable");
    expect((await reconcileTalkieUser(sys)).why).toContain("ps unavailable");
    expect(world.created).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
