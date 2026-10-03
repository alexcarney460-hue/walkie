// Roster records, queries, validate() (PROTOCOL §2 rules 1–4) and applyRosterEvent().
// No I/O here: everything is deterministic given inputs. The authority chain lives in chain.ts.
import { parseAddress } from "../protocol/address.ts";
import { seatsChannelContent, seatsChannelNode } from "../protocol/seats.ts";
import { eventHeader } from "../protocol/header.ts";
import { deriveTeamId, nodeIdFromPubkey } from "../protocol/ids.ts";
import { Bodies, Event as EventSchema, TransportKind as TransportKindSchema, type BodyOf, type Event, type Role, type TransportKind } from "../protocol/schemas.ts";
import { decodeLicense, licenseForTeam, verifyLicense, type LicenseVerifier } from "../license/format.ts";
import { FUTURE_SKEW_MS, type LicenseState } from "../license/plans.ts";
import { isValidPubkey, verifyEvent, verifyHeader, verifySig } from "./keys.ts";
import { decodeInvite, INVITE_MAX_CHARS } from "./invite.ts";

export const DEFAULT_PEER_PORT = 7458;
const TRANSPORTS: readonly TransportKind[] = TransportKindSchema.options;

export interface MemberRec {
  readonly login: string; readonly handle: string; readonly role: Role | "removed"; readonly display_name?: string;
  /**
   * Chain position (entry index) of the member's last removing `team.member` (every replica derives the same value
   * from the chain). Kept when the member is re-admitted: a Walkie Direct invite minted before it can't bring them
   * back (invite.ts), whatever their role is now.
   */
  readonly removed_pos?: number;
  /**
   * When this member last stopped being an owner (the demoting event's `ts`). Local, derived from the chain: a
   * member or observer may mark an invite used only within an hour of it. Absent for someone who was never demoted
   * from owner, and cleared again on promotion back to owner.
   */
  readonly demoted_ts?: number;
  /** Invite-spend restates applied since `demoted_ts` (that demotion's budget). Owners are not counted. */
  readonly invite_spends?: number;
}

/**
 * A handle's invite cut-off (PROTOCOL §4 "Direct"): the chain position of the latest removal of any member who held
 * the handle. Survives re-admission and handle changes: a code for the handle whose issuer's signed chain position
 * is not past it is void. No timestamp is involved.
 */
export interface VoidBefore { readonly pos: number }
export interface NodeRec {
  readonly node_id: string; readonly login: string; readonly hostname: string; readonly pubkey: string;
  readonly ip: string; readonly port: number; readonly revoked: boolean;
  /** Revoked implicitly by the member's removal (a fresh `walkie join` may re-admit it after a re-invite). */
  readonly revoked_by_removal?: boolean;
  readonly peer_sig_v1?: true;
  /** v0.2: transports the node serves (known ones only); absent = tailscale only (v0.1). */
  readonly transports?: readonly TransportKind[];
}

/** Whether a node serves Walkie Direct (iroh), dialed by its pubkey. */
export function servesDirect(n: Pick<NodeRec, "transports">): boolean {
  return n.transports?.includes("direct") ?? false;
}

/** The node's transports: v0.1 records (no field) are Tailscale nodes. */
export function transportsOf(n: Pick<NodeRec, "transports">): TransportKind[] {
  return n.transports ? [...n.transports] : ["tailscale"];
}

/**
 * The transports a node can be reached over (PROTOCOL §4 "Mixed teams"): Tailscale only with a pinned address
 * (a Direct-only machine has none), Walkie Direct when its record says it serves it.
 */
export function reachableOver(n: Pick<NodeRec, "transports" | "ip">): TransportKind[] {
  return transportsOf(n).filter((t) => t !== "tailscale" || n.ip !== "");
}

/**
 * How two nodes talk: a transport both serve, Tailscale first (it needs no relay and is what v0.1 nodes speak),
 * else Walkie Direct; null when they share none (a Tailscale-only and a Direct-only machine), in which case their
 * events travel through machines that serve both (sync pulls every origin from any peer that has it).
 */
export function pickTransport(a: Pick<NodeRec, "transports" | "ip">, b: Pick<NodeRec, "transports" | "ip">): TransportKind | null {
  const x = reachableOver(a);
  const y = reachableOver(b);
  if (x.includes("tailscale") && y.includes("tailscale")) return "tailscale";
  if (x.includes("direct") && y.includes("direct")) return "direct";
  return null;
}

/** A node's transports with `add` included, in canonical order (tailscale, direct). */
export function withTransport(n: Pick<NodeRec, "transports">, add: TransportKind): TransportKind[] {
  const have = new Set([...transportsOf(n), add]);
  return TRANSPORTS.filter((t) => have.has(t));
}

function knownTransports(names: readonly string[] | undefined): TransportKind[] | undefined {
  if (!names) return undefined;
  const known = TRANSPORTS.filter((t) => names.includes(t));
  return known.length ? known : undefined;
}
export interface ChannelRec {
  readonly name: string; readonly topic?: string; readonly members?: readonly string[]; readonly archived?: boolean;
  /** Marked as a machine's seats channel by an upsert carrying `seats: true` (sticky; PRE4 RC Codex 5). */
  readonly seats?: true;
}
export interface TeamRec { readonly id: string; readonly name: string; readonly founder: string; readonly create_id: string; readonly created_ts: number }
export interface Roster {
  readonly team: TeamRec | null;
  readonly members: ReadonlyMap<string, MemberRec>; // by login
  readonly nodes: ReadonlyMap<string, NodeRec>; // by node id
  readonly channels: ReadonlyMap<string, ChannelRec>; // by name
  /** The latest applied `team.license` (PROTOCOL §2 "Licenses"). Plays no part in any validity rule. */
  readonly license?: LicenseState;
  /** Connector id → nodes it is enabled on (`team.integration`, F3). Plays no part in any validity rule. */
  readonly integrations?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Walkie Direct invites already used (`team.node.invite`, PROTOCOL §4): each admits one machine, once. */
  readonly invites?: ReadonlySet<string>;
  /** Chain entries folded into this roster (the chain length at this point; absent = 0). Local, never on the wire. */
  readonly pos?: number;
  /** Handle → its invite cut-off (the latest removal of a member holding it). Local, derived from the chain. */
  readonly voids?: ReadonlyMap<string, VoidBefore>;
  readonly peer_sig_strict?: boolean;
}

