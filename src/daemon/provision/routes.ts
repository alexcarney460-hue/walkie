import { z } from "zod";
import { json, HttpError, parseWith, readJson } from "../http.ts";
import { LOCAL_BODY_MAX, requireTeam, route, type RouteCtx } from "../local-routes.ts";
import { nodeMember } from "../roster.ts";
import { parseLauncher } from "../../protocol/seats.ts";
import { SeatAccountKey } from "../../protocol/seats.ts";
import { appendAudit, recordAdmin } from "../admin/audit.ts";
import { agentCaller, personOnly } from "../admin/gate.ts";
import { runFor } from "../admin/runs.ts";
import { provisionProblem, provisionUidProblem } from "./authorization.ts";
import { CLI_CONSENT_PHRASE, CONSENT_VERSION, consentText } from "./consent.ts";
import { executorFor } from "./executor.ts";
import { createGrant, GRANT_DAYS, readGrant, revokeGrant, type Grant } from "./grant.ts";
import { profile, type ProfileId } from "./profiles.ts";
import { applyProfile, markInterrupted, observedStatus, profileStatus, resetProfileJournal, type ApplyResult } from "./runner.ts";
import { OwnerSshGrant, verifyOwnerSshGrant } from "../ssh/grant.ts";
import { installSshGrant, SshInstallRollbackError } from "../ssh/enrollment.ts";
import { hasOwnerKey } from "../ssh/authorized-keys.ts";
import { enrollmentPath, requireEnrollmentRoot, rootMarkerPresent, RootMarkerInvalid, RootMarkerRequired } from "./root-marker.ts";
import { closeSshTunnelsQuietly } from "../ssh/tunnel.ts";
import { noteRevocationOutcome, revokeSshAccess } from "../ssh/revoke.ts";
import { admittedBySshInvite, consumeSshPacket, isSshPacketSpent, releaseSshPacket, sshPacketRecordPath } from "../ssh/packet.ts";
import { sshServerStatus } from "../ssh/server.ts";
import type { Core } from "../core.ts";

const running = new WeakMap<object, Set<ProfileId>>();
function isRunning(core: object, id: ProfileId): boolean { return running.get(core)?.has(id) ?? false; }
function claim(core: object, id: ProfileId): () => void {
  const active = running.get(core) ?? new Set<ProfileId>();
  if (active.size) throw new HttpError(409, "provision_busy", "a provisioning profile is already running");
  active.add(id); running.set(core, active);
  return () => { active.delete(id); };
}

function reconciledStatus(home: string, id: ProfileId, active: boolean) {
  try { return active ? profileStatus(home, id) : markInterrupted(home, id); }
  catch (err) {
    const changed = (err as Error).message === "profile journal version mismatch";
    throw new HttpError(409, changed ? "profile_version_mismatch" : "receipt_invalid",
      changed ? "profile changed: renew local consent, then run walkie provision reset --profile <id> to archive the old receipt" : "the private provision receipt is unreadable");
  }
}

function existingGrant(home: string): Grant | null {
  try { return readGrant(home); }
  catch { throw new HttpError(409, "grant_invalid", "the private enrollment grant is unreadable"); }
}

const Selection = z.object({ id: z.enum(["developer-worker", "freight-worker"]), version: z.number().int().positive() }).strict();
const Confirmation = z.object({ surface: z.enum(["cli", "desktop", "windows"]),
  typed_phrase: z.literal(CLI_CONSENT_PHRASE) }).strict();
const GrantReq = z.object({ owner_node: z.string().min(1).max(128), launchers: z.array(z.string().min(2).max(140)).min(1).max(50),
  seat_cap: z.number().int().min(1).max(100), profiles: z.array(Selection).min(1).max(2), company_mode: z.literal(true),
  worker_accounts: z.object({ claude: SeatAccountKey.optional(), codex: SeatAccountKey.optional() }).strict().optional(),
  owner_ssh: OwnerSshGrant.optional(),
  consent_version: z.literal(CONSENT_VERSION), consent_text: z.string().min(1).max(4000), consented: z.literal(true), confirmation: Confirmation,
}).strict();
const ApplyReq = z.object({ profile: z.enum(["developer-worker", "freight-worker"]) }).strict();
const CheckReq = z.object({ owner_ssh: OwnerSshGrant.optional() }).strict();

