import { createHash } from "node:crypto";
import { canonicalJson } from "../protocol/canonical.ts";
import { PeerCapabilities, type PeerCapabilities as Capabilities } from "../protocol/capabilities.ts";
import type { PeerVvRelay } from "../protocol/schemas.ts";
import type { Store } from "./store.ts";
import { PEER_SIG_CAP, verifyPeerVvEvidence } from "./peer-sig.ts";
import { nodeMember, transportFields, type Roster } from "./roster.ts";
import type { Core } from "./core.ts";

const keyOf = (nodeId: string) => `peer_capabilities:${nodeId}`;
const requiredKey = (nodeId: string) => `peer_sig_required:${nodeId}`;
const verifiedKey = (nodeId: string) => `peer_caps_verified:${nodeId}`;

export function peerCapabilities(store: Store, nodeId: string): Capabilities | undefined {
  if (store.getMeta(verifiedKey(nodeId)) !== "1") return undefined;
  const raw = store.getMeta(keyOf(nodeId));
  if (!raw) return undefined;
  try { return PeerCapabilities.parse(JSON.parse(raw)); } catch { return undefined; }
}

export function peerSigPolicy(store: Store, nodeId: string): "required" | "legacy" | "unknown" {
  if (store.getMeta(verifiedKey(nodeId)) !== "1") return "unknown";
  if (store.getMeta(requiredKey(nodeId)) === "1") return "required";
  const caps = peerCapabilities(store, nodeId);
  return !caps ? "unknown" : caps.caps.includes(PEER_SIG_CAP) ? "required" : "legacy";
}

/** An authority-signed roster marker or locally verified node proof is irreversible evidence. */
export function peerSigRequired(roster: Roster, store: Store, nodeId: string): boolean {
  return roster.nodes.get(nodeId)?.peer_sig_v1 === true || peerSigPolicy(store, nodeId) === "required";
}

export function peerSigStrict(roster: Roster, store: Store): boolean {
  if (roster.peer_sig_strict !== undefined) return roster.peer_sig_strict;
  const admitted = [...roster.nodes.values()].filter((n) => nodeMember(roster, n.node_id));
  return admitted.length > 0 && admitted.every((n) => peerSigRequired(roster, store, n.node_id));
}

/** Replicate verified key possession once, in the authority's signed roster chain. */
export function recordPeerSignature(core: Core, nodeId: string): void {
  const node = core.roster.nodes.get(nodeId);
  if (!core.isAuthority() || !node || node.peer_sig_v1 || !nodeMember(core.roster, nodeId)) return;
  core.emit("team.node", { node_id: node.node_id, login: node.login, hostname: node.hostname,
    pubkey: node.pubkey, ip: node.ip, port: node.port, ...transportFields(node), peer_sig_v1: true });
}

/** Verify the signed envelope against the current admission, including its claimed node. */
export function validPeerProof(core: Core, report: PeerVvRelay, requester: string): boolean {
  const node = core.roster.nodes.get(report.node);
  return !!node && !!nodeMember(core.roster, report.node) && report.body.node === report.node
    && verifyPeerVvEvidence(node.pubkey, report.body, requester, report.challenge, report.proof);
}

/** One authority path for HTTP relays and proofs held locally across a transfer. */
export function recordPeerProof(core: Core, report: PeerVvRelay, requester: string): "invalid" | "pending" | "recorded" {
  if (!core.isAuthority() || !validPeerProof(core, report, requester)) return "invalid";
  const digest = createHash("sha256").update(canonicalJson(report)).digest("hex");
  const consumedKey = `peer_proof_consumed:${digest}`;
  const consumedNode = core.store.getMeta(consumedKey);
  if (consumedNode !== null && consumedNode !== report.node) return "invalid";
  if (core.roster.nodes.get(report.node)?.peer_sig_v1) return "recorded";
  if (consumedNode === null) core.store.setMeta(consumedKey, report.node);
  recordPeerSignature(core, report.node);
  return core.roster.nodes.get(report.node)?.peer_sig_v1 === true ? "recorded" : "pending";
}

/** Seal the automatically reached strict state in the signed chain. */
export function engagePeerSigStrict(core: Core): void {
  if (!core.isAuthority() || core.roster.peer_sig_strict !== undefined || !peerSigStrict(core.roster, core.store)) return;
  const own = core.roster.nodes.get(core.nodeId);
  if (!own || own.revoked) return;
  core.emit("team.node", { node_id: own.node_id, login: own.login, hostname: own.hostname,
    pubkey: own.pubkey, ip: own.ip, port: own.port, ...transportFields(own), peer_sig_strict: true,
    ...(own.peer_sig_v1 ? { peer_sig_v1: true } : {}) });
}

/** Persist only authenticated capability evidence; callers must verify the source first. */
export function rememberPeerCapabilities(store: Store, nodeId: string, value: Capabilities | undefined): void {
  if (!value) return;
  const incoming = PeerCapabilities.parse(value);
  const trusted = store.getMeta(verifiedKey(nodeId)) === "1";
  const old = trusted ? peerCapabilities(store, nodeId) : undefined;
  const sticky = (trusted && store.getMeta(requiredKey(nodeId)) === "1") || !!old?.caps.includes(PEER_SIG_CAP) || incoming.caps.includes(PEER_SIG_CAP);
  const caps = sticky ? [...new Set([...incoming.caps, PEER_SIG_CAP])] : incoming.caps;
  const serialized = JSON.stringify({ ...incoming, caps });
  if (store.getMeta(keyOf(nodeId)) !== serialized) store.setMeta(keyOf(nodeId), serialized);
  if (store.getMeta(verifiedKey(nodeId)) !== "1") store.setMeta(verifiedKey(nodeId), "1");
  if (sticky && store.getMeta(requiredKey(nodeId)) !== "1") store.setMeta(requiredKey(nodeId), "1");
}

export function rememberValidPeerSignature(store: Store, nodeId: string): void {
  const caps = peerCapabilities(store, nodeId);
  if (!caps) store.deleteMeta(keyOf(nodeId));
  if (store.getMeta(requiredKey(nodeId)) !== "1") store.setMeta(requiredKey(nodeId), "1");
  if (store.getMeta(verifiedKey(nodeId)) !== "1") store.setMeta(verifiedKey(nodeId), "1");
  if (caps && !caps.caps.includes(PEER_SIG_CAP)) rememberPeerCapabilities(store, nodeId, caps);
}
