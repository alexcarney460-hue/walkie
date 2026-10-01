import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { remoteArgvProblem } from "../../src/protocol/admin.ts";
import { PROFILES, profileArgvProblem, profileIdFromArgv } from "../../src/daemon/provision/profiles.ts";
import { createGrant, readGrant, revokeGrant, authorizeProvision, backfillEnrollment, enrollmentMode, unenrollGrant, type Grant } from "../../src/daemon/provision/grant.ts";
import { requiredWorkerAccount } from "../../src/daemon/seats/enrollment-account.ts";
import { applyProfile, markInterrupted, observedStatus, profileStatus, resetProfileJournal, type StepExecutor } from "../../src/daemon/provision/runner.ts";
import { provisionChecks, vaultProbeLogChecks } from "../../src/cli/commands/doctor.ts";
import { inspectVersion, lockProblem, runInstaller, systemVersionAtLeast } from "../../src/daemon/provision/executor.ts";
import { provisionUidProblem } from "../../src/daemon/provision/authorization.ts";
import { ProvisionInterrupted } from "../../src/daemon/provision/interrupt.ts";
import codexLock from "../../src/daemon/provision/locks/codex/package-lock.json";
import { cliConsentAccepted, provision, rootUnenrollProblem } from "../../src/cli/commands/provision.ts";
import { parseAdminArgv } from "../../src/daemon/seats/admin.ts";
import { seatUserPlan } from "../../src/daemon/seats/seat-user.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { CLI_CONSENT_PHRASE } from "../../src/daemon/provision/consent.ts";
import { enrollmentPath, secureMarkerMetadata, setTestEnrollmentRoot } from "../../src/daemon/provision/root-marker.ts";

const homes: string[] = [];
const home = () => { const p = mkdtempSync("/tmp/walkie-provision-"); homes.push(p); setTestEnrollmentRoot(p, join(p, "root")); return p; };
afterEach(() => { for (const p of homes.splice(0)) rmSync(p, { recursive: true, force: true }); });

const fields = {
  team_id: "team-1", owner_node: "owner-node", target_node: "target-node", recipient: "kira", consent_version: 1,
  company_mode: true as const, launchers: ["@alex"], seat_cap: 3,
  profiles: [{ id: "developer-worker" as const, version: PROFILES["developer-worker"].version }],
  consent_text: "consent shown", created_at: Date.now(), expires_at: Date.now() + 90 * 86400_000,
};
const checks = (grant: Grant | null, extra: Record<string, unknown> = {}) => ({
  grant, teamId: "team-1", targetHandle: "kira", targetNode: "target-node", ownerHandle: "alex", actorHandle: "alex", actorNode: "owner-node",
  actorRole: "owner", ownerNodeCurrent: true, remoteAdmin: true, agentAdmin: true,
  profile: "developer-worker", ...extra,
});

test("grant is atomic, private, bound to joined team, and revocation refuses execution", () => {
  const p = home();
  const g = createGrant(p, fields);
  expect(readGrant(p)).toEqual(g);
  expect(statSync(join(p, "provision-grant.json")).mode & 0o777).toBe(0o600);
  expect(authorizeProvision(checks(g))).toBeNull();
  const revoked = revokeGrant(p, fields.created_at + 1);
  expect(revoked.revoked_at).toBe(fields.created_at + 1);
  expect(authorizeProvision(checks(readGrant(p)))).toBe("grant_revoked");
  expect(() => createGrant(p, { ...fields, created_at: fields.created_at })).toThrow();
  expect(createGrant(p, { ...fields, created_at: fields.created_at + 2 }).revoked_at).toBeUndefined();
});