export const EMPTY_ROSTER: Roster = Object.freeze({ team: null, members: new Map(), nodes: new Map(), channels: new Map() });

export type Verdict =
  | { readonly status: "ok" }
  | { readonly status: "pending"; readonly reason: string }
  | { readonly status: "reject"; readonly reason: string };

/** What an `answer` references (D6): unknown, held only as a stub, stored hidden, or an accepted event. */
export type AskRef =
  | { readonly state: "none" } | { readonly state: "stub" } | { readonly state: "hidden" }
  | { readonly state: "ok"; readonly event: Event };

export interface ValidateCtx {
  readonly teamId: string;
  /** Default true. Stored events were verified on ingest, so re-validation passes false. */
  readonly verifySig?: boolean;
  /** Skip envelope parsing (id, team, schema): the event was parsed when it was stored. */
  readonly trusted?: boolean;
  /** Needed for `answer` (§2 rule 4): what the referenced event is. Absent = not checked. */
  readonly askLookup?: (id: string) => AskRef;
  /** Checks a `team.license` key; defaults to the production verifier (the embedded vendor key). */
  readonly verifyLicense?: LicenseVerifier;
  /**
   * The authority is deciding an event it is about to sign (a local emit), not judging history: only then are the
   * rules for a machine's seats channel applied (seatsChannelRule), so a rule never retroactively drops a channel.
   */
  readonly authoring?: boolean;
}

export const ROSTER_KINDS: ReadonlySet<string> = new Set(["team.create", "team.member", "team.node", "channel.upsert", "team.authority", "team.license", "team.integration"]);
export const CHANNEL_KINDS: ReadonlySet<string> = new Set(["msg.post", "artifact.share", "ask", "answer"]);
/**
 * Rejections that depend on the event alone (schema-level), never on the roster: such events keep
 * only a signed-header stub (PROTOCOL §2 rule 7). Every roster-dependent failure stays curable.
 */
export const PERMANENT_REASONS: ReadonlySet<string> = new Set([
  "bad_body", "unexpected_channel", "channel_required", "agent_mismatch", "unknown_kind", "author_node_mismatch",
  "duplicate_team_create", "team_create_not_first", "bad_node_id", "public_with_members",
]);

export const ROLE_RANK: Readonly<Record<Role | "removed", number>> = { removed: 0, observer: 1, member: 2, owner: 3 };

/**
 * Admission capacity (PROTOCOL §2 "Node limits", H1/F5): at most this many non-revoked nodes per login,
 * and this many node ids ever recorded per team (revoked ones included: a node id never leaves the
 * roster). The watermark carries only admitted origins, so it stays far below MAX_WM_ORIGINS.
 */
export const MAX_NODES_PER_LOGIN = 16;
export const MAX_NODES_PER_TEAM = 1024;

const OK: Verdict = { status: "ok" };
const pending = (reason: string): Verdict => ({ status: "pending", reason });
const reject = (reason: string): Verdict => ({ status: "reject", reason });

// ---- queries -------------------------------------------------------------------

export function memberByHandle(r: Roster, handle: string): MemberRec | undefined {
  for (const m of r.members.values()) if (m.handle === handle) return m;
  return undefined;
}

/** The current member owning an admitted, non-revoked node; null if revoked/removed/unknown. */
export function nodeMember(r: Roster, nodeId: string): MemberRec | null {
  const n = r.nodes.get(nodeId);
  if (!n || n.revoked) return null;
  const m = r.members.get(n.login);
  return m && m.role !== "removed" ? m : null;
}

/**
 * The current member owning the admitted, non-revoked node whose key is exactly `pubkey` (base64). The node id is a
 * 64-bit digest of the key, so the stored key is compared too: a key that merely collides on the id gets nothing.
 */
export function nodeMemberByKey(r: Roster, pubkey: string): MemberRec | null {
  const n = r.nodes.get(nodeIdFromPubkey(pubkey));
  return n && n.pubkey === pubkey ? nodeMember(r, n.node_id) : null;
}

/**
 * The Walkie Direct gate (PROTOCOL §4): the current member owning the admitted, non-revoked node whose key is exactly
 * `pubkey` AND whose record serves Direct. A Tailscale-only machine's key is not let in over Direct: a Tailscale join
 * never proved the joiner holds its key, so that key only gets Direct access after the machine proves it over QUIC
 * (a Direct `/join` from that key, which adds "direct" to its record: PROTOCOL §4 "Mixed teams").
 */
export function directMemberByKey(r: Roster, pubkey: string): MemberRec | null {
  const n = r.nodes.get(nodeIdFromPubkey(pubkey));
  return n && servesDirect(n) ? nodeMemberByKey(r, pubkey) : null;
}

/**
 * Whether `nodeId` can serve as roster authority for every active machine: each shares a transport with it
 * (a Direct-only machine reaches only a Direct-serving authority, a Tailscale-only one only a Tailscale one).
 * Checked before a transfer is emitted or requested; the chain's own rules are unchanged (v0.1 compatibility).
 */
export function authorityReachable(r: Roster, nodeId: string): { ok: true } | { ok: false; unreachable: NodeRec[] } {
  const target = r.nodes.get(nodeId);
  if (!target) return { ok: true };
  const unreachable = activeNodes(r).filter((n) => n.node_id !== nodeId && pickTransport(target, n) === null);
  return unreachable.length ? { ok: false, unreachable } : { ok: true };
}

export function ownerCount(r: Roster): number {
  let n = 0;
  for (const m of r.members.values()) if (m.role === "owner") n++;
  return n;
}

