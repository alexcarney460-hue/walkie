import { join, resolve } from "node:path";
import { unlinkSync } from "node:fs";
import { z } from "zod";
import { readPrivate, writePrivate } from "./files.ts";
import { profile } from "./profiles.ts";
import { CONSENT_VERSION } from "./consent.ts";
import { SeatAccountKey } from "../../protocol/seats.ts";
import { walkieArgv } from "../../hooks/install.ts";
import { removeRootMarker, requireEnrollmentRoot, rootMarkerPresent, rootUnenrolled, writeRootMarker } from "./root-marker.ts";
import { OwnerSshGrant } from "../ssh/grant.ts";

export const GRANT_DAYS = 90;

const GrantSchema = z.object({
  team_id: z.string().min(1).max(128), owner_node: z.string().min(1).max(128), target_node: z.string().min(1).max(128), recipient: z.string().min(1).max(80),
  consent_text: z.string().min(1).max(4000), consent_version: z.number().int().positive(), company_mode: z.literal(true),
  launchers: z.array(z.string().min(2).max(140)).min(1).max(50), seat_cap: z.number().int().min(1).max(100),
  profiles: z.array(z.object({ id: z.enum(["developer-worker", "freight-worker"]), version: z.number().int().positive() }).strict()).min(1).max(2),
  worker_accounts: z.object({ claude: SeatAccountKey.optional(), codex: SeatAccountKey.optional() }).strict().optional(),
  owner_ssh: OwnerSshGrant.optional(),
  ssh_state: z.enum(["pending", "active", "denied"]).optional(),
  created_at: z.number().int().positive(), expires_at: z.number().int().positive(), revoked_at: z.number().int().positive().optional(),
}).strict();
const LegacyGrantSchema = GrantSchema.omit({ target_node: true, expires_at: true });
export type Grant = z.infer<typeof GrantSchema>;
export const grantPath = (home: string) => join(home, "provision-grant.json");
export { enrollmentPath } from "./root-marker.ts";

