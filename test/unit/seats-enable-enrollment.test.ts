import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createGrant, type Grant } from "../../src/daemon/provision/grant.ts";
import { requiredWorkerAccount } from "../../src/daemon/seats/enrollment-account.ts";
import { setTestEnrollmentRoot } from "../../src/daemon/provision/root-marker.ts";
import { PROFILES } from "../../src/daemon/provision/profiles.ts";
import { doctorCommand, enableCommand } from "../../src/cli/commands/seats-enable.ts";
import type { Ctx } from "../../src/cli/context.ts";

const previousHome = process.env.WALKIE_HOME;
let home: string | null = null;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
  if (previousHome === undefined) delete process.env.WALKIE_HOME;
  else process.env.WALKIE_HOME = previousHome;
});

test("enrolled Grok seats cannot fall through to the recipient subscription", () => {
  const grant = { worker_accounts: { claude: `alex:${"a".repeat(24)}`, codex: `alex:${"b".repeat(24)}` },
    expires_at: Date.now() + 60_000 } as Grant;
  const run = { op: "run" as const, v: 2 as const, runtime: "grok" as const, brief: "a".repeat(64), timeout_s: 3600, max_concurrent: 1 };
  expect(requiredWorkerAccount(grant, run)).toContain("Claude or Codex");
});

test("enable cannot report Ready from a personal login when no owner account is selected", async () => {
  home = mkdtempSync("/tmp/walkie-enrolled-enable-");
  setTestEnrollmentRoot(home, `${home}/root`);
  process.env.WALKIE_HOME = home;
  const now = Date.now();
  createGrant(home, { team_id: "team", owner_node: "owner-node", target_node: "target-node", recipient: "kira",
    consent_text: "consent", consent_version: 1, company_mode: true, launchers: ["@alex"], seat_cap: 1,
    profiles: [{ id: "developer-worker", version: PROFILES["developer-worker"].version }], created_at: now, expires_at: now + 86400_000 });
  const local = { allow: true, same_user: true, ephemeral: false, channel_ok: true, claude_login: "machine", codex_login: "machine" };
  const lines: string[] = [];
  const client = { seats: async () => ({ local }), seatsConfig: async () => ({ local }),
    me: async () => ({ handle: "kira", role: "member", team: { name: "team" } }),
    team: async () => ({ nodes: [{ node_id: "owner-node", handle: "alex" }], members: [{ handle: "alex", role: "owner" }] }),
    accounts: async () => ({ accounts: [] }) };
  const ctx = { args: { pos: [], flags: new Map([["yes", true]]) }, json: false, forAgent: false,
    agentMarker: () => null, client: () => client, out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) } as unknown as Ctx;
  await enableCommand(ctx);
  expect(lines.join("\n")).toContain("waiting for owner account");
  expect(lines.join("\n")).toContain("Not ready");
  expect(lines.join("\n")).not.toContain("Ready:");
});

test("repeated enrolled doctor runs use probes and consume no vault hand-outs", async () => {
  home = mkdtempSync("/tmp/walkie-enrolled-doctor-");
  setTestEnrollmentRoot(home, `${home}/root`);
  process.env.WALKIE_HOME = home;
  const id = "a".repeat(24);
  const now = Date.now();
  createGrant(home, { team_id: "team", owner_node: "owner-node", target_node: "target-node", recipient: "kira",
    consent_text: "consent", consent_version: 1, company_mode: true, launchers: ["@alex"], seat_cap: 1,
    profiles: [{ id: "developer-worker", version: PROFILES["developer-worker"].version }], created_at: now, expires_at: now + 86400_000,
    worker_accounts: { claude: `alex:${id}`, codex: `alex:${id}` } });
  const local = { allow: true, same_user: true, ephemeral: false, channel_ok: true, claude_login: "machine", codex_login: "machine" };
  const machine = { node_id: "owner-node", hostname: "owner", handle: "alex", online: true, self: false, vault: { policy: "shared", share_with: ["kira"] } };
  const accounts = (["claude", "codex"] as const).map((provider) => ({ key: `alex:${id}`, id, provider, owners: ["alex"], machines: [machine] }));
  let probes = 0;
  let handouts = 0;
  let checks = 0;
  // The doctor asks the daemon to check the sign-ins now (seatsDoctor); a plain status read would serve the last check.
  const client = { seats: async () => { throw new Error("the doctor must ask for a check, not read the status"); }, seatsDoctor: async () => { checks++; return { local }; },
    me: async () => ({ handle: "kira", role: "member", team: { name: "team" } }),
    team: async () => ({ nodes: [{ node_id: "owner-node", handle: "alex" }], members: [{ handle: "alex", role: "owner" }] }),
    accounts: async () => ({ accounts }), vaultProbe: async () => { probes++; return { ready: true }; },
    vaultLease: async () => { handouts++; throw new Error("doctor must never request a hand-out"); } };
  const lines: string[] = [];
  const ctx = { args: { pos: [], flags: new Map() }, json: false, forAgent: false,
    agentMarker: () => null, client: () => client, out: (line: string) => lines.push(line), err: (line: string) => lines.push(line) } as unknown as Ctx;
  for (let i = 0; i < 6; i++) await doctorCommand(ctx);
  expect(checks).toBe(6);
  expect(probes).toBe(12);
  expect(handouts).toBe(0);
});
