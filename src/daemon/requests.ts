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
import { authorityReachable, nodeMember, requestAllowed, transportFields, type MemberRec, type Roster } from "./roster.ts";
import type { QueuedRequest } from "./store.ts";

/** Pulls the authority's origin up to `seq` so the requester sees the appended event. */
export type CatchUp = (addr: PeerAddr, origin: string, seq: number) => Promise<void>;
export type SubmitResult = { event: Event | null } | { queued: true; request_id: string };
/** `submitRequest(..., { queue: false })`: the authority did not apply it, and nothing was stored to retry. */
export type SubmitUnreachable = { unreachable: string };
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
  // The chain's used set, not the local retirement overlay: an id this daemon has only retired still has to be written.
  // An identical replay never reaches here (applyRequest returns the entry it already stored).
  if (kind === "team.node" && typeof body.invite === "string" && core.recordedInvites()?.has(body.invite)) {
    throw new HttpError(403, "forbidden", "request refused: invite_used");
  }
  const allowed = requestAllowed(kind, body, core.roster, by, byNode, core.clock());
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
  const event = core.emit("team.node", {
    node_id: j.node_id, login: j.login, hostname: j.hostname, pubkey: j.pubkey, ip: j.ip, port: j.port,
    ...(core.store.getMeta(`peer_sig_required:${j.node_id}`) === "1" && core.store.getMeta(`peer_caps_verified:${j.node_id}`) === "1"
      ? { peer_sig_v1: true } : {}),
    ...(requestedBy ? { requested_by: requestedBy } : {}),
  }, requestId ? { requestId } : {});
  return event;
}

function storedEvent(core: Core, id: string): Event | null {
  const row = core.store.getRow(id);
  return row && row.redacted === 0 && row.status === "ok" ? (JSON.parse(row.json) as Event) : null;
}

/**
 * Why `send` will not try the authority. Null when this node is the authority, or it has a transport to the
 * authority's machine. A null result still fails later if that machine does not answer; the caller then decides
 * whether the request is queued.
 */
export function authoritySendBlock(core: Core, client: PeerClient): string | null {
  if (core.isAuthority()) return null;
  const id = core.authority;
  const node = id ? core.roster.nodes.get(id) : undefined;
  if (!id || !node) return "authority_unknown";
  if (!client.addrOf(node)) return "authority_unreachable (no transport in common; it must run Walkie Direct: walkie direct enable)";
  return null;
}

/** Sends one request to the authority. A 4xx refusal throws (it will never apply); other failures retry. */
async function send(core: Core, client: PeerClient, catchUp: CatchUp, req: RosterRequest): Promise<Sent> {
  if (core.isAuthority()) return { done: true, event: applyRequest(core, req) };
  const blocked = authoritySendBlock(core, client);
  if (blocked) return { done: false, error: blocked };
  const a = core.authority as string;
  const node = core.roster.nodes.get(a);
  const addr = node ? client.addrOf(node) : null;
  if (!node || !addr) return { done: false, error: authoritySendBlock(core, client) ?? "authority_unknown" };
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
export async function submitRequest(core: Core, client: PeerClient, catchUp: CatchUp, kind: RosterRequestKind, body: Record<string, unknown>): Promise<SubmitResult>;
/** Same send. `queue: false` leaves nothing to flush: the caller gets `{ unreachable }` instead of a stored request. */
export async function submitRequest(core: Core, client: PeerClient, catchUp: CatchUp, kind: RosterRequestKind, body: Record<string, unknown>, opts: { queue: false }): Promise<SubmitResult | SubmitUnreachable>;
export async function submitRequest(core: Core, client: PeerClient, catchUp: CatchUp, kind: RosterRequestKind, body: Record<string, unknown>, opts?: { queue?: boolean }): Promise<SubmitResult | SubmitUnreachable> {
  const req = signRequest(core, kind, body);
  const res = await send(core, client, catchUp, req);
  if (res.done) return { event: res.event };
  if (opts?.queue === false) return { unreachable: res.error };
  core.store.queueRequest(req.id, JSON.stringify(req));
  core.log.info("roster_request_queued", { id: req.id, kind, reason: res.error });
  return { queued: true, request_id: req.id };
}

/** Flushes whose send is still in progress. Offboard waits on these before it drops a queued role. Process-wide on purpose. */
const rosterFlushes = new Set<Promise<void>>();

/**
 * Logins whose queued `team.member` row this core is inside `send` for.
 * Keyed by core so two daemons in one process do not see each other's sends. `rosterFlushes` is not.
 */
const memberSends = new WeakMap<Core, Map<string, number>>();

function noteMemberSend(core: Core, login: string, delta: number): void {
  const counts = memberSends.get(core) ?? new Map<string, number>();
  if (!memberSends.has(core)) memberSends.set(core, counts);
  const next = (counts.get(login) ?? 0) + delta;
  if (next <= 0) counts.delete(login);
  else counts.set(login, next);
}

/** True while this core's flush is inside the send of a queued `team.member` row for `login`. */
export function rosterMemberSendInFlight(core: Core, login: string): boolean {
  return (memberSends.get(core)?.get(login) ?? 0) > 0;
}

/**
 * Resolves when no roster flush is in progress, or when `boundMs` has passed, whichever comes first.
 * A flush that is still sending at the bound is not cancelled. A flush that starts after this returns is not waited for.
 */
export async function waitForRosterFlush(boundMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, boundMs);
  while (rosterFlushes.size > 0) {
    const left = deadline - Date.now();
    if (left <= 0) return;
    const pending = [...rosterFlushes];
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, left);
      Promise.allSettled(pending).then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
    });
  }
}

