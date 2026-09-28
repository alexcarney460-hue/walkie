import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../../src/protocol/canonical.ts";
import { deriveTeamId, nodeIdFromPubkey } from "../../src/protocol/ids.ts";
import { generateKeys, loadOrCreateKeys, signEvent, verifyEvent, verifySig } from "../../src/daemon/keys.ts";
import { createTeam, ev, tnode } from "../helpers/events.ts";

describe("canonicalJson", () => {
  test("sorts keys recursively, drops undefined, no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  });
  test("stable across key insertion order and round-trips", () => {
    const x = { kind: "msg.post", body: { text: "hé   \"q\"", n: 1.5 }, id: "a:1" };
    const y = JSON.parse(JSON.stringify({ id: "a:1", body: { n: 1.5, text: "hé   \"q\"" }, kind: "msg.post" }));
    expect(canonicalJson(x)).toBe(canonicalJson(y));
    expect(JSON.parse(canonicalJson(x))).toEqual(x);
  });
  test("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
  });
});

describe("keys", () => {
  test("node id = sha256(raw pubkey)[0:16]", () => {
    const k = generateKeys();
    expect(k.nodeId).toMatch(/^[0-9a-f]{16}$/);
    expect(nodeIdFromPubkey(k.pubkey)).toBe(k.nodeId);
    expect(Buffer.from(k.pubkey, "base64").length).toBe(32);
  });

  test("sign/verify and tamper detection", () => {
    const k = generateKeys();
    const sig = k.sign("hello");
    expect(verifySig(k.pubkey, "hello", sig)).toBe(true);
    expect(verifySig(k.pubkey, "hellO", sig)).toBe(false);
    expect(verifySig(generateKeys().pubkey, "hello", sig)).toBe(false);
    expect(verifySig(k.pubkey, "hello", "not-a-sig")).toBe(false);
    expect(verifySig("AAAA", "hello", sig)).toBe(false);
  });

  test("event signature covers every field", () => {
    const alex = tnode("alex");
    const { team } = createTeam(alex);
    const e = ev(team, alex, "msg.post", { text: "x" }, { channel: "general" });
    expect(verifyEvent(e, alex.keys.pubkey)).toBe(true);
    for (const mutate of [
      { ts: e.ts + 1 }, { channel: "other" }, { author: { ...e.author, agent: "zz" } }, { body: { text: "y" } }, { kind: "ask" as const },
    ]) expect(verifyEvent({ ...e, ...mutate }, alex.keys.pubkey)).toBe(false);
    const resigned = signEvent(alex.keys, { ...e, sig: undefined } as never);
    expect(verifyEvent(resigned, alex.keys.pubkey)).toBe(true);
  });

  test("node.key is created 0600 and reloads to the same identity; loose perms are tightened", () => {
    const dir = mkdtempSync("/tmp/walkie-keys-");
    try {
      const path = join(dir, "node.key");
      const a = loadOrCreateKeys(path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      chmodSync(path, 0o644);
      const b = loadOrCreateKeys(path);
      expect(b.nodeId).toBe(a.nodeId);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("team id is bound to founder key, name and ts", () => {
    const k = generateKeys();
    const id = deriveTeamId(k.pubkey, "acme", 1);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(deriveTeamId(k.pubkey, "acme", 2)).not.toBe(id);
    expect(deriveTeamId(generateKeys().pubkey, "acme", 1)).not.toBe(id);
  });
});
