import { expect, test } from "bun:test";
import { join } from "node:path";
import { noSeatUsers } from "../helpers/no-seat-users.ts";

const PRELOAD = join(import.meta.dir, "../helpers/absent-seat-registration.ts");
const INSTANCE = join(import.meta.dir, "../../src/daemon/seats/instance.ts");
const SEAT_USER = join(import.meta.dir, "../../src/daemon/seats/seat-user.ts");

test("the empty fixture ledger reports no users and refuses every mutation", async () => {
  expect(noSeatUsers.seatRegistration?.()).toEqual({ state: "absent" });
  expect(await noSeatUsers.admin?.("pending", 0)).toEqual({ ok: true, ids: [] });
  for (const verb of ["create", "destroy"] as const) {
    expect(await noSeatUsers.admin?.(verb, 1)).toMatchObject({ ok: false, code: "refused" });
  }
});

test("the child preload hides only seat registration reads, keeping real registration and owner refusals", () => {
  const probe = `
    import { readFileSync, lstatSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { homedir } from "node:os";
    import { readSeatRegistration, seatScopeFor, seatRegistrationText } from ${JSON.stringify(INSTANCE)};
    import { SEAT_OWNER_FILE, SEAT_INSTANCE_FILE, seatOwnerProblem } from ${JSON.stringify(SEAT_USER)};
    const missing = [SEAT_OWNER_FILE, SEAT_INSTANCE_FILE].flatMap(path =>
      [readFileSync, lstatSync].map(read => { try { read(path); return "unexpected read"; } catch (e) { return e.code; } }));
    const fixture = join(homedir(), "seat-instance-preload-control");
    const foreign = { v: 1, user: "foreign-fixture", uid: process.getuid() + 1, home: homedir(), socket: join(homedir(), "other.sock") };
    writeFileSync(fixture, seatRegistrationText(foreign));
    const present = readSeatRegistration(fixture, false);
    console.log(JSON.stringify({ missing, absent: readSeatRegistration(), present,
      scope: seatScopeFor(present, join(homedir(), "mine.sock"), process.getuid()).state,
      owner: seatOwnerProblem("fixture-person", () => "foreign-fixture\\n"),
      unrelatedFile: lstatSync(fixture).isFile() && readFileSync(fixture, "utf8") === seatRegistrationText(foreign) }));
  `;
  const child = Bun.spawnSync([process.execPath, "--preload", PRELOAD, "-e", probe], { stdout: "pipe", stderr: "pipe" });
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(child.stdout.toString());
  expect(result.missing).toEqual(["ENOENT", "ENOENT", "ENOENT", "ENOENT"]);
  expect(result.absent).toEqual({ state: "absent" });
  expect(result.present).toMatchObject({ state: "present", registration: { user: "foreign-fixture" } });
  expect(result.scope).toBe("other");
  expect(result.owner).toContain("set up for foreign-fixture: one person per machine");
  expect(result.unrelatedFile).toBe(true);
});
