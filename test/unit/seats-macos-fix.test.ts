// SEATS-MACOS-FIX: the first real seat launch on a teammate's Mac (v0.2.0-pre.4) failed with
//   walkie-s1 could not be made clean: walkie-s1 is in other groups (12, 61, 701, 100) (and undoing it left:
//   schedules: crontab -u walkie-s1 -r failed (1): crontab: you (walkie-s1) are not allowed to use this program)
// 1. macOS puts every local account in everyone (12), localaccounts (61) and the groups nesting them (_lpoperator 100,
//    com.apple.sharepoint.group.1 701): judged by direct membership (mac-groups.ts), from this Mac's real dscl output
//    (test/fixtures/seats-macos, read-only captures).
// 2. crontab refuses a user in cron.deny (every seat user is), even for root: the spool is checked and a crontab there
//    removed by root directly, verified (admin-sys.ts crontabRemoval).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSeatUser, destroySeatUser, pendingSeatUsers } from "../../src/daemon/seats/admin.ts";
import { crontabRemoval, realAdminSys, removeSpoolCrontab } from "../../src/daemon/seats/admin-sys.ts";
import { macImplicitGids, parseDsGroups, parseDsRecords, parseDsUser, type DsGroup } from "../../src/daemon/seats/mac-groups.ts";
import { fakeSeatWorld } from "../helpers/fake-seat-users.ts";