test("a deleted grant leaves enrolled mode active until the local person explicitly unenrolls", () => {
  const p = home();
  createGrant(p, fields);
  expect(enrollmentMode(p)).toBe(true);
  unlinkSync(join(p, "provision-grant.json"));
  expect(readGrant(p)).toBeNull();
  expect(enrollmentMode(p)).toBe(true);
  unenrollGrant(p);
  expect(enrollmentMode(p)).toBe(false);
  createGrant(p, { ...fields, created_at: fields.created_at + 1 });
  revokeGrant(p);
  unenrollGrant(p);
  expect(enrollmentMode(p)).toBe(false);
  expect(readGrant(p)).toBeNull();
});

test("startup backfills old grant and journal enrollment before a grant is lost", () => {
  const p = home();
  // Legacy grant from before the root marker existed.
  writeFileSync(join(p, "provision-grant.json"), `${JSON.stringify(fields)}\n`, { mode: 0o600 });
  expect(backfillEnrollment(p)).toBe(true);
  expect(statSync(enrollmentPath(p)).mode & 0o777).toBe(0o644);
  unlinkSync(join(p, "provision-grant.json"));
  expect(enrollmentMode(p)).toBe(true);
  expect(requiredWorkerAccount(null, {} as never, Date.now(), enrollmentMode(p))).toContain("grant is missing");
  const other = home();
  writeFileSync(join(other, "provision-developer-worker.json"), "{}\n", { mode: 0o600 });
  expect(backfillEnrollment(other)).toBe(true);
  expect(enrollmentMode(other)).toBe(true);
});

test("a same-user grant file cannot restore enrollment after the root marker is removed", () => {
  const p = home();
  createGrant(p, fields);
  revokeGrant(p);
  unenrollGrant(p);
  writeFileSync(join(p, "provision-grant.json"), `${JSON.stringify(fields)}\n`, { mode: 0o600 });
  expect(enrollmentMode(p)).toBe(false);
  expect(requiredWorkerAccount(readGrant(p), {} as never, Date.now(), enrollmentMode(p)))
    .toContain("root enrollment marker");
});

test("absent grant, wrong owner, switched-off admin, wrong team and unknown profile refuse", () => {
  const p = home();
  expect(authorizeProvision(checks(null))).toBe("grant_absent");
  const g = createGrant(p, fields);
  expect(authorizeProvision(checks(g, { actorRole: "member", actorHandle: "other" }))).toBe("not_authorized");
  expect(authorizeProvision(checks(g, { actorRole: "owner", actorHandle: "other" }))).toBe("owner_not_consented");
  expect(authorizeProvision(checks(g, { actorRole: "member", actorHandle: "kira", actorNode: "target-node", localPerson: true }))).toBeNull();
  expect(authorizeProvision(checks(g, { targetNode: "copied-to-other-machine" }))).toBe("wrong_machine");
  expect(authorizeProvision(checks(g, { now: g.expires_at + 1 }))).toBe("grant_expired");
  expect(authorizeProvision(checks({ ...g, consent_version: 999 }))).toBe("consent_version_mismatch");
  expect(authorizeProvision(checks(g, { ownerNodeCurrent: false }))).toBe("owner_changed");
  expect(authorizeProvision(checks(g, { remoteAdmin: false }))).toBe("remote_admin_off");
  expect(authorizeProvision(checks(g, { agentAdmin: false }))).toBe("agent_admin_off");
  expect(authorizeProvision(checks(g, { teamId: "elsewhere" }))).toBe("wrong_team");
  expect(authorizeProvision(checks(g, { profile: "custom" }))).toBe("unknown_profile");
  expect(authorizeProvision(checks({ ...g, profiles: [{ id: "developer-worker", version: 999 }] }))).toBe("profile_version_mismatch");
});

