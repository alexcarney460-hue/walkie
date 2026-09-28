// Roster requests (PROTOCOL §2 "Roster requests"): a node that isn't the roster authority asks the
// authority to append a roster event for its member. While the authority is unreachable the request
// is persisted and retried every sync round (in order); the local API answers 202 `{queued: true}`.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../protocol/canonical.ts";
import { Bodies, NodeId, RosterRequest, type Event, type RosterRequestKind } from "../protocol/schemas.ts";
import { checkActivatable } from "../license/activate.ts";
import { PlanLimitError, planLimitFromPeer } from "../license/enforce.ts";
import type { Core } from "./core.ts";
import { HttpError } from "./http.ts";
import { verifySig } from "./keys.ts";
import { PeerCallError, type PeerAddr, type PeerClient } from "./peer-client.ts";
import { authorityReachable, nodeMember, requestAllowed, type MemberRec, type Roster } from "./roster.ts";

/** Pulls the authority's origin up to `seq` so the requester sees the appended event. */
export type CatchUp = (addr: PeerAddr, origin: string, seq: number) => Promise<void>;
export type SubmitResult = { event: Event | null } | { queued: true; request_id: string };
type Sent = { done: true; event: Event | null } | { done: false; error: string };

/** Body fields only the authority sets. */
const AUTHORITY_FIELDS = new Set(["wm", "after", "requested_by", "request_id"]);
const AdmitBody = z.object({ node_id: NodeId, approve: z.boolean() });
/** New channels one non-owner member may have the authority create per day (F5). */
export const MEMBER_CHANNELS_PER_DAY = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A request's identity in the replicated chain (C5, H3/F3): sha256 of its canonical SIGNED PAYLOAD
 * (team, node, id, kind, body, ts), so it doesn't depend on how the signature is encoded.
 */
export function requestIdOf(team: string, req: RosterRequest): string {
  const { sig: _sig, ...rest } = req;
  return createHash("sha256").update(signedPart(team, rest)).digest("hex");
}

function signedPart(team: string, r: Omit<RosterRequest, "sig">): string {
  return canonicalJson({ team, id: r.id, kind: r.kind, body: r.body, node: r.node, ts: r.ts });
}

export function signRequest(core: Core, kind: RosterRequestKind, body: Record<string, unknown>): RosterRequest {
  const unsigned = { id: randomBytes(16).toString("hex"), kind, body: JSON.parse(JSON.stringify(body)) as Record<string, unknown>, node: core.nodeId, ts: Date.now() };
  return { ...unsigned, sig: core.keys.sign(signedPart(core.teamId ?? "", unsigned)) };
}

/**
 * On the authority: checks the requester (admitted; an owner for anything but a new public channel),
 * then appends the event itself with `requested_by` and `request_id`. Idempotent per request (C5):
 * a request whose id is already in the chain returns that entry, on this authority or any later one
 * (the chain is replicated; the entry and its dedup mark are one signed, stored event).
 */
export function applyRequest(core: Core, req: RosterRequest): Event | null {
  if (!core.isAuthority()) throw new HttpError(409, "not_authority", "this node is not the roster authority");
  const node = core.roster.nodes.get(req.node);
  const member = nodeMember(core.roster, req.node);
  if (!node || !member) throw new HttpError(403, "forbidden", "requesting node is not admitted");
  const { sig, ...rest } = req;
  if (!verifySig(node.pubkey, signedPart(core.teamId ?? "", rest), sig)) throw new HttpError(403, "forbidden", "bad request signature");
  const rid = requestIdOf(core.teamId ?? "", req);
  const done = core.requestEvent(rid);
  if (done) return storedEvent(core, done);
  const body = Object.fromEntries(Object.entries(req.body).filter(([k]) => !AUTHORITY_FIELDS.has(k)));
  return req.kind === "team.admit" ? admitRequest(core, body, member, rid) : append(core, req.kind, body, member, rid, req.node);
}

function append(core: Core, kind: Exclude<RosterRequestKind, "team.admit">, body: Record<string, unknown>, by: MemberRec, rid: string, byNode: string): Event {
  const allowed = requestAllowed(kind, body, core.roster, by, byNode);
  if (allowed.status !== "ok") throw new HttpError(403, "forbidden", `request refused: ${allowed.reason}`);
  const parsed = Bodies[kind].safeParse(body);
  if (!parsed.success) throw new HttpError(400, "invalid", "request body is invalid");
  if (kind === "channel.upsert" && by.role !== "owner") checkMemberChannelQuota(core, by);
  if (kind === "team.license") checkActivatable(core, (parsed.data as { key: string }).key);
  if (kind === "team.authority") checkAuthorityReachable(core.roster, (parsed.data as { node_id: string }).node_id);
  return core.emit(kind, { ...parsed.data, requested_by: by.handle } as never, { requestId: rid });
}

/** 409 unless every active machine shares a transport with the proposed authority (mixed teams, PROTOCOL §4). */
export function checkAuthorityReachable(roster: Roster, nodeId: string): void {
  const r = authorityReachable(roster, nodeId);
  if (r.ok) return;
  const names = r.unreachable.slice(0, 5).map((n) => n.hostname).join(", ");
  throw new HttpError(409, "authority_unreachable", `${names} couldn't reach that machine (no transport in common); run walkie direct enable on it first`);
}

/** F5: a non-owner may have at most MEMBER_CHANNELS_PER_DAY channels created per day. */
function checkMemberChannelQuota(core: Core, by: MemberRec): void {
  if (core.channelCreationsBy(by.handle, core.clock() - DAY_MS) >= MEMBER_CHANNELS_PER_DAY) {
    throw new HttpError(429, "channel_limit", `@${by.handle} already created ${MEMBER_CHANNELS_PER_DAY} channels today; ask an owner`);
  }
}

