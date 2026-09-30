import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSeatUser, destroySeatUser, pendingSeatUsers, seatHome } from "../../src/daemon/seats/admin.ts";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";
import { UF_DATAVAULT } from "../../src/daemon/seats/fsat.ts";
import { SeatsHost } from "../../src/daemon/seats/host.ts";
import { Database } from "bun:sqlite";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function world() {
  const base = mkdtempSync("/tmp/walkie-round13-");
  dirs.push(base);
  return fakeSeatWorld(base, join(base, "walkie"));
}
const proof = (path: string) => { const st = lstatSync(path); return [{ path, reason: "EPERM open", dev: st.dev, ino: st.ino }]; };

test("verified protected Library residue retires the home, deletes account and finishes ledger", async () => {
  const w = world();
  expect((await createSeatUser(1, w.sys)).ok).toBe(true);
  const home = seatHome(w.sys, 1);
  const mail = join(home, "Library", "Mail");
  mkdirSync(mail, { recursive: true });
  rmSync(join(home, "walkie-seats"), { recursive: true });
  w.sys.sweepAsUser = async () => ({ ok: true, left: [], residuePaths: [mail], residueProofs: proof(mail), leftoverDirs: [`${mail} (EPERM open)`] });
  const r = await destroySeatUser(1, w.sys);
  if (!r.ok) throw new Error(JSON.stringify(r));
  expect(r.ok).toBe(true);
  expect(w.users.has("walkie-s1")).toBe(false);
  expect(existsSync(home)).toBe(false);
  expect((await import("node:fs")).readdirSync(join(w.homes, ".walkie-retired")).some((entry) => /^walkie-s1-600001-[0-9a-f]{32}$/.test(entry))).toBe(true);
  expect(w.sys.ledger().seatResidueSummary(w.sys.caller()).homes).toBe(1);
  expect(pendingSeatUsers(w.sys)).toMatchObject({ ok: true, ids: [], residueSummary: { homes: 1, vaults: 0 } });
});

test("readable leftovers and wrong home identities stay quarantined", async () => {
  for (const kind of ["readable", "symlink", "other-owner"] as const) {
    const w = world();
    expect((await createSeatUser(1, w.sys)).ok).toBe(true);
    const home = seatHome(w.sys, 1);
    const mail = join(home, "Library", "Mail");
    mkdirSync(mail, { recursive: true });
    rmSync(join(home, "walkie-seats"), { recursive: true });
    if (kind === "readable") writeFileSync(join(home, "readable"), "escape");
    if (kind === "other-owner") w.rootOwned.add(home);
    if (kind === "symlink") { rmSync(home, { recursive: true }); symlinkSync(w.outside, home); }
    w.sys.sweepAsUser = async () => ({ ok: true, left: [], residuePaths: [mail], residueProofs: proof(mail), leftoverDirs: [] });
    const r = await destroySeatUser(1, w.sys);
    expect(r.ok).toBe(false);
    expect(w.users.has("walkie-s1")).toBe(true);
  }
});

test("Apple cache vaults require a root-observed flag and seat ownership", async () => {
  for (const valid of [true, false]) {
    const w = world();
    expect((await createSeatUser(1, w.sys)).ok).toBe(true);
    const cache = w.sys.cacheDir as string;
    const vault = join(cache, "com.apple.aneuserd");
    mkdirSync(vault);
    w.vaults.set(vault, { uid: 600001, flags: valid ? UF_DATAVAULT : 0 });
    w.sys.sweepAsUser = async () => {
      rmSync(join(seatHome(w.sys, 1), "walkie-seats"), { recursive: true, force: true });
      return { ok: true, left: [], residuePaths: [vault], residueProofs: proof(vault), leftoverDirs: [`${vault} (EPERM open)`] };
    };
    const r = await destroySeatUser(1, w.sys);
    expect(r.ok).toBe(valid);
    expect(w.users.has("walkie-s1")).toBe(!valid);
    expect(w.sys.ledger().seatResidueSummary(w.sys.caller()).vaults).toBe(valid ? 1 : 0);
  }
});

