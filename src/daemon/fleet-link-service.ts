// Fleet links on the roster authority (FLEET-LINK-1, PROTOCOL §4 "Fleet links"): registering a link an owner minted,
// redeeming it for a joining machine, deciding a machine that waits for approval, revoking, and the owners' view.
// Every decision that spends a use runs synchronously from the check to the append, on the single roster authority,
// so two machines racing for the last use can't both get in.
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { Handle, NodeId, type Event, type PeerJoinRes } from "../protocol/schemas.ts";
import { FLEET_LINK_MAX_USES, type FleetLinkState, type FleetLinkUse, type FleetLinkView, type FleetLinksView } from "../protocol/fleet-link.ts";
import type { Core } from "./core.ts";
import { DAY_MS, FLEET_LINK_MAX_DAYS, linkUseId, type FleetLinkToken } from "./fleet-link.ts";
import type { LinkRow } from "./fleet-link-registry.ts";
import { HttpError } from "./http.ts";
import { shortNodeName } from "./identity.ts";
import type { BucketSpec } from "./ratelimit.ts";
import {
  DEFAULT_PEER_PORT, MAX_FLEET_NODES_PER_LOGIN, activeNodes, endpointHex, memberByHandle, nodeMember, servesDirect, voidBefore,
  type Roster,
} from "./roster.ts";
import { JoinLimitError, type JoinRequest } from "./store.ts";

/** Redemption attempts per joining key: 3 at once, then one every 20 s (plus the shared bucket for unadmitted keys). */
export const LINK_ATTEMPTS: BucketSpec = { capacity: 3, perSecond: 1 / 20 };
/** Links that can still admit a machine, per team. */
export const MAX_LIVE_LINKS = 200;
/** An expiry this far past the longest allowed is refused (clock slack between the minting machine and the authority). */
const EXPIRY_SLACK_MS = 60 * 60 * 1000;

export const LinkId = z.string().regex(/^[0-9a-f]{32}$/);
/** What an owner's machine registers on the authority (never the secret or the token). */
export const RegisterLink = z.object({
  id: LinkId, handle: Handle, uses: z.number().int().min(0).max(FLEET_LINK_MAX_USES), approve: z.boolean(),
  expires_at: z.number().int().positive(), observer: z.boolean().optional(), owner_machines: z.boolean().optional(),
});
export type RegisterLink = z.infer<typeof RegisterLink>;

/** Distinct route/request kind: an older authority must refuse, never strip this precondition. */
export const AdmitLinkReq = z.object({ node_id: NodeId, approve: z.boolean(), link: LinkId,
  generation: z.string().regex(/^[0-9a-f]{32}$/) });
export type LinkDecision = Pick<z.infer<typeof AdmitLinkReq>, "link" | "generation">;

// ---- checks ---------------------------------------------------------------------------------------------------------

/** Why a recorded link can't admit anyone any more because of who it names, or null. */
function deadReason(r: Roster, row: LinkRow): string | null {
  if (r.authority_pos !== undefined && r.authority_pos >= row.pos) return "link_authority_changed";
  const issuer = nodeMember(r, row.issuer);
  const issuerNode = r.nodes.get(row.issuer);
  if (issuer?.role !== "owner" || (issuer.owner_lost_pos !== undefined && issuer.owner_lost_pos >= row.pos)
    || (issuerNode?.revoked_pos !== undefined && issuerNode.revoked_pos >= row.pos)) return "link_issuer_not_owner";
  const m = memberByHandle(r, row.handle);
  if (!m || m.login !== row.login || m.role === "removed") return "link_member_removed";
  const cut = voidBefore(r, row.handle);
  if (cut && cut.pos >= row.pos) return "link_member_removed"; // removed (and maybe re-invited) since the link was made
  if (m.role !== row.role || (m.role_changed_pos !== undefined && m.role_changed_pos >= row.pos)) return "link_role_changed";
  return null;
}