/**
 * A queued invite spend was signed with the node record of that moment. Every replica folds that body
 * onto the node, so sending it later would undo a newer pin (Walkie Direct, the address). Rebuild it
 * from this machine's current record, keeping the invite id and the code, and sign that. Drop it when
 * the record is gone, revoked, or no longer the same login and key: there is nothing honest to restate.
 * Any other queued request is returned unchanged.
 */
function refreshQueuedSpend(core: Core, req: RosterRequest): RosterRequest | "drop" {
  if (req.kind !== "team.node" || req.node !== core.nodeId) return req;
  const carried = req.body;
  if (typeof carried.invite !== "string" || carried.revoked === true || carried.peer_sig_strict !== undefined) return req;
  if (carried.node_id !== core.nodeId) return req;
  const n = core.roster.nodes.get(core.nodeId);
  if (!n || n.revoked || carried.login !== n.login || carried.pubkey !== n.pubkey) return "drop";
  const body: Record<string, unknown> = {
    node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: n.ip, port: n.port,
    ...transportFields(n), ...(n.peer_sig_v1 ? { peer_sig_v1: true } : {}), invite: carried.invite,
  };
  if (Object.prototype.hasOwnProperty.call(carried, "invite_code")) body.invite_code = carried.invite_code;
  const plain = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  if (canonicalJson(plain) === canonicalJson(carried)) return req;
  const unsigned = { id: req.id, kind: req.kind, body: plain, node: req.node, ts: req.ts };
  return { ...unsigned, sig: core.keys.sign(signedPart(core.teamId ?? "", unsigned)) };
}

/** A queued restate that marks one invite used. Anything else is left for the normal retry. */
function queuedSpend(core: Core, req: RosterRequest): boolean {
  if (req.kind !== "team.node" || req.node !== core.nodeId) return false;
  const carried = req.body;
  return typeof carried.invite === "string" && carried.revoked !== true && carried.peer_sig_strict === undefined && carried.node_id === core.nodeId;
}

/** Queued requests one sync round sends at most. */
const FLUSH_BATCH = 20;

/**
 * Most queued rows read in one round to find that batch while spends are held. A held spend does not
 * use up a slot, but the scan still stops here (the queue is a handful of rows; this only bounds a flood).
 */
const HOLD_SCAN_LIMIT = 1_000;

/** Whether a stored row is a queued invite spend. A row that does not parse is not one (the flush drops it). */
function heldSpend(core: Core, json: string): boolean {
  try {
    const parsed = RosterRequest.safeParse(JSON.parse(json));
    return parsed.success && queuedSpend(core, parsed.data);
  } catch {
    return false;
  }
}

/**
 * The rows to try this round, oldest first (creation order is kept). Without a hold that is the first
 * 20. With one, spends are read past and not counted, so a request queued behind 20 or more held
 * spends is still reached; the scan reads at most HOLD_SCAN_LIMIT rows.
 */