function actor(c: RouteCtx): { node: string; label: string; remote: boolean } {
  const run = runFor(c.core, c.req.headers.get("x-walkie-admin-token"));
  return run?.callerNode ? { node: run.callerNode, label: run.actor, remote: true }
    : { node: c.core.nodeId, label: `@${c.core.myHandle() ?? "unknown"}/${c.core.hostname}${agentCaller(c) ? "/agent" : ""}`, remote: false };
}

function requireProvision(c: RouteCtx, id: ProfileId): ReturnType<typeof actor> {
  const a = actor(c);
  const problem = provisionProblem(c.core, a.node, id, !a.remote && !agentCaller(c) && c.via !== "phone");
  if (problem) {
    appendAudit(c.core, { actor: a.label, action: `provision ${id}`, machine: c.core.hostname, via: a.remote ? "remote" : "local", refused: problem });
    throw new HttpError(403, problem, `provision ${id} refused: ${problem}`);
  }
  return a;
}

/**
 * Everything this daemon can know about an owner SSH packet before it is spent: the signature and expiry against the owner's
 * roster key, that it is for this team, this owner and this person, and that THIS machine was admitted by the invite it names.
 * The grant route and the check route both call this one function, so what the check promises is what the grant enforces.
 */
function assertPacketUsable(core: Core, packet: OwnerSshGrant, owner: { pubkey: string; node_id: string }, ownerHandle: string): void {
  try { verifyOwnerSshGrant(packet, owner.pubkey, Date.now()); }
  catch { throw new HttpError(403, "owner_ssh_invalid", "owner SSH authorization is not signed by the roster owner"); }
  if (packet.team_id !== core.teamId || packet.owner_node !== owner.node_id || packet.owner_handle !== ownerHandle || packet.recipient !== core.me()?.handle) {
    throw new HttpError(403, "owner_ssh_mismatch", "owner SSH authorization is for another enrollment");
  }
  if (!admittedBySshInvite(core, packet.invite_id)) throw new HttpError(403, "owner_ssh_invite", "the signed SSH authorization's invite did not admit this machine");
}

/**
 * What a failure before or during the install means to the caller. The root marker is the person's to install or repair, and
 * each of its two problems has its own code and message (a marker that is not what Walkie installed used to be reported as
 * a key failure). Only what is left, inside an owner-SSH install, is an owner key that could not be installed; its message
 * carries the real reason.
 */
function installRefusal(error: unknown, ssh: boolean, home: string): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RootMarkerRequired || message.includes("root enrollment marker is required")) {
    return new HttpError(409, "root_marker_required", "this machine's root-owned enrollment marker is missing: run the enrollment's administrator step "
      + "(walkie provision prepare-enrollment asks for your password once), then run the same command again; the same link still works");
  }
  if (error instanceof RootMarkerInvalid) {
    const path = enrollmentPath(home);
    return new HttpError(409, "root_marker_invalid", `the root enrollment marker ${path} is not what Walkie installed (${message}): have an administrator `
      + `fix or remove it, then run the same command again; the same link still works`);
  }
  return ssh ? new HttpError(409, "owner_key_install_failed", `owner key could not be installed: ${message}`) : error;
}

/**
 * The install failed after the packet was spent. If no owner key is in authorized_keys and the rollback finished,
 * nothing was authorized, so the packet goes back (the same link can be tried again). If a rollback did not finish, or
 * the state cannot be read, the packet stays spent.
 */
function giveBackUnusedPacket(core: RouteCtx["core"], packet: NonNullable<z.infer<typeof GrantReq>["owner_ssh"]>, error: unknown): void {
  if (error instanceof SshInstallRollbackError) return;
  try {
    if (hasOwnerKey(core.sshUserHome, packet.team_id, packet.owner_handle, packet.public_key)) return;
    releaseSshPacket(core.paths.home, packet);
  } catch { /* the state could not be established: the packet stays spent */ }
}