/** Bind the redeemer's removal to this link's origin, even when the link names someone else. */
function predatesRemoval(r: Roster, row: LinkRow, nodeId: string): boolean {
  const known = r.nodes.get(nodeId);
  const cut = known ? r.members.get(known.login)?.removed_pos : undefined;
  return cut !== undefined && cut >= row.pos;
}

function stateOf(core: Core, row: LinkRow, now: number): { state: FleetLinkState; reason?: string; used: number; pending: number } {
  const { used, pending } = core.store.links.counted(row.id, now);
  if (row.revoked_at !== null) return { state: "revoked", used, pending };
  const dead = deadReason(core.roster, row);
  if (dead) return { state: "dead", reason: dead, used, pending };
  if (now >= row.expires_at) return { state: "expired", used, pending };
  if (row.uses > 0 && used + pending >= row.uses) return { state: "used_up", used, pending };
  return { state: "active", used, pending };
}

function viewOf(core: Core, row: LinkRow, now: number): FleetLinkView {
  const s = stateOf(core, row, now);
  return {
    id: row.id, short: row.id.slice(0, 8), handle: row.handle, role: row.role as FleetLinkView["role"], uses: row.uses,
    used: s.used, pending: s.pending, expires_at: row.expires_at, approve: row.approve === 1, created_at: row.created_at,
    created_by: row.created_by, revoked_at: row.revoked_at, state: s.state, ...(s.reason ? { reason: s.reason } : {}),
  };
}

function requireAuthority(core: Core): void {
  if (!core.isAuthority()) throw new HttpError(409, "not_authority", "this node is not the roster authority");
}

/** The owner a request comes from: the admitted node `nodeId` of a current owner. */
function ownerOf(core: Core, nodeId: string): string {
  const m = nodeMember(core.roster, nodeId);
  if (!m || m.role !== "owner") throw new HttpError(403, "forbidden", "owner role required");
  return m.handle;
}

// ---- registration -----------------------------------------------------------------------------------------------------

/**
 * On the authority: records a link an owner's machine (`issuer`, possibly this one) minted. The target is a current
 * member (an observer only when the owner said so); the record keeps their login and role and this chain position,
 * so a later removal or role change ends the link. Returns the view and, for the token, this machine's relay hint.
 */
export async function registerLink(core: Core, req: RegisterLink, issuer: string): Promise<{ link: FleetLinkView; relay: string | null }> {
  requireAuthority(core);
  // The relay hint is read first (it may wait up to 3 s); every check after it runs synchronously with the insert, so
  // the record's chain position is the roster its checks saw.
  const relay = core.relayHint ? await core.relayHint(3_000).catch(() => null) : null;
  requireAuthority(core);
  const createdBy = ownerOf(core, issuer);
  const self = core.roster.nodes.get(core.nodeId);
  if (!self || !servesDirect(self)) {
    throw new HttpError(409, "direct_unavailable", "the team's roster authority doesn't run Sqwakie Direct yet, so machines couldn't reach it with a link (on the roster authority run: walkie direct enable)");
  }
  const now = core.clock();
  if (req.expires_at <= now || req.expires_at > now + FLEET_LINK_MAX_DAYS * DAY_MS + EXPIRY_SLACK_MS) {
    throw new HttpError(400, "invalid", `a fleet link lasts at most ${FLEET_LINK_MAX_DAYS} days`);
  }
  const m = memberByHandle(core.roster, req.handle);
  if (!m || m.role === "removed") throw new HttpError(404, "not_found", `@${req.handle} isn't on the team; machines join as an existing member`);
  if (m.role === "observer" && req.observer !== true) {
    throw new HttpError(409, "observer_target", `@${req.handle} is an observer: their machines can read but never post; say so explicitly (--observer, or tick "as an observer" in the dashboard)`);
  }
  if (m.role === "owner" && req.owner_machines !== true) {
    throw new HttpError(409, "owner_target", `@${req.handle} is an owner: this link grants owner-level access (mint links, remove members, move authority, read restricted channels); confirm with --owner-machines or the dashboard checkbox`);
  }
  if (core.store.links.liveCount(now) >= MAX_LIVE_LINKS) {
    throw new HttpError(409, "link_limit", `this team already has ${MAX_LIVE_LINKS} fleet links that can still be used; revoke some (walkie team link list)`);
  }
  if (core.store.links.get(req.id)) throw new HttpError(409, "conflict", "a fleet link with this id exists");
  const row: LinkRow = {
    id: req.id, issuer, created_by: createdBy, handle: m.handle, login: m.login, role: m.role, uses: req.uses,
    approve: req.approve ? 1 : 0, pos: core.roster.pos ?? 0, created_at: now, expires_at: req.expires_at, revoked_at: null, revoked_by: null,
  };
  core.store.links.insert(row);
  core.log.info("fleet_link_created", { link: row.id, handle: row.handle, uses: row.uses, approve: req.approve, expires_at: row.expires_at, by: createdBy });
  core.hub.nodesChanged();
  return { link: viewOf(core, row, now), relay };
}

