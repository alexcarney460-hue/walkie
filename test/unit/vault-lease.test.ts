// ACCOUNTS-2 phase 3: handing a Claude setup-token from the owner's vault to another machine. Policy (own / shared +
// the owner's vault_sharing / local), replay and clock checks, the per-node rate limit, Codex never, and the reply
// sealed so only the requesting daemon's ephemeral key opens it. Logs name the account and node, never the token.
import { afterEach, describe, expect, test } from "bun:test";
import type { Core } from "../../src/daemon/core.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import type { MemberRec } from "../../src/daemon/roster.ts";
import type { HttpError } from "../../src/daemon/http.ts";
import { grantLease, NonceBook, probeLease, requestLease, type PeerLeaseReq } from "../../src/daemon/vault-lease.ts";
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
  test("repeated readiness probes check policy and health without spending hand-outs", async () => {
    const { core, kira } = owner();
    const d = { vault: vault([{ policy: "shared", share_with: ["kira"] }]), sharing: true,
      roomLeft: () => 11, nonces: new NonceBook() };
    await expect(probeLease(core, d, "node-kira", kira, { account: A, provider: "claude" }, now()))
      .rejects.toMatchObject({ code: "unavailable" });
    for (let i = 0; i < 12; i++) expect(await probeLease(core, d, "node-kira", kira, { account: A, provider: "claude" }, now())).toEqual({ ready: true });
    expect((await grantLease(core, d, "node-kira", kira, body(req()), now())).owner).toBe("alex");
    await expect(probeLease(core, { ...d, roomLeft: () => 10 }, "node-kira", kira, { account: A, provider: "claude" }, now()))
      .rejects.toMatchObject({ code: "unavailable", message: "lease unavailable" });
  }, 15_000);
  test("probe refuses after the local hand-out bucket is exhausted without spending capacity", async () => {
    const { core, alex } = owner();
    const d = { vault: vault([{ policy: "own" }]), sharing: false, nonces: new NonceBook() };
    for (let i = 0; i < 10; i++) await grantLease(core, d, "node-alex-2", alex, body(req()), now());
    await expect(probeLease(core, d, "node-alex-2", alex, { account: A, provider: "claude" }, now()))
      .rejects.toMatchObject({ code: "unavailable", message: "lease unavailable" });
    await expect(grantLease(core, d, "node-alex-2", alex, body(req()), now()))
      .rejects.toMatchObject({ code: "rate_limited" });
    expect(logs.some((l) => l.includes("vault_probe_denied") && l.includes("handout_rate_limited"))).toBe(true);
  });
  test("probe exposes one unavailable response for owner-side account failures", async () => {
    const cases = [
      { reason: "not_found", entry: [], sharing: true, room: 11 },
      { reason: "not_allowed", entry: [{ policy: "shared", share_with: ["kira"] }], sharing: false, room: 11 },
      { reason: "reserved", entry: [{ policy: "shared", share_with: ["kira"] }], sharing: true, room: 10 },
      { reason: "expired", entry: [{ policy: "shared", share_with: ["kira"], expires_at: now() + 1000 }], sharing: true, room: 11 },
      { reason: "claude_token_unreadable", entry: [{ policy: "shared", share_with: ["kira"] }], sharing: true, room: 11, unreadable: true },
    ] satisfies Array<{ reason: string; entry: Partial<VaultEntry>[]; sharing: boolean; room: number; unreadable?: boolean }>;
    const replies: string[] = [];
    for (const item of cases) {
      const { core, kira } = owner();
      const source = vault([...item.entry]);
      const d = { vault: "unreadable" in item ? { ...source, claudeToken: async () => { throw new Error("private credential failure"); } } : source,
        sharing: item.sharing, roomLeft: () => item.room, nonces: new NonceBook() };
      try { await probeLease(core, d, "node-kira", kira, { account: A, provider: "claude" }, now()); }
      catch (error) { replies.push(JSON.stringify({ code: (error as HttpError).code, message: (error as Error).message, status: (error as HttpError).status })); }
      if (item.unreadable) await expect(probeLease(core, d, "node-kira", kira, { account: A, provider: "claude" }, now()))
        .rejects.toMatchObject({ code: "unavailable" });
      expect(logs.some((line) => line.includes(`"reason":"${item.reason}"`))).toBe(true);
    }
    expect(new Set(replies).size).toBe(1);
    expect(replies.length).toBe(cases.length);
    expect(replies[0]).toContain("unavailable");
  }, 8_000);
  test("absent and unreadable accounts have bounded refusal timing across repeated probes", async () => {
    const { core, alex } = owner();
    const absent = { vault: vault([]), sharing: false, nonces: new NonceBook() };
    const source = vault([{ policy: "own" }]);
    const unreadable = { vault: { ...source, claudeToken: async () => { await Bun.sleep(90); throw new Error("unreadable"); } },
      sharing: false, nonces: new NonceBook() };
    const durations: { absent: number[]; unreadable: number[] } = { absent: [], unreadable: [] };
    for (let i = 0; i < 5; i++) {
      for (const [name, deps] of [["absent", absent], ["unreadable", unreadable]] as const) {
        const start = performance.now();
        await expect(probeLease(core, deps, "node-alex-2", alex, { account: A, provider: "claude" }, now()))
          .rejects.toMatchObject({ code: "unavailable" });
        durations[name].push(performance.now() - start);
      }
    }
    const average = (samples: number[]) => samples.reduce((sum, value) => sum + value, 0) / samples.length;
    expect(durations.absent.every((duration) => duration >= 220)).toBe(true);
    expect(Math.abs(average(durations.absent) - average(durations.unreadable))).toBeLessThan(60);
  }, 10_000);
  test("cold probes share a deadline; a 2 s Keychain read later warms a healthy cache", async () => {
    const { core, alex } = owner();
    const present = vault([{ policy: "own" }]);
    let reads = 0;
    const cases = [
      { name: "absent", deps: { vault: vault([]), sharing: false, nonces: new NonceBook() } },
      { name: "slow", deps: { vault: { ...present, claudeToken: async () => { reads++; await Bun.sleep(2_000); return TOKEN; } }, sharing: false, nonces: new NonceBook() } },
    ];
    const durations: number[] = [];
    for (const item of cases) {
      const started = performance.now();
      await expect(probeLease(core, item.deps, `node-${item.name}`, alex, { account: A, provider: "claude" }, now()))
        .rejects.toMatchObject({ code: "unavailable" });
      durations.push(performance.now() - started);
    }
    expect(Math.min(...durations)).toBeGreaterThanOrEqual(650);
    expect(Math.max(...durations)).toBeLessThan(950);
    expect(Math.max(...durations) - Math.min(...durations)).toBeLessThan(100);
    await Bun.sleep(1_400);
    const warmStart = performance.now();
    expect(await probeLease(core, cases[1]!.deps, "node-slow", alex, { account: A, provider: "claude" }, now())).toEqual({ ready: true });
    expect(performance.now() - warmStart).toBeLessThan(950);
    expect(reads).toBe(1);
  }, 6_000);
  test("concurrent cold probes start at most one Keychain read", async () => {
    const { core, alex } = owner();
    let inFlight = 0;
    let peak = 0;
    let reads = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const d = { vault: { ...vault([{ policy: "own" }]), claudeToken: async () => {
      reads++;
      peak = Math.max(peak, ++inFlight);
      await held;
      inFlight--;
      return TOKEN;
    } }, sharing: false, nonces: new NonceBook() };
    try {
      const probes = Array.from({ length: 4 }, (_, i) => probeLease(core, d, `node-${i}`, alex, { account: A, provider: "claude" }, now()));
      const results = await Promise.allSettled(probes);
      expect(results.every((result) => result.status === "rejected" && (result.reason as HttpError).code === "unavailable")).toBe(true);
      expect(reads).toBe(1);
      expect(peak).toBe(1);
    } finally { release(); }
    await Bun.sleep(0);
    expect(await probeLease(core, d, "node-0", alex, { account: A, provider: "claude" }, now())).toEqual({ ready: true });
  }, 5_000);
  test("a warm probe queues a single background refresh before the 60 s cache expires", async () => {
    const { core, alex } = owner();
    let reads = 0;
    const source = vault([{ policy: "own" }]);
    const d = { vault: { ...source, claudeToken: async () => { reads++; return TOKEN; } }, sharing: false, nonces: new NonceBook() };
    await expect(probeLease(core, d, "node-first", alex, { account: A, provider: "claude" }, Date.now()))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(reads).toBe(1);
    expect(await probeLease(core, d, "node-next", alex, { account: A, provider: "claude" }, Date.now() + 55_000)).toEqual({ ready: true });
    await Bun.sleep(0);
    expect(reads).toBe(2);
    expect(await probeLease(core, d, "node-last", alex, { account: A, provider: "claude" }, Date.now())).toEqual({ ready: true });
    expect(reads).toBe(2);
  }, 5_000);
  test("expired Claude subscription entries cannot be lent", async () => {
    const { core, alex } = owner();
    const d = { vault: vault([{ expires_at: now() - 1 }]), sharing: true, nonces: new NonceBook() };
    await expect(grantLease(core, d, "node-alex-2", alex, body(req()), now())).rejects.toMatchObject({ code: "expired" });
  });
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
    const on = { ...off, sharing: true, roomLeft: () => 11 };
    expect((await grantLease(core, on, "node-kira", kira, body(req()), now())).owner).toBe("alex");
    const arvid: MemberRec = { login: "arvid@example.com", handle: "arvid", role: "member" };
    await expect(grantLease(core, on, "node-arvid", arvid, body(req()), now())).rejects.toMatchObject({ code: "not_allowed" });
    const local = { vault: vault([{ policy: "local" }]), sharing: true, nonces: new NonceBook() };
    await expect(grantLease(core, local, "node-kira", kira, body(req()), now())).rejects.toMatchObject({ code: "not_allowed" });
  });

  test("cross-person shared and company leases preserve the owner's 10% reserve", async () => {
    const { core, kira } = owner();
    for (const policy of ["shared", "own"] as const) {
      const allowed = { vault: vault([{ policy, share_with: ["kira"], personal: false }]), sharing: true,
        teamPolicy: () => policy === "own" ? "company" as const : "per-account" as const,
        roomLeft: () => 11, nonces: new NonceBook() };
      expect((await grantLease(core, allowed, "node-kira", kira, body(req({ agent: "seat-1" })), now())).owner).toBe("alex");
      for (const room of [10, 9]) {
        const d = { vault: vault([{ policy, share_with: ["kira"], personal: false }]), sharing: true,
          teamPolicy: () => policy === "own" ? "company" as const : "per-account" as const,
          roomLeft: () => room, nonces: new NonceBook() };
        await expect(grantLease(core, d, "node-kira", kira, body(req({ agent: "seat-1" })), now())).rejects.toMatchObject({ code: "reserved" });
      }
    }
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
  test("an API key from a claimed Claude account is refused instead of used as a fallback", async () => {
    const own = owner();
    const alex2 = tnode("alex", "alex@example.com", "alex-mini");
    const requester = makeCore(alex2, own.core.teamId as string, cleanups);
    requester.ingest(own.create, "remote");
    const fake = { ...vault([{ policy: "own" }]), claudeToken: async () => "sk-ant-api03-FAKEKEY" };
    const d = { vault: fake, sharing: false, nonces: new NonceBook() };
    const call = async (_addr: { ip: string; port: number }, b: PeerLeaseReq) => grantLease(own.core, d, requester.nodeId, own.alex, b, now());
    await expect(requestLease(requester, call, { account: A, node: own.core.nodeId }, now())).rejects.toMatchObject({ code: "unavailable" });
  });
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