route("POST", "/v1/provision/grant", async (c) => {
  if (provisionUidProblem()) throw new HttpError(403, "root_forbidden", "provisioning must run as the machine person");
  personOnly(c, "approve enrollment provisioning");
  if (c.via === "phone" || runFor(c.core, c.req.headers.get("x-walkie-admin-token"))) throw new HttpError(403, "person_only", "enrollment consent is local to this machine");
  requireTeam(c);
  const b = parseWith(GrantReq, await readJson(c.req, LOCAL_BODY_MAX));
  const owner = c.core.roster.nodes.get(b.owner_node);
  const ownerMember = owner && !owner.revoked ? nodeMember(c.core.roster, owner.node_id) : null;
  if (!owner || !ownerMember || ownerMember.role !== "owner") throw new HttpError(403, "owner_required", "the named owner node is not a current roster owner");
  if (Object.values(b.worker_accounts ?? {}).some((key) => key?.split(":")[0] !== ownerMember.handle)) {
    throw new HttpError(400, "invalid_account", "worker accounts must belong to the named owner");
  }
  if (b.launchers.some((l) => !parseLauncher(l))) throw new HttpError(400, "invalid_launcher", "a launcher does not name a roster handle or agent");
  if (b.profiles.some((p) => profile(p.id)?.version !== p.version)) throw new HttpError(400, "profile_version_mismatch", "selected profile version is not built in");
  if (b.owner_ssh) assertPacketUsable(c.core, b.owner_ssh, owner, ownerMember.handle);
  const expected = consentText(ownerMember.handle, b.launchers, b.seat_cap, b.profiles, b.worker_accounts, b.owner_ssh);
  if (b.consent_text !== expected) throw new HttpError(400, "invalid_consent", "consent text does not match the current disclosure");
  const prior = existingGrant(c.core.paths.home);
  if (prior && !prior.revoked_at) throw new HttpError(409, "grant_exists", "revoke the old grant before a new local consent");
  // The one-use packet is spent only after every check that can fail before the owner key is written has passed
  // (the root marker, which createGrant also demands, included): a refusal here leaves the same packet usable.
  try { requireEnrollmentRoot(c.core.paths.home); }
  catch (error) { throw installRefusal(error, b.owner_ssh !== undefined, c.core.paths.home); }
  if (b.owner_ssh) {
    let fresh: boolean;
    try { fresh = consumeSshPacket(c.core.paths.home, b.owner_ssh); }
    catch (error) { throw new HttpError(409, "owner_ssh_record", `the one-use record of SSH authorizations (${sshPacketRecordPath(c.core.paths.home)}) could not be written: ${(error as Error).message}`); }
    if (!fresh) throw new HttpError(403, "owner_ssh_spent", "the signed SSH authorization was already used");
  }
  const created = Math.max(Date.now(), (prior?.revoked_at ?? 0) + 1);
  const input: Grant = { team_id: c.core.teamId as string, owner_node: owner.node_id,
    target_node: c.core.nodeId, recipient: c.core.me()?.handle as string, consent_text: expected, consent_version: CONSENT_VERSION,
    company_mode: true, launchers: b.launchers, seat_cap: b.seat_cap, profiles: b.profiles,
    ...(b.worker_accounts ? { worker_accounts: b.worker_accounts } : {}),
    ...(b.owner_ssh ? { owner_ssh: b.owner_ssh } : {}),
    created_at: created, expires_at: created + GRANT_DAYS * 86400_000 };
  let grant: Grant;
  try { grant = b.owner_ssh ? installSshGrant(c.core.paths.home, c.core.sshUserHome, input) : createGrant(c.core.paths.home, input); }
  catch (error) {
    // An install that left no owner key behind and rolled back completely does not spend the packet: it can be retried.
    if (b.owner_ssh) giveBackUnusedPacket(c.core, b.owner_ssh, error);
    throw installRefusal(error, b.owner_ssh !== undefined, c.core.paths.home);
  }
  recordAdmin(c.core, { actor: `@${grant.recipient}/${c.core.hostname}`, action: `approved enrollment grant for ${b.profiles.map((p) => `${p.id} v${p.version}`).join(", ")} via ${b.confirmation.surface}`, machine: c.core.hostname, via: "local" }, { post: false });
  recordAdmin(c.core, { actor: `@${ownerMember.handle}`, action: `may now provision ${c.core.hostname} (consent v${grant.consent_version}, expires ${new Date(grant.expires_at).toISOString()})`, machine: c.core.hostname, via: "local" }, { post: true });
  return json(grant);
});