const FIX = join(import.meta.dir, "..", "fixtures", "seats-macos");
const fixture = (f: string) => readFileSync(join(FIX, f), "utf8");
const REAL_GROUPS = fixture("dscl-readall-groups.txt");

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
function tmp(): string {
  const d = mkdtempSync("/tmp/walkie-macfix-");
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

// A new seat user as dscl would show it: its own group, and walkie-seats listing it (by name and GeneratedUID).
const SEAT = { name: "walkie-s1", guid: "0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D", gid: 600_001 };
const SEATS_RECORD = `GeneratedUID: 7D1E4C2A-9B3F-4E5D-8A6C-1F2E3D4C5B6A\nGroupMembers: ${SEAT.guid}\nGroupMembership: ${SEAT.name}\nPrimaryGroupID: 599999\nRecordName: walkie-seats`;
const OWN_RECORD = `GeneratedUID: 3C4D5E6F-7A8B-4C9D-8E0F-1A2B3C4D5E6F\nPrimaryGroupID: 600001\nRecordName: ${SEAT.name}`;
const groupsWith = (...extra: string[]): DsGroup[] => parseDsGroups([REAL_GROUPS.trimEnd(), SEATS_RECORD, OWN_RECORD, ...extra].join("\n-\n"));
/** What `id -G walkie-s1` printed on the teammate's Mac, less its own group and walkie-seats. */
const TEAMMATE_GIDS = [12, 61, 701, 100];

describe("dscl output, parsed as dscl prints it (this Mac's real output)", () => {
  test("-readall records split on `-`; a value with a space puts each value on its own indented line", () => {
    const groups = parseDsGroups(REAL_GROUPS);
    expect(groups.length).toBe(8);
    expect(groups.find((g) => g.gid === 98)).toEqual({
      names: ["_lpadmin", "lpadmin", "BUILTIN\\Print Operators"], gid: 98, guid: "ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000062",
      membership: [], members: [], nested: ["ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000050"],
    });
    expect(groups.find((g) => g.gid === 80)?.membership).toEqual(["root", "localadmin", "_mbsetupuser"]);
    expect(groups.find((g) => g.gid === 100)?.nested).toEqual(["ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000003D", "ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000062"]);
  });

  test("-read of one group: native keys with colons and multi-line RealName don't disturb the fields read", () => {
    const share = parseDsGroups(fixture("dscl-read-com.apple.sharepoint.group.1.txt"));
    expect(share).toHaveLength(1);
    expect(share[0]).toMatchObject({ gid: 701, guid: "5904C48C-484C-41DB-8C16-29F39DF3AE6A", nested: ["ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C"] });
    expect(parseDsRecords(fixture("dscl-read-com.apple.sharepoint.group.1.txt"))[0]?.get("dsAttrTypeNative:IsHidden")).toEqual(["1"]);
    expect(parseDsGroups(fixture("dscl-read-_lpoperator.txt"))[0]).toMatchObject({ gid: 100, names: ["_lpoperator"] });
    expect(parseDsGroups(fixture("dscl-read-everyone.txt"))[0]).toMatchObject({ gid: 12, guid: "ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C", membership: [] });
    expect(parseDsGroups(fixture("dscl-read-localaccounts.txt"))[0]).toMatchObject({ gid: 61, guid: "ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000003D" });
  });

  test("a user's GeneratedUID and primary group; none readable throws", () => {
    expect(parseDsUser(fixture("dscl-read-user-nobody.txt"))).toEqual({ guid: "FFFFEEEE-DDDD-CCCC-BBBB-AAAAFFFFFFFE", gid: -2 });
    expect(() => parseDsUser("PrimaryGroupID: 20\n")).toThrow(/can't be read/);
    expect(() => parseDsUser("")).toThrow(/can't be read/);
  });
});

describe("macOS groups every local account is in are not extra (bug 1)", () => {
  test("the teammate's 12, 61, 701, 100: everyone, localaccounts and the groups nesting them only", () => {
    expect(macImplicitGids(SEAT, TEAMMATE_GIDS, groupsWith()).sort((a, b) => a - b)).toEqual([12, 61, 100, 701]);
  });

  test("the same judgement as `id -G nobody` on this Mac (a local account in no group of its own)", () => {
    const ids = fixture("id-G-nobody.txt").trim().split(/\s+/).map(Number).slice(1); // its primary first
    expect(ids).toEqual(TEAMMATE_GIDS);
    expect(macImplicitGids({ name: "nobody", ...parseDsUser(fixture("dscl-read-user-nobody.txt")) }, ids, parseDsGroups(REAL_GROUPS)).sort((a, b) => a - b)).toEqual([12, 61, 100, 701]);
  });

  test("a group that lists the seat user directly (by name, or by GeneratedUID) is refused", () => {
    const byName = "GeneratedUID: 11111111-AAAA-4BBB-8CCC-000000000001\nGroupMembership: localadmin walkie-s1\nPrimaryGroupID: 399\nRecordName: com.apple.access_ssh";
    const byGuid = `GeneratedUID: 11111111-AAAA-4BBB-8CCC-000000000002\nGroupMembers: ${SEAT.guid}\nPrimaryGroupID: 398\nRecordName: com.apple.access_screensharing`;
    expect(macImplicitGids(SEAT, [...TEAMMATE_GIDS, 399, 398], groupsWith(byName, byGuid)).sort((a, b) => a - b)).toEqual([12, 61, 100, 701]);
  });

  test("a group nesting a non-built-in group that holds the seat user is refused, at any depth", () => {
    const seatsGuid = "7D1E4C2A-9B3F-4E5D-8A6C-1F2E3D4C5B6A";
    // Nests walkie-seats (which lists it) next to everyone: the everyone path doesn't excuse the other.
    const nestsSeats = `GeneratedUID: 22222222-AAAA-4BBB-8CCC-000000000001\nNestedGroups: ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C ${seatsGuid}\nPrimaryGroupID: 501\nRecordName: nests-seats`;
    // Two levels down: outer → middle → a group listing it by name.
    const lists = "GeneratedUID: 22222222-AAAA-4BBB-8CCC-000000000002\nGroupMembership: walkie-s1\nPrimaryGroupID: 502\nRecordName: lists-it";
    const middle = "GeneratedUID: 22222222-AAAA-4BBB-8CCC-000000000003\nNestedGroups: 22222222-AAAA-4BBB-8CCC-000000000002\nPrimaryGroupID: 503\nRecordName: middle";
    const outer = "GeneratedUID: 22222222-AAAA-4BBB-8CCC-000000000004\nNestedGroups: ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000003D 22222222-AAAA-4BBB-8CCC-000000000003\nPrimaryGroupID: 504\nRecordName: outer";
    // Nests the seat user's own primary group.
    const nestsOwn = "GeneratedUID: 22222222-AAAA-4BBB-8CCC-000000000005\nNestedGroups: 3C4D5E6F-7A8B-4C9D-8E0F-1A2B3C4D5E6F\nPrimaryGroupID: 505\nRecordName: nests-own";
    const got = macImplicitGids(SEAT, [...TEAMMATE_GIDS, 501, 502, 503, 504, 505], groupsWith(nestsSeats, lists, middle, outer, nestsOwn));
    expect(got.sort((a, b) => a - b)).toEqual([12, 61, 100, 701]);
  });

  test("what can't be explained from the local directory fails closed", () => {
    // Nests everyone and a group that isn't a local record; a gid with no record; a gid two records share; a group
    // that neither lists it nor nests a built-in group.
    const unknownNested = "GeneratedUID: 33333333-AAAA-4BBB-8CCC-000000000001\nNestedGroups: ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C 99999999-0000-4000-8000-000000000000\nPrimaryGroupID: 601\nRecordName: unknown-nested";
    const dupA = "GeneratedUID: 33333333-AAAA-4BBB-8CCC-000000000002\nNestedGroups: ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C\nPrimaryGroupID: 602\nRecordName: dup-a";
    const dupB = "GeneratedUID: 33333333-AAAA-4BBB-8CCC-000000000003\nNestedGroups: ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C\nPrimaryGroupID: 602\nRecordName: dup-b";
    const plain = "GeneratedUID: 33333333-AAAA-4BBB-8CCC-000000000004\nPrimaryGroupID: 603\nRecordName: plain";
    const got = macImplicitGids(SEAT, [...TEAMMATE_GIDS, 601, 602, 603, 604], groupsWith(unknownNested, dupA, dupB, plain));
    expect(got.sort((a, b) => a - b)).toEqual([12, 61, 100, 701]);
    // A record claiming a built-in GeneratedUID under another gid is not the built-in group.
    const fakeEveryone = "GeneratedUID: ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C\nPrimaryGroupID: 605\nRecordName: not-everyone";
    expect(macImplicitGids(SEAT, [605], groupsWith(fakeEveryone))).toEqual([]);
  });

  test("an account an administrator put in admin is refused even through _lpoperator (this Mac's own user)", () => {
    const me = { name: "localadmin", guid: "5791DEAD-CAF0-4DEA-9C8B-187F9DFFF610", gid: 20 };
    // _lpoperator nests _lpadmin, which nests admin, which lists localadmin: 100 is a real membership for it.
    expect(macImplicitGids(me, [12, 61, 80, 98, 100, 701], parseDsGroups(REAL_GROUPS)).sort((a, b) => a - b)).toEqual([12, 61, 701]);
  });

  test("admin, wheel, staff and _lpadmin are never excused, even nesting everyone or localaccounts (PRE5 RC LOW)", () => {
    const EVERYONE = "ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C";
    const LOCAL = "ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000003D";
    // This Mac's real records, with an administrator's change: each of these nests everyone (or localaccounts).
    const real = parseDsGroups(REAL_GROUPS).map((g) => ([80, 98, 20].includes(g.gid ?? -1) ? { ...g, membership: [], members: [], nested: [EVERYONE] } : g));
    const wheel = `GeneratedUID: ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000000\nNestedGroups: ${LOCAL}\nPrimaryGroupID: 0\nRecordName: wheel`;
    const renamedAdmin = `GeneratedUID: 44444444-AAAA-4BBB-8CCC-000000000001\nNestedGroups: ${EVERYONE}\nPrimaryGroupID: 7080\nRecordName: admin`;
    const lpadminByName = `GeneratedUID: 44444444-AAAA-4BBB-8CCC-000000000002\nNestedGroups: ${EVERYONE}\nPrimaryGroupID: 7098\nRecordName: lpadmin _lpadmin`;
    const groups = [...real, ...parseDsGroups([SEATS_RECORD, OWN_RECORD, wheel, renamedAdmin, lpadminByName].join("\n-\n"))];
    const got = macImplicitGids(SEAT, [...TEAMMATE_GIDS, 0, 20, 80, 98, 7080, 7098], groups);
    // 100 (_lpoperator) is still excused: here it reaches the user only through localaccounts and everyone; 98 itself is refused.
    expect(got.sort((a, b) => a - b)).toEqual([12, 61, 100, 701]);
  });

  test.if(process.platform === "darwin")("the real helper's dscl reads agree on this Mac (read-only: nobody)", () => {
    const sys = realAdminSys();
    const ids = Bun.spawnSync(["id", "-G", "nobody"]).stdout.toString().trim().split(/\s+/).map(Number).slice(1);
    expect(ids.length).toBeGreaterThan(0);
    expect(sys.implicitGroups?.("nobody", ids).sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
  });
});

describe("crontab refuses a cron-denied user even for root (bug 2)", () => {
  const DENIED = "crontab: you (walkie-s1) are not allowed to use this program\n";

  test("denied, and no crontab in the spool: nothing to remove", () => {
    const t = tmp();
    const tabs = join(t, "tabs");
    mkdirSync(tabs);
    expect(crontabRemoval("walkie-s1", 1, DENIED, [tabs])).toBeNull();
  });

  test("denied, and a crontab in the spool: root removes it, verified; the same directory through a link is fine", () => {
    const t = tmp();
    const tabs = join(t, "at", "tabs");
    mkdirSync(tabs, { recursive: true });
    symlinkSync(join(t, "at"), join(t, "cron")); // /usr/lib/cron -> /var/at, as on macOS
    writeFileSync(join(tabs, "walkie-s1"), "* * * * * /tmp/x\n");
    writeFileSync(join(tabs, "walkie-s10"), "keep\n");
    expect(crontabRemoval("walkie-s1", 1, DENIED, [join(t, "cron", "tabs"), tabs])).toBeNull();
    expect(existsSync(join(tabs, "walkie-s1"))).toBe(false);
    expect(readFileSync(join(tabs, "walkie-s10"), "utf8")).toBe("keep\n");
  });

  test("a spool entry that isn't a crontab, or a spool that can't be read, is reported with the failure", () => {
    const t = tmp();
    const tabs = join(t, "tabs");
    mkdirSync(join(tabs, "walkie-s1"), { recursive: true });
    expect(crontabRemoval("walkie-s1", 1, DENIED, [tabs])).toMatch(/^crontab -u walkie-s1 -r failed \(1\): crontab: you \(walkie-s1\) are not allowed.*; .*walkie-s1 is a directory/);
    const file = join(t, "not-a-dir");
    writeFileSync(file, "");
    expect(removeSpoolCrontab("walkie-s1", [file])).toMatch(/can't be checked \(ENOTDIR\)/);
  });

  test("any other failure is reported as before; no crontab, or removed, is fine", () => {
    expect(crontabRemoval("walkie-s1", 1, "crontab: tmp/tmp.1: Permission denied\n", [])).toBe("crontab -u walkie-s1 -r failed (1): crontab: tmp/tmp.1: Permission denied");
    expect(crontabRemoval("walkie-s1", 1, "crontab: no crontab for walkie-s1\n", [])).toBeNull();
    expect(crontabRemoval("walkie-s1", 0, "", [])).toBeNull();
  });
});

describe("the teammate's machine: walkie-s1 left half-made, then the fixed helper", () => {
  /** A fake machine where new users get macOS's implicit groups and the crontab step behaves as macOS's does. */
  function macWorld(fixed: boolean) {
    const root = tmp();
    const w = fakeSeatWorld(root, join(root, "walkie-home"));
    const tabs = join(root, "tabs");
    mkdirSync(tabs);
    const create = w.sys.createUser.bind(w.sys);
    w.sys.createUser = (u) => { create(u); const x = w.users.get(u.name); if (x) w.users.set(u.name, { ...x, gids: [...x.gids, ...TEAMMATE_GIDS] }); };
    // crontab -u <name> -r on a user in cron.deny, as macOS answers it.
    w.sys.removeSchedules = (name, _uid, exists) => {
      if (!exists) return null;
      const denied = (w.sys.readSchedulerFile(w.schedulerFiles.cron[1]) ?? "").split("\n").includes(name);
      const err = denied ? `crontab: you (${name}) are not allowed to use this program\n` : `crontab: no crontab for ${name}\n`;
      return fixed ? crontabRemoval(name, 1, err, [tabs]) : `crontab -u ${name} -r failed (1): ${err.trim()}`;
    };
    if (fixed) w.sys.implicitGroups = (name, gids) => macImplicitGids({ ...SEAT, name, gid: w.users.get(name)?.gid ?? -1 }, gids, groupsWith());
    return { w, tabs };
  }

  test("before the fix: exactly the teammate's error, and walkie-s1 stays for the next destroy", async () => {
    const { w } = macWorld(false);
    const r = await createSeatUser(1, w.sys);
    expect(r.ok).toBe(false);
    expect(r.why).toBe("walkie-s1 could not be made clean: walkie-s1 is in other groups (12, 61, 701, 100) (and undoing it left: schedules: crontab -u walkie-s1 -r failed (1): crontab: you (walkie-s1) are not allowed to use this program)");
    expect(w.users.has("walkie-s1")).toBe(true);
    expect(pendingSeatUsers(w.sys)).toEqual({ ok: true, ids: [1] });
  });

  test("after the fix: the next destroy removes the left walkie-s1 (its crontab too), and walkie-s2 is made", async () => {
    const before = macWorld(false);
    await createSeatUser(1, before.w.sys);
    // The same machine (users, ledger, deny files), now with the fixed helper.
    const { w, tabs } = { w: before.w, tabs: join(before.w.root, "tabs") };
    w.sys.implicitGroups = (name, gids) => macImplicitGids({ ...SEAT, name, gid: w.users.get(name)?.gid ?? -1 }, gids, groupsWith());
    w.sys.removeSchedules = (name, _uid, exists) => (exists ? crontabRemoval(name, 1, `crontab: you (${name}) are not allowed to use this program\n`, [tabs]) : null);
    writeFileSync(join(tabs, "walkie-s1"), "* * * * * /tmp/x\n"); // even had it managed to schedule something
    expect(await destroySeatUser(1, w.sys)).toMatchObject({ ok: true, name: "walkie-s1" });
    expect(w.users.has("walkie-s1")).toBe(false);
    expect(existsSync(join(tabs, "walkie-s1"))).toBe(false);
    expect(existsSync(join(w.homes, "walkie-s1"))).toBe(false);
    expect(pendingSeatUsers(w.sys)).toEqual({ ok: true, ids: [] });
    const s2 = await createSeatUser(2, w.sys);
    expect(s2).toMatchObject({ ok: true, name: "walkie-s2", uid: 600_002 });
    // And its own end, through the same cron-denied crontab step.
    expect(await destroySeatUser(2, w.sys)).toMatchObject({ ok: true });
  });

  test("with the fix, admin nesting everyone is still refused by the helper (PRE5 RC LOW)", async () => {
    const { w } = macWorld(true);
    const create = w.sys.createUser.bind(w.sys);
    w.sys.createUser = (u) => { create(u); const x = w.users.get(u.name); if (x) w.users.set(u.name, { ...x, gids: [...x.gids, 80] }); };
    const adminNestsEveryone = parseDsGroups(REAL_GROUPS).map((g) => (g.gid === 80 ? { ...g, membership: [], members: [], nested: ["ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C"] } : g));
    const groups = [...adminNestsEveryone, ...parseDsGroups([SEATS_RECORD, OWN_RECORD].join("\n-\n"))];
    w.sys.implicitGroups = (name, gids) => macImplicitGids({ ...SEAT, name, gid: w.users.get(name)?.gid ?? -1 }, gids, groups);
    const r = await createSeatUser(1, w.sys);
    expect(r).toMatchObject({ ok: false, code: "failed" });
    expect(r.why).toContain("walkie-s1 is in other groups (80)");
    expect(w.users.has("walkie-s1")).toBe(false);
  });

  test("with the fix, a direct extra group is still refused (and the half-made user destroyed)", async () => {
    const { w } = macWorld(true);
    const create = w.sys.createUser.bind(w.sys);
    w.sys.createUser = (u) => { create(u); const x = w.users.get(u.name); if (x) w.users.set(u.name, { ...x, gids: [...x.gids, 399] }); };
    const byName = "GeneratedUID: 11111111-AAAA-4BBB-8CCC-000000000001\nGroupMembership: walkie-s1\nPrimaryGroupID: 399\nRecordName: com.apple.access_ssh";
    w.sys.implicitGroups = (name, gids) => macImplicitGids({ ...SEAT, name }, gids, groupsWith(byName));
    const r = await createSeatUser(1, w.sys);
    expect(r).toMatchObject({ ok: false, code: "failed", why: "walkie-s1 could not be made clean: walkie-s1 is in other groups (399)" });
    expect(w.users.has("walkie-s1")).toBe(false);
  });
});