/** Whether `handle` may see content of `channel` (undefined channel = team-wide). */
export function canSeeChannel(r: Roster, channel: string | undefined | null, handle: string | null): boolean {
  if (!channel) return true;
  const ch = r.channels.get(channel);
  if (!ch || !ch.members) return true;
  return handle !== null && ch.members.includes(handle);
}

export function isRestricted(r: Roster, channel: string | undefined | null): boolean {
  return !!channel && !!r.channels.get(channel)?.members;
}

/** Admitted, non-revoked nodes whose member is current. */
export function activeNodes(r: Roster): NodeRec[] {
  return [...r.nodes.values()].filter((n) => nodeMember(r, n.node_id) !== null);
}

/** Distinct connectors enabled on at least one ACTIVE node (the plan's integration count, F3). */
export function integrationsUsed(r: Roster): number {
  let n = 0;
  for (const nodes of (r.integrations ?? new Map<string, ReadonlySet<string>>()).values()) {
    if ([...nodes].some((id) => nodeMember(r, id) !== null)) n++;
  }
  return n;
}

/** Whether `connector` is enabled on some active node (enabling it elsewhere adds no integration). */
export function integrationInUse(r: Roster, connector: string): boolean {
  const nodes = r.integrations?.get(connector);
  return !!nodes && [...nodes].some((id) => nodeMember(r, id) !== null);
}

/**
 * Whether a `team.node` for (nodeId, login) fits the node limits: a node id not yet in the roster needs
 * room under MAX_NODES_PER_TEAM, and making a node non-revoked needs room under MAX_NODES_PER_LOGIN.
 * Revoking, re-pinning an active node, and any non-node roster change are never limited, so an authority
 * at capacity can still revoke, remove and transfer.
 */
export function nodeCapacity(r: Roster, nodeId: string, login: string, revoked: boolean): Verdict {
  const existing = r.nodes.get(nodeId);
  if (!existing && r.nodes.size >= MAX_NODES_PER_TEAM) return reject("node_limit");
  if (revoked || (existing && !existing.revoked)) return OK;
  let active = 0;
  for (const n of r.nodes.values()) if (n.login === login && !n.revoked) active++;
  return active >= MAX_NODES_PER_LOGIN ? reject("node_limit") : OK;
}

// ---- validation ----------------------------------------------------------------

// Stored events are immutable objects, so parsed bodies can be memoized per body object.
const bodyCache = new WeakMap<object, unknown>();

export function parseBody<K extends keyof typeof Bodies>(kind: K, body: unknown): BodyOf<K> | null {
  const key = typeof body === "object" && body !== null ? body : null;
  if (key && bodyCache.has(key)) return bodyCache.get(key) as BodyOf<K> | null;
  const res = Bodies[kind].safeParse(body);
  const out = res.success ? (res.data as BodyOf<K>) : null;
  if (key) bodyCache.set(key, out);
  return out;
}

function checkChannel(r: Roster, name: string, handle: string): Verdict {
  const ch = r.channels.get(name);
  if (!ch) return pending("unknown_channel");
  if (ch.members && !ch.members.includes(handle)) return reject("not_channel_member");
  if (ch.archived) return reject("channel_archived");
  return OK;
}

function signaturesOk(ev: Event, pubkey: string): Verdict {
  if (!verifyEvent(ev, pubkey)) return reject("bad_signature");
  if (!verifyHeader(eventHeader(ev), ev.hsig, pubkey)) return reject("bad_hsig");
  return OK;
}

function validateCreate(ev: Event, r: Roster, ctx: ValidateCtx): Verdict {
  const b = parseBody("team.create", ev.body);
  if (!b) return reject("bad_body");
  if (r.team) return r.team.create_id === ev.id ? OK : reject("duplicate_team_create");
  if (ev.seq !== 1) return reject("team_create_not_first");
  if (!isValidPubkey(b.node_pubkey)) return reject("bad_pubkey");
  if (ev.origin !== nodeIdFromPubkey(b.node_pubkey)) return reject("origin_pubkey_mismatch");
  if (ev.team !== deriveTeamId(b.node_pubkey, b.name, ev.ts)) return reject("team_id_mismatch");
  if (ev.author.node !== ev.origin || ev.author.handle !== b.owner_handle) return reject("author_mismatch");
  if (ev.channel !== undefined) return reject("unexpected_channel");
  return ctx.verifySig !== false ? signaturesOk(ev, b.node_pubkey) : OK;
}

/** D6: an answer must reference an accepted ask addressed to its author, in the ask's channel. */
function validateAnswer(ev: Event, b: BodyOf<"answer">, r: Roster, author: MemberRec, ctx: ValidateCtx): Verdict {
  if (!ctx.askLookup) return OK;
  const ref = ctx.askLookup(b.ask);
  if (ref.state === "none" || ref.state === "stub") return pending("unknown_ask");
  if (ref.state === "hidden") return reject("ask_not_accepted");
  const ask = ref.event;
  if (ask.kind !== "ask") return reject("not_an_ask");
  if ((ask.channel ?? null) !== (ev.channel ?? null)) return reject("ask_channel_mismatch");
  const to = parseAddress(String((ask.body as { to?: unknown }).to ?? ""));
  if (to.handle !== author.handle) return reject("not_addressee");
  if (to.machine && r.nodes.get(ev.origin)?.hostname !== to.machine) return reject("not_addressee");
  // A person at the addressed machine (no agent) may answer for its agent.
  if (to.agent && ev.author.agent !== undefined && ev.author.agent !== to.agent) return reject("not_addressee");
  return OK;
}

/** How many invite-spend restates one demotion allows a member or an observer. Owners are not counted. */
const INVITE_SPEND_LIMIT = 8;
/** An hour, the life of a rental code. Not imported from compute: roster stays free of that module. */
const INVITE_SPEND_WINDOW_MS = 60 * 60 * 1000;

/**
 * How many more invite-spend restates `member` may make at `now` (the authority's clock). An owner is not
 * counted (no finite budget). Anyone else is zero unless they are a member or an observer still inside the
 * hour after the demotion that took owner away, and still under {@link INVITE_SPEND_LIMIT}.
 */