test("remote provision is a fixed verb with one fixed profile and no caller program or URL", () => {
  expect(remoteArgvProblem(["provision", "status", "--profile", "developer-worker"])).toBeNull();
  expect(remoteArgvProblem(["provision", "apply", "--profile=freight-worker"])).toBeNull();
  for (const argv of [
    ["provision", "apply", "--profile", "custom"],
    ["provision", "apply", "--profile", "developer-worker", "--url", "https://evil"],
    ["provision", "apply", "--profile", "developer-worker", "--", "sh"],
    ["provision", "apply", "--profile", "developer-worker", "--yes"],
    ["provision", "revoke", "--profile", "developer-worker"],
  ]) expect(remoteArgvProblem(argv)).not.toBeNull();
  expect(profileArgvProblem(["apply", "--profile", "developer-worker"])).toBeNull();
  expect(profileIdFromArgv(["apply", "--profile=developer-worker"])).toBe("developer-worker");
  expect(profileArgvProblem(["apply", "--profile", "--json", "developer-worker"])).not.toBeNull();
  expect(profileIdFromArgv(["apply", "--profile", "--json", "developer-worker"])).toBeNull();
});

test("CLI consent needs an interactive terminal and the exact typed phrase", () => {
  expect(cliConsentAccepted(false, CLI_CONSENT_PHRASE)).toBe(false);
  expect(cliConsentAccepted(true, "YES")).toBe(false);
  expect(CLI_CONSENT_PHRASE).toBe("yes");
  expect(cliConsentAccepted(true, CLI_CONSENT_PHRASE)).toBe(true);
});

test("un-enroll CLI refuses a non-interactive caller before any daemon or sudo action", async () => {
  const ctx = { args: { pos: ["unenroll"], flags: new Map() }, json: false, forAgent: false,
    agentMarker: () => null, person: { interactive: () => false, ask: async () => "yes", note: () => undefined },
    client: () => { throw new Error("daemon must not be called"); }, out: () => undefined, err: () => undefined } as unknown as Ctx;
  await expect(provision(ctx)).rejects.toMatchObject({ code: "person_only" });
});

test("passwordless seat helper has no marker removal command", () => {
  const plan = seatUserPlan({ platform: "darwin", daemonUser: "arvid", source: "/usr/local/bin/walkie",
    groupId: 590_001, walkieHome: "/Users/arvid/.walkie", sudoersTmp: "/tmp/walkie-seats",
    home: "/Users/arvid", homeProblem: null, runtimes: {} });
  expect(plan.sudoers).not.toContain("root-marker");
  expect(plan.sudoers).not.toContain("unenroll");
  expect(parseAdminArgv(["root-marker", "remove"])).toBeNull();
  expect(parseAdminArgv(["unenroll-root"])).toBeNull();
});

test("root un-enrollment step requires a TTY and rechecks seats and grant", () => {
  const p = home();
  createGrant(p, fields);
  const uid = statSync(p).uid;
  expect(rootUnenrollProblem(p, uid, 0, false)).toContain("interactive terminal");
  expect(rootUnenrollProblem(p, uid, 0, true)).toContain("revoke");
  revokeGrant(p);
  writeFileSync(join(p, "config.json"), JSON.stringify({ seats: { allow: true } }), { mode: 0o600 });
  expect(rootUnenrollProblem(p, uid, 0, true)).toContain("turn seats off");
  writeFileSync(join(p, "config.json"), JSON.stringify({ seats: { allow: false } }), { mode: 0o600 });
  expect(rootUnenrollProblem(p, uid, 0, true)).toBeNull();
});

test("direct root un-enrollment command refuses without a terminal", async () => {
  const p = home();
  const ctx = { args: { pos: ["unenroll-root", p], flags: new Map() }, json: false, forAgent: false,
    agentMarker: () => null, client: () => { throw new Error("daemon must not be called"); },
    out: () => undefined, err: () => undefined } as unknown as Ctx;
  await expect(provision(ctx)).rejects.toThrow("interactive terminal");
});

test("production enrollment marker requires a root owner and no write permission for the machine user", () => {
  const path = enrollmentPath("/Users/example/.walkie");
  expect(path.startsWith(process.platform === "darwin" ? "/Library/Application Support/Walkie/" : "/var/lib/walkie/")).toBe(true);
  const file = { isFile: () => true, uid: 0, mode: 0o100644 };
  expect(secureMarkerMetadata(file)).toBe(true);
  expect(secureMarkerMetadata({ ...file, uid: 501 })).toBe(false);
  expect(secureMarkerMetadata({ ...file, mode: 0o100664 })).toBe(false);
});

