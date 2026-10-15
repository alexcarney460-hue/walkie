// Fleet links (FLEET-LINK-1, docs/plans/FLEET-LINK-1.md): one owner-minted link that admits up to N machines, each as
// one existing member's machine, until it expires or is revoked. The token is shaped like an invite code (invite.ts)
// with its own prefix and signature domain:
//
//   "wl1" + base64url( v=1 | team(8) | authority pubkey(32) | issuer node id(8) | secret(16) | expiry s(u32)
//                      | uses(u16, 0 = unlimited) | flags(u8: 1 = each machine waits for an owner's approval)
//                      | handle len(1) handle | relay len(1) relay | ed25519 signature(64) )
//
// The signature, by the minting owner's node, covers "walkie-fleet-link-v1\n" + base64url(everything before it). The
// token alone admits nobody: the roster authority keeps the link's record (fleet-link-registry.ts), keyed by
// linkId(secret), and redeems only against it (uses left, revocation, expiry, the target member). The secret is never
// stored or logged anywhere; the token is a bearer credential until the link is used up, expires or is revoked.
import { createHash, randomBytes } from "node:crypto";
import { Handle } from "../protocol/schemas.ts";
import { nodeIdFromPubkey } from "../protocol/ids.ts";
import { FLEET_LINK_PREFIX, FLEET_LINK_MAX_CHARS, FLEET_LINK_MAX_USES, tokenFromInput } from "../protocol/fleet-link.ts";
import { verifySig, type NodeKeys } from "./keys.ts";
import { nodeMember, type Roster } from "./roster.ts";

const SIG_DOMAIN = "walkie-fleet-link-v1\n";
const MAX_RELAY_CHARS = 48;
const FIXED = 1 + 8 + 32 + 8 + 16 + 4 + 2 + 1; // through the flags byte
/** The longest a link may last (the authority refuses a record further out). */
export const FLEET_LINK_MAX_DAYS = 30;
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface FleetLinkFields {
  team: string; authority: string; relay?: string; handle: string;
  /** Unix ms; whole seconds on the wire. */
  expires_at: number;
  /** 0 = unlimited (bounded by the node limits). */
  uses: number;
  approve: boolean;
}

export interface FleetLinkToken {
  team: string; authority: string; relay?: string; issuer: string; handle: string;
  expires_at: number; uses: number; approve: boolean;
  /** linkId(secret): the record's key on the authority. */
  id: string;
}

export type FleetLinkRefusal =
  | "link_malformed" | "link_wrong_team" | "link_issuer_not_owner" | "link_bad_signature";

/** The link's id on the authority: sha256("walkie-fleet-link\n" ‖ secret), 32 hex. Never the secret. */
export function linkId(secret: Uint8Array): string {
  return createHash("sha256").update("walkie-fleet-link\n").update(secret).digest("hex").slice(0, 32);
}

/** What the chain records for one machine admitted by a link (`team.node.invite`): unique per (link, machine). */
export function linkUseId(id: string, nodeId: string): string {
  return createHash("sha256").update(`walkie-fleet-link-use\n${id}\n${nodeId}`).digest("hex").slice(0, 32);
}