function roundRows(core: Core, holdSpends: boolean): QueuedRequest[] {
  if (!holdSpends) return core.store.queuedRequests(FLUSH_BATCH);
  const rows: QueuedRequest[] = [];
  for (const q of core.store.queuedRequests(HOLD_SCAN_LIMIT)) {
    if (heldSpend(core, q.json)) continue;
    rows.push(q);
    if (rows.length >= FLUSH_BATCH) break;
  }
  return rows;
}

/**
 * Sync round: retries queued requests in order, stopping at the first that can't be delivered.
 * `holdSpends`: this machine is not known to be caught up with the authority's record. Leave invite
 * spends queued (a rebuild now would use a stale node) and still try everything else, including a
 * request queued behind up to HOLD_SCAN_LIMIT - 1 held spends. The flush is tracked while it sends,
 * so offboard can wait for a send of the person's own row (WALK-72).
 */
export async function flushRequests(core: Core, client: PeerClient, catchUp: CatchUp, opts: { holdSpends?: boolean } = {}): Promise<void> {
  const run = flushQueued(core, client, catchUp, opts.holdSpends === true);
  rosterFlushes.add(run);
  try {
    await run;
  } finally {
    rosterFlushes.delete(run);
  }
}

async function flushQueued(core: Core, client: PeerClient, catchUp: CatchUp, holdSpends: boolean): Promise<void> {
  // The round decided spends against this authority. A request sent earlier in this flush (an authority transfer) can
  // change it: a spend after that waits for a round caught up with the new one (Codex pre.13 audit SHOULD).
  // Identity and transfer count: a transfer away and back (A to B to A) is a change too (Codex pre.13 audit round 2).
  const startAuthority = core.authority;
  const startTerm = core.authorityLeaseTerm;
  const authorityMoved = () => core.authority !== startAuthority || core.authorityLeaseTerm !== startTerm;
  for (const q of roundRows(core, holdSpends)) {
    // The list above is a copy. A drop that committed since then removed the row; skip it and keep going.
    const still = core.store.queuedRequest(q.id);
    if (!still) continue;
    const parsed = RosterRequest.safeParse(JSON.parse(still.json));
    if (parsed.success && queuedSpend(core, parsed.data) && authorityMoved()) continue;
    const refreshed = parsed.success ? refreshQueuedSpend(core, parsed.data) : null;
    if (refreshed === "drop") {
      core.store.dequeueRequest(q.id);
      core.log.warn("roster_request_refused", { id: q.id, err: "spend node no longer matches; dropped" });
      continue;
    }
    const bodyLogin = parsed.success && parsed.data.kind === "team.member" ? parsed.data.body.login : undefined;
    const login = typeof bodyLogin === "string" && bodyLogin.length > 0 ? bodyLogin : null;
    try {
      // Cleared in `finally`, including when `send` returns early or throws, before this flush promise settles.
      if (login) noteMemberSend(core, login, 1);
      const res: Sent = refreshed ? await send(core, client, catchUp, refreshed) : { done: true, event: null };
      if (!res.done) {
        core.store.requestFailed(q.id, res.error);
        return;
      }
      core.store.dequeueRequest(q.id);
      core.log.info("roster_request_applied", { id: q.id, event: res.event?.id ?? null });
    } catch (err) {
      core.store.dequeueRequest(q.id);
      core.log.warn("roster_request_refused", { id: q.id, err: err instanceof Error ? err.message : String(err) });
    } finally {
      if (login) noteMemberSend(core, login, -1);
    }
  }
}

/** The pending view must not show an invite code (a bearer). The queued request itself still carries it. */
function publicRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(body, "invite_code")) return body;
  const { invite_code: _code, ...rest } = body;
  return rest;
}

/** `/v1/team/pending` view of this node's queued requests. */
export function queuedView(core: Core): { id: string; kind: string; body: unknown; created_at: number; attempts: number; last_error: string | null }[] {
  return core.store.queuedRequests().map((q) => {
    const r = JSON.parse(q.json) as RosterRequest;
    const body = r.body && typeof r.body === "object" ? publicRequestBody(r.body) : r.body;
    return { id: q.id, kind: r.kind, body, created_at: q.created_at, attempts: q.attempts, last_error: q.last_error };
  });
}