export function inviteSpendsRemaining(member: MemberRec, now: number): number {
  if (member.role === "owner") return Number.POSITIVE_INFINITY;
  if (member.role !== "member" && member.role !== "observer") return 0;
  if (member.demoted_ts === undefined) return 0;
  const age = now - member.demoted_ts;
  if (age < -FUTURE_SKEW_MS || age > INVITE_SPEND_WINDOW_MS) return 0;
  return Math.max(0, INVITE_SPEND_LIMIT - (member.invite_spends ?? 0));
}

/**
 * A `team.node` that does nothing but restate the requester's own admitted node and name one invite id.
 * An owner may ask for this with the id alone. A member or an observer may ask for it only to mark a code used
 * after they were demoted: within an hour of that demotion (the authority's clock, `now`), only a code their own
 * node minted (`invite_code` on the request, never on the chain), and at most {@link INVITE_SPEND_LIMIT} times for
 * that demotion. Anything else is refused `not_owner`. Null when it isn't this shape: the caller keeps its
 * ordinary rule. `requesterNode` absent is never this (the caller didn't say which machine asked).
 */
function inviteSpend(kind: string, body: Record<string, unknown>, r: Roster, requester: MemberRec, requesterNode?: string, now?: number): Verdict | null {
  if (kind !== "team.node" || !requesterNode) return null;
  if (requester.role !== "owner" && requester.role !== "member" && requester.role !== "observer") return null;
  const b = parseBody("team.node", body);
  if (!b || !b.invite || b.revoked === true || b.peer_sig_strict !== undefined) return null;
  if (b.node_id !== requesterNode) return null;
  const existing = r.nodes.get(b.node_id);
  if (!existing || existing.revoked) return null;
  if (existing.login !== requester.login || b.login !== requester.login) return null;
  if (b.hostname !== existing.hostname || b.pubkey !== existing.pubkey || b.ip !== existing.ip) return null;
  if ((b.port ?? DEFAULT_PEER_PORT) !== existing.port) return null;
  const want = existing.transports;
  const got = b.transports;
  if (want) {
    if (!got || got.length !== want.length || got.some((t, i) => t !== want[i])) return null;
  } else if (got !== undefined) return null;
  if (servesDirect(existing)) {
    if (b.endpoint !== endpointHex(existing.pubkey)) return null;
  } else if (b.endpoint !== undefined) return null;
  if (existing.peer_sig_v1) {
    if (b.peer_sig_v1 !== true) return null;
  } else if (b.peer_sig_v1 !== undefined) return null;
  if (requester.role === "owner") return OK;
  return formerOwnerSpend(body, r, requester, requesterNode, b.invite, now);
}

/**
 * The narrow member/observer allowance. Every miss is `not_owner` (no new reason, and nothing about the code):
 * a pre.12 authority refuses the whole request the same way. `now` is the authority's clock; the request's own
 * `ts` is not used.
 */
function formerOwnerSpend(raw: Record<string, unknown>, r: Roster, requester: MemberRec, requesterNode: string, inviteId: string, now: number | undefined): Verdict {
  if (now === undefined || requester.demoted_ts === undefined) return reject("not_owner");
  const age = now - requester.demoted_ts;
  if (age < -FUTURE_SKEW_MS || age > INVITE_SPEND_WINDOW_MS) return reject("not_owner");
  if ((requester.invite_spends ?? 0) >= INVITE_SPEND_LIMIT) return reject("not_owner");
  if (!codeMintedByNode(raw.invite_code, r, requesterNode, inviteId)) return reject("not_owner");
  return OK;
}

/**
 * Whether `code` is an invite this node minted for `id`. The code is the only proof of who minted it: a demoted
 * owner still holds their node key, so a signature over a bare id would not. Expiry, current role and the used-set
 * are not checked here (the caller is marking it used, which a current owner would fail). Never throws, never logs.
 */
function codeMintedByNode(code: unknown, r: Roster, nodeId: string, id: string): boolean {
  if (typeof code !== "string" || code.length === 0 || code.length > INVITE_MAX_CHARS) return false;
  const d = decodeInvite(code);
  if ("error" in d) return false;
  if (!r.team || d.team !== r.team.id || d.id !== id || d.issuer !== nodeId) return false;
  const issuer = r.nodes.get(d.issuer);
  if (!issuer || nodeIdFromPubkey(issuer.pubkey) !== d.issuer) return false;
  return verifySig(issuer.pubkey, d.signed, d.sig);
}

/**
 * What a requester may ask the authority for (PROTOCOL §2 "Roster requests"): owners anything, other
 * non-observers only a NEW public channel, and any non-observer a `team.integration` for the node the
 * request came from (`requesterNode`; owners too, F3). A member or an observer may also restate their own
 * unchanged node with one invite id, only for a code their node minted within an hour of being demoted, and
 * only a few times (`inviteSpend`). The authority then validates the event itself
 * as usual. An owner's `team.node` request may bind a key only to the owner's OWN login (F4): another
 * member's machine is admitted only through the whois-bound join (`/peer/v1/join`, optionally approved
 * with `team.admit`). Revoking any node, or re-admitting a node with the login and key it already has
 * in the roster (a binding its member's join made), stays allowed.
 */
