// Walkie Direct invites (PROTOCOL §4 "Direct"). Without Tailscale there is no `whois` to say who a caller
// is, so an owner vouches for a new machine with a signed, single-use, expiring invite code:
//
//   "wk1" + base64url( v=1 | team(8) | authority pubkey(32) | issuer node id(8) | secret(16) | expiry s(u32)
//                      | chain position(u32) | role(1) | handle len(1) handle | relay len(1) relay
//                      | ed25519 signature(64) )
//
// The chain position is the issuer's roster chain length when it minted the code: every roster event it had
// applied. The authority refuses a code for a handle whose last removal sits at or after that position (the issuer
// hadn't seen the removal), so a code minted before a removal stays void through any re-admission. That position is the
// only removal invalidation: no clock is involved, so a removal stamped by a clock that ran ahead can't block the
// member's later re-invite. Clocks only judge ordinary expiry (7 days).
//
// The signature, by the issuing owner node's key, covers "walkie-invite-v1\n" + base64url(everything before it).
// The roster authority admits the machine that presents it (its QUIC-authenticated key becomes the node key)
// and records sha256(secret) on the chain (`team.node.invite`), so every replica, and any later authority,
// refuses a second use. The code is a bearer credential: it is never logged.
import { createHash, randomBytes } from "node:crypto";
import { Handle, Role as RoleSchema, type Role } from "../protocol/schemas.ts";
import { nodeIdFromPubkey } from "../protocol/ids.ts";
import { verifySig, type NodeKeys } from "./keys.ts";
import { nodeMember, voidBefore, type Roster } from "./roster.ts";

export const INVITE_PREFIX = "wk1";
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Codes are at most this long (the longest handle and relay hint included). */
export const INVITE_MAX_CHARS = 300;
/** Relay hints longer than this are left out (n0 relay URLs are ~30 characters; discovery finds the rest). */
const MAX_RELAY_CHARS = 48;
/** An expiry further ahead than the TTL (plus clock slack) was not minted by an honest daemon. */
const EXPIRY_SLACK_MS = 60 * 60 * 1000;
const SIG_DOMAIN = "walkie-invite-v1\n";
const ROLES: readonly Role[] = ["owner", "member", "observer"];
const FIXED = 1 + 8 + 32 + 8 + 16 + 4 + 4 + 1; // through the role byte

export interface InviteFields {
  team: string; authority: string; relay?: string; handle: string; role: Role; now: number;
  /** The issuer's roster chain length now (`roster.pos`). */
  pos: number;
}

export interface Invite {
  /** Team id (16 hex). */
  team: string;
  /** The roster authority's node key (base64) when the invite was minted: the endpoint the joiner dials. */
  authority: string;
  /** The authority's home relay URL, if it fit. */
  relay?: string;
  /** Node id of the owner node that signed the invite. */
  issuer: string;
  handle: string;
  role: Role;
  expires_at: number;
  /** The issuer's roster chain length when it minted the code (signed). */
  pos: number;
  /** sha256(secret) hex[0:32]: what the chain records when the invite is used. */
  id: string;
}

export type InviteCheck = { ok: true; invite: Invite } | { ok: false; reason: InviteRefusal };
export type InviteRefusal =
  | "invite_malformed" | "invite_wrong_team" | "invite_expired" | "invite_issuer_unknown"
  | "invite_issuer_not_owner" | "invite_bad_signature" | "invite_used" | "invite_predates_removal";

/** The member login for a person admitted by a Direct invite (there is no Tailscale login to use). */
export function directLogin(handle: string): string { return `direct:${handle}`; }

export function inviteId(secret: Uint8Array): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 32);
}

/** Cheap shape test used to tell an invite code from a peer address (`walkie join <code|host>`). */
export function isInviteCode(s: string): boolean {
  return s.startsWith(INVITE_PREFIX) && /^[A-Za-z0-9_-]+$/.test(s.slice(INVITE_PREFIX.length)) && s.length > 40;
}

function relayBytes(relay: string | undefined): Buffer {
  if (!relay) return Buffer.alloc(0);
  const short = relay.startsWith("https://") ? relay.slice(8) : `!${relay}`;
  const b = Buffer.from(short, "utf8");
  return b.length <= MAX_RELAY_CHARS && /^[\x21-\x7e]+$/.test(short) ? b : Buffer.alloc(0);
}

