// Roster requests (PROTOCOL §2 "Roster requests"): a node that isn't the roster authority asks the
// authority to append a roster event for its member. While the authority is unreachable the request
// is persisted and retried every sync round (in order); the local API answers 202 `{queued: true}`.
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../protocol/canonical.ts";
import { Bodies, NodeId, RosterRequest, type BodyOf, type Event, type RosterRequestKind } from "../protocol/schemas.ts";
import { checkActivatable } from "../license/activate.ts";
import { PlanLimitError, planLimitFromPeer } from "../license/enforce.ts";
import type { Core } from "./core.ts";
import { HttpError } from "./http.ts";
import { verifySig } from "./keys.ts";
import { PeerCallError, type PeerAddr, type PeerClient } from "./peer-client.ts";
import { authorityReachable, memberByHandle, nodeMember, requestAllowed, transportFields, type MemberRec, type Roster } from "./roster.ts";
import type { QueuedRequest } from "./store.ts";
import { admitLinkJoin, AdmitLinkReq, type LinkDecision } from "./fleet-link-service.ts";

/** Pulls the authority's origin up to `seq` so the requester sees the appended event. */
export type CatchUp = (addr: PeerAddr, origin: string, seq: number) => Promise<void>;
export type SubmitResult = { event: Event | null } | { queued: true; request_id: string };
/** `submitRequest(..., { queue: false })`: the authority did not apply it, and nothing was stored to retry. */
export type SubmitUnreachable = { unreachable: string };
type Sent = { done: true; event: Event | null } | { done: false; error: string };

/** Body fields only the authority sets. */
const AUTHORITY_FIELDS = new Set(["wm", "after", "requested_by", "request_id"]);
/**
 * Body fields only a request carries (signed with it, read by the authority, never put on the chain).
 * `seen_pos` (team.member/channel.upsert): the chain position the requester's roster had reached when it signed.
 */
const REQUEST_FIELDS = new Set(["seen_pos"]);
const AdmitBody = z.object({ node_id: NodeId, approve: z.boolean() });
/** New channels one non-owner member may have the authority create per day (F5). */
export const MEMBER_CHANNELS_PER_DAY = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const AUTHZ_MIN_VERSION = "0.2.0-pre.14";

/** Only requests that can add access need an authority that understands their signed position. */
function grantsAccess(req: RosterRequest): boolean {
  const body = req.body;
  if (req.kind === "team.member") {
    return body.role !== "removed";
  }
  if (req.kind !== "channel.upsert") return false;
  return body.public === true || (body.members !== undefined && (!Array.isArray(body.members) || body.members.length > 0));
}

function authorityVersionState(version: string | undefined): "unknown" | "old" | "current" {
  if (!version) return "unknown";
  try { return Bun.semver.order(version, AUTHZ_MIN_VERSION) >= 0 ? "current" : "old"; } catch { return "unknown"; }
}

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
  // Role and channel requests say which roster they were decided against, before a queued grant can undo removal.
  const carried = kind === "team.member" || kind === "channel.upsert" ? { ...body, seen_pos: core.roster.pos ?? 0 } : body;
  const unsigned = { id: randomBytes(16).toString("hex"), kind, body: JSON.parse(JSON.stringify(carried)) as Record<string, unknown>, node: core.nodeId, ts: Date.now() };
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
  const body = Object.fromEntries(Object.entries(req.body).filter(([k]) => !AUTHORITY_FIELDS.has(k) && !REQUEST_FIELDS.has(k)));
  return req.kind === "team.admit" || req.kind === "team.admit-link" ? admitRequest(core, body, member, rid, req.kind === "team.admit-link") : append(core, req.kind, body, member, rid, req.node, req.body.seen_pos);
}