export function requestAllowed(kind: string, body: Record<string, unknown>, r: Roster, requester: MemberRec, requesterNode?: string, now?: number): Verdict {
  if (kind === "team.integration") {
    if (requester.role === "observer") return reject("not_owner");
    const b = parseBody("team.integration", body);
    if (!b) return reject("bad_body");
    return b.node === requesterNode ? OK : reject("not_own_node");
  }
  const up = kind === "channel.upsert" ? parseBody("channel.upsert", body) : null;
  if (kind === "channel.upsert" && !up) return reject("bad_body");
  // A machine's seats channel (PROTOCOL §11): only that machine's person shapes it, owners included.
  const seats = up ? seatsChannelRule(up, r, requester.handle) : null;
  if (seats && seats.status !== "ok") return seats;
  if (up?.seats === true && !seats) return reject("reserved_name"); // the seats marker only on a machine's seats channel
  const spent = inviteSpend(kind, body, r, requester, requesterNode, now);
  if (spent) return spent;
  if (requester.role === "owner") return kind === "team.node" ? ownNodeRequest(body, r, requester) : OK;
  if (requester.role !== "member" || !up) return reject("not_owner");
  if (seats) return OK; // a member's own machine's seats channel: created or re-shaped by them
  if (r.channels.has(up.name)) return reject("not_channel_owner");
  if (up.members !== undefined || up.archived !== undefined || up.public !== undefined) return reject("owner_only");
  return OK;
}

/**
 * The seats-channel content rule (protocol/seats.ts) for a channel named after a node this roster knows (Opus r11
 * INFO: the same names seatsChannelRule reserves) AND marked a seats channel (`seats: true` on an upsert, PRE4 RC
 * Codex 5) in the roster the event is judged by: every replica computes it from the chain alone. A `seats-<id>`
 * channel that was an ordinary channel before (a pre.3 one) keeps its history: events judged by a roster from before
 * the marking entry are not seats content; a channel never marked stays ordinary.
 */
function seatsContent(r: Roster, ev: Event): string | null {
  const node = seatsChannelNode(ev.channel);
  return node && r.nodes.has(node) && r.channels.get(ev.channel as string)?.seats === true ? seatsChannelContent(ev) : null;
}

/**
 * `seats-<n>` of an admitted node n whose member is `h` is the seats channel of that machine (PROTOCOL §11): the
 * prompts and output of the seats run there. Checked by the authority before it signs an upsert of it (a request,
 * or its own emit: "authoring" only; replicas don't re-judge history): only `h` may create or change it (`by`, who
 * asked), it stays restricted, it keeps `h` as a member, and every member is a current member of the team. Null when
 * the name isn't reserved (no such node, or its member is gone).
 */
export function seatsChannelRule(b: BodyOf<"channel.upsert">, r: Roster, by: string, o: { authoritySweep?: boolean } = {}): Verdict | null {
  const node = seatsChannelNode(b.name);
  const n = node ? r.nodes.get(node) : undefined;
  const h = n ? r.members.get(n.login) : undefined;
  if (!n || !h || h.role === "removed") return null;
  if (b.members && new Set(b.members).size !== b.members.length) return reject("duplicate_member");
  // The authority's own removal sweep only (never a member's request): PROTOCOL §11 "Removed members".
  if (by !== h.handle) return o.authoritySweep && removedMembersDropped(b, r) ? OK : reject("reserved_name");
  if (b.public === true) return reject("reserved_name");
  const next = applyChannel(r.channels.get(b.name), b);
  if (!next.members || !next.members.includes(h.handle)) return reject("reserved_name");
  for (const m of next.members) {
    const rec = memberByHandle(r, m);
    if (!rec || rec.role === "removed") return reject("unknown_member");
  }
  return OK;
}

/**
 * The authority taking members who are no longer on the team out of someone's seats channel (its removal sweep,
 * core.ts dropFromRestricted; PRE4 RC Opus 1): only narrowing, only members removed from the team, and nothing else
 * about the channel changes. Anything more stays with the machine's person.
 */
function removedMembersDropped(b: BodyOf<"channel.upsert">, r: Roster): boolean {
  const prev = r.channels.get(b.name);
  if (!prev?.members || b.public === true || b.members === undefined) return false;
  const next = applyChannel(prev, b);
  if (next.topic !== prev.topic || next.archived !== prev.archived || next.seats !== prev.seats) return false;
  const kept = new Set(b.members);
  if (b.members.some((m) => !prev.members?.includes(m))) return false;
  const dropped = prev.members.filter((m) => !kept.has(m));
  return dropped.length > 0 && dropped.every((m) => { const rec = memberByHandle(r, m); return !rec || rec.role === "removed"; });
}

function ownNodeRequest(body: Record<string, unknown>, r: Roster, requester: MemberRec): Verdict {
  const b = parseBody("team.node", body);
  if (!b) return reject("bad_body");
  if (b.login === requester.login) return OK;
  // Another member's machine: only an EXISTING binding (same login and key) may be revoked or re-admitted.
  // A revocation must never create a cross-login binding (FIX-4 re-audit #1).
  const existing = r.nodes.get(b.node_id);
  return existing && existing.login === b.login && existing.pubkey === b.pubkey ? OK : reject("not_own_node");
}

function validateAuthority(ev: Event, r: Roster): Verdict {
  const b = parseBody("team.authority", ev.body);
  if (!b) return reject("bad_body");
  const target = r.nodes.get(b.node_id);
  if (!target || b.node_id === ev.origin) return reject("bad_authority_target");
  return nodeMember(r, b.node_id)?.role === "owner" ? OK : reject("bad_authority_target");
}