test("owner doctor shows bounded local probe refusal reasons", () => {
  const p = home();
  mkdirSync(join(p, "logs"));
  writeFileSync(join(p, "logs", "daemon.log"), [
    JSON.stringify({ msg: "vault_probe_denied", reason: "claude_token_unreadable" }),
    JSON.stringify({ msg: "vault_probe_denied", reason: "reserved" }),
  ].join("\n"));
  expect(vaultProbeLogChecks(p).map((item) => item.detail)).toEqual([
    "recent owner-side refusal: claude_token_unreadable", "recent owner-side refusal: reserved",
  ]);
});

test("locked package metadata rejects changed version, host and missing SHA-512", () => {
  expect(lockProblem(codexLock, "@openai/codex", "0.159.1")).toBeNull();
  expect(lockProblem(codexLock, "@openai/codex", "0.160.0")).toBe("wrong_lock_version");
  const replaced = structuredClone(codexLock) as typeof codexLock;
  replaced.packages["node_modules/@openai/codex"]!.resolved = "https://example.com/codex.tgz";
  expect(lockProblem(replaced, "@openai/codex", "0.159.1")).toBe("unverified_package");
});

test("system versions use minimums and a missing prerequisite does not block user installs", async () => {
  expect(systemVersionAtLeast("git version 2.50.1", "2.30")).toBe(true);
  expect(systemVersionAtLeast("GNU Make 3.81", "3.81")).toBe(true);
  expect(systemVersionAtLeast("OpenSSH_10.2p1", "8.0")).toBe(true);
  expect(systemVersionAtLeast("git version 2.20", "2.30")).toBe(false);
  const p = home();
  const installed = new Set<string>();
  const ran: string[] = [];
  const executor: StepExecutor = {
    inspect: async (s) => installed.has(s.id) ? "installed" : "missing",
    execute: async (s) => {
      if (s.kind === "check" || s.kind === "installer_elevation") return "needs_installer_elevation";
      ran.push(s.id); installed.add(s.id);
    },
  };
  const result = await applyProfile(p, "developer-worker", () => null, executor);
  expect(result.state).toBe("needs_installer_elevation");
  expect(ran).toContain("node");
  expect(ran).toContain("codex");
});

test("journal is persisted before installer; success is never repeated; failed step resumes", async () => {
  const p = home();
  const g = createGrant(p, fields);
  const calls: string[] = [];
  const installed = new Set(["walkie-daemon"]);
  let fail = true;
  const executor: StepExecutor = {
    inspect: async (s) => installed.has(s.id) ? "installed" : "missing",
    execute: async (s) => {
      const status = profileStatus(p, "developer-worker");
      expect(status.steps.find((x) => x.id === s.id)?.state).toBe("started");
      expect(status.steps.find((x) => x.id === s.id)?.actor).toBe("@alex/owner");
      expect(status.steps.find((x) => x.id === s.id)?.target).toBe("test-machine");
      calls.push(s.id);
      if (fail) { fail = false; throw new Error("simulated installer failure"); }
      installed.add(s.id);
    },
  };
  const guard = () => authorizeProvision(checks(readGrant(p)));
  const context = { actor: "@alex/owner", target: "test-machine" };
  expect((await applyProfile(p, "developer-worker", guard, executor, context)).state).toBe("failed");
  expect((await applyProfile(p, "developer-worker", guard, executor, context)).state).not.toBe("failed");
  expect(calls.filter((x) => x === calls[0]).length).toBe(2);
  const before = calls.length;
  await applyProfile(p, "developer-worker", guard, executor, context);
  expect(calls.length).toBe(before);
  expect(statSync(join(p, "provision-developer-worker.json")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(p, "provision-developer-worker.json"), "utf8")).not.toContain("simulated installer failure");
  expect(g.recipient).toBe("kira");
});