// ---- redemption -------------------------------------------------------------------------------------------------------

function refuse(core: Core, row: LinkRow | null, joiner: { nodeId: string; hostname: string }, code: string, status: number, message: string): never {
  if (row) {
    const prev = core.store.links.use(row.id, joiner.nodeId);
    if (!prev || prev.state === "refused") {
      core.store.links.record({ link: row.id, node_id: joiner.nodeId, hostname: joiner.hostname, state: "refused", reason: code, at: core.clock() });
    }
  }
  core.log.warn("fleet_link_refused", { link: row?.id ?? null, node: joiner.nodeId, reason: code });
  throw new HttpError(status, code, message);
}

/** A name for a new machine that no active machine of the team has: `ubuntu`, `ubuntu-2`, `ubuntu-3`, … */
export function uniqueHostname(r: Roster, wanted: string, nodeId: string): string {
  const base = shortNodeName(wanted);
  const taken = new Set(activeNodes(r).filter((n) => n.node_id !== nodeId).map((n) => n.hostname));
  if (!taken.has(base)) return base;
  for (let i = 2; i <= MAX_FLEET_NODES_PER_LOGIN * 4 + 1; i++) {
    const suffix = `-${i}`;
    const name = `${base.slice(0, 63 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(name)) return name;
  }
  return base;
}

/**
 * On the authority, for a machine presenting a link over Sqwakie Direct (its key authenticated by QUIC; the token's
 * shape, team, signature and owner issuer already checked). Admits it as the link's member, queues it for an owner's
 * approval, or refuses; from the record check to the append nothing awaits.
 */
export function redeemLink(core: Core, link: FleetLinkToken, joiner: { nodeId: string; pubkey: string; hostname: string }): PeerJoinRes {
  requireAuthority(core);
  const team = core.teamId as string;
  const now = core.clock();
  const hostname = shortNodeName(joiner.hostname);
  const who = { nodeId: joiner.nodeId, hostname };
  const row = core.store.links.get(link.id);
  // The record must be this token's (the token is signed, so only a forged record could differ).
  if (!row || row.issuer !== link.issuer || row.handle !== link.handle || row.uses !== link.uses || (row.approve === 1) !== link.approve
    || Math.floor(row.expires_at / 1000) !== Math.floor(link.expires_at / 1000)) {
    return refuse(core, null, who, "link_unknown", 403, "this roster authority has no such fleet link (it may have been made before the roster authority moved): ask an owner for a new one");
  }
  if (row.revoked_at !== null) return refuse(core, row, who, "link_revoked", 403, "this fleet link was revoked: ask an owner for a new one");
  if (now >= row.expires_at) return refuse(core, row, who, "link_expired", 403, "this fleet link expired: ask an owner for a new one");
  const dead = deadReason(core.roster, row);
  if (dead) return refuse(core, row, who, dead, 403, `this fleet link can't be used any more (${dead.replace(/^link_/, "").replace(/_/g, " ")}): ask an owner for a new one`);
  if (predatesRemoval(core.roster, row, joiner.nodeId)) return refuse(core, row, who, "link_predates_removal", 403, "this fleet link was made before this machine's member was removed: ask an owner for a new invitation");
  const prev = core.store.links.use(row.id, joiner.nodeId);
  if (prev?.state === "declined") return refuse(core, row, who, "link_declined", 403, "an owner declined this machine");
  const waiting = core.store.joinRequest(joiner.nodeId, now);
  // A pending request binds its key to one member. Replacing only its link would retain the old login in the
  // shared join queue and evade the new target's pending cap. An owner must decide it, or it must expire first.
  if (waiting && waiting.link !== row.id) return refuse(core, row, who, "link_pending_elsewhere", 409, "this machine already awaits approval through another invitation; ask an owner to decide it first");
  if (prev?.state === "pending" && waiting?.link === row.id && waiting.generation && prev.generation === waiting.generation) return { admitted: false, reason: "pending_approval" }; // asked again: no second use
  const { used, pending } = core.store.links.counted(row.id, now);
  // Renewing a pre-upgrade request reuses its reservation only if counted() actually counted that generation.
  const reserved = waiting?.link === row.id && prev?.state === "pending" && (waiting.generation ?? null) === (prev.generation ?? null);
  if (row.uses > 0 && used + pending - (reserved ? 1 : 0) >= row.uses) {
    return refuse(core, row, who, "link_used_up", 403, `this fleet link has admitted all ${row.uses} machines it was made for: ask an owner for a new one`);
  }
  const known = core.roster.nodes.get(joiner.nodeId);
  if (known && known.login !== row.login) return refuse(core, row, who, "forbidden", 403, "this machine belongs to another member");
  try {
    core.checkNodeCapacity(joiner.nodeId, row.login, false, MAX_FLEET_NODES_PER_LOGIN); // 409 node_limit
    core.checkPlan("team.node", { node_id: joiner.nodeId, login: row.login }); // 402 plan_limit, before anything is queued
  } catch (err) {
    // Recorded for owners (a machine the plan or the node limit kept out), then refused as it is.
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && (!prev || prev.state === "refused")) core.store.links.record({ link: row.id, node_id: joiner.nodeId, hostname, state: "refused", reason: code, at: now });
    throw err;
  }
  if (row.approve === 1) {
    const generation = randomBytes(16).toString("hex");
    try {
      core.store.transaction(() => {
        core.store.addJoinRequest({ node_id: joiner.nodeId, login: row.login, pubkey: joiner.pubkey, hostname, ip: "", port: DEFAULT_PEER_PORT, requested_at: now, link: row.id, generation });
        core.store.links.record({ link: row.id, node_id: joiner.nodeId, hostname, state: "pending", reason: null, at: now, generation });
      });
    } catch (err) {
      if (err instanceof JoinLimitError) throw new HttpError(429, "join_limit", `${err.message}; an owner must approve or wait for them to expire (24 h)`);
      throw err;
    }
    core.log.info("fleet_link_pending", { link: row.id, node: joiner.nodeId, hostname });
    core.hub.nodesChanged();
    return { admitted: false, reason: "pending_approval" };
  }
  const name = uniqueHostname(core.roster, hostname, joiner.nodeId);
  admit(core, row, { node_id: joiner.nodeId, pubkey: joiner.pubkey, hostname: name }, now);
  core.log.info("node_admitted", { node: joiner.nodeId, login: row.login, hostname: name, via: "fleet_link", link: row.id });
  return { admitted: true, team, node_id: joiner.nodeId };
}