function validateKindRules(ev: Event, r: Roster, author: MemberRec, ctx: ValidateCtx): Verdict {
  const role = author.role;
  if (ev.channel !== undefined && !CHANNEL_KINDS.has(ev.kind)) return reject("unexpected_channel");
  switch (ev.kind) {
    case "team.create":
      return reject("duplicate_team_create");
    case "team.member": {
      const b = parseBody("team.member", ev.body);
      if (!b) return reject("bad_body");
      if (role !== "owner") return reject("not_owner");
      const existing = r.members.get(b.login);
      if (existing && existing.handle !== b.handle) return reject("handle_immutable");
      const holder = memberByHandle(r, b.handle);
      if (holder && holder.login !== b.login) return reject("handle_taken");
      if (existing?.role === "owner" && b.role !== "owner" && ownerCount(r) <= 1) return reject("last_owner");
      return OK;
    }
    case "team.node": {
      const b = parseBody("team.node", ev.body);
      if (!b) return reject("bad_body");
      if (role !== "owner") return reject("not_owner");
      if (!isValidPubkey(b.pubkey) || nodeIdFromPubkey(b.pubkey) !== b.node_id) return reject("bad_node_id");
      const target = r.members.get(b.login);
      if (!target) return pending("unknown_member");
      if (target.role === "removed" && b.revoked !== true) return reject("member_removed");
      const existing = r.nodes.get(b.node_id);
      if (existing && existing.login !== b.login) return reject("node_login_mismatch");
      return OK;
    }
    case "channel.upsert": {
      const b = parseBody("channel.upsert", ev.body);
      if (!b) return reject("bad_body");
      if (b.public === true && b.members !== undefined) return reject("public_with_members");
      if (role !== "owner") return reject("not_owner");
      if (ctx.authoring) {
        // No `requested_by`: the authority's own upsert (its removal sweep may narrow someone's seats channel).
        const seats = seatsChannelRule(b, r, b.requested_by ?? author.handle, { authoritySweep: b.requested_by === undefined });
        if (seats && seats.status !== "ok") return seats;
        if (b.seats === true && !seats) return reject("reserved_name");
      }
      return OK;
    }
    case "team.authority":
      return role === "owner" ? validateAuthority(ev, r) : reject("not_owner");
    case "team.license": {
      const b = parseBody("team.license", ev.body);
      if (!b) return reject("bad_body");
      if (role !== "owner") return reject("not_owner");
      // Only a license bound to THIS team (audit H3): an activation code or another team's key is rejected.
      const lic = (ctx.verifyLicense ?? verifyLicense)(b.key);
      return lic.ok && licenseForTeam(lic.payload, ctx.teamId) ? OK : reject("bad_license");
    }
    case "team.integration": {
      const b = parseBody("team.integration", ev.body);
      if (!b) return reject("bad_body");
      if (role !== "owner") return reject("not_owner");
      return r.nodes.has(b.node) ? OK : reject("bad_integration_target");
    }
    case "msg.post":
    case "artifact.share": {
      if (!parseBody(ev.kind, ev.body)) return reject("bad_body");
      if (role === "observer") return reject("observer_readonly");
      if (!ev.channel) return reject("channel_required");
      const v = checkChannel(r, ev.channel, author.handle);
      if (v.status !== "ok") return v;
      const seats = seatsContent(r, ev); // seat requests and the host's own posts only (SEATS-FIX-8)
      return seats ? reject(seats) : v;
    }
    case "ask":
    case "answer": {
      const b = ev.kind === "ask" ? parseBody("ask", ev.body) : parseBody("answer", ev.body);
      if (!b) return reject("bad_body");
      if (role === "observer") return reject("observer_readonly");
      if (ev.channel) {
        const v = checkChannel(r, ev.channel, author.handle);
        if (v.status !== "ok") return v;
        const seats = seatsContent(r, ev); // no asks or answers in a seats channel (Opus r9, Codex r9 MEDIUM 2)
        if (seats) return reject(seats);
      }
      return ev.kind === "answer" ? validateAnswer(ev, b as BodyOf<"answer">, r, author, ctx) : OK;
    }
    case "agent.status": {
      const b = parseBody("agent.status", ev.body);
      if (!b) return reject("bad_body");
      if (role === "observer") return reject("observer_readonly");
      if (ev.author.agent !== b.agent) return reject("agent_mismatch");
      return OK;
    }
    default:
      return reject("unknown_kind");
  }
}

/**
 * PROTOCOL §2 rules 1–4 for one event against a roster. Returns pending when
 * the admitting team.* event may simply not have arrived yet (rule 5).
 */
export function validate(input: unknown, r: Roster, ctx: ValidateCtx): Verdict {
  if (!ctx.trusted) {
    const parsed = EventSchema.safeParse(input);
    if (!parsed.success) return reject("bad_event");
  }
  const ev = input as Event; // keep the original body: the signature covers it verbatim
  if (!ctx.trusted) {
    if (ev.id !== `${ev.origin}:${ev.seq}`) return reject("bad_id");
    if (ev.team !== ctx.teamId) return reject("wrong_team");
  }
  if (ev.kind === "team.create") return validateCreate(ev, r, ctx);
  if (!r.team) return pending("no_team");

  const node = r.nodes.get(ev.origin);
  if (!node) return pending("unknown_origin");
  if (ctx.verifySig !== false) {
    const sigs = signaturesOk(ev, node.pubkey);
    if (sigs.status !== "ok") return sigs;
  }
  const member = r.members.get(node.login);
  if (node.revoked) return reject(member?.role === "removed" ? "member_removed" : "node_revoked");
  if (ev.author.node !== ev.origin) return reject("author_node_mismatch");
  if (!member) return pending("unknown_member");
  if (member.role === "removed") return reject("member_removed");
  if (ev.author.handle !== member.handle) return reject("author_handle_mismatch");
  return validateKindRules(ev, r, member, ctx);
}

// ---- application ------------------------------------------------------------------

export function memberRecOf(b: BodyOf<"team.member">): MemberRec {
  return { login: b.login, handle: b.handle, role: b.role, ...(b.display_name ? { display_name: b.display_name } : {}) };
}

export function nodeRecOf(b: BodyOf<"team.node">, previous?: NodeRec): NodeRec {
  const transports = knownTransports(b.transports);
  return {
    node_id: b.node_id, login: b.login, hostname: b.hostname, pubkey: b.pubkey, ip: b.ip,
    port: b.port ?? DEFAULT_PEER_PORT, revoked: b.revoked === true, ...(transports ? { transports } : {}),
    ...(b.peer_sig_v1 === true || previous?.peer_sig_v1 ? { peer_sig_v1: true as const } : {}),
  };
}

/** The v0.2 transport fields a re-emitted `team.node` carries over from the node's record (re-pin, approval). */
export function transportFields(n: Pick<NodeRec, "transports" | "pubkey"> | undefined): { endpoint?: string; transports?: TransportKind[] } {
  if (!n?.transports) return {};
  return { transports: [...n.transports], ...(servesDirect(n) ? { endpoint: endpointHex(n.pubkey) } : {}) };
}