test("doctor reports every selected step and an interrupted installer stays uncertain", async () => {
  const p = home();
  createGrant(p, fields);
  expect((await provisionChecks(p)).length).toBe(PROFILES["developer-worker"].steps.length);
  const initial = profileStatus(p, "developer-worker");
  const started = { ...initial, steps: initial.steps.map((s, i) => i === 0 ? { ...s, state: "started" } : s) };
  writeFileSync(join(p, "provision-developer-worker.json"), JSON.stringify(started), { mode: 0o600 });
  expect(markInterrupted(p, "developer-worker").steps[0]?.state).toBe("uncertain");
  expect((await provisionChecks(p))[0]?.level).toBe("fail");
});

test("doctor names the migration command when the enrollment backfill needs elevation", async () => {
  const p = home();
  const checks = await provisionChecks(p, () => { throw new Error("enrollment migration requires local elevation: run walkie provision migrate-enrollment"); });
  expect(checks).toEqual([{ level: "fail", name: "provision", detail: "enrollment migration requires local elevation: run walkie provision migrate-enrollment" }]);
});

test("status rechecks done steps and reports drift without rerunning them", async () => {
  const p = home();
  const initial = profileStatus(p, "developer-worker");
  writeFileSync(join(p, "provision-developer-worker.json"), JSON.stringify({ ...initial,
    steps: initial.steps.map((s) => ({ ...s, state: "done" })) }), { mode: 0o600 });
  const executor: StepExecutor = { inspect: async (s) => s.id === "node" ? "missing" : "installed", execute: async () => { throw new Error("must not install"); } };
  const status = await observedStatus(p, "developer-worker", executor);
  expect(status.steps.find((s) => s.id === "node")?.state).toBe("drift");
  expect(profileStatus(p, "developer-worker").steps.find((s) => s.id === "node")?.state).toBe("done");
  const result = await applyProfile(p, "developer-worker", () => null, executor);
  expect(result.state).toBe("drift");
  expect(result.journal.steps.find((s) => s.id === "node")?.state).toBe("drift");
});

test("apply holds a recorded success when inspection fails", async () => {
  const p = home();
  const initial = profileStatus(p, "developer-worker");
  writeFileSync(join(p, "provision-developer-worker.json"), JSON.stringify({ ...initial,
    steps: initial.steps.map((s) => ({ ...s, state: "done" })) }), { mode: 0o600 });
  const executor: StepExecutor = { inspect: async (s) => {
    if (s.id === "node") throw new Error("inspection unavailable");
    return "installed";
  }, execute: async () => { throw new Error("must not install"); } };
  const result = await applyProfile(p, "developer-worker", () => null, executor);
  expect(result.state).toBe("uncertain");
  expect(result.journal.steps.find((s) => s.id === "node")?.state).toBe("uncertain");
});

test("advancing a later step never persists a transient observation over a successful installer receipt", async () => {
  const p = home();
  const initial = profileStatus(p, "developer-worker");
  writeFileSync(join(p, "provision-developer-worker.json"), JSON.stringify({ ...initial,
    steps: initial.steps.map((s) => ({ ...s, state: s.id === "pnpm" ? "pending" : "done" })) }), { mode: 0o600 });
  let nodeInspectionFails = true;
  const installed = new Set<string>();
  const executed: string[] = [];
  const executor: StepExecutor = {
    inspect: async (s) => {
      if (s.id === "node" && nodeInspectionFails) throw new Error("transient inspection error");
      if (s.id === "node" || s.id === "pnpm") return installed.has(s.id) ? "installed" : "missing";
      return "installed";
    },
    execute: async (s) => { executed.push(s.id); installed.add(s.id); },
  };
  const first = await applyProfile(p, "developer-worker", () => null, executor);
  expect(first.state).toBe("uncertain");
  expect(first.journal.steps.find((s) => s.id === "node")?.state).toBe("uncertain");
  expect(executed).toEqual(["pnpm"]);
  expect(profileStatus(p, "developer-worker").steps.find((s) => s.id === "node")?.state).toBe("done");
  nodeInspectionFails = false;
  const second = await applyProfile(p, "developer-worker", () => null, executor);
  expect(second.state).toBe("drift");
  expect(second.journal.steps.find((s) => s.id === "node")?.state).toBe("drift");
  expect(profileStatus(p, "developer-worker").steps.find((s) => s.id === "node")?.state).toBe("done");
  expect(executed).not.toContain("node");
});