/**
 * What the installer asks BEFORE the person's question and before any administrator step: would this daemon accept this
 * owner SSH packet, and what does the administrator step have to do? Nothing is spent, written or installed. A packet this
 * daemon would refuse (the grant route's own rules, one function) is refused here with the grant route's own code, so no root
 * work runs for it. A packet THIS machine's standing grant already carries reads as "recorded": a retry of the same command
 * resumes onto it. Local to this machine and the person's alone, like the grant it precedes.
 */
route("POST", "/v1/provision/check", async (c) => {
  if (provisionUidProblem()) throw new HttpError(403, "root_forbidden", "provisioning must run as the machine person");
  personOnly(c, "check enrollment provisioning");
  if (c.via === "phone" || runFor(c.core, c.req.headers.get("x-walkie-admin-token"))) throw new HttpError(403, "person_only", "enrollment checks are local to this machine");
  requireTeam(c);
  const b = parseWith(CheckReq, await readJson(c.req, LOCAL_BODY_MAX));
  let packet: "none" | "usable" | "recorded" = "none";
  if (b.owner_ssh) {
    const owner = c.core.roster.nodes.get(b.owner_ssh.owner_node);
    const ownerMember = owner && !owner.revoked ? nodeMember(c.core.roster, owner.node_id) : null;
    if (!owner || !ownerMember || ownerMember.role !== "owner") throw new HttpError(403, "owner_required", "the owner who signed this SSH authorization is not a current roster owner");
    assertPacketUsable(c.core, b.owner_ssh, owner, ownerMember.handle);
    const standing = existingGrant(c.core.paths.home);
    if (standing && !standing.revoked_at && standing.owner_ssh?.signature === b.owner_ssh.signature) packet = "recorded";
    else {
      let spent: boolean;
      try { spent = isSshPacketSpent(c.core.paths.home, b.owner_ssh); }
      catch (error) { throw new HttpError(409, "owner_ssh_record", `the one-use record of SSH authorizations (${sshPacketRecordPath(c.core.paths.home)}) could not be read: ${(error as Error).message}`); }
      if (spent) throw new HttpError(403, "owner_ssh_spent", "the signed SSH authorization was already used");
      packet = "usable";
    }
  }
  let rootMarker = false;
  try { rootMarker = rootMarkerPresent(c.core.paths.home); } catch { rootMarker = false; }
  return json({ root_marker: rootMarker, ssh_server: (await sshServerStatus()).enabled, owner_ssh: packet });
});

route("POST", "/v1/provision/revoke", async (c) => {
  personOnly(c, "revoke enrollment provisioning");
  if (c.via === "phone" || runFor(c.core, c.req.headers.get("x-walkie-admin-token"))) throw new HttpError(403, "person_only", "revoke this grant locally");
  const prior = existingGrant(c.core.paths.home);
  if (!prior) throw new HttpError(404, "grant_absent", "no enrollment grant exists");
  let sshFailure: unknown;
  if (prior.owner_ssh) {
    try { revokeSshAccess(c.core, prior); } catch (err) { sshFailure = err; }
  } else closeSshTunnelsQuietly(c.core);
  let grant: Grant;
  try { grant = revokeGrant(c.core.paths.home); }
  catch (err) {
    // This route sends no team receipt, so a grant that could not be marked revoked either leaves only memory.
    throw (prior.owner_ssh ? noteRevocationOutcome(c.core.paths.home, sshFailure, false) : null) ?? err;
  }
  if (prior.owner_ssh) noteRevocationOutcome(c.core.paths.home, null, false);
  if (sshFailure) throw sshFailure;
  if (!prior.revoked_at) recordAdmin(c.core, { actor: `@${c.core.myHandle() ?? "unknown"}/${c.core.hostname}`, action: `revoked @${c.core.myHandle() ?? "unknown"}'s enrollment grant for ${c.core.hostname}`, machine: c.core.hostname, via: "local" });
  return json({ revoked_at: grant.revoked_at });
});