/** The iroh endpoint id of a node key: hex of the raw 32-byte ed25519 public key. */
export function endpointHex(pubkeyB64: string): string {
  return Buffer.from(pubkeyB64, "base64").toString("hex");
}

export function founderRecs(ev: Event): { member: MemberRec; node: NodeRec } {
  const b = ev.body as BodyOf<"team.create">;
  return {
    member: { login: b.owner_login, handle: b.owner_handle, role: "owner" },
    node: {
      node_id: ev.origin, login: b.owner_login, hostname: b.node_hostname, pubkey: b.node_pubkey,
      ip: b.node_ip, port: b.node_port ?? DEFAULT_PEER_PORT, revoked: false,
      ...(b.peer_sig_v1 ? { peer_sig_v1: true } : {}),
    },
  };
}

/**
 * A channel after an upsert (F4): an omitted field keeps its previous value, so an update can't
 * declassify a restricted channel by leaving `members` out; only `public: true` clears the list.
 */
export function applyChannel(prev: ChannelRec | undefined, b: BodyOf<"channel.upsert">): ChannelRec {
  const topic = b.topic ?? prev?.topic;
  const members = b.public === true ? undefined : b.members ?? prev?.members;
  const archived = b.archived ?? prev?.archived;
  const seats = b.seats === true || prev?.seats === true;
  return {
    name: b.name,
    ...(topic !== undefined ? { topic } : {}),
    ...(members !== undefined ? { members: [...members] } : {}),
    ...(archived !== undefined ? { archived } : {}),
    ...(seats ? { seats: true as const } : {}),
  };
}

/**
 * The body the authority signs for a channel.upsert (F4): omitted `members` and `archived` of an
 * existing channel are filled with the current values, so every signed upsert states them explicitly.
 */
export function completeChannelUpsert(b: BodyOf<"channel.upsert">, r: Roster): BodyOf<"channel.upsert"> {
  const prev = r.channels.get(b.name);
  if (!prev) return b;
  return {
    ...b,
    ...(b.members === undefined && b.public !== true && prev.members ? { members: [...prev.members] } : {}),
    ...(b.archived === undefined && prev.archived !== undefined ? { archived: prev.archived } : {}),
  };
}

/** A removal revokes every node of that login (Fable F6); a re-invite alone does not restore them. */
export function revokeForRemoval(n: NodeRec): NodeRec {
  return n.revoked ? n : { ...n, revoked: true, revoked_by_removal: true };
}

/** The invite cut-off for `handle`: the latest removal of any member who held it, if any. */
export function voidBefore(r: Roster, handle: string): VoidBefore | undefined {
  return r.voids?.get(handle);
}

/** A generator plus `Symbol.dispose`, which `SetIterator` requires. Closing it ends the walk. */
function iteratorOf<T>(gen: Generator<T>): SetIterator<T> {
  const iter = gen as Generator<T> & { [Symbol.dispose]?: () => void };
  iter[Symbol.dispose] = () => { gen.return(undefined); };
  return iter as unknown as SetIterator<T>;
}

/**
 * Two neighbouring segments are joined when neither is more than this many times as long as the other.
 * After balancing, each older segment is more than twice the next newer one, so a lookup walks O(log n) segments
 * and a checkpoint keeps sharing the segments it already held.
 */
const SEGMENT_FACTOR = 2;

/**
 * Used invite ids, shared by the roster checkpoints that contain them. Each node holds only its own segment
 * and points at the previous segment. Adding an id links a one-id segment and then joins it with the segment
 * before it while the two lengths are within {@link SEGMENT_FACTOR}. Joining copies those two segments
 * and leaves the tail behind them in place, so a later checkpoint still points at that tail. The ids kept
 * for every checkpoint therefore grow like N log N, not like a fresh copy of the whole set each time.
 * `prev` is absent on the oldest segment (a one-id segment, or a plain set this one wraps).
 */
export class InviteSet implements ReadonlySet<string> {
  readonly size: number;
  readonly prev?: InviteSet;
  /** Ids in this segment only. A string is a one-id segment; a set is never mutated. */
  private readonly segment: ReadonlySet<string> | string;
  /** How many ids this segment holds, not counting `prev`. */
  readonly span: number;

  private constructor(size: number, segment: ReadonlySet<string> | string, span: number, prev?: InviteSet) {
    this.size = size;
    this.segment = segment;
    this.span = span;
    this.prev = prev;
  }

  /** The set plus `id`, or `prev` itself when `id` is already in it. */
  static of(prev: ReadonlySet<string> | undefined, id: string): InviteSet {
    if (prev instanceof InviteSet) {
      if (prev.has(id)) return prev;
      return InviteSet.balance(new InviteSet(prev.size + 1, id, 1, prev));
    }
    if (prev && prev.size > 0) {
      if (prev.has(id)) return new InviteSet(prev.size, prev, prev.size);
      return InviteSet.balance(new InviteSet(prev.size + 1, id, 1, new InviteSet(prev.size, prev, prev.size)));
    }
    return new InviteSet(1, id, 1);
  }

  /** Join `node` with the segment before it while their lengths are within a factor of {@link SEGMENT_FACTOR}. */
  private static balance(node: InviteSet): InviteSet {
    const prev = node.prev;
    if (!prev) return node;
    const a = node.span;
    const b = prev.span;
    if (a > SEGMENT_FACTOR * b || b > SEGMENT_FACTOR * a) return node;
    const merged = new Set<string>();
    node.writeInto(merged);
    prev.writeInto(merged);
    return InviteSet.balance(new InviteSet(node.size, merged, merged.size, prev.prev));
  }

  private writeInto(into: Set<string>): void {
    if (typeof this.segment === "string") into.add(this.segment);
    else for (const id of this.segment) into.add(id);
  }

  private holds(id: string): boolean {
    return typeof this.segment === "string" ? this.segment === id : this.segment.has(id);
  }

