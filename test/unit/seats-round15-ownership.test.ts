import { afterEach, expect, test } from "bun:test";
import { linkSync, lstatSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSeatUser, destroySeatUser, seatHome } from "../../src/daemon/seats/admin.ts";
import { AT_FDCWD, statAt } from "../../src/daemon/seats/fsat.ts";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const base = mkdtempSync("/tmp/walkie-round15-owner-");
  dirs.push(base);
  return fakeSeatWorld(base, join(base, "walkie"));
}

test("root requires runner EPERM proof and seat ownership for every retained entry", async () => {
  for (const kind of ["seat", "root", "other", "unstatable", "no-proof"] as const) {
    const w = setup();
    expect((await createSeatUser(1, w.sys)).ok).toBe(true);
    const home = seatHome(w.sys, 1);
    const mail = join(home, "Library", "Mail");
    mkdirSync(mail, { recursive: true });
    rmSync(join(home, "walkie-seats"), { recursive: true });
    if (kind === "root") w.rootOwned.add(mail);
    if (kind === "other") w.otherOwned.add(mail);
    if (kind === "unstatable") w.unstatable.add(mail);
    const st = lstatSync(mail);
    w.sys.sweepAsUser = async () => ({ ok: true, left: [], residuePaths: [mail],
      residueProofs: kind === "no-proof" ? [] : [{ path: mail, reason: "EPERM open", dev: st.dev, ino: st.ino }] });
    const result = await destroySeatUser(1, w.sys);
    expect(result.ok).toBe(kind === "seat");
    if (kind !== "seat") expect(w.users.has("walkie-s1")).toBe(true);
  }
});

test("a retained file hard-linked outside the home keeps the seat quarantined", async () => {
  const w = setup();
  expect((await createSeatUser(1, w.sys)).ok).toBe(true);
  const home = seatHome(w.sys, 1);
  const retained = join(home, "retained");
  writeFileSync(retained, "seat data");
  linkSync(retained, join(w.outside, "reachable"));
  rmSync(join(home, "walkie-seats"), { recursive: true });
  const st = lstatSync(retained);
  expect(st.nlink).toBe(2);
  expect(statAt(AT_FDCWD(), retained).nlink).toBe(st.nlink);
  w.sys.sweepAsUser = async () => ({ ok: true, left: [], residuePaths: [retained],
    residueProofs: [{ path: retained, reason: "EPERM open", dev: st.dev, ino: st.ino }] });
  const result = await destroySeatUser(1, w.sys);
  expect(result.ok).toBe(false);
  expect(result.why).toContain("multiple hard links");
  expect(w.users.has("walkie-s1")).toBe(true);
});

test("a retained entry on a different device keeps the seat quarantined", async () => {
  const w = setup();
  expect((await createSeatUser(1, w.sys)).ok).toBe(true);
  const home = seatHome(w.sys, 1);
  const retained = join(home, "mounted");
  mkdirSync(retained);
  rmSync(join(home, "walkie-seats"), { recursive: true });
  const st = lstatSync(retained);
  w.fakeDevices.set(retained, st.dev + 1);
  w.sys.sweepAsUser = async () => ({ ok: true, left: [], residuePaths: [retained],
    residueProofs: [{ path: retained, reason: "EPERM open", dev: st.dev + 1, ino: st.ino }] });
  const result = await destroySeatUser(1, w.sys);
  expect(result.ok).toBe(false);
  expect(result.why).toContain("different device");
  expect(w.users.has("walkie-s1")).toBe(true);
});
