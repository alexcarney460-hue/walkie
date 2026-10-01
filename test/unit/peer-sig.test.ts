import { describe, expect, test } from "bun:test";
import { generateKeys } from "../../src/daemon/keys.ts";
import { PeerNonceBook, peerSigTier, signPeerRequest, verifyPeerSig, verifyPeerSigResult,
  signPeerVv, verifyPeerVv } from "../../src/daemon/peer-sig.ts";

const requester = generateKeys();
const target = generateKeys();
const team = "team-1";
const now = 1_800_000_000_000;
const base = { method: "POST", path: "/peer/v1/events", query: "?b=2&a=1", body: '{"events":[]}',
  requester: requester.nodeId, target: target.nodeId, team, ts: now, nonce: "00112233445566778899aabbccddeeff" };

function signed(input = base) { return signPeerRequest(requester, input); }
function check(input = base, headers = signed(), book = new PeerNonceBook(), at = now) {
  return verifyPeerSig(requester.pubkey, input, headers, book, at);
}

describe("Tailscale peer request signature", () => {
  test("vv response proof binds body, identities, timestamp, and challenge", () => {
    const vv = { node: target.nodeId, vv: {}, ts: now, capabilities: { version: "0.2.0-pre.9", caps: ["peer_sig_v1"] } };
    const challenge = "00112233445566778899aabbccddeeff";
    const proof = signPeerVv(target, vv, requester.nodeId, challenge);
    expect(verifyPeerVv(target.pubkey, vv, requester.nodeId, challenge, proof, now)).toBe(true);
    expect(verifyPeerVv(target.pubkey, { ...vv, capabilities: { ...vv.capabilities, caps: [] } }, requester.nodeId, challenge, proof, now)).toBe(false);
    expect(verifyPeerVv(target.pubkey, vv, target.nodeId, challenge, proof, now)).toBe(false);
    expect(verifyPeerVv(target.pubkey, vv, requester.nodeId, "f".repeat(32), proof, now)).toBe(false);
    expect(verifyPeerVv(target.pubkey, vv, requester.nodeId, challenge, proof, now + 120_001)).toBe(false);
  });
  test("raw query order and exact body bytes are bound", () => {
    expect(check({ ...base, query: "?a=1&b=2" })).toBe(false);
    const duplicates = { ...base, query: "?channel=public&channel=private" };
    expect(check({ ...duplicates, query: "?channel=private&channel=public" }, signed(duplicates))).toBe(false);
    expect(check({ ...base, body: '{"events":[] }' })).toBe(false);
  });
  test("target and key are bound", () => {
    expect(check({ ...base, target: requester.nodeId })).toBe(false);
    expect(verifyPeerSig(target.pubkey, base, signed(), new PeerNonceBook(), now)).toBe(false);
  });
  test("window includes exact edges and excludes next millisecond", () => {
    expect(check(base, signed(), new PeerNonceBook(), now + 120_000)).toBe(true);
    expect(check(base, signed(), new PeerNonceBook(), now - 120_000)).toBe(true);
    expect(check(base, signed(), new PeerNonceBook(), now + 120_001)).toBe(false);
    expect(check(base, signed(), new PeerNonceBook(), now - 120_001)).toBe(false);
  });
  test("nonce replays are refused per requester", () => {
    const book = new PeerNonceBook();
    expect(check(base, signed(), book)).toBe(true);
    expect(check(base, signed(), book)).toBe(false);
  });
  test("the requester table evicts an old entry instead of refusing a new requester", () => {
    const book = new PeerNonceBook();
    for (let i = 0; i < 1025; i++) {
      expect(book.accept(i.toString(16).padStart(16, "0"), base.nonce, now)).toBe(true);
    }
  });
  test("a burst of 1200 fresh nonces remains valid", () => {
    const book = new PeerNonceBook();
    for (let i = 0; i < 1200; i++) {
      expect(book.accept(requester.nodeId, i.toString(16).padStart(32, "0"), now + i)).toBe(true);
    }
  });
  test("trimmed nonces advance a floor and have a distinct stale result", () => {
    const book = new PeerNonceBook();
    for (let i = 0; i < 4100; i++) book.accept(requester.nodeId, i.toString(16).padStart(32, "0"), now + i);
    const stale = { ...base, nonce: "0".repeat(32) };
    expect(verifyPeerSigResult(requester.pubkey, stale, signed(stale), book, now + 4100)).toBe("too_old");
    const fresh = { ...base, nonce: "f".repeat(32), ts: now + 4101 };
    expect(verifyPeerSigResult(requester.pubkey, fresh, signed(fresh), book, now + 4101)).toBe("valid");
    expect(verifyPeerSigResult(requester.pubkey, fresh, signed(fresh), book, now + 4101)).toBe("replay");
    expect(verifyPeerSigResult(requester.pubkey, fresh, signed(fresh), new PeerNonceBook(), now + 124_102)).toBe("clock_skew");
    expect(verifyPeerSigResult(target.pubkey, fresh, signed(fresh), new PeerNonceBook(), now + 4101)).toBe("bad_signature");
  });
  test("a receiver restart refuses a timestamp signed before boot", () => {
    const beforeBoot = new PeerNonceBook(now + 1);
    expect(check(base, signed(), beforeBoot, now + 1)).toBe(false);
    const afterBoot = { ...base, ts: now + 2 };
    expect(check(afterBoot, signed(afterBoot), beforeBoot, now + 2)).toBe(true);
  });
  test("route tiers include both tunnel shapes and known joins", () => {
    expect(peerSigTier("POST", "/peer/v1/admin/run")).toBe("A");
    expect(peerSigTier("POST", "/peer/v1/vault/lease")).toBe("A");
    expect(peerSigTier("GET", `/peer/v1/pool/serve-tunnel/${"a".repeat(32)}`)).toBe("A");
    expect(peerSigTier("GET", "/peer/v1/blobs/" + "b".repeat(64))).toBe("B");
    expect(peerSigTier("GET", "/peer/v1/events")).toBe("B");
    expect(peerSigTier("POST", "/peer/v1/roster-request")).toBe("C");
    expect(peerSigTier("POST", "/peer/v1/peer-proof")).toBe("A");
    expect(peerSigTier("POST", "/peer/v1/join")).toBe("C");
    expect(peerSigTier("POST", "/peer/v1/ssh/revocation")).toBe("A"); // ENROLL-SSH: a signed receipt, and a signed request
    expect(peerSigTier("POST", `/peer/v1/pool/tunnel/${"a".repeat(32)}`)).toBe("A");
    expect(peerSigTier("DELETE", `/peer/v1/pool/serve-tunnel/${"a".repeat(32)}`)).toBe("A");
    for (const path of ["schedule-claim", "schedule-defaults", "schedule-manage", "schedule-progress"]) {
      expect(peerSigTier("POST", `/peer/v1/orchestrator/${path}`)).toBe("A");
    }
    expect(peerSigTier("GET", "/peer/v1/future-route")).toBe("A");
  });
});