route("POST", "/v1/provision/unenroll", () => {
  throw new HttpError(403, "person_only", "un-enroll from the machine person's interactive CLI");
});

route("POST", "/v1/provision/reset", async (c) => {
  if (provisionUidProblem()) throw new HttpError(403, "root_forbidden", "provisioning must run as the machine person");
  personOnly(c, "reset enrollment provisioning receipts");
  if (c.via === "phone" || c.req.headers.has("x-walkie-admin-token")) throw new HttpError(403, "person_only", "reset a profile locally");
  const b = parseWith(ApplyReq, await readJson(c.req, LOCAL_BODY_MAX));
  const grant = existingGrant(c.core.paths.home);
  if (!grant || grant.revoked_at || (grant.owner_ssh && grant.ssh_state !== "active") || grant.expires_at <= Date.now() ||
    grant.profiles.find((p) => p.id === b.profile)?.version !== profile(b.profile)?.version) {
    throw new HttpError(409, "new_consent_required", "renew local consent with the current profile version before reset");
  }
  if (isRunning(c.core, b.profile)) throw new HttpError(409, "provision_busy", "a provisioning profile is running");
  let archive: string;
  try { archive = await resetProfileJournal(c.core.paths.home, b.profile, grant.created_at); }
  catch (err) {
    const code = (err as Error).message;
    if (["profile_upgrade_required", "new_consent_required", "installer_process_unresolved", "receipt_migration_required"].includes(code)) {
      throw new HttpError(409, code, `provision reset refused: ${code}`);
    }
    throw new HttpError(409, "receipt_invalid", "the private provision receipt is unreadable");
  }
  recordAdmin(c.core, { actor: `@${c.core.myHandle() ?? "unknown"}/${c.core.hostname}`,
    action: `reset provision ${b.profile} receipt after new consent`, machine: c.core.hostname, via: "local" }, { post: false });
  return json({ reset: true, archived: !!archive });
});

route("GET", "/v1/provision", async (c) => {
  const id = c.url.searchParams.get("profile") ?? "";
  if (!profile(id)) throw new HttpError(400, "unknown_profile", "unknown provisioning profile");
  requireProvision(c, id as ProfileId);
  reconciledStatus(c.core.paths.home, id as ProfileId, isRunning(c.core, id as ProfileId));
  return json(await observedStatus(c.core.paths.home, id as ProfileId, executorFor(c.core.paths.home)));
});

route("POST", "/v1/provision/apply", async (c) => {
  if (provisionUidProblem()) throw new HttpError(403, "root_forbidden", "provisioning must run as the machine person");
  const b = parseWith(ApplyReq, await readJson(c.req, LOCAL_BODY_MAX));
  const token = c.req.headers.get("x-walkie-admin-token");
  const remoteRun = runFor(c.core, token);
  if (token && !remoteRun) throw new HttpError(403, "invalid_run_token", "provision apply requires a current admin run token");
  if (!remoteRun && (c.via === "phone" || agentCaller(c))) throw new HttpError(403, "person_only", "local provision apply requires the machine person");
  const a = requireProvision(c, b.profile);
  const release = claim(c.core, b.profile);
  c.noTimeout();
  let result: ApplyResult;
  try {
    reconciledStatus(c.core.paths.home, b.profile, false);
    result = await applyProfile(c.core.paths.home, b.profile, () => provisionProblem(c.core, a.node, b.profile, !a.remote) ||
      (a.remote && !runFor(c.core, token) ? "remote_run_ended" : null), executorFor(c.core.paths.home), {
      actor: a.label, target: c.core.hostname,
      onTransition: (step, state) => appendAudit(c.core, { actor: a.label, action: `provision ${b.profile} v${profile(b.profile)?.version} ${step.id}: ${state}`, machine: c.core.hostname, via: a.remote ? "remote" : "local" }),
    });
  } finally { release(); }
  if (!a.remote) recordAdmin(c.core, { actor: a.label, action: `provision ${b.profile} v${result.journal.version}: ${result.state}`, machine: c.core.hostname, via: "local" });
  return json(result);
});
