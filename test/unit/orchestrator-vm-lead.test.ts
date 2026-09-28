import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isWsl, setVmLeadEligible, vmMayLead } from "../../src/daemon/orchestrator/vm-lead.ts";
import type { Core } from "../../src/daemon/core.ts";

test("WSL is detected from environment or kernel release", () => {
  expect(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, "linux")).toBe(true);
  expect(isWsl({}, "5.15.0-microsoft-standard-WSL2")).toBe(true);
  expect(isWsl({}, "Darwin Kernel Version 25")).toBe(false);
});

test("WSL leadership requires person opt-in and no other online owner", () => {
  const home = mkdtempSync(join(import.meta.dir, ".vm-"));
  const core = { nodeId: "wsl", paths: { home }, roster: { members: new Map([["alex@example.com", { handle: "alex", role: "owner" }]]) } } as unknown as Core;
  const self = { node_id: "wsl", hostname: "wsl", handle: "alex", online: true, last_seen: 1 };
  const mac = { node_id: "mac", hostname: "mac", handle: "alex", online: true, last_seen: 1 };
  try {
    expect(vmMayLead(core, [self], true)).toBe(false);
    setVmLeadEligible(core, true);
    expect(vmMayLead(core, [self, mac], true)).toBe(false);
    expect(vmMayLead(core, [self, { ...mac, online: false }], true)).toBe(true);
    setVmLeadEligible(core, false);
    expect(vmMayLead(core, [self], true)).toBe(false);
    expect(vmMayLead(core, [self, mac], false)).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