function append(core: Core, kind: Exclude<RosterRequestKind, "team.admit" | "team.admit-link">, body: Record<string, unknown>, by: MemberRec, rid: string, byNode: string, seenPos?: unknown): Event {
  // The chain's used set, not the local retirement overlay: an id this daemon has only retired still has to be written.
  // An identical replay never reaches here (applyRequest returns the entry it already stored).
  if (kind === "team.node" && typeof body.invite === "string" && core.recordedInvites()?.has(body.invite)) {
    throw new HttpError(403, "forbidden", "request refused: invite_used");
  }
  const allowed = requestAllowed(kind, body, core.roster, by, byNode, core.clock());
  if (allowed.status !== "ok") throw new HttpError(403, "forbidden", `request refused: ${allowed.reason}`);
  const parsed = Bodies[kind].safeParse(body);
  if (!parsed.success) throw new HttpError(400, "invalid", "request body is invalid");
  if (kind === "team.member") checkMemberPrecondition(core.roster, parsed.data as BodyOf<"team.member">, seenPos);
  if (kind === "channel.upsert") checkChannelPrecondition(core.roster, parsed.data as BodyOf<"channel.upsert">, seenPos);
  if (kind === "channel.upsert" && by.role !== "owner") checkMemberChannelQuota(core, by);
  if (kind === "team.license") checkActivatable(core, (parsed.data as { key: string }).key);
  if (kind === "team.authority") checkAuthorityReachable(core.roster, (parsed.data as { node_id: string }).node_id);
  return core.emit(kind, { ...parsed.data, requested_by: by.handle } as never, { requestId: rid });
}

/**
 * WALK-109: a queued role request is decided on the requester's roster and applied later. `seen_pos` is that roster's
 * chain position; `changed_pos` is the position of the member's newest `team.member` entry (roster.ts), a removal
 * included, so that entry is in the requester's roster exactly when `seen_pos > changed_pos`. A request that sat in a
 * queue across a removal or any other role change to the person (the person may even be back since) was never decided
 * about them as they are now, so it is refused, not applied: a queued "make them owner" must not undo a demotion, any
 * more than it may bring back someone removed. Only a removal's own request is exempt: it never admits or raises
 * anyone, so a removal wins. Someone no entry has named yet has nothing to be stale against. The position is the
 * roster's own sequence; no age limit is added because the chain has no request expiry to reuse. A request from before
 * this check (no `seen_pos`) cannot show what its owner had read, so it is refused if the target was ever
 * removed or demoted. A future position or malformed position is refused before any role exemption.
 */
function checkMemberPrecondition(roster: Roster, b: BodyOf<"team.member">, seenPos: unknown): void {
  if (seenPos !== undefined && (typeof seenPos !== "number" || !Number.isSafeInteger(seenPos) || seenPos < 0 || seenPos > (roster.pos ?? 0))) {
    throw new HttpError(400, "invalid", "request refused: bad_precondition");
  }
  if (b.role === "removed") return;
  const target = roster.members.get(b.login);
  if (seenPos === undefined) {
    if (target?.removed_pos !== undefined || target?.demoted_pos !== undefined) throw staleWithoutPosition(b.handle);
    return;
  }
  if (target?.changed_pos !== undefined && target.changed_pos >= seenPos) throw stale(b.handle);
}

/** The requesting machine's roster had not read the latest change to this person: it is behind, and syncing fixes that. */
function stale(handle: string): HttpError {
  return new HttpError(409, "stale_request", `request refused: stale_request (@${handle} was removed or had their role changed after the roster this request was made on, so the requesting machine has not caught up yet. The request is not applied: try again after that machine syncs, if the change is still wanted)`);
}

/** A request with no position cannot be made to work by syncing: it came from an older Sqwakie, so only an update helps. */
function staleWithoutPosition(handle: string): HttpError {
  return new HttpError(409, "stale_request", `request refused: stale_request (@${handle} was removed or demoted, and this request carries no roster position, so it cannot show it was made after that change was read. It came from an older Sqwakie, or was queued before the requesting machine updated. Update Sqwakie on the requesting machine, then make the change again if it is still wanted)`);
}

