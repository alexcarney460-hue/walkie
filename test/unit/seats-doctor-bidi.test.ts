import { expect, test } from "bun:test";
import { doctorChecks } from "../../src/daemon/seats/doctor.ts";
import type { SeatsLocalView } from "../../src/protocol/seats.ts";

test("doctor strips bidi overrides from a seat-controlled cleanup reason", () => {
  const local = { quarantined: ["walkie-s1"], quarantine_why: { "walkie-s1": "left\u202Eevil" } } as unknown as SeatsLocalView;
  const checks = doctorChecks(local, { team: null, release: false, runnerProblem: null, helper: "ok", rootsFile: "ok", runtimes: { claude: null, codex: null } });
  const line = checks.find((check) => check.what.includes("awaiting cleanup"))?.what;
  expect(line).toContain("leftevil");
  expect(line).not.toContain("\u202E");
});