/** Records the use and appends the machine's `team.node` in one transaction (either both or neither). */
function admit(core: Core, row: LinkRow, n: { node_id: string; pubkey: string; hostname: string }, now: number, by?: { requestedBy?: string; requestId?: string }): Event {
  return core.store.transaction(() => {
    core.store.links.record({ link: row.id, node_id: n.node_id, hostname: n.hostname, state: "admitted", reason: null, at: now });
    return core.emit("team.node", {
      node_id: n.node_id, login: row.login, hostname: n.hostname, pubkey: n.pubkey, ip: "", port: DEFAULT_PEER_PORT,
      endpoint: endpointHex(n.pubkey), transports: ["direct"], invite: linkUseId(row.id, n.node_id), peer_sig_v1: true,
      ...(by?.requestedBy ? { requested_by: by.requestedBy } : {}),
    }, { nodeLimit: MAX_FLEET_NODES_PER_LOGIN, ...(by?.requestId ? { requestId: by.requestId } : {}) });
  }, { durable: true });
}

/**
 * On the authority: an owner decides a machine that presented an approve-each-machine link (`team.admit-link`, from the
 * dashboard's Waiting to join list or another owner's request). Approval re-checks the link (a revoked or dead link's
 * waiting machines were dropped, but its member may have changed since) and the limits; a decline frees the use.
 */