export function isFleetLink(s: string): boolean {
  return s.startsWith(FLEET_LINK_PREFIX) && /^[A-Za-z0-9_-]+$/.test(s.slice(FLEET_LINK_PREFIX.length)) && s.length > 40;
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

/** A fresh 16-byte secret and its link id. */
export function newLinkSecret(): { secret: Buffer; id: string } {
  const secret = randomBytes(16);
  return { secret, id: linkId(secret) };
}

/** Builds and signs a token for `secret` with this (owner) node's key. */
export function encodeFleetLink(keys: NodeKeys, secret: Uint8Array, f: FleetLinkFields): string {
  const team = Buffer.from(f.team, "hex");
  const authority = Buffer.from(f.authority, "base64");
  const issuer = Buffer.from(keys.nodeId, "hex");
  if (team.length !== 8 || authority.length !== 32 || issuer.length !== 8 || secret.length !== 16) throw new Error("invalid fleet link fields");
  if (!Handle.safeParse(f.handle).success) throw new Error("invalid handle");
  if (!Number.isInteger(f.uses) || f.uses < 0 || f.uses > FLEET_LINK_MAX_USES) throw new Error("invalid uses");
  const expiry = Math.floor(f.expires_at / 1000);
  if (!Number.isInteger(expiry) || expiry <= 0 || expiry > 0xffffffff) throw new Error("invalid expiry");
  const head = Buffer.alloc(FIXED);
  let o = 0;
  head.writeUInt8(1, o); o += 1;
  team.copy(head, o); o += 8;
  authority.copy(head, o); o += 32;
  issuer.copy(head, o); o += 8;
  Buffer.from(secret).copy(head, o); o += 16;
  head.writeUInt32BE(expiry, o); o += 4;
  head.writeUInt16BE(f.uses, o); o += 2;
  head.writeUInt8(f.approve ? 1 : 0, o);
  const handle = Buffer.from(f.handle, "utf8");
  const relay = relayBytes(f.relay);
  const unsigned = Buffer.concat([head, Buffer.from([handle.length]), handle, Buffer.from([relay.length]), relay]);
  const sig = Buffer.from(keys.sign(SIG_DOMAIN + unsigned.toString("base64url")), "base64");
  return FLEET_LINK_PREFIX + Buffer.concat([unsigned, sig]).toString("base64url");
}

interface Decoded extends FleetLinkToken { readonly signed: string; readonly sig: string }

/** Parses a token without checking the signature (a joiner can't: it doesn't know the issuer's key). */
export function decodeFleetLink(token: string): Decoded | { error: "link_malformed" } {
  const bad = { error: "link_malformed" as const };
  if (typeof token !== "string" || token.length > FLEET_LINK_MAX_CHARS || !isFleetLink(token)) return bad;
  const body = token.slice(FLEET_LINK_PREFIX.length);
  const raw = Buffer.from(body, "base64url");
  if (raw.toString("base64url") !== body) return bad; // one encoding per token
  if (raw.length < FIXED + 2 + 64 || raw.readUInt8(0) !== 1) return bad;
  let o = 1;
  const team = raw.subarray(o, o + 8).toString("hex"); o += 8;
  const authority = raw.subarray(o, o + 32).toString("base64"); o += 32;
  const issuer = raw.subarray(o, o + 8).toString("hex"); o += 8;
  const secret = raw.subarray(o, o + 16); o += 16;
  const expires = raw.readUInt32BE(o) * 1000; o += 4;
  const uses = raw.readUInt16BE(o); o += 2;
  const flags = raw.readUInt8(o); o += 1;
  const hlen = raw.readUInt8(o); o += 1;
  if (o + hlen + 1 + 64 > raw.length) return bad;
  const handle = raw.subarray(o, o + hlen).toString("utf8"); o += hlen;
  const rlen = raw.readUInt8(o); o += 1;
  if (o + rlen + 64 !== raw.length) return bad;
  const relay = relayFrom(raw.subarray(o, o + rlen)); o += rlen;
  if (flags > 1 || uses > FLEET_LINK_MAX_USES || !Handle.safeParse(handle).success || relay === null) return bad;
  return {
    team, authority, ...(relay ? { relay } : {}), issuer, handle, expires_at: expires, uses, approve: flags === 1,
    id: linkId(secret), signed: SIG_DOMAIN + raw.subarray(0, o).toString("base64url"), sig: raw.subarray(o).toString("base64"),
  };
}

export type FleetLinkCheck = { ok: true; link: FleetLinkToken } | { ok: false; reason: FleetLinkRefusal };

/**
 * What any node can check (PROTOCOL §4 "Fleet links"): the shape, this team, a signature by a node that is now an
 * admitted owner's. Only the roster authority's record says whether the link is still good (fleet-link-service.ts).
 */
export function checkFleetLink(token: string, roster: Roster, teamId: string): FleetLinkCheck {
  const d = decodeFleetLink(token);
  if ("error" in d) return { ok: false, reason: d.error };
  if (d.team !== teamId) return { ok: false, reason: "link_wrong_team" };
  const issuer = roster.nodes.get(d.issuer);
  if (!issuer || nodeIdFromPubkey(issuer.pubkey) !== d.issuer || nodeMember(roster, d.issuer)?.role !== "owner") {
    return { ok: false, reason: "link_issuer_not_owner" };
  }
  if (!verifySig(issuer.pubkey, d.signed, d.sig)) return { ok: false, reason: "link_bad_signature" };
  const { signed: _s, sig: _g, ...link } = d;
  return { ok: true, link };
}

/** The fleet link token in what a person pasted (a token, the /join link, the install command, wrapped or not). */
export function linkTokenFrom(input: string): string | null {
  return tokenFromInput(input, (t) => !("error" in decodeFleetLink(t)));
}
