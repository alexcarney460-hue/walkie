import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import type { Core } from "../core.ts";
import { HttpError } from "../http.ts";
import { nodeMember } from "../roster.ts";
import { readSwitches } from "../admin/switches.ts";
import { appendAudit, appendAuditStrict, postAudit } from "../admin/audit.ts";
import { readGrant } from "../provision/grant.ts";
import { verifyOwnerSshGrant } from "./grant.ts";
import { hasOwnerKey } from "./authorized-keys.ts";
import { sshServicePort } from "./server.ts";
import { sshGateProblem } from "./state.ts";
import { teamSshRevoked } from "./team-revocation.ts";
import { splice, tcpEnd, type End } from "../../pool/run/tunnel.ts";
import type { TunnelGrant } from "../../pool/run/stage.ts";
import type { SshCaller } from "./caller.ts";

const active = new WeakMap<Core, Set<End>>();
const MAX_LIVE = 4;

/** Fresh checks on each open and while a tunnel is live. No legacy grant grants SSH implicitly. */
export function sshTunnelProblem(core: Core, actorNode: string, keyHome = core.sshUserHome): string | null {
  let grant;
  try { grant = readGrant(core.paths.home); } catch { return "grant_invalid"; }
  if (!grant?.owner_ssh) return "grant_absent";
  if (grant.revoked_at || grant.expires_at <= Date.now()) return "grant_revoked";
  const gate = sshGateProblem(core.paths.home);
  if (gate) return gate;
  if (grant.ssh_state !== "active") return grant.ssh_state === "pending" ? "ssh_pending" : "ssh_denied";
  if (!core.sshTeamConfirmed()) return "ssh_team_waiting";
  try { if (teamSshRevoked(core, grant)) return "ssh_denied"; }
  catch { return "ssh_team_waiting"; }
  if (grant.team_id !== core.teamId || grant.target_node !== core.nodeId || grant.recipient !== core.me()?.handle) return "wrong_machine";
  if (!readSwitches(core.paths.config).remote_admin) return "remote_admin_off";
  const owner = core.roster.nodes.get(grant.owner_node);
  const ownerMember = owner && !owner.revoked ? nodeMember(core.roster, owner.node_id) : null;
  const actor = core.roster.nodes.get(actorNode);
  const actorMember = actor && !actor.revoked ? nodeMember(core.roster, actorNode) : null;
  if (!owner || !ownerMember || ownerMember.role !== "owner" || ownerMember.handle !== grant.owner_ssh.owner_handle) return "owner_changed";
  try { verifyOwnerSshGrant(grant.owner_ssh, owner.pubkey, grant.created_at); } catch { return "grant_invalid"; }
  if (!actorMember || actorMember.handle !== ownerMember.handle || actorMember.role !== "owner") return "not_authorized";
  try { if (!hasOwnerKey(keyHome, grant.team_id, grant.owner_ssh.owner_handle, grant.owner_ssh.public_key)) return "owner_key_absent"; }
  catch { return "owner_key_invalid"; }
  return null;
}

export function closeSshTunnels(core: Core): void {
  let failure: unknown;
  for (const end of active.get(core) ?? []) {
    try { end.close(); } catch (err) { failure ??= err; }
  }
  if (failure) throw failure;
}

/**
 * For callers that must go on whatever a stream's close() does (a revocation, a switch turning remote admin off, the
 * daemon's shutdown): every stream was still tried, and the failure is logged instead of aborting the caller.
 */
export function closeSshTunnelsQuietly(core: Core): void {
  try { closeSshTunnels(core); }
  catch (err) { core.log?.warn("ssh_tunnel_close_failed", { error: (err as Error).message }); }
}

/**
 * Authenticated Walkie Direct stream to a loopback SSH server. Only a fixed local port is selected by the daemon: Walkie's
 * own service on 22022 on macOS, the machine's SSH server on 22 on Linux and WSL (`sshServicePort`).
 */
