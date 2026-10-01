import { createHash, randomBytes } from "node:crypto";
import { canonicalJson } from "../protocol/canonical.ts";
import type { NodeKeys } from "./keys.ts";
import { verifySig } from "./keys.ts";

export const PEER_SIG_CAP = "peer_sig_v1";
const WINDOW_MS = 120_000;
/** An old relay proves that a currently admitted node signed once; it never authorizes the old request. */
export const PEER_PROOF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DOMAIN = "walkie-peer-sig-v1\n";
const VV_DOMAIN = "walkie-peer-vv-v1\n";
const NONCE = /^[0-9a-f]{32}$/;
const MAX_REQUESTERS = 1024;
const MAX_NONCES_PER_REQUESTER = 4096;

export interface PeerSigRequest {
  readonly method: string; readonly path: string; readonly query: string;
  readonly body: string | Uint8Array; readonly requester: string; readonly target: string;
  readonly team: string; readonly ts: number; readonly nonce: string;
}

export interface PeerSigHeaders { readonly "X-Walkie-Ts": string; readonly "X-Walkie-Nonce": string; readonly "X-Walkie-Sig": string }

function signedText(r: PeerSigRequest): string {
  const body_sha256 = createHash("sha256").update(r.body).digest("hex");
  return DOMAIN + canonicalJson({ v: 1, method: r.method, path: r.path, query: r.query,
    body_sha256, requester: r.requester, target: r.target, team: r.team, ts: r.ts, nonce: r.nonce });
}

export function signPeerRequest(keys: NodeKeys, r: PeerSigRequest): PeerSigHeaders {
  if (keys.nodeId !== r.requester || !NONCE.test(r.nonce) || !Number.isSafeInteger(r.ts) || r.ts < 0) throw new Error("invalid peer signature fields");
  return { "X-Walkie-Ts": String(r.ts), "X-Walkie-Nonce": r.nonce, "X-Walkie-Sig": keys.sign(signedText(r)) };
}

export function newPeerNonce(): string { return randomBytes(16).toString("hex"); }

export interface PeerVvProofBody { readonly node: string; readonly ts: number }

function vvSignedText(body: PeerVvProofBody, requester: string, challenge: string): string {
  return VV_DOMAIN + canonicalJson({ body_sha256: createHash("sha256").update(canonicalJson(body)).digest("hex"),
    requester, target: body.node, ts: body.ts, challenge });
}

export function signPeerVv<T extends PeerVvProofBody>(keys: NodeKeys, body: T, requester: string, challenge: string): string {
  if (keys.nodeId !== body.node || !NONCE.test(challenge) || !Number.isSafeInteger(body.ts) || body.ts < 0) {
    throw new Error("invalid peer vv proof fields");
  }
  return keys.sign(vvSignedText(body, requester, challenge));
}

export function verifyPeerVv<T extends PeerVvProofBody>(pubkey: string, body: T, requester: string, challenge: string,
  proof: string, now = Date.now()): boolean {
  if (!NONCE.test(challenge) || !Number.isSafeInteger(body.ts) || Math.abs(now - body.ts) > WINDOW_MS) return false;
  return verifySig(pubkey, vvSignedText(body, requester, challenge), proof);
}

/** Only for the authority's sticky capability marker, never for a vv response or request authorization. */
export function verifyPeerVvEvidence(pubkey: string, body: PeerVvProofBody, requester: string, challenge: string,
  proof: string, now = Date.now()): boolean {
  if (!NONCE.test(challenge) || !Number.isSafeInteger(body.ts) || body.ts < 0
    || now - body.ts > PEER_PROOF_MAX_AGE_MS || body.ts - now > WINDOW_MS) return false;
  return verifySig(pubkey, vvSignedText(body, requester, challenge), proof);
}

export type PeerSigResult = "valid" | "bad_signature" | "clock_skew" | "too_old" | "replay";

/** An in-memory replay guard. A floor keeps evicted nonces from becoming valid again. */
export class PeerNonceBook {
  private readonly peers = new Map<string, { nonces: Map<string, number>; floor: number }>();
  constructor(readonly bootAt: number | null = null) {}

  accept(requester: string, nonce: string, now: number, ts = now): boolean {
    return this.result(requester, nonce, now, ts) === "valid";
  }

