// Joining a team through any member's node: the roster authority admits, every other node
// answers `not_authority` with the authority's address and the joiner retries there.
// Over Tailscale the authority admits a whois login on the roster; over Walkie Direct, an invite code.
import type { MeView } from "../protocol/schemas.ts";
import type { Core } from "./core.ts";
import { HttpError } from "./http.ts";
import { decodeInvite } from "./invite.ts";
import { PeerCallError, parsePeerTarget, type PeerAddr, type PeerClient } from "./peer-client.ts";
import { DEFAULT_PEER_PORT } from "./roster.ts";
import type { SyncManager } from "./sync.ts";
import { addrLabel } from "./transport.ts";
import { meView } from "./views.ts";

export type JoinResult = MeView & { admitted: boolean; reason?: string };

function key(a: PeerAddr): string { return `${a.ip}:${a.port}`; }

export async function joinTeam(core: Core, sync: SyncManager, client: PeerClient, peer: string): Promise<JoinResult> {
  // An already-admitted node may re-join (idempotent) to re-pin a changed IP/port, and a node whose
  // member was removed may re-join the same team after a re-invite (adoptTeam refuses another team).
  // A node with a team id it was never admitted to must not silently switch teams.
  if (core.teamId && !core.me() && !core.roster.nodes.get(core.nodeId)?.revoked_by_removal) {
    throw new HttpError(409, "team_exists", "this node already has a team id but is not admitted; use a fresh WALKIE_HOME");
  }
  let first: PeerAddr;
  try {
    first = parsePeerTarget(peer, DEFAULT_PEER_PORT);
  } catch (err) {
    throw new HttpError(400, "invalid", (err as Error).message);
  }

  let authority: PeerAddr[] = [];
  try {
    const a = (await client.hello(first)).authority;
    authority = a ? [{ ip: a.ip, port: a.port }] : [];
  } catch (err) {
    if (err instanceof PeerCallError && err.status === 403) return { ...meView(core), admitted: false, reason: "not_member" };
    throw new HttpError(502, "peer_unreachable", `could not reach ${peer}: ${(err as Error).message}`);
  }

  const queue: PeerAddr[] = [first, ...authority];
  const tried = new Set<string>();
  while (queue.length) {
    const addr = queue.shift() as PeerAddr;
    if (tried.has(key(addr))) continue;
    tried.add(key(addr));
    let res;
    try {
      res = await client.join(addr, { pubkey: core.keys.pubkey, hostname: core.hostname, ip: core.ip, port: core.peerPort });
    } catch (err) {
      if (err instanceof PeerCallError && err.status === 403) return { ...meView(core), admitted: false, reason: err.code === "not_member" ? "not_member" : err.message };
      if (err instanceof PeerCallError && err.code === "node_limit") return { ...meView(core), admitted: false, reason: "node_limit" };
      if (err instanceof PeerCallError && err.code === "plan_limit") return { ...meView(core), admitted: false, reason: "plan_limit" };
      core.log.warn("join_attempt_failed", { peer: key(addr), err: (err as Error).message });
      continue;
    }
    if (res.admitted && res.team) return adopt(core, sync, client, addr, res.team);
    if (res.reason === "pending_approval") return { ...meView(core), admitted: false, reason: "pending_approval" };
    if (res.authority) queue.push({ ip: res.authority.ip, port: res.authority.port });
  }
  return { ...meView(core), admitted: false, reason: "not_authority" };
}

/** Admitted by the node at `addr`: take the team id, pull the whole log from it, and start syncing. */
async function adopt(core: Core, sync: SyncManager, client: PeerClient, addr: PeerAddr, team: string): Promise<JoinResult> {
  core.adoptTeam(team);
  const vv = await client.vv(addr);
  await sync.pullAll(addr, vv.vv);
  // Origins pulled before the founder's were held until the team existed: release them now.
  core.drainPending();
  if (!core.me()) throw new HttpError(502, "join_incomplete", "admitted, but the roster from the peer does not list this node yet; retry walkie join");
  sync.rosterChanged();
  core.log.info("joined_team", { team, via: addrLabel(addr) });
  return { ...meView(core), admitted: true };
}

/** Refusals a Direct join reports as its `reason` (the rest are transport failures, 502). */
const DIRECT_REFUSALS = new Set(["not_member", "node_limit", "plan_limit", "forbidden"]);

/**
 * `walkie join <invite-code>` (Walkie Direct, PROTOCOL §4): dial the roster authority named in the invite by its
 * node key (relay hint and discovery find it), present the code and this node's key, and follow at most two
 * `not_authority` redirects (the authority moved since the invite was minted). The code is never logged.
 */
export async function joinWithInvite(
  core: Core, sync: SyncManager, client: PeerClient, code: string, enableDirect: () => Promise<void>,
): Promise<JoinResult> {
  const inv = decodeInvite(code);
  if ("error" in inv) throw new HttpError(400, "invalid", "that is not a valid Walkie invite code (copy the whole code, starting with wk1)");
  if (core.teamId && core.teamId !== inv.team) throw new HttpError(409, "team_exists", "this node already belongs to another team; use a fresh WALKIE_HOME");
  if (core.teamId && !core.me() && !core.roster.nodes.get(core.nodeId)?.revoked_by_removal) {
    throw new HttpError(409, "team_exists", "this node already has a team id but is not admitted; use a fresh WALKIE_HOME");
  }
  await enableDirect();
  let addr: PeerAddr = { ip: "", port: DEFAULT_PEER_PORT, pubkey: inv.authority, ...(inv.relay ? { relay: inv.relay } : {}) };
  for (let hop = 0; hop < 3; hop++) {
    let res;
    try {
      res = await client.join(addr, { pubkey: core.keys.pubkey, hostname: core.hostname, ip: "", port: DEFAULT_PEER_PORT, invite: code });
    } catch (err) {
      if (err instanceof PeerCallError && err.status > 0 && (err.code.startsWith("invite_") || DIRECT_REFUSALS.has(err.code))) {
        return { ...meView(core), admitted: false, reason: err.code };
      }
      throw new HttpError(502, "peer_unreachable", `could not reach the team's roster authority over Walkie Direct: ${(err as Error).message}`);
    }
    if (res.admitted && res.team) {
      // The code names its team; a machine (the invite's authority, or one it redirected to) that admits us into
      // any other team is not the one the owner sent us to.
      if (res.team !== inv.team) throw new HttpError(502, "team_mismatch", "the machine that answered admitted this node to a different team than the invite's; nothing was joined");
      return adopt(core, sync, client, addr, res.team);
    }
    if (res.reason === "pending_approval") return { ...meView(core), admitted: false, reason: "pending_approval" };
    if (!res.authority?.pubkey || res.authority.pubkey === addr.pubkey) break;
    addr = { ip: "", port: DEFAULT_PEER_PORT, pubkey: res.authority.pubkey };
  }
  return { ...meView(core), admitted: false, reason: "not_authority" };
}