export function sshTunnelGrant(core: Core, actorNode: string, port = sshServicePort(), keyHome = core.sshUserHome,
  caller: SshCaller = { caller: "unverified caller" }): TunnelGrant {
  const problem = sshTunnelProblem(core, actorNode, keyHome);
  if (problem) {
    appendAudit(core, { actor: actorNode, action: "SSH tunnel refused", machine: core.hostname, via: "remote", refused: problem });
    throw new HttpError(403, problem, `SSH tunnel refused: ${problem}`);
  }
  if (!core.limiter.take(`ssh:${actorNode}`, { capacity: 10, perSecond: 1 / 6 })) throw new HttpError(429, "rate_limited", "too many SSH tunnel opens");
  const live = active.get(core) ?? new Set<End>();
  if (live.size >= MAX_LIVE) throw new HttpError(429, "ssh_busy", "too many live SSH tunnels");
  active.set(core, live);
  const source = core.roster.nodes.get(actorNode)?.hostname ?? actorNode;
  const handle = nodeMember(core.roster, actorNode)?.handle ?? "unknown";
  // Direct authenticates the node key and the roster binds it to the owner.
  // Both caller fields are source-supplied diagnostics, never an authorization input.
  const actor = `@${handle}/${actorNode}`;
  const reported = `${caller.caller === "person" || caller.caller === "unverified caller" ? caller.caller : `agent ${caller.caller}`} (reported by ${source})`;
  const claim = caller.claim ? `; reported claim: agent ${caller.claim} (reported by ${source})` : "";
  const origin = `from ${source} (owner ${handle}); reported caller: ${reported}${claim}`;
  const session = randomUUID();
  const started = Date.now();
  try {
    appendAuditStrict(core, { actor, action: `SSH tunnel opened ${origin} session=${session} at=${new Date(started).toISOString()}`, machine: core.hostname, via: "remote" });
  } catch {
    throw new HttpError(503, "audit_unavailable", "SSH tunnel refused: local audit is unavailable");
  }
  let used = false;
  return {
    release: () => {
      if (used) return;
      used = true;
      try { appendAuditStrict(core, { actor, action: `SSH tunnel closed session=${session} duration_ms=${Date.now() - started} reason=unused`, machine: core.hostname, via: "remote" }); }
      catch (err) { core.log.warn("ssh_audit_close_failed", { error: (err as Error).message }); }
    },
    accept: async (end) => {
      if (used) { end.close(); return; }
      used = true;
      if (live.size >= MAX_LIVE || sshTunnelProblem(core, actorNode, keyHome)) {
        end.close();
        try { appendAuditStrict(core, { actor, action: `SSH tunnel closed session=${session} duration_ms=${Date.now() - started} reason=revoked_before_bridge`, machine: core.hostname, via: "remote" }); }
        catch (err) { core.log.warn("ssh_audit_close_failed", { error: (err as Error).message }); }
        return;
      }
      live.add(end);
      const check = setInterval(() => { if (sshTunnelProblem(core, actorNode, keyHome)) end.close(); }, 250);
      let action = "closed";
      let bytesIn = 0;
      let bytesOut = 0;
      try {
        const socket = connect({ host: "127.0.0.1", port });
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        });
        const counts = await splice(end, tcpEnd(socket));
        bytesIn = counts.up;
        bytesOut = counts.down;
      } catch (err) {
        action = "failed";
        end.close();
      } finally {
        clearInterval(check); live.delete(end);
        const duration = Date.now() - started;
        try { appendAuditStrict(core, { actor, action: `SSH tunnel ${action} session=${session} duration_ms=${duration} bytes_in=${bytesIn} bytes_out=${bytesOut}`, machine: core.hostname, via: "remote" }); }
        catch (err) { core.log.warn("ssh_audit_close_failed", { error: (err as Error).message }); }
        let recipient: string | undefined;
        try { recipient = readGrant(core.paths.home)?.recipient; } catch { /* a broken grant must not mask tunnel cleanup */ }
        postAudit(core, `[ssh] opened ${origin} on ${core.hostname} at ${new Date(started).toISOString()}; ${action} after ${duration} ms.`, recipient);
      }
    },
  };
}