export function admitLinkJoin(core: Core, j: JoinRequest, approve: boolean, requestedBy?: string, requestId?: string): Event | null {
  return core.store.transaction(() => decideLinkJoin(core, j, approve, requestedBy, requestId), { durable: true });
}

function decideLinkJoin(core: Core, j: JoinRequest, approve: boolean, requestedBy?: string, requestId?: string): Event | null {
  requireAuthority(core);
  // Re-read inside the transaction, with no await before admission. Even callers holding an old JoinRequest
  // cannot approve/deny a replacement. Legacy pending rows must present their link again after upgrading.
  const current = core.store.joinRequest(j.node_id, core.clock());
  if (!j.generation || !j.link || current?.link !== j.link || current.generation !== j.generation) {
    throw new HttpError(409, "stale_join_request", "this machine's join request changed or expired; refresh before deciding it");
  }
  const now = core.clock();
  const row = j.link ? core.store.links.get(j.link) : null;
  if (!approve || !row) {
    core.store.transaction(() => {
      core.store.deleteJoinRequest(j.node_id);
      if (row) core.store.links.record({ link: row.id, node_id: j.node_id, hostname: j.hostname, state: "declined", reason: requestedBy ? `by @${requestedBy}` : null, at: now });
    });
    core.hub.nodesChanged();
    if (approve) throw new HttpError(409, "link_unknown", "the fleet link this machine used is gone; it can't be approved");
    return null;
  }
  if (row.revoked_at !== null) throw new HttpError(409, "link_revoked", "the fleet link this machine used was revoked; deny it");
  if (now >= row.expires_at) throw new HttpError(409, "link_expired", "the fleet link this machine used expired; deny it and ask for a new link");
  const dead = deadReason(core.roster, row);
  if (dead) throw new HttpError(409, dead, `the fleet link this machine used can't admit anyone now (${dead.replace(/^link_/, "").replace(/_/g, " ")}); deny it`);
  if (predatesRemoval(core.roster, row, j.node_id)) throw new HttpError(403, "link_predates_removal", "this fleet link was made before this machine's member was removed; deny it");
  const known = core.roster.nodes.get(j.node_id);
  if (known?.revoked && !known.revoked_by_removal) throw new HttpError(403, "forbidden", "this node was revoked; an owner must re-admit it");
  if (known && known.login !== row.login) throw new HttpError(403, "forbidden", "this machine belongs to another member");
  // Before dropping the request, so it can be retried (after an upgrade, for a plan limit).
  core.checkNodeCapacity(j.node_id, row.login, false, MAX_FLEET_NODES_PER_LOGIN);
  core.checkPlan("team.node", { node_id: j.node_id, login: row.login });
  const name = uniqueHostname(core.roster, j.hostname, j.node_id);
  const ev = core.store.transaction(() => {
    core.store.deleteJoinRequest(j.node_id);
    return admit(core, row, { node_id: j.node_id, pubkey: j.pubkey, hostname: name }, now, { requestedBy, requestId });
  }, { durable: true });
  core.hub.nodesChanged();
  core.log.info("node_admitted", { node: j.node_id, login: row.login, hostname: name, via: "fleet_link_approved", link: row.id, by: requestedBy ?? null });
  return ev;
}

// ---- revoke and view ----------------------------------------------------------------------------------------------------