function relayFrom(b: Buffer): string | undefined | null {
  if (!b.length) return undefined;
  const s = b.toString("utf8");
  const url = s.startsWith("!") ? s.slice(1) : `https://${s}`;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** Mints a code signed by `keys` (an owner node). Returns the code, its chain id and expiry. */
export function createInvite(keys: NodeKeys, f: InviteFields): { code: string; id: string; expires_at: number } {
  const team = Buffer.from(f.team, "hex");
  const authority = Buffer.from(f.authority, "base64");
  const issuer = Buffer.from(keys.nodeId, "hex");
  if (team.length !== 8 || authority.length !== 32 || issuer.length !== 8) throw new Error("invalid invite fields");
  if (!Number.isInteger(f.pos) || f.pos < 0 || f.pos > 0xffffffff) throw new Error("invalid chain position");
  if (!Handle.safeParse(f.handle).success) throw new Error("invalid handle");
  const secret = randomBytes(16);
  const expirySeconds = Math.floor((f.now + INVITE_TTL_MS) / 1000);
  const head = Buffer.alloc(FIXED);
  let o = 0;
  head.writeUInt8(1, o); o += 1;
  team.copy(head, o); o += 8;
  authority.copy(head, o); o += 32;
  issuer.copy(head, o); o += 8;
  secret.copy(head, o); o += 16;
  head.writeUInt32BE(expirySeconds, o); o += 4;
  head.writeUInt32BE(f.pos, o); o += 4;
  head.writeUInt8(ROLES.indexOf(f.role), o);
  const handle = Buffer.from(f.handle, "utf8");
  const relay = relayBytes(f.relay);
  const unsigned = Buffer.concat([head, Buffer.from([handle.length]), handle, Buffer.from([relay.length]), relay]);
  const sig = Buffer.from(keys.sign(SIG_DOMAIN + unsigned.toString("base64url")), "base64");
  return { code: INVITE_PREFIX + Buffer.concat([unsigned, sig]).toString("base64url"), id: inviteId(secret), expires_at: expirySeconds * 1000 };
}

interface Decoded extends Invite { readonly signed: string; readonly sig: string }

/** Parses a code without checking the signature (the joiner can't: it doesn't know the issuer's key yet). */
export function decodeInvite(code: string): Decoded | { error: InviteRefusal } {
  const bad = { error: "invite_malformed" as const };
  if (typeof code !== "string" || code.length > INVITE_MAX_CHARS || !isInviteCode(code)) return bad;
  const raw = Buffer.from(code.slice(INVITE_PREFIX.length), "base64url");
  if (raw.toString("base64url") !== code.slice(INVITE_PREFIX.length)) return bad; // one encoding per code
  if (raw.length < FIXED + 2 + 64 || raw.readUInt8(0) !== 1) return bad;
  let o = 1;
  const team = raw.subarray(o, o + 8).toString("hex"); o += 8;
  const authority = raw.subarray(o, o + 32).toString("base64"); o += 32;
  const issuer = raw.subarray(o, o + 8).toString("hex"); o += 8;
  const secret = raw.subarray(o, o + 16); o += 16;
  const expires = raw.readUInt32BE(o) * 1000; o += 4;
  const pos = raw.readUInt32BE(o); o += 4;
  const role = ROLES[raw.readUInt8(o)]; o += 1;
  const hlen = raw.readUInt8(o); o += 1;
  if (o + hlen + 1 + 64 > raw.length) return bad;
  const handle = raw.subarray(o, o + hlen).toString("utf8"); o += hlen;
  const rlen = raw.readUInt8(o); o += 1;
  if (o + rlen + 64 !== raw.length) return bad;
  const relay = relayFrom(raw.subarray(o, o + rlen)); o += rlen;
  if (!role || !RoleSchema.safeParse(role).success || !Handle.safeParse(handle).success || relay === null) return bad;
  return {
    team, authority, ...(relay ? { relay } : {}), issuer, handle, role, expires_at: expires, pos, id: inviteId(secret),
    signed: SIG_DOMAIN + raw.subarray(0, o).toString("base64url"), sig: raw.subarray(o).toString("base64"),
  };
}

/** The chain position to mint a code with: the issuer's roster chain length. */
export function inviteMintPos(roster: Roster): number {
  return roster.pos ?? 0;
}

/**
 * The roster authority's check (PROTOCOL §4 "Direct"): this team; not expired (and not minted further ahead
 * than the TTL); signed by a node that is, now, an admitted owner's; not used before on the chain; and, for a
 * handle ever removed, minted after its latest removal, whatever the handle's member is now (a code held before a
 * removal must not bring the member, or their old machine, back with the role it names, even after a re-invite).
 * "After" is judged by the issuer's signed chain position alone (clock-free).
 */
export function checkInvite(code: string, roster: Roster, teamId: string, now: number): InviteCheck {
  const d = decodeInvite(code);
  if ("error" in d) return { ok: false, reason: d.error };
  if (d.team !== teamId) return { ok: false, reason: "invite_wrong_team" };
  if (now >= d.expires_at || d.expires_at > now + INVITE_TTL_MS + EXPIRY_SLACK_MS) return { ok: false, reason: "invite_expired" };
  const issuer = roster.nodes.get(d.issuer);
  if (!issuer || nodeIdFromPubkey(issuer.pubkey) !== d.issuer) return { ok: false, reason: "invite_issuer_unknown" };
  if (nodeMember(roster, d.issuer)?.role !== "owner") return { ok: false, reason: "invite_issuer_not_owner" };
  if (!verifySig(issuer.pubkey, d.signed, d.sig)) return { ok: false, reason: "invite_bad_signature" };
  if (roster.invites?.has(d.id)) return { ok: false, reason: "invite_used" };
  const cut = voidBefore(roster, d.handle);
  if (cut && d.pos <= cut.pos) return { ok: false, reason: "invite_predates_removal" };
  const { signed: _s, sig: _g, ...invite } = d;
  return { ok: true, invite };
}