  result(requester: string, nonce: string, now: number, ts: number): "valid" | "too_old" | "replay" {
    let entries = this.peers.get(requester);
    if (!entries) {
      for (const [peer, entry] of this.peers) {
        for (const [key, stamp] of entry.nonces) if (stamp + WINDOW_MS < now) entry.nonces.delete(key);
        if (!entry.nonces.size && entry.floor + WINDOW_MS < now) this.peers.delete(peer);
      }
      if (this.peers.size >= MAX_REQUESTERS) this.peers.delete(this.peers.keys().next().value as string);
      entries = { nonces: new Map(), floor: -1 };
      this.peers.set(requester, entries);
    }
    for (const [key, stamp] of entries.nonces) if (stamp + WINDOW_MS < now) entries.nonces.delete(key);
    if (entries.floor + WINDOW_MS < now) entries.floor = -1;
    if (ts <= entries.floor) return "too_old";
    if (entries.nonces.has(nonce)) return "replay";
    if (entries.nonces.size >= MAX_NONCES_PER_REQUESTER) {
      let oldestKey = "";
      let oldestTs = Infinity;
      for (const [key, stamp] of entries.nonces) {
        if (stamp < oldestTs) { oldestKey = key; oldestTs = stamp; }
      }
      entries.nonces.delete(oldestKey);
      entries.floor = Math.max(entries.floor, oldestTs);
      if (ts <= entries.floor) return "too_old";
    }
    entries.nonces.set(nonce, ts);
    return "valid";
  }
}

export function verifyPeerSigResult(pubkey: string, r: PeerSigRequest, h: PeerSigHeaders, book: PeerNonceBook, now = Date.now(), record = true): PeerSigResult {
  if (!Number.isSafeInteger(r.ts) || r.ts < 0 || !NONCE.test(r.nonce)) return "bad_signature";
  if (Math.abs(now - r.ts) > WINDOW_MS) return "clock_skew";
  if (book.bootAt !== null && r.ts < book.bootAt) return "too_old";
  if (h["X-Walkie-Ts"] !== String(r.ts) || h["X-Walkie-Nonce"] !== r.nonce) return "bad_signature";
  if (!verifySig(pubkey, signedText(r), h["X-Walkie-Sig"])) return "bad_signature";
  return record ? book.result(r.requester, r.nonce, now, r.ts) : "valid";
}

export function verifyPeerSig(pubkey: string, r: PeerSigRequest, h: PeerSigHeaders, book: PeerNonceBook, now = Date.now(), record = true): boolean {
  return verifyPeerSigResult(pubkey, r, h, book, now, record) === "valid";
}

export type PeerSigTier = "A" | "B" | "C";
export function peerSigTier(method: string, path: string): PeerSigTier {
  // Join checks the known node's sticky evidence (and strict mode) after parsing its key.
  if (method === "POST" && path === "/peer/v1/join") return "C";
  if ((method === "GET" && path === "/peer/v1/hello") || (method === "POST" && path === "/peer/v1/roster-request")) return "C";
  if (method === "POST" && ["/peer/v1/admin/run", "/peer/v1/vault/lease", "/peer/v1/vault/usage",
    "/peer/v1/pool/stage", "/peer/v1/pool/serve", "/peer/v1/ssh/revocation"].includes(path)) return "A";
  if (/^\/peer\/v1\/pool\/(tunnel|serve-tunnel)\/[0-9a-f]{32}$/.test(path)) return "A";
  if (["/peer/v1/orchestrator/schedule-claim", "/peer/v1/orchestrator/schedule-defaults",
    "/peer/v1/orchestrator/schedule-manage", "/peer/v1/orchestrator/schedule-progress"].includes(path)) return "A";
  if (["/peer/v1/orchestrator/lease", "/peer/v1/events", "/peer/v1/vv"].includes(path)
    || (method === "GET" && /^\/peer\/v1\/blobs\/[0-9a-f]{64}$/.test(path))) return "B";
  return "A";
}

export function hasPeerSig(headers: Headers): boolean {
  return ["x-walkie-ts", "x-walkie-nonce", "x-walkie-sig"].some((name) => headers.has(name));
}