function admitRequest(core: Core, body: Record<string, unknown>, by: MemberRec, rid: string): Event | null {
  if (by.role !== "owner") throw new HttpError(403, "forbidden", "request refused: not_owner");
  const b = AdmitBody.safeParse(body);
  if (!b.success) throw new HttpError(400, "invalid", "admit needs {node_id, approve}");
  return admitJoin(core, b.data.node_id, b.data.approve, by.handle, rid);
}

/**
 * On the authority: decides a pending join request (auto_admit off). A decline emits nothing, so
 * retrying a declined `team.admit` request finds no join request (404) and is dropped.
 */
export function admitJoin(core: Core, nodeId: string, approve: boolean, requestedBy?: string, requestId?: string): Event | null {
  const j = core.store.joinRequest(nodeId, core.clock());
  if (!j) throw new HttpError(404, "not_found", "no pending join for that node");
  if (approve) {
    // Before dropping the request, so it can be retried (after an upgrade, for a plan limit).
    core.checkNodeCapacity(j.node_id, j.login);
    core.checkPlan("team.node", { node_id: j.node_id, login: j.login });
  }
  core.store.deleteJoinRequest(nodeId);
  core.hub.nodesChanged();
  if (!approve) return null;
  return core.emit("team.node", {
    node_id: j.node_id, login: j.login, hostname: j.hostname, pubkey: j.pubkey, ip: j.ip, port: j.port,
    ...(requestedBy ? { requested_by: requestedBy } : {}),
  }, requestId ? { requestId } : {});
}

function storedEvent(core: Core, id: string): Event | null {
  const row = core.store.getRow(id);
  return row && row.redacted === 0 && row.status === "ok" ? (JSON.parse(row.json) as Event) : null;
}

/** Sends one request to the authority. A 4xx refusal throws (it will never apply); other failures retry. */
async function send(core: Core, client: PeerClient, catchUp: CatchUp, req: RosterRequest): Promise<Sent> {
  if (core.isAuthority()) return { done: true, event: applyRequest(core, req) };
  const a = core.authority;
  const node = a ? core.roster.nodes.get(a) : undefined;
  if (!a || !node) return { done: false, error: "authority_unknown" };
  const addr = client.addrOf(node);
  if (!addr) return { done: false, error: "authority_unreachable (no transport in common; it must run Walkie Direct: walkie direct enable)" };
  let res: { event?: unknown };
  try {
    res = await client.rosterRequest(addr, req);
  } catch (err) {
    const refused = err instanceof PeerCallError && err.status >= 400 && err.status < 500 && err.status !== 429 && err.code !== "not_authority";
    if (refused && err.code === "plan_limit") {
      // Relayed from the authority: validate its numbers and rebuild the link and text locally.
      const d = planLimitFromPeer(err.raw, core.roster, core.planNow(), core.clock());
      if (d) throw new PlanLimitError(d);
      // Malformed details: never show the peer's own text (it could carry a link).
      throw new HttpError(402, "plan_limit", "the team's plan has no room for this change; see: walkie license");
    }
    if (refused) throw new HttpError(err.status, err.code, err.message);
    return { done: false, error: err instanceof Error ? err.message : String(err) };
  }
  // The returned event is untrusted: we catch up on the authority's origin and use our own stored copy.
  const id = (res.event as { id?: unknown } | null | undefined)?.id;
  const seq = (res.event as { seq?: unknown } | null | undefined)?.seq;
  if (typeof id !== "string" || typeof seq !== "number") return { done: true, event: null };
  await catchUp(addr, a, seq).catch((err: Error) => core.log.warn("catch_up_failed", { err: err.message }));
  return { done: true, event: storedEvent(core, id) };
}

/** Local API path: apply now through the authority, or queue (202) while it is unreachable. */
export async function submitRequest(core: Core, client: PeerClient, catchUp: CatchUp, kind: RosterRequestKind, body: Record<string, unknown>): Promise<SubmitResult> {
  const req = signRequest(core, kind, body);
  const res = await send(core, client, catchUp, req);
  if (res.done) return { event: res.event };
  core.store.queueRequest(req.id, JSON.stringify(req));
  core.log.info("roster_request_queued", { id: req.id, kind, reason: res.error });
  return { queued: true, request_id: req.id };
}

/** Sync round: retries queued requests in order, stopping at the first that can't be delivered. */
export async function flushRequests(core: Core, client: PeerClient, catchUp: CatchUp): Promise<void> {
  for (const q of core.store.queuedRequests(20)) {
    const parsed = RosterRequest.safeParse(JSON.parse(q.json));
    try {
      const res: Sent = parsed.success ? await send(core, client, catchUp, parsed.data) : { done: true, event: null };
      if (!res.done) {
        core.store.requestFailed(q.id, res.error);
        return;
      }
      core.store.dequeueRequest(q.id);
      core.log.info("roster_request_applied", { id: q.id, event: res.event?.id ?? null });
    } catch (err) {
      core.store.dequeueRequest(q.id);
      core.log.warn("roster_request_refused", { id: q.id, err: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** `/v1/team/pending` view of this node's queued requests. */
export function queuedView(core: Core): { id: string; kind: string; body: unknown; created_at: number; attempts: number; last_error: string | null }[] {
  return core.store.queuedRequests().map((q) => {
    const r = JSON.parse(q.json) as RosterRequest;
    return { id: q.id, kind: r.kind, body: r.body, created_at: q.created_at, attempts: q.attempts, last_error: q.last_error };
  });
}