/** A prior grant or provisioning receipt is evidence of enrollment even when its marker predates this release. */
export function backfillEnrollment(home: string): boolean {
  if (rootMarkerPresent(home)) return true;
  if (rootUnenrolled(home)) return false;
  if (!legacyEnrollmentEvidence(home)) return false;
  try { writeRootMarker(home); } catch {
    // Existing installations may have a cached noninteractive sudo credential.
    let installed = false;
    try {
      const result = Bun.spawnSync(["sudo", "-n", ...walkieArgv(), "provision", "root-marker", "install", resolve(home)],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      installed = result.exitCode === 0 && rootMarkerPresent(home);
    } catch { /* no usable noninteractive elevation */ }
    if (!installed) {
      throw new Error("enrollment migration requires local elevation: run walkie provision migrate-enrollment");
    }
  }
  return true;
}

export function legacyEnrollmentEvidence(home: string): boolean {
  const legacy = readPrivate(join(home, "enrolled-mode.json"));
  if (legacy !== null && legacy !== '{"company_mode":true}\n') throw new Error("legacy enrolled mode marker is unreadable");
  const grant = readGrant(home);
  const journal = ["developer-worker", "freight-worker"]
    .some((id) => readPrivate(join(home, `provision-${id}.json`)) !== null);
  return !!legacy || !!grant || journal;
}

/** Independent of the grant so deleting a grant cannot restore personal-login seats. */
export function enrollmentMode(home: string): boolean {
  return backfillEnrollment(home);
}

const suspensionPath = (home: string) => join(home, "provision-grant-suspended.json");
const SuspensionSchema = z.object({ grant_created_at: z.number().int().positive(), reason: z.literal("ssh_install_failed") }).strict();

/** Independent durable deny record for a grant whose revocation could not be written. */
export function suspendGrant(home: string, grantCreatedAt: number): void {
  writePrivate(suspensionPath(home), SuspensionSchema.parse({ grant_created_at: grantCreatedAt, reason: "ssh_install_failed" }));
}

export function grantSuspensionProblem(home: string, grant: Grant | null): string | null {
  const raw = readPrivate(suspensionPath(home));
  if (raw === null) return null;
  const suspension = SuspensionSchema.parse(JSON.parse(raw) as unknown);
  return grant && suspension.grant_created_at === grant.created_at ? suspension.reason : null;
}

export function readGrant(home: string): Grant | null {
  const raw = readPrivate(grantPath(home));
  if (raw === null) return null;
  const value = JSON.parse(raw) as unknown;
  const current = GrantSchema.safeParse(value);
  if (current.success) return grantSuspensionProblem(home, current.data) ? { ...current.data, ssh_state: "denied" } : current.data;
  const legacy = LegacyGrantSchema.parse(value);
  // Old consent was not bound to a node or expiry. Keep it revocable, never executable.
  return GrantSchema.parse({ ...legacy, target_node: "legacy-unbound", expires_at: legacy.created_at + 1 });
}

/** Called by the local, person-only post-join endpoint after it verifies the roster and exact consent text. */
export function createGrant(home: string, input: Grant): Grant {
  const grant = GrantSchema.parse(input);
  if (grant.consent_version !== CONSENT_VERSION || grant.expires_at <= grant.created_at ||
    grant.expires_at > grant.created_at + GRANT_DAYS * 86400_000) throw new Error("invalid grant consent or expiry");
  const old = readGrant(home);
  if (old && (!old.revoked_at || grant.created_at <= old.revoked_at)) throw new Error("an active enrollment grant exists, or consent predates revocation");
  for (const p of grant.profiles) if (profile(p.id)?.version !== p.version) throw new Error("unknown profile version");
  // The CLI installs a root-owned marker before the daemon records consent.
  requireEnrollmentRoot(home);
  writePrivate(grantPath(home), grant);
  return grant;
}

export function revokeGrant(home: string, now = Date.now()): Grant {
  const grant = readGrant(home);
  if (!grant) throw new Error("no enrollment grant");
  if (grant.revoked_at) return grant;
  const revoked = GrantSchema.parse({ ...grant, revoked_at: now });
  writePrivate(grantPath(home), revoked);
  return revoked;
}

/** Only a local person-only route may call this, after seats are disabled and the grant revoked. */
export function unenrollGrant(home: string): void {
  const grant = readGrant(home);
  if (grant && !grant.revoked_at) throw new Error("revoke the enrollment grant before unenrolling");
  const marked = rootMarkerPresent(home);
  if (!marked && !rootUnenrolled(home)) throw new Error("this machine is not enrolled");
  if (marked) removeRootMarker(home);
  if (grant) unlinkSync(grantPath(home));
  try { unlinkSync(join(home, "enrolled-mode.json")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function setGrantSshState(home: string, state: "active" | "denied", write: typeof writePrivate = writePrivate): Grant {
  const grant = readGrant(home);
  if (!grant?.owner_ssh || grant.revoked_at) throw new Error("no active owner SSH grant");
  const updated = GrantSchema.parse({ ...grant, ssh_state: state });
  write(grantPath(home), updated);
  return updated;
}

export interface Authorization {
  readonly grant: Grant | null; readonly teamId: string | null; readonly targetHandle: string | null; readonly targetNode: string;
  readonly actorHandle: string | null; readonly actorNode: string | null; readonly actorRole: string | null;
  readonly ownerHandle: string | null; readonly ownerNodeCurrent: boolean; readonly remoteAdmin: boolean; readonly agentAdmin: boolean; readonly profile: string;
  readonly now?: number; readonly localPerson?: boolean;
}

export function authorizeProvision(a: Authorization): string | null {
  if (!profile(a.profile)) return "unknown_profile";
  if (!a.grant) return "grant_absent";
  if (a.grant.revoked_at) return "grant_revoked";
  if (a.grant.owner_ssh && a.grant.ssh_state !== "active") return a.grant.ssh_state === "pending" ? "ssh_pending" : "ssh_denied";
  if (a.grant.consent_version !== CONSENT_VERSION) return "consent_version_mismatch";
  if ((a.now ?? Date.now()) >= a.grant.expires_at) return "grant_expired";
  if (a.grant.target_node !== a.targetNode) return "wrong_machine";
  if (a.grant.team_id !== a.teamId || a.grant.recipient !== a.targetHandle) return "wrong_team";
  if (!a.ownerNodeCurrent) return "owner_changed";
  if (!a.remoteAdmin) return "remote_admin_off";
  if (!a.agentAdmin) return "agent_admin_off";
  const selected = a.grant.profiles.find((p) => p.id === a.profile);
  if (!selected) return "profile_not_selected";
  if (selected.version !== profile(a.profile)?.version) return "profile_version_mismatch";
  if (a.localPerson) {
    if (a.actorNode !== a.targetNode || a.actorHandle !== a.targetHandle) return "not_authorized";
  } else {
    if (a.actorRole !== "owner") return "not_authorized";
    if (a.actorHandle !== a.ownerHandle) return "owner_not_consented";
  }
  if (!a.actorNode) return "not_authorized";
  return null;
}
