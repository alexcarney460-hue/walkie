// The seat-run failure surface (Alex: each refusal should print what happened and the exact command that fixes it,
// including which machine's person runs it): the pure message helpers, unit level. End-to-end coverage of the same
// texts lives in test/integration/seats.test.ts, seats-v2.test.ts and seats-cli.test.ts.
import { describe, expect, test } from "bun:test";
import { permissionModeNote } from "../../src/cli/commands/seats.ts";
import { capacityFullText } from "../../src/daemon/seats/host.ts";
import { KIMI_FULL_ACCESS_ONLY } from "../../src/daemon/seats/runtime.ts";

describe("capacityFullText: the machine-wide cap refusal names the exact fix and whose machine", () => {
  test("no quarantine: raise --max, or wait for one to finish", () => {
    const text = capacityFullText({ seats: 3, hostMax: 3, quarantine: 0, hostname: "arvid-mac" });
    expect(text).toBe("this machine is full: 3 of 3 seats running on arvid-mac: its person runs `walkie seats allow --max 4` there to raise the limit, or waits for one to finish (walkie seats there)");
  });

  test("quarantined users with live or unknown processes hold slots", () => {
    const text = capacityFullText({ seats: 1, hostMax: 1, quarantine: 1, hostname: "arvid-mac" });
    expect(text).toBe("this machine is full: 1 seat user is still being removed (live or unknown processes hold a slot; cleanup retries with backoff): its person runs `walkie seats doctor` on arvid-mac to see why");
    expect(capacityFullText({ seats: 2, hostMax: 2, quarantine: 2, hostname: "arvid-mac" }))
      .toContain("2 seat users are still being removed");
  });
});

describe("permissionModeNote: guidance for the default seat mode (acceptEdits)", () => {
  test("acceptEdits: warns that shell commands are refused, and how to allow them", () => {
    const note = permissionModeNote("acceptEdits");
    expect(note).toContain("acceptEdits");
    expect(note).toContain("shell commands");
    expect(note).toContain("--permission-mode bypassPermissions");
  });

  test("default and bypassPermissions: no note (bypassPermissions already runs shell commands; default asks for everything)", () => {
    expect(permissionModeNote("default")).toBeNull();
    expect(permissionModeNote("bypassPermissions")).toBeNull();
  });
});

test("KIMI_FULL_ACCESS_ONLY names the exact flag to add, and the runtimes that don't need it", () => {
  expect(KIMI_FULL_ACCESS_ONLY).toContain("--permission-mode bypassPermissions");
  expect(KIMI_FULL_ACCESS_ONLY).toContain("--runtime claude");
  expect(KIMI_FULL_ACCESS_ONLY).toContain("--runtime codex");
});