/** A key-only poll from an unadmitted Direct machine: no bearer token needs to be stored by the joiner. */
export function linkJoinStatus(core: Core, nodeId: string): PeerJoinRes | null {
  if (!core.isAuthority()) return null;
  const pending = core.store.joinRequest(nodeId, core.clock());
  if (pending?.link) {
    const row = core.store.links.get(pending.link);
    if (row && core.clock() >= row.expires_at) throw new HttpError(403, "link_expired", "the fleet link expired; ask an owner for a new one");
    const dead = row ? deadReason(core.roster, row) : "link_unknown";
    if (dead) throw new HttpError(403, dead, "the fleet link can no longer admit this machine; ask an owner for a new one");
    return { admitted: false, reason: "pending_approval" };
  }
  if (core.store.links.latestUse(nodeId)?.state === "declined") {
    throw new HttpError(403, "link_declined", "an owner declined this machine or revoked its fleet link");
  }
  return null;
}

/** On the authority: revokes the link whose id starts with `ref` (8+ hex); its waiting machines are dropped with it. */
export function revokeLink(core: Core, ref: string, by: string): FleetLinkView {
  requireAuthority(core);
  const matches = core.store.links.byPrefix(ref);
  if (!matches.length) throw new HttpError(404, "not_found", `no fleet link ${ref} (walkie team link list)`);
  if (matches.length > 1) throw new HttpError(409, "ambiguous", `${matches.length} fleet links start with ${ref}; give more of the id`);
  const row = matches[0] as LinkRow;
  const now = core.clock();
  core.store.transaction(() => {
    core.store.links.revoke(row.id, by, now);
    for (const nodeId of core.store.links.pendingNodes(row.id)) {
      const j = core.store.joinRequest(nodeId, now);
      if (j?.link === row.id) core.store.deleteJoinRequest(nodeId);
      core.store.links.record({ link: row.id, node_id: nodeId, hostname: j?.hostname ?? "", state: "declined", reason: "link revoked", at: now });
    }
  });
  core.log.info("fleet_link_revoked", { link: row.id, by });
  core.hub.nodesChanged();
  return viewOf(core, core.store.links.get(row.id) as LinkRow, now);
}

/** Owners' view of the links this authority holds and the machines that used them. */
export function linksView(core: Core): FleetLinksView {
  requireAuthority(core);
  const now = core.clock();
  const uses: FleetLinkUse[] = core.store.links.uses().filter((u) => {
    if (u.state !== "pending") return true;
    const j = core.store.joinRequest(u.node_id, now);
    return !!u.generation && j?.link === u.link && j.generation === u.generation;
  }).map((u) => ({
    link: u.link, node_id: u.node_id, hostname: u.hostname, state: u.state as FleetLinkUse["state"],
    ...(u.reason ? { reason: u.reason } : {}), at: u.at, ...(u.generation ? { generation: u.generation } : {}),
  }));
  return { links: core.store.links.list().map((r) => viewOf(core, r, now)), uses, authority: core.hostname };
}

/** The peer route's owner check (`/peer/v1/links`), shared with the local routes on the authority. */
export function linkOwner(core: Core, nodeId: string): string {
  return ownerOf(core, nodeId);
}

export const LinksPeerReq = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), link: RegisterLink }),
  z.object({ op: z.literal("revoke"), id: z.string().regex(/^[0-9a-f]{6,32}$/) }),
  z.object({ op: z.literal("list") }),
]);
export type LinksPeerReq = z.infer<typeof LinksPeerReq>;

/** `POST /peer/v1/links` on the authority, for an admitted owner's node `nodeId`. */
export async function servePeerLinks(core: Core, nodeId: string, body: LinksPeerReq): Promise<unknown> {
  requireAuthority(core);
  const by = ownerOf(core, nodeId);
  if (body.op === "create") {
    const res = await registerLink(core, body.link, nodeId);
    return { link: res.link, relay: res.relay };
  }
  if (body.op === "revoke") return { link: revokeLink(core, body.id, by) };
  return linksView(core);
}
