import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSshGrant, type InstallStep } from "../../src/daemon/ssh/enrollment.ts";
import { authorizeProvision, grantPath, grantSuspensionProblem, readGrant, revokeGrant, setGrantSshState, type Grant } from "../../src/daemon/provision/grant.ts";
import { writePrivate } from "../../src/daemon/provision/files.ts";
import { hasOwnerKey, revokeOwnerKeys } from "../../src/daemon/ssh/authorized-keys.ts";
import { appendAuditStrict } from "../../src/daemon/admin/audit.ts";
import { requiredWorkerAccount, workerAccountChecks } from "../../src/daemon/seats/enrollment-account.ts";
import type { AnySeatRun } from "../../src/protocol/seats.ts";
import type { Core } from "../../src/daemon/core.ts";
import { sshTunnelProblem } from "../../src/daemon/ssh/tunnel.ts";
import { provisionChecks, sshStatusChecks, type SshStatus } from "../../src/cli/commands/doctor.ts";
import { appendSshRevocationAudit, beginSshDaemon, clearSshGate, recordSshRevocation, REVOCATION_UNSAVED_MESSAGE, setSshGate, sshGateProblem, sshRevocationProblem, sshRevocationUnsaved } from "../../src/daemon/ssh/state.ts";
import { noteRevocationOutcome, revokeSshAccess, SshRevocationUnsaved } from "../../src/daemon/ssh/revoke.ts";
import { PROFILES } from "../../src/daemon/provision/profiles.ts";
import { setTestEnrollmentRoot } from "../../src/daemon/provision/root-marker.ts";

const team = "a".repeat(16);
const owner = "b".repeat(16);
const key = (() => {
  const name = Buffer.from("ssh-ed25519");
  const a = Buffer.alloc(4); a.writeUInt32BE(name.length);
  const b = Buffer.alloc(4); b.writeUInt32BE(32);
  return `ssh-ed25519 ${Buffer.concat([a, name, b, Buffer.alloc(32, 4)]).toString("base64")}`;
})();

/** A Walkie home under `root` with its own enrollment-marker root: consent needs the marker, and tests never touch the host's. */
function walkieHome(root: string): string {
  const home = join(root, "walkie");
  setTestEnrollmentRoot(home, join(root, "enrollment-root"));
  return home;
}

function fixture(): Grant {
  const now = Date.now();
  return { team_id: team, owner_node: owner, target_node: "target", recipient: "kira", consent_text: "consent",
    consent_version: 1, company_mode: true, launchers: ["@alex"], seat_cap: 1,
    profiles: [{ id: "developer-worker", version: PROFILES["developer-worker"].version }], created_at: now,
    expires_at: now + 86400_000, owner_ssh: { team_id: team, owner_node: owner, owner_handle: "alex",
      recipient: "kira", invite_id: "c".repeat(32), public_key: key, expires_at: now + 86400_000,
      signature: "test-signature" } };
}