  has(id: string): boolean {
    let n: InviteSet | undefined = this;
    while (n) {
      if (n.holds(id)) return true;
      n = n.prev;
    }
    return false;
  }

  private *walk(): Generator<string> {
    let n: InviteSet | undefined = this;
    while (n) {
      if (typeof n.segment === "string") yield n.segment;
      else yield* n.segment;
      n = n.prev;
    }
  }

  values(): SetIterator<string> { return iteratorOf(this.walk()); }
  keys(): SetIterator<string> { return this.values(); }
  entries(): SetIterator<[string, string]> {
    const gen = function* (set: InviteSet): Generator<[string, string]> { for (const id of set.walk()) yield [id, id]; };
    return iteratorOf(gen(this));
  }
  [Symbol.iterator](): SetIterator<string> { return this.values(); }
  forEach(fn: (value: string, key: string, set: ReadonlySet<string>) => void, thisArg?: unknown): void {
    for (const id of this) fn.call(thisArg, id, id, this);
  }
  readonly [Symbol.toStringTag] = "Set";
}

/** Applies an already-validated roster event (the chain's next entry), returning a new Roster. */
export function applyRosterEvent(r: Roster, ev: Event): Roster {
  return { ...applyKind(r, ev), pos: (r.pos ?? 0) + 1 };
}

/**
 * A member record after `team.member`: a removal records its cut-off; a re-admission keeps the previous one.
 * Leaving owner records `ts` (that demotion's invite-spend window). A later non-owner role keeps the window and
 * the spend count. Promotion back to owner clears both, so the next demotion starts a new budget.
 */
function memberAfter(prev: MemberRec | undefined, b: BodyOf<"team.member">, pos: number, ts: number): MemberRec {
  const rec = memberRecOf(b);
  const removed = b.role === "removed"
    ? { removed_pos: pos }
    : (prev?.removed_pos !== undefined ? { removed_pos: prev.removed_pos } : {});
  const demoted = prev?.role === "owner" && b.role !== "owner"
    ? { demoted_ts: ts }
    : b.role !== "owner" && prev?.demoted_ts !== undefined
      ? { demoted_ts: prev.demoted_ts, ...(prev.invite_spends ? { invite_spends: prev.invite_spends } : {}) }
      : {};
  return { ...rec, ...removed, ...demoted };
}

function applyKind(r: Roster, ev: Event): Roster {
  switch (ev.kind) {
    case "team.create": {
      const { member, node } = founderRecs(ev);
      const b = ev.body as BodyOf<"team.create">;
      return {
        ...r, team: { id: ev.team, name: b.name, founder: ev.origin, create_id: ev.id, created_ts: ev.ts },
        members: new Map(r.members).set(member.login, member), nodes: new Map(r.nodes).set(node.node_id, node),
      };
    }
    case "team.member": {
      const b = ev.body as BodyOf<"team.member">;
      const pos = r.pos ?? 0;
      const members = new Map(r.members).set(b.login, memberAfter(r.members.get(b.login), b, pos, ev.ts));
      if (b.role !== "removed") return { ...r, members };
      const nodes = new Map(r.nodes);
      for (const n of r.nodes.values()) if (n.login === b.login) nodes.set(n.node_id, revokeForRemoval(n));
      // The cut-off goes on the handle the member held before and the one named now (a removal may rename).
      const voids = new Map(r.voids ?? []);
      for (const h of new Set([r.members.get(b.login)?.handle, b.handle])) {
        if (h) voids.set(h, { pos });
      }
      return { ...r, members, nodes, voids };
    }
    case "team.node": {
      const b = ev.body as BodyOf<"team.node">;
      const prior = r.nodes.get(b.node_id);
      const invites = typeof b.invite === "string" ? InviteSet.of(r.invites, b.invite) : r.invites;
      // The body is the node record, the same way a pre.12 replica folds it. A queued invite spend is
      // rebuilt from the sender's current record before it is signed again (requests.ts), so this fold
      // does not special-case it.
      // An explicit owner waiver admits a legacy machine. Consume the waiver in the signed chain so
      // automatic strict mode resumes when that machine later proves possession of its key.
      const legacyAdmitted = r.peer_sig_strict === false && (!prior || prior.revoked) && !b.peer_sig_v1;
      const nodes = new Map(r.nodes).set(b.node_id, nodeRecOf(b, prior));
      let members = r.members;
      const by = typeof b.requested_by === "string" ? memberByHandle(r, b.requested_by) : undefined;
      if (by && by.role !== "owner" && by.demoted_ts !== undefined && typeof b.invite === "string"
          && prior && !prior.revoked && prior.login === by.login) {
        members = new Map(r.members).set(by.login, { ...by, invite_spends: (by.invite_spends ?? 0) + 1 });
      }
      return { ...r, nodes, members,
        ...(invites ? { invites } : {}),
        ...(b.peer_sig_strict !== undefined ? { peer_sig_strict: b.peer_sig_strict }
          : legacyAdmitted ? { peer_sig_strict: undefined } : {}) };
    }
    case "channel.upsert": {
      const b = ev.body as BodyOf<"channel.upsert">;
      return { ...r, channels: new Map(r.channels).set(b.name, applyChannel(r.channels.get(b.name), b)) };
    }
    case "team.license": {
      // Validated (signature included) before it joined the chain; decoding can't fail here.
      const key = (ev.body as BodyOf<"team.license">).key;
      const d = decodeLicense(key);
      return "error" in d ? r : { ...r, license: { key, payload: d.payload, event_id: ev.id } };
    }
    case "team.integration": {
      const b = ev.body as BodyOf<"team.integration">;
      const integrations = new Map(r.integrations ?? []);
      const nodes = new Set(integrations.get(b.connector) ?? []);
      if (b.enabled) nodes.add(b.node); else nodes.delete(b.node);
      if (nodes.size) integrations.set(b.connector, nodes); else integrations.delete(b.connector);
      return { ...r, integrations };
    }
    default:
      return r;
  }
}