/** A delayed membership list must not restore a removed handle, even if the person has since rejoined (WALK-124). */
function checkChannelPrecondition(roster: Roster, b: BodyOf<"channel.upsert">, seenPos: unknown): void {
  if (seenPos !== undefined && (typeof seenPos !== "number" || !Number.isSafeInteger(seenPos) || seenPos < 0 || seenPos > (roster.pos ?? 0))) {
    throw new HttpError(400, "invalid", "request refused: bad_precondition");
  }
  const channel = roster.channels.get(b.name);
  if (b.members === undefined && b.public !== true) return;
  if (b.public === true && channel?.members !== undefined && seenPos === undefined) {
    throw new HttpError(409, "stale_request", "request refused: stale_request (a public channel request with no roster position cannot open a restricted channel; update Sqwakie and send the request again)");
  }
  if (channel?.membership_pos !== undefined && seenPos !== undefined && channel.membership_pos >= seenPos) {
    throw new HttpError(409, "stale_request", "request refused: stale_request (this channel's access list changed after the requesting machine's roster position; sync and send the request again)");
  }
  if (b.members === undefined) return;
  if (seenPos === undefined && (channel?.membership_changed || (channel?.members !== undefined &&
    (b.members.length !== channel.members.length || b.members.some((handle, index) => handle !== channel.members?.[index]))))) {
    throw new HttpError(409, "stale_request", "request refused: stale_request (this channel's access list cannot be verified fresh without a roster position; Update Sqwakie and send it again)");
  }
  for (const handle of b.members) {
    const target = memberByHandle(roster, handle);
    if (!target) throw new HttpError(400, "invalid", `request refused: unknown_member (@${handle} is not a team member)`);
    if (target.role === "removed") {
      throw new HttpError(409, "stale_request", `request refused: stale_request (@${handle} is removed and cannot be added to a channel)`);
    }
    if (target.removed_pos === undefined) continue;
    if (seenPos === undefined) throw staleWithoutPosition(handle);
    if (target.removed_pos >= seenPos) throw stale(handle);
  }
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

function admitRequest(core: Core, body: Record<string, unknown>, by: MemberRec, rid: string, fleet: boolean): Event | null {
  if (by.role !== "owner") throw new HttpError(403, "forbidden", "request refused: not_owner");
  if (fleet) {
    const b = AdmitLinkReq.safeParse(body);
    if (!b.success) throw new HttpError(400, "invalid", "fleet decision needs node_id, approve, link and generation");
    return admitJoin(core, b.data.node_id, b.data.approve, by.handle, rid, b.data);
  }
  const b = AdmitBody.safeParse(body);
  if (!b.success) throw new HttpError(400, "invalid", "admit needs {node_id, approve}");
  return admitJoin(core, b.data.node_id, b.data.approve, by.handle, rid);
}

/**
 * On the authority: decides a pending join request (auto_admit off). A decline emits nothing, so
 * retrying a declined `team.admit` request finds no join request (404) and is dropped.
 */
export function admitJoin(core: Core, nodeId: string, approve: boolean, requestedBy?: string, requestId?: string, binding?: LinkDecision): Event | null {
  const j = core.store.joinRequest(nodeId, core.clock());
  if (!j) throw new HttpError(404, "not_found", "no pending join for that node");
  // A Sqwakie Direct machine that presented an approve-each-machine fleet link (FLEET-LINK-1).
  if (j.link || binding) {
    if (!binding || !j.generation || j.link !== binding.link || j.generation !== binding.generation) {
      throw new HttpError(409, "stale_join_request", "fleet approval needs the displayed link and request generation; refresh or update Sqwakie before deciding it");
    }
    return admitLinkJoin(core, j, approve, requestedBy, requestId);
  }
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
  if (!client.addrOf(node)) return "authority_unreachable (no transport in common; it must run Sqwakie Direct: walkie direct enable)";
  return null;
}

/**
 * Sends one request to the authority. A 4xx refusal throws (it will never apply); other failures retry. The version
 * gate's refusal retries too when the row is queued (`queued`): an old or unconfirmed authority version is exactly
 * what a later flush re-checks, so the flush keeps the row instead of dropping it. An interactive send refuses a
 * confirmed old version; an unconfirmed version leaves the request for a later retry.
 */
async function send(core: Core, client: PeerClient, catchUp: CatchUp, req: RosterRequest, opts?: { queued?: boolean }): Promise<Sent> {
  if (core.isAuthority()) return { done: true, event: applyRequest(core, req) };
  const a = core.authority as string;
  const node = a ? core.roster.nodes.get(a) : undefined;
  const addr = node ? client.addrOf(node) : null;
  if (grantsAccess(req)) {
    // Only a live signed /vv can authorize this send; a cached version may predate a rollback.
    const fresh = addr && node ? await client.vv(addr, node.pubkey).catch(() => undefined) : undefined;
    const version = fresh?.verified ? fresh.capabilities?.version ?? fresh.stats?.sys?.version : undefined;
    const state = authorityVersionState(version);
    if (state !== "current") {
      const message = state === "old"
        ? `the roster authority must be updated to Sqwakie ${AUTHZ_MIN_VERSION} first before granting access`
        : `the roster authority's version could not be confirmed; it must be reachable and updated to Sqwakie ${AUTHZ_MIN_VERSION} first before granting access`;
      if (state === "old" && !opts?.queued) throw new HttpError(409, "authority_update_required", message);
      return { done: false, error: message };
    }
  }
  const blocked = authoritySendBlock(core, client);
  if (blocked) return { done: false, error: blocked };
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
 * onto the node, so sending it later would undo a newer pin (Sqwakie Direct, the address). Rebuild it
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

/** The position of the latest roster change to this request's person or channel. */
function subjectPosition(core: Core, req: RosterRequest): number | undefined {
  if (req.kind === "team.member") return core.roster.members.get(req.body.login as string)?.changed_pos;
  if (req.kind === "channel.upsert") {
    const entries = core.rosterEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const event = entries[i]!;
      if (event.kind === "channel.upsert" && event.body.name === req.body.name) return i;
    }
  }
  return undefined;
}

/** Refresh only after the latest subject change is confirmed to be this machine's own queued request. */
async function refreshQueuedPosition(core: Core, client: PeerClient, catchUp: CatchUp, req: RosterRequest): Promise<RosterRequest | "wait"> {
  if (req.node !== core.nodeId || (req.kind !== "team.member" && req.kind !== "channel.upsert")) return req;
  const seen = req.body.seen_pos;
  const at = subjectPosition(core, req);
  if (typeof seen !== "number" || at === undefined || at < seen) return req;
  const latest = core.rosterEntries()[at];
  if (!latest || typeof latest.body.request_id !== "string" || !core.store.wasQueuedApplied(latest.body.request_id, latest.id)) return req;
  if (!core.isAuthority()) {
    const authority = core.authority;
    const node = authority ? core.roster.nodes.get(authority) : undefined;
    const addr = node ? client.addrOf(node) : null;
    if (!authority || !node || !addr) return "wait";
    try {
      const vv = await client.vv(addr, node.pubkey);
      if (!vv.verified || vv.node !== authority || typeof vv.vv[authority] !== "number") return "wait";
      await catchUp(addr, authority, vv.vv[authority]);
    } catch { return "wait"; }
  }
  const currentAt = subjectPosition(core, req);
  const current = currentAt === undefined ? undefined : core.rosterEntries()[currentAt];
  if (!current || typeof current.body.request_id !== "string" || !core.store.wasQueuedApplied(current.body.request_id, current.id)) return req;
  if (currentAt! < seen) return req;
  const body = { ...req.body, seen_pos: core.roster.pos ?? 0 };
  const unsigned = { id: req.id, kind: req.kind, body, node: req.node, ts: req.ts };
  return { ...unsigned, sig: core.keys.sign(signedPart(core.teamId ?? "", unsigned)) };
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
      const positioned = refreshed ? await refreshQueuedPosition(core, client, catchUp, refreshed) : null;
      if (positioned === "wait") {
        core.store.requestFailed(q.id, "roster catch-up pending");
        return;
      }
      if (positioned && positioned !== refreshed) core.store.updateQueuedRequest(q.id, JSON.stringify(positioned));
      const res: Sent = positioned ? await send(core, client, catchUp, positioned, { queued: true }) : { done: true, event: null };
      if (!res.done) {
        core.store.requestFailed(q.id, res.error);
        return;
      }
      if (!res.event && positioned && (positioned.kind === "team.member" || positioned.kind === "channel.upsert")) {
        const subject = positioned.kind === "team.member" ? positioned.body.login : positioned.body.name;
        if (typeof subject === "string" && core.store.hasLaterQueuedSubject(q, positioned.kind, subject)) {
          core.store.requestFailed(q.id, "roster catch-up pending");
          return;
        }
      }
      if (res.event && positioned) {
        const requestId = requestIdOf(core.teamId ?? "", positioned);
        if (core.requestEvent(requestId) === res.event.id) core.store.recordQueuedApplied(requestId, res.event.id);
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