for (const step of ["gate_pending", "grant_pending", "record_prepared", "key_written", "record_finalized", "gate_open", "before_grant_active"] as InstallStep[]) {
  test(`SSH install failure after ${step} keeps the gate denied and restores authorized_keys bytes`, () => {
    const root = mkdtempSync(join(tmpdir(), "walkie-ssh-enroll-"));
    const home = walkieHome(root);
    const sshHome = join(root, "person");
    mkdirSync(home); mkdirSync(join(sshHome, ".ssh"), { recursive: true });
    const path = join(sshHome, ".ssh", "authorized_keys");
    const original = Buffer.from([0xff, 0x0a, 0x23, 0x20, 0x6b, 0x65, 0x65, 0x70]);
    writeFileSync(path, original, { mode: 0o600 });
    try {
      expect(() => installSshGrant(home, sshHome, fixture(), (current) => {
        if (current === step) throw new Error(`injected ${step}`);
      })).toThrow(`injected ${step}`);
      expect(sshGateProblem(home)).toBe("ssh_denied");
      expect(readGrant(home)?.ssh_state).not.toBe("active");
      if (step !== "gate_pending") expect(readGrant(home)?.revoked_at).toBeGreaterThan(0);
      expect(readFileSync(path)).toEqual(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("successful SSH install opens the gate only after the key and active grant are recorded", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-ssh-enroll-"));
  const home = walkieHome(root);
  const sshHome = join(root, "person");
  mkdirSync(home); mkdirSync(sshHome);
  try {
    const seen: InstallStep[] = [];
    const grant = installSshGrant(home, sshHome, fixture(), (step) => {
      seen.push(step);
      const pending = readGrant(home);
      expect(pending?.ssh_state).toBe(step === "gate_pending" ? undefined : "pending");
      expect(authorizeProvision({ grant: pending, teamId: team, targetHandle: "kira", targetNode: "target",
        ownerHandle: "alex", actorHandle: "alex", actorNode: owner, actorRole: "owner",
        ownerNodeCurrent: true, remoteAdmin: true, agentAdmin: true, profile: "developer-worker" }))
        .toBe(step === "gate_pending" ? "grant_absent" : "ssh_pending");
      const core = { paths: { home }, sshUserHome: sshHome } as Core;
      expect(sshTunnelProblem(core, owner)).not.toBeNull();
    });
    expect(seen).toEqual(["gate_pending", "grant_pending", "record_prepared", "before_rename", "key_written", "record_finalized", "gate_open", "before_grant_active"]);
    expect(grant.ssh_state).toBe("active");
    expect(sshGateProblem(home)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a restarted SSH gate waits for a fresh team sync despite an active local grant", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-ssh-team-"));
  const home = walkieHome(root);
  const sshHome = join(root, "person");
  mkdirSync(home); mkdirSync(sshHome);
  try {
    installSshGrant(home, sshHome, fixture());
    const core = { paths: { home }, sshUserHome: sshHome, sshTeamConfirmed: () => false } as unknown as Core;
    expect(sshTunnelProblem(core, owner)).toBe("ssh_team_waiting");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("directory fsync failure after activation rename returns the committed active grant", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-ssh-activation-"));
  const home = walkieHome(root);
  const sshHome = join(root, "person");
  mkdirSync(home); mkdirSync(sshHome);
  const input = fixture();
  try {
    const grant = installSshGrant(home, sshHome, input, undefined, undefined, undefined,
      (_home, state) => setGrantSshState(home, state, (target, value) => {
        expect(target).toBe(grantPath(home));
        writePrivate(target, value, () => { throw new Error("injected directory fsync failure"); });
      }));
    expect(grant.ssh_state).toBe("active");
    expect(readGrant(home)?.ssh_state).toBe("active");
    expect(sshGateProblem(home)).toBeNull();
    expect(hasOwnerKey(sshHome, team, "alex", key)).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed grant revocation durably suspends provisioning after SSH install failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-ssh-enroll-"));
  const home = walkieHome(root);
  const sshHome = join(root, "person");
  mkdirSync(home); mkdirSync(sshHome);
  try {
    expect(() => installSshGrant(home, sshHome, fixture(), (step) => {
      if (step === "before_grant_active") throw new Error("injected post-install failure");
    }, () => { throw new Error("injected revoke failure"); })).toThrow("injected revoke failure");
    const grant = readGrant(home);
    expect(grant?.revoked_at).toBeUndefined();
    expect(grantSuspensionProblem(home, grant)).toBe("ssh_install_failed");
    expect(authorizeProvision({ grant, teamId: team, targetHandle: "kira", targetNode: "target",
      ownerHandle: "alex", actorHandle: "alex", actorNode: owner, actorRole: "owner",
      ownerNodeCurrent: true, remoteAdmin: true, agentAdmin: true, profile: "developer-worker" })).toBe("ssh_denied");
    expect((await provisionChecks(home))[0]).toMatchObject({ level: "fail", name: "provision" });
    expect((await provisionChecks(home))[0]?.detail).toContain("SSH install failed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed activation stays non-executable even when revoke and suspension fail", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-ssh-enroll-"));
  const home = walkieHome(root);
  const sshHome = join(root, "person");
  mkdirSync(home); mkdirSync(sshHome);
  try {
    expect(() => installSshGrant(home, sshHome, fixture(), (step) => {
      if (step === "before_grant_active") throw new Error("injected activation failure");
    }, () => { throw new Error("injected revoke failure"); },
    () => { throw new Error("injected suspension failure"); })).toThrow("injected suspension failure");
    const grant = readGrant(home);
    expect(grant?.ssh_state).toBe("pending");
    expect(authorizeProvision({ grant, teamId: team, targetHandle: "kira", targetNode: "target",
      ownerHandle: "alex", actorHandle: "alex", actorNode: owner, actorRole: "owner",
      ownerNodeCurrent: true, remoteAdmin: true, agentAdmin: true, profile: "developer-worker" })).toBe("ssh_pending");
    expect(sshGateProblem(home)).toBe("ssh_denied");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pending SSH grant refuses seats and account readiness", () => {
  const grant = { ...fixture(), ssh_state: "pending" as const, worker_accounts: { claude: "alex:claude" } };
  const run = { op: "run", v: 1, runtime: "claude", prompt: "test", timeout_s: 600, max_concurrent: 1 } as AnySeatRun;
  expect(requiredWorkerAccount(grant, run)).toContain("pending");
  expect(workerAccountChecks(grant, { me: "kira", owner: "alex", accounts: [], team: "per-account", role: "member" })
    .every((check) => !check.ok)).toBe(true);
});

test("failed byte rollback leaves a durable SSH deny state", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-ssh-enroll-"));
  const home = walkieHome(root);
  const sshHome = join(root, "person");
  mkdirSync(home); mkdirSync(sshHome);
  const path = join(sshHome, ".ssh", "authorized_keys");
  try {
    expect(() => installSshGrant(home, sshHome, fixture(), (step) => {
      if (step === "key_written") {
        rmSync(path);
        mkdirSync(path);
        throw new Error("injected key failure");
      }
    })).toThrow("key rollback");
    expect(sshGateProblem(home)).toBe("ssh_denied");
    expect(readGrant(home)?.revoked_at).toBeGreaterThan(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("durably armed SSH gate reopens after restart and unreadable state stays denied", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-ssh-gate-"));
  try {
    expect(sshGateProblem(root)).toBe("ssh_gate_invalid");
    clearSshGate(root);
    expect(sshGateProblem(root)).toBeNull();
    const modulePath = join(import.meta.dir, "../../src/daemon/ssh/state.ts");
    const restart = () => Bun.spawnSync([process.execPath, "-e",
      `import { sshGateProblem } from ${JSON.stringify(modulePath)}; process.stdout.write(sshGateProblem(process.env.WALKIE_TEST_SSH_HOME) ?? "open");`],
    { env: { ...process.env, WALKIE_TEST_SSH_HOME: root } });
    const restarted = restart();
    expect(restarted.exitCode).toBe(0);
    expect(restarted.stdout.toString()).toBe("open");
    const path = join(root, "owner-ssh-gate.json");
    chmodSync(path, 0o644);
    expect(restart().stdout.toString()).toBe("ssh_gate_invalid");
    chmodSync(path, 0o600);
    writeFileSync(path, '{"state":"open","armed":false}\n');
    expect(restart().stdout.toString()).toBe("ssh_gate_invalid");
    setSshGate(root, "denied");
    expect(restart().stdout.toString()).toBe("ssh_denied");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed gate writes and key removal keep SSH closed after daemon restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-ssh-revoke-"));
  const home = walkieHome(root);
  const sshHome = join(root, "person");
  mkdirSync(home); mkdirSync(sshHome);
  try {
    const grant = installSshGrant(home, sshHome, fixture());
    const core = { paths: { home }, sshUserHome: sshHome, hostname: "target" } as Core;
    let attempts = 0;
    expect(() => revokeSshAccess(core, grant, () => { throw new Error("injected key removal failure"); },
      () => { attempts++; throw new Error("injected gate write failure"); })).toThrow("injected key removal failure");
    expect(attempts).toBe(2);
    expect(hasOwnerKey(sshHome, team, "alex", key)).toBe(true);
    const modulePath = join(import.meta.dir, "../../src/daemon/ssh/state.ts");
    const restarted = Bun.spawnSync([process.execPath, "-e",
      `import { sshGateProblem } from ${JSON.stringify(modulePath)}; process.stdout.write(sshGateProblem(process.env.WALKIE_TEST_SSH_HOME) ?? "open");`],
    { env: { ...process.env, WALKIE_TEST_SSH_HOME: home } });
    expect(restarted.exitCode).toBe(0);
    expect(restarted.stdout.toString()).toBe("ssh_denied");
    const checks = await provisionChecks(home);
    expect(checks.some((check) => check.detail.includes("SSH revocation incomplete: gate write: injected gate write failure, key removal"))).toBe(true);
    // Simulate a lost intent file and failed grant update: the strict audit still denies on a fresh process.
    rmSync(join(home, "owner-ssh-revocation.json"));
    writePrivate(grantPath(home), grant);
    const auditOnly = Bun.spawnSync([process.execPath, "-e",
      `import { sshGateProblem } from ${JSON.stringify(modulePath)}; process.stdout.write(sshGateProblem(process.env.WALKIE_TEST_SSH_HOME) ?? "open");`],
    { env: { ...process.env, WALKIE_TEST_SSH_HOME: home } });
    expect(auditOnly.exitCode).toBe(0);
    expect(auditOnly.stdout.toString()).toBe("ssh_denied");
    // The general admin log rotates; the revocation audit must survive its removal.
    rmSync(join(home, "admin-audit.jsonl"));
    const afterRotation = Bun.spawnSync([process.execPath, "-e",
      `import { sshGateProblem } from ${JSON.stringify(modulePath)}; process.stdout.write(sshGateProblem(process.env.WALKIE_TEST_SSH_HOME) ?? "open");`],
    { env: { ...process.env, WALKIE_TEST_SSH_HOME: home } });
    expect(afterRotation.exitCode).toBe(0);
    expect(afterRotation.stdout.toString()).toBe("ssh_denied");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("revocation intent readback accepts a post-rename directory fsync error", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-ssh-intent-"));
  try {
    const grant = fixture();
    writePrivate(grantPath(root), { ...grant, ssh_state: "active" });
    recordSshRevocation(root, grant.created_at, ["gate write"], (path, value) =>
      writePrivate(path, value, () => { throw new Error("injected intent fsync failure"); }));
    expect(sshRevocationProblem(root)).toBe("gate write");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("doctor says SSH waits for the team's authority, or for every peer when this machine is the authority", () => {
  const waiting: SshStatus = { owner_key_present: true, tunnel_allowed: false, reason: "ssh_team_waiting",
    server: { enabled: true, detail: "SSH server responds on 127.0.0.1" } };
  const tunnel = (status: SshStatus) => sshStatusChecks(status).find((check) => check.name === "ssh tunnel")?.detail;
  expect(tunnel(waiting)).toBe("SSH waits for the team's authority to confirm access");
  expect(tunnel({ ...waiting, is_authority: true }))
    .toBe("SSH waits for every team machine that shares a transport with this one to confirm access (this machine is the team's authority)");
  expect(tunnel({ ...waiting, tunnel_allowed: true, reason: null })).toBe("allowed through Walkie Direct");
});

test("a revocation that wrote nothing durable is reported as unsaved; any one durable write is enough", () => {
  const fail = (): never => { throw new Error("injected disk failure"); };
  const none = { record: fail, audit: fail, adminAudit: fail, grantState: fail };
  const attempt = (removeKeys: typeof revokeOwnerKeys, writeGate: typeof setSshGate, writes: Parameters<typeof revokeSshAccess>[4]): unknown => {
    const root = mkdtempSync(join(tmpdir(), "walkie-ssh-unsaved-"));
    const home = walkieHome(root);
    const sshHome = join(root, "person");
    mkdirSync(home); mkdirSync(sshHome);
    try {
      const grant = installSshGrant(home, sshHome, fixture());
      const core = { paths: { home }, sshUserHome: sshHome, hostname: "target" } as Core;
      try { revokeSshAccess(core, grant, removeKeys, writeGate, writes); } catch (err) { return err; }
      throw new Error("revocation was expected to report failures");
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  const unsaved = attempt(fail, fail, none);
  expect(unsaved).toBeInstanceOf(SshRevocationUnsaved);
  expect((unsaved as Error).message).toContain("SSH revocation incomplete");
  // Whatever single artifact survives, a restart still finds the denial, so it is not "unsaved".
  const survivors: Record<string, unknown> = {
    "revocation record": attempt(fail, fail, { ...none, record: recordSshRevocation }),
    "revocation audit": attempt(fail, fail, { ...none, audit: appendSshRevocationAudit }),
    "admin audit": attempt(fail, fail, { ...none, adminAudit: appendAuditStrict }),
    "grant state": attempt(fail, fail, { ...none, grantState: setGrantSshState }),
    "gate": attempt(fail, setSshGate, none),
    "key removal": attempt(revokeOwnerKeys, fail, none),
  };
  for (const [leg, error] of Object.entries(survivors)) {
    expect(error, leg).toBeInstanceOf(Error);
    expect(error, leg).not.toBeInstanceOf(SshRevocationUnsaved);
  }
});

test("doctor says plainly when a revocation was not saved", () => {
  const status: SshStatus = { owner_key_present: true, tunnel_allowed: false, reason: "ssh_denied", revocation_unsaved: true,
    server: { enabled: true, detail: "SSH server responds on 127.0.0.1" } };
  expect(REVOCATION_UNSAVED_MESSAGE)
    .toBe("the revocation was not saved; SSH stays closed until restart; run it again once the disk is writable");
  expect(sshStatusChecks(status).find((check) => check.name === "owner ssh"))
    .toEqual({ level: "fail", name: "owner ssh", detail: REVOCATION_UNSAVED_MESSAGE });
  expect(sshStatusChecks({ ...status, revocation_unsaved: false }).some((check) => check.name === "owner ssh")).toBe(false);
});

test("the unsaved warning follows the latest attempt and never claims a revocation the team holds", () => {
  const home = "/walkie-unsaved-outcome";
  const nothingSaved = new SshRevocationUnsaved("SSH revocation incomplete: every write failed");
  expect(noteRevocationOutcome(home, new Error("SSH revocation incomplete: key removal"), false)).toBeNull();
  expect(sshRevocationUnsaved(home)).toBe(false);
  expect(noteRevocationOutcome(home, nothingSaved, true)).toBeNull(); // a team peer holds the receipt
  expect(sshRevocationUnsaved(home)).toBe(false);
  const refusal = noteRevocationOutcome(home, nothingSaved, false);
  expect(refusal).toMatchObject({ status: 503, code: "ssh_revocation_unsaved", message: REVOCATION_UNSAVED_MESSAGE });
  expect(sshRevocationUnsaved(home)).toBe(true);
  expect(noteRevocationOutcome(home, null, false)).toBeNull(); // run again once the disk is writable
  expect(sshRevocationUnsaved(home)).toBe(false);
  noteRevocationOutcome(home, nothingSaved, false);
  beginSshDaemon(home); // a restart forgets it: nothing on disk could have kept it
  expect(sshRevocationUnsaved(home)).toBe(false);
});

test("a revocation begun from a stale grant is not incomplete when the grant was revoked meanwhile", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-ssh-stale-"));
  const home = walkieHome(root);
  const sshHome = join(root, "person");
  mkdirSync(home); mkdirSync(sshHome);
  try {
    installSshGrant(home, sshHome, fixture());
    const stale = readGrant(home) as Grant; // what a caller read before it waited on something
    revokeGrant(home); // `walkie provision revoke` finished first
    const core = { paths: { home }, sshUserHome: sshHome, hostname: "target" } as Core;
    expect(() => revokeSshAccess(core, stale)).not.toThrow();
    expect(sshRevocationProblem(home)).toBe("revoked"); // the record names no failure
    expect(hasOwnerKey(home, team, "alex", key)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a grant a concurrent revoke already denied is not written again", () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-ssh-stale-"));
  const home = walkieHome(root);
  const sshHome = join(root, "person");
  mkdirSync(home); mkdirSync(sshHome);
  try {
    installSshGrant(home, sshHome, fixture());
    const stale = readGrant(home) as Grant;
    setGrantSshState(home, "denied"); // the other revoke got as far as denying SSH
    const core = { paths: { home }, sshUserHome: sshHome, hostname: "target" } as Core;
    const fail = (): never => { throw new Error("injected disk failure"); };
    // The state is already what this revocation would write, so a failing state write is not a failure.
    expect(() => revokeSshAccess(core, stale, undefined, undefined, { record: recordSshRevocation, audit: appendSshRevocationAudit,
      adminAudit: appendAuditStrict, grantState: fail })).not.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