test("profile upgrade retains successful destructive receipt and refuses a live installer", async () => {
  const p = home();
  const old = { profile: "developer-worker", version: 2, steps: [
    { id: "node", version: "22.20.0", state: "done", attempts: 1, at: 1 },
    { id: "pnpm", version: "10.0", state: "uncertain", attempts: 1, at: 2, process: { pid: 12345, start: "fixed-start" } },
  ] };
  writeFileSync(join(p, "provision-developer-worker.json"), JSON.stringify(old), { mode: 0o600 });
  expect(() => profileStatus(p, "developer-worker")).toThrow("profile journal version mismatch");
  await expect(resetProfileJournal(p, "developer-worker", 3, async () => true)).rejects.toThrow("installer_process_unresolved");
  expect(readFileSync(join(p, "provision-developer-worker.json"), "utf8")).toContain("fixed-start");
  const archive = await resetProfileJournal(p, "developer-worker", 3, async () => false);
  expect(archive).toContain(".bak");
  expect(JSON.parse(readFileSync(archive!, "utf8"))).toEqual(old);
  const current = profileStatus(p, "developer-worker");
  expect(current.version).toBe(PROFILES["developer-worker"].version);
  expect(current.steps.find((s) => s.id === "node")?.state).toBe("done");
  expect(current.steps.find((s) => s.id === "pnpm")?.state).toBe("uncertain");
  const executor: StepExecutor = { inspect: async (s) => s.id === "node" ? "missing" : "installed", execute: async () => { throw new Error("must not install"); } };
  const result = await applyProfile(p, "developer-worker", () => null, executor, { processAlive: async () => false });
  expect(result.state).toBe("drift");
  expect(result.journal.steps.find((s) => s.id === "node")?.state).toBe("drift");
});

test("reset requires a newer profile and consent after the prior receipt", async () => {
  const p = home();
  const current = profileStatus(p, "developer-worker");
  writeFileSync(join(p, "provision-developer-worker.json"), JSON.stringify(current), { mode: 0o600 });
  await expect(resetProfileJournal(p, "developer-worker", Date.now() + 1)).rejects.toThrow("profile_upgrade_required");
  const old = { profile: "developer-worker", version: 2, steps: [{ id: "node", version: "22.20.0", state: "done", attempts: 1, at: 100 }] };
  writeFileSync(join(p, "provision-developer-worker.json"), JSON.stringify(old), { mode: 0o600 });
  await expect(resetProfileJournal(p, "developer-worker", 100)).rejects.toThrow("new_consent_required");
  const unmatched = { profile: "developer-worker", version: 2,
    steps: [{ id: "retired-installer", version: "1", state: "uncertain", attempts: 0, at: 0 }] };
  writeFileSync(join(p, "provision-developer-worker.json"), JSON.stringify(unmatched), { mode: 0o600 });
  await expect(resetProfileJournal(p, "developer-worker", 101)).rejects.toThrow("receipt_migration_required");
});