test("a retry records a home moved before its ledger write failed", async () => {
  const w = world();
  expect((await createSeatUser(1, w.sys)).ok).toBe(true);
  const home = seatHome(w.sys, 1);
  const mail = join(home, "Library", "Mail");
  mkdirSync(mail, { recursive: true });
  rmSync(join(home, "walkie-seats"), { recursive: true });
  w.sys.sweepAsUser = async () => ({ ok: true, left: [], residuePaths: existsSync(home) ? [mail] : [], residueProofs: existsSync(home) ? proof(mail) : [] });
  const ledger = w.sys.ledger();
  const save = ledger.saveSeatResidue.bind(ledger);
  let fail = true;
  ledger.saveSeatResidue = ((...args: Parameters<typeof save>) => {
    if (fail) { fail = false; throw new Error("ledger write failed"); }
    return save(...args);
  }) as typeof save;
  expect((await destroySeatUser(1, w.sys)).ok).toBe(false);
  expect(w.users.has("walkie-s1")).toBe(true);
  const db = new Database(ledger.path, { readonly: true });
  try {
    const record = db.query("SELECT uid, source_dev, source_ino, tombstone FROM seat_home_retirement WHERE n = 1").get() as
      { uid: number; source_dev: number; source_ino: number; tombstone: string } | null;
    expect(record?.uid).toBe(600001);
    expect(record?.tombstone).toMatch(/^walkie-s1-600001-[0-9a-f]{32}$/);
    expect(record?.source_ino).toBe(lstatSync(join(w.homes, ".walkie-retired", record!.tombstone)).ino);
  } finally { db.close(); }
  expect((await destroySeatUser(1, w.sys)).ok).toBe(true);
  expect(ledger.seatResidueSummary(w.sys.caller()).homes).toBe(1);
});

test("a failed home lock or move keeps the account quarantined with its reason", async () => {
  const w = world();
  expect((await createSeatUser(1, w.sys)).ok).toBe(true);
  const home = seatHome(w.sys, 1);
  const mail = join(home, "Library", "Mail");
  mkdirSync(mail, { recursive: true });
  rmSync(join(home, "walkie-seats"), { recursive: true });
  w.sys.sweepAsUser = async () => ({ ok: true, left: [], residuePaths: [mail], residueProofs: proof(mail) });
  w.sys.retireHome = () => { throw new Error("rename EPERM"); };
  const r = await destroySeatUser(1, w.sys);
  expect(r.ok).toBe(false);
  expect(r.why).toContain("rename EPERM");
  expect(w.users.has("walkie-s1")).toBe(true);
});

test("a tombstoned home releases its host slot only after helper success", async () => {
  const w = world();
  expect((await createSeatUser(1, w.sys)).ok).toBe(true);
  const home = seatHome(w.sys, 1);
  const mail = join(home, "Library", "Mail");
  mkdirSync(mail, { recursive: true });
  rmSync(join(home, "walkie-seats"), { recursive: true });
  w.sys.sweepAsUser = async () => ({ ok: true, left: [], residuePaths: [mail], residueProofs: proof(mail) });
  const host = Object.create(SeatsHost.prototype) as Record<string, unknown>;
  Object.assign(host, {
    quarantine: new Set(["walkie-s1"]), quarantineWhy: new Map(), liveUsers: new Set([1]),
    residueSummary: { homes: 0, vaults: 0, knownBytes: 0 }, closing: false,
    save: () => true, rebalance: () => undefined, log: { info: () => undefined, warn: () => undefined },
    adminOp: async () => destroySeatUser(1, w.sys),
  });
  expect((host.blockingQuarantine as () => number).call(host)).toBe(1);
  expect(await (host.destroyOnce as (n: number) => Promise<{ ok: boolean }>).call(host, 1)).toEqual({ ok: true });
  expect((host.blockingQuarantine as () => number).call(host)).toBe(0);
  expect((host.residueSummary as { homes: number }).homes).toBe(1);
});
