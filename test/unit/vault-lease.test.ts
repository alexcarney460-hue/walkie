// ACCOUNTS-2 phase 3: handing a Claude setup-token from the owner's vault to another machine. Policy (own / shared +
// the owner's vault_sharing / local), replay and clock checks, the per-node rate limit, Codex never, and the reply
// sealed so only the requesting daemon's ephemeral key opens it. Logs name the account and node, never the token.
import { afterEach, describe, expect, test } from "bun:test";
import type { Core } from "../../src/daemon/core.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import type { MemberRec } from "../../src/daemon/roster.ts";
import { grantLease, NonceBook, requestLease, type PeerLeaseReq } from "../../src/daemon/vault-lease.ts";
import type { VaultSource } from "../../src/accounts/service.ts";
import type { VaultEntry } from "../../src/accounts/vault/vault.ts";
import { ephemeralKey } from "../../src/accounts/vault/seal.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const TOKEN = ("sk" + "-ant-oat01-FAKEHANDOUTTOKEN0123456789abcdefghijk");
const A = "a".repeat(24);
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const logs: string[] = [];
const spy: Logger = { debug: () => undefined, info: (m, f) => logs.push(JSON.stringify({ m, ...f })), warn: (m, f) => logs.push(JSON.stringify({ m, ...f })), error: (m, f) => logs.push(JSON.stringify({ m, ...f })) };

function vault(entries: Partial<VaultEntry>[]): VaultSource {
  const list = entries.map((e) => ({ id: A, provider: "claude", label: "Claude account", plan: null, policy: "own", share_with: [], created_at: 1, expires_at: null, home: null, linked: false, gen: "g1", ...e }) as VaultEntry);
  return { list: () => list, claudeToken: async () => TOKEN };
}

function owner(): { core: Core; alex: MemberRec; kira: MemberRec; create: import("../../src/protocol/schemas.ts").Event } {
  const alex = tnode("alex");
  const { team, create } = createTeam(alex);
  const core = makeCore(alex, team, cleanups);
  core.ingest(create, "local");
  (core as unknown as { log: Logger }).log = spy;
  return { core, create, alex: { login: alex.login, handle: "alex", role: "owner" }, kira: { login: "kira@example.com", handle: "kira", role: "member" } };
}

function req(over: Partial<PeerLeaseReq> = {}): PeerLeaseReq & { key: ReturnType<typeof ephemeralKey> } {
  const key = ephemeralKey();
  return { account: A, epk: key.publicKey, nonce: crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), ""), ts: now(), key, ...over };
}
const body = (r: ReturnType<typeof req>) => { const { key: _k, ...b } = r; return b; };

describe("grantLease (the owner's machine)", () => {
  test("own-machines: the owner's other machine gets it; a teammate does not", async () => {
    const { core, alex, kira } = owner();
    const d = { vault: vault([{ policy: "own" }]), sharing: false, nonces: new NonceBook() };
    const r = req();
    const res = await grantLease(core, d, "node-alex-2", alex, body(r), now());
    expect(res.owner).toBe("alex");
    expect(JSON.stringify(res)).not.toContain("FAKEHANDOUT");
    await expect(grantLease(core, d, "node-kira", kira, body(req()), now())).rejects.toMatchObject({ code: "not_allowed" });
    expect(logs.join("\n")).not.toContain("FAKEHANDOUT");
    expect(logs.some((l) => l.includes("vault_lease_granted") && l.includes("node-alex-2"))).toBe(true);
  });

  test("shared: only listed teammates, and only while the owner has vault_sharing on; local: nobody", async () => {
    const { core, kira } = owner();
    const off = { vault: vault([{ policy: "shared", share_with: ["kira"] }]), sharing: false, nonces: new NonceBook() };
    await expect(grantLease(core, off, "node-kira", kira, body(req()), now())).rejects.toMatchObject({ code: "not_allowed" });
    const on = { ...off, sharing: true };
    expect((await grantLease(core, on, "node-kira", kira, body(req()), now())).owner).toBe("alex");
    const arvid: MemberRec = { login: "arvid@example.com", handle: "arvid", role: "member" };
    await expect(grantLease(core, on, "node-arvid", arvid, body(req()), now())).rejects.toMatchObject({ code: "not_allowed" });
    const local = { vault: vault([{ policy: "local" }]), sharing: true, nonces: new NonceBook() };
    await expect(grantLease(core, local, "node-kira", kira, body(req()), now())).rejects.toMatchObject({ code: "not_allowed" });
  });

  test("replays, stale requests, Codex accounts, unknown accounts and the 11th hand-out in an hour are refused", async () => {
    const { core, alex } = owner();
    const d = { vault: vault([{ policy: "own" }, { id: "b".repeat(24), provider: "codex", policy: "own" }]), sharing: false, nonces: new NonceBook() };
    const r = req();
    await grantLease(core, d, "node-2", alex, body(r), now());
    await expect(grantLease(core, d, "node-2", alex, body(r), now())).rejects.toMatchObject({ code: "replay" });
    await expect(grantLease(core, d, "node-2", alex, body(req({ ts: now() - 120_000 })), now())).rejects.toMatchObject({ code: "stale" });
    await expect(grantLease(core, d, "node-2", alex, body(req({ account: "b".repeat(24) })), now())).rejects.toMatchObject({ code: "not_found" });
    await expect(grantLease(core, d, "node-2", alex, body(req({ account: "c".repeat(24) })), now())).rejects.toMatchObject({ code: "not_found" });
    await expect(grantLease(core, d, "node-2", alex, { ...body(req()), extra: 1 }, now())).rejects.toMatchObject({ code: "invalid" });
    // 5 requests above were counted; 5 more pass, the 11th is limited.
    for (let i = 0; i < 5; i++) await grantLease(core, d, "node-2", alex, body(req()), now());
    await expect(grantLease(core, d, "node-2", alex, body(req()), now())).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("requestLease (the machine that needs the token)", () => {
  test("opens the sealed reply with its own ephemeral key; a reply for another context is rejected", async () => {
    const own = owner();
    const alex2 = tnode("alex", "alex@example.com", "alex-mini");
    const requester = makeCore(alex2, own.core.teamId as string, cleanups);
    // The requester knows the owner's node from the team's creation event.
    requester.ingest(own.create, "remote");
    const ownerNode = own.core.nodeId;
    expect(requester.roster.nodes.has(ownerNode)).toBe(true);
    const d = { vault: vault([{ policy: "own" }]), sharing: false, nonces: new NonceBook() };
    const call = async (_addr: { ip: string; port: number }, b: PeerLeaseReq) => grantLease(own.core, d, requester.nodeId, own.alex, b, now());
    const got = await requestLease(requester, call, { account: A, node: ownerNode, agent: "cc-abc123" }, now());
    expect(got).toMatchObject({ token: TOKEN, owner: "alex", grant: expect.stringMatching(/^[0-9a-f]{16}$/) });
    // A reply sealed for another requester node does not open here.
    const wrong = async (_a: { ip: string; port: number }, b: PeerLeaseReq) => grantLease(own.core, { ...d, nonces: new NonceBook() }, "someone-else", own.alex, b, now());
    await expect(requestLease(requester, wrong, { account: A, node: ownerNode }, now())).rejects.toMatchObject({ code: "bad_lease" });
    await expect(requestLease(requester, call, { account: A, node: requester.nodeId }, now())).rejects.toMatchObject({ code: "invalid" });
  });
});