test("legacy unbound grant can be revoked for new consent but cannot authorize", () => {
  const p = home();
  const { target_node: _node, expires_at: _expiry, ...legacy } = fields;
  writeFileSync(join(p, "provision-grant.json"), JSON.stringify(legacy), { mode: 0o600 });
  expect(authorizeProvision(checks(readGrant(p)))).not.toBeNull();
  expect(revokeGrant(p).revoked_at).toBeGreaterThan(0);
  expect(createGrant(p, { ...fields, created_at: Date.now() + 10 }).target_node).toBe("target-node");
});

test("doctor explains profile renewal before a receipt reset", async () => {
  const p = home();
  writeFileSync(join(p, "provision-grant.json"), JSON.stringify({ ...fields,
    profiles: [{ id: "developer-worker", version: 2 }] }), { mode: 0o600 });
  expect((await provisionChecks(p))[0]?.detail).toContain("renew local consent");
});

test("switch-off after inspection but before an installer action prevents execution", async () => {
  const p = home();
  createGrant(p, fields);
  let allowed = true;
  let executed = 0;
  const executor: StepExecutor = {
    inspect: async () => { allowed = false; return "missing"; },
    execute: async () => { executed++; },
  };
  const result = await applyProfile(p, "developer-worker", () => allowed ? null : "remote_admin_off", executor);
  expect(result.state).toBe("revoked");
  expect(executed).toBe(0);
});

test("uncertain installer waits while its recorded process remains alive", async () => {
  const p = home();
  createGrant(p, fields);
  const initial = profileStatus(p, "developer-worker");
  const saved = { ...initial, steps: initial.steps.map((s) => s.id === "node" ?
    { ...s, state: "uncertain", process: { pid: 12345, start: "fixed-start" } } : { ...s, state: "done" }) };
  writeFileSync(join(p, "provision-developer-worker.json"), JSON.stringify(saved), { mode: 0o600 });
  let executed = 0;
  const executor: StepExecutor = { inspect: async () => "missing", execute: async () => { executed++; } };
  const result = await applyProfile(p, "developer-worker", () => null, executor, { processAlive: async () => true });
  expect(result.state).toBe("uncertain");
  expect(executed).toBe(0);
  await applyProfile(p, "developer-worker", () => null, executor, { processAlive: async () => false });
  expect(executed).toBe(1);
});

test("running fake installer is interrupted and leaves an uncertain receipt", async () => {
  const p = home();
  createGrant(p, fields);
  let reason: string | null = null;
  let seen = false;
  const executor: StepExecutor = {
    inspect: async () => "missing",
    execute: async (_step, onProcess, guard) => {
      await runInstaller([process.execPath, "-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], p,
        { PATH: process.env.PATH ?? "" }, onProcess, guard);
    },
  };
  setTimeout(() => { reason = "grant_revoked"; }, 150);
  const result = await applyProfile(p, "developer-worker", () => reason, executor, { onTransition: (_s, state) => { if (state === "uncertain") seen = true; } });
  expect(result.state).toBe("revoked");
  expect(seen).toBe(true);
  expect(result.journal.steps[0]?.state).toBe("uncertain");
  expect(ProvisionInterrupted).toBeDefined();
});

test("failure receipt stores a safe reason and root is refused", async () => {
  expect(provisionUidProblem(0)).toBe("root_forbidden");
  expect(provisionUidProblem(501)).toBeNull();
  const p = home();
  const executor: StepExecutor = { inspect: async () => "missing", execute: async () => { throw new Error("Node archive checksum mismatch secret-raw-detail"); } };
  const result = await applyProfile(p, "developer-worker", () => null, executor);
  expect(result.journal.steps[0]?.reason).toBe("checksum_mismatch");
  expect(readFileSync(join(p, "provision-developer-worker.json"), "utf8")).not.toContain("secret-raw-detail");
  let ticked = false;
  const pending = inspectVersion([process.execPath, "-e", "setTimeout(()=>console.log('v1.2.3'),100)"], p);
  setTimeout(() => { ticked = true; }, 10);
  expect(await pending).toBe("v1.2.3");
  expect(ticked).toBe(true);
});
