// A teammate who has used their 10 hand-outs an hour must not get another 10 by flooding the shared rate limiter.
// grantLease, probe and usage-refresh budgets used to live in that limiter (512 keys, least recently used evicted).
// routeDirect inserted `peer:direct:<fresh id>` for unadmitted keys before refusing them, so 512 of those dropped
// the exhausted lease bucket and the next hand-out started a fresh ten. These budgets now live in their own store.
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { VaultEntry } from "../../src/accounts/vault/vault.ts";
import type { TeamPolicy } from "../../src/protocol/accounts.ts";
import type { Core } from "../../src/daemon/core.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import { memberByHandle, type MemberRec } from "../../src/daemon/roster.ts";
import { grantLease, NonceBook, probeLease, refreshBorrowedUsage, type PeerLeaseReq } from "../../src/daemon/vault-lease.ts";
import type { VaultSource } from "../../src/accounts/service.ts";
import { ephemeralKey } from "../../src/accounts/vault/seal.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, memberEv, nodeEv, now, tnode } from "../helpers/events.ts";

const TOKEN = "sk-ant-oat01-FAKEHANDOUTTOKEN0123456789abcdefghijk";
const A = "a".repeat(24);
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const spy: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function vault(entries: Partial<VaultEntry>[]): VaultSource {
  const list = entries.map((e) => ({ id: A, provider: "claude", label: "Claude account", plan: null, policy: "own", share_with: [], created_at: 1, expires_at: null, home: null, linked: false, gen: "g1", ...e }) as VaultEntry);
  return { list: () => list, claudeToken: async () => TOKEN };
}

function owner(): { core: Core; alex: MemberRec } {
  const alex = tnode("alex");
  const { team, create } = createTeam(alex);
  const core = makeCore(alex, team, cleanups);
  core.ingest(create, "local");
  (core as unknown as { log: Logger }).log = spy;
  return { core, alex: { login: alex.login, handle: "alex", role: "owner" } };
}

function req(over: Partial<PeerLeaseReq> = {}): PeerLeaseReq {
  const key = ephemeralKey();
  return { account: A, epk: key.publicKey, nonce: crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), ""), ts: now(), ...over };
}

/** The reviewer's probe: fill the shared limiter with keys that have nothing to do with leases. */
function floodLimiter(core: Core, clock: number): void {
  for (let i = 0; i < 512; i++) expect(core.limiter.take(`peer:direct:${i}`, core.limits.peer, clock)).toBe(true);
}

test("an exhausted 10/hour hand-out cap survives 512 unrelated limiter keys", async () => {
  const { core, alex } = owner();
  const d = { vault: vault([{ policy: "own" }]), sharing: false, nonces: new NonceBook() };
  const clock = now();
  for (let i = 0; i < 10; i++) expect((await grantLease(core, d, "alex-host", alex, req({ ts: clock }), clock)).owner).toBe("alex");
  await expect(grantLease(core, d, "alex-host", alex, req({ ts: clock }), clock)).rejects.toMatchObject({ code: "rate_limited" });
  floodLimiter(core, clock);
  await expect(grantLease(core, d, "alex-host", alex, req({ ts: clock }), clock)).rejects.toMatchObject({ code: "rate_limited" });
  // One token refills in 360 s at 10/hour. The flood must not have started a fresh burst of 10.
  const later = clock + 360_001;
  expect((await grantLease(core, d, "alex-host", alex, req({ ts: later }), later)).owner).toBe("alex");
  await expect(grantLease(core, d, "alex-host", alex, req({ ts: later }), later)).rejects.toMatchObject({ code: "rate_limited" });
});

test("an exhausted owner-launched cap survives the same flood, and the base cap stays exhausted", async () => {
  const { core, alex } = owner();
  writeFileSync(core.paths.config, JSON.stringify({ vault_own_lease_limit: 80 }));
  const d = { vault: vault([{ policy: "own" }]), sharing: false, nonces: new NonceBook() };
  const clock = now();
  for (let i = 0; i < 10; i++) await grantLease(core, d, "alex-host", alex, req({ ts: clock }), clock);
  await expect(grantLease(core, d, "alex-host", alex, req({ ts: clock }), clock)).rejects.toMatchObject({ code: "rate_limited" });
  for (let i = 0; i < 80; i++) await grantLease(core, d, "alex-host", alex, req({ launcher: "alex", ts: clock }), clock);
  await expect(grantLease(core, d, "alex-host", alex, req({ launcher: "alex", ts: clock }), clock)).rejects.toMatchObject({ code: "rate_limited" });
  floodLimiter(core, clock);
  await expect(grantLease(core, d, "alex-host", alex, req({ ts: clock }), clock)).rejects.toMatchObject({ code: "rate_limited" });
  await expect(grantLease(core, d, "alex-host", alex, req({ launcher: "alex", ts: clock }), clock)).rejects.toMatchObject({ code: "rate_limited" });
  const later = clock + 45_001; // one hand-out at 80/hour
  expect((await grantLease(core, d, "alex-host", alex, req({ launcher: "alex", ts: later }), later)).owner).toBe("alex");
  await expect(grantLease(core, d, "alex-host", alex, req({ launcher: "alex", ts: later }), later)).rejects.toMatchObject({ code: "rate_limited" });
});

test("an exhausted lease-probe cap survives the same flood", async () => {
  const { core, alex } = owner();
  const d = { vault: vault([{ policy: "own" }]), sharing: false, nonces: new NonceBook() };
  const clock = now();
  const probe = () => probeLease(core, d, "alex-host", alex, { account: A, provider: "claude" }, clock);
  const first: Promise<string>[] = [];
  for (let i = 0; i < 60; i++) first.push(probe().then(() => "ok", (e: { code?: string }) => e.code ?? "throw"));
  const codes = await Promise.all(first);
  expect(codes.filter((c) => c === "rate_limited")).toHaveLength(0);
  await expect(probe()).rejects.toMatchObject({ code: "rate_limited" });
  floodLimiter(core, clock);
  await expect(probe()).rejects.toMatchObject({ code: "rate_limited" });
}, 15_000);

test("an exhausted usage-refresh cap survives the same flood", () => {
  const a = tnode("alex");
  const l = tnode("lena");
  const b = tnode("bob");
  const { team, create } = createTeam(a);
  const core = makeCore(l, team, cleanups);
  feed(core, [create, memberEv(team, a, l, "owner"), nodeEv(team, a, l), memberEv(team, a, b, "member"), nodeEv(team, a, b)]);
  const account = "b".repeat(24);
  const entry = { id: account, provider: "claude", policy: "shared", share_with: ["bob"], personal: false } as unknown as VaultEntry;
  const d = { vault: { list: () => [entry] } as never, sharing: true as boolean, teamPolicy: (): TeamPolicy => "per-account" };
  const bob = memberByHandle(core.roster, "bob") as MemberRec;
  const node = b.keys.nodeId;
  const grant = core.vaultGrants.record(account, node, Date.now());
  core.vaultRefresh = () => undefined;
  for (let i = 0; i < 10; i++) expect(refreshBorrowedUsage(core, d, node, bob, { account, grant })).toEqual({ usage: null });
  expect(() => refreshBorrowedUsage(core, d, node, bob, { account, grant })).toThrow("throttled");
  floodLimiter(core, Date.now());
  expect(() => refreshBorrowedUsage(core, d, node, bob, { account, grant })).toThrow("throttled");
});

test("a caller removed while the vault read is in flight does not receive the sealed token", async () => {
  const alexNode = tnode("alex");
  const { team, create } = createTeam(alexNode);
  const core = makeCore(alexNode, team, cleanups);
  core.ingest(create, "local");
  (core as unknown as { log: Logger }).log = spy;
  const kira = tnode("kira");
  const node = { node_id: kira.keys.nodeId, login: kira.login, hostname: kira.hostname, pubkey: kira.keys.pubkey, ip: "127.0.0.1", revoked: false };
  core.emit("team.member", { login: kira.login, handle: "kira", role: "member" });
  core.emit("team.node", node);
  const caller: MemberRec = { login: kira.login, handle: "kira", role: "member" };
  const clock = now();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const enteredP = new Promise<void>((r) => { entered = r; });
  const src = vault([{ policy: "shared", share_with: ["kira"] }]);
  const d = {
    vault: { ...src, claudeToken: async () => { entered(); await gate; return TOKEN; } },
    sharing: true, roomLeft: () => 90, nonces: new NonceBook(),
  };
  const pending = grantLease(core, d, kira.keys.nodeId, caller, req({ ts: clock }), clock);
  await enteredP;
  core.emit("team.node", { ...node, revoked: true });
  release();
  const removed = { code: "rate_limited", status: 429, message: "too many hand-outs from this machine; try later" };
  await expect(pending).rejects.toMatchObject(removed);
  await expect(grantLease(core, d, kira.keys.nodeId, caller, req({ ts: clock }), clock)).rejects.toMatchObject(removed);
});

test("a roster node that is already revoked draws nothing, and coming back starts a fresh cap", async () => {
  const alexNode = tnode("alex");
  const { team, create } = createTeam(alexNode);
  const core = makeCore(alexNode, team, cleanups);
  core.ingest(create, "local");
  (core as unknown as { log: Logger }).log = spy;
  const kira = tnode("kira");
  const body = { node_id: kira.keys.nodeId, login: kira.login, hostname: kira.hostname, pubkey: kira.keys.pubkey, ip: "127.0.0.1", revoked: true };
  core.emit("team.member", { login: kira.login, handle: "kira", role: "member" });
  core.emit("team.node", body);
  const caller: MemberRec = { login: kira.login, handle: "kira", role: "member" };
  const d = { vault: vault([{ policy: "shared", share_with: ["kira"] }]), sharing: true, roomLeft: () => 90, nonces: new NonceBook() };
  const clock = now();
  await expect(grantLease(core, d, kira.keys.nodeId, caller, req({ ts: clock }), clock)).rejects.toMatchObject({ code: "rate_limited" });
  core.emit("team.node", { ...body, revoked: false });
  expect((await grantLease(core, d, kira.keys.nodeId, caller, req({ ts: clock }), clock)).owner).toBe("alex");
});

test("a node that leaves the roster cannot mint a fresh cap, and coming back continues the cap it left with", async () => {
  const alexNode = tnode("alex");
  const { team, create } = createTeam(alexNode);
  const core = makeCore(alexNode, team, cleanups);
  core.ingest(create, "local");
  (core as unknown as { log: Logger }).log = spy;
  const kira = tnode("kira");
  const body = { node_id: kira.keys.nodeId, login: kira.login, hostname: kira.hostname, pubkey: kira.keys.pubkey, ip: "127.0.0.1" };
  core.emit("team.member", { login: kira.login, handle: "kira", role: "member" });
  core.emit("team.node", body);
  const alex: MemberRec = { login: alexNode.login, handle: "alex", role: "owner" };
  const caller: MemberRec = { login: kira.login, handle: "kira", role: "member" };
  const d = { vault: vault([{ policy: "shared", share_with: ["kira"] }]), sharing: true, roomLeft: () => 90, nonces: new NonceBook() };
  const clock = now();
  const id = kira.keys.nodeId;
  for (let i = 0; i < 10; i++) await grantLease(core, d, id, caller, req({ ts: clock }), clock);
  await expect(grantLease(core, d, id, caller, req({ ts: clock }), clock)).rejects.toMatchObject({ code: "rate_limited" });
  core.emit("team.node", { ...body, revoked: true });
  await expect(grantLease(core, d, id, caller, req({ ts: clock }), clock)).rejects.toMatchObject({ code: "rate_limited" });
  core.emit("team.node", body);
  // Revoking and readmitting it is not a reset (Codex pre.12 audit SHOULD 4): the exhausted cap refills at its own rate.
  await expect(grantLease(core, d, id, caller, req({ ts: clock }), clock)).rejects.toMatchObject({ code: "rate_limited" });
  const later = clock + 361_000;
  expect((await grantLease(core, d, id, caller, req({ ts: later }), later)).owner).toBe("alex");
  await expect(grantLease(core, d, id, caller, req({ ts: later }), later)).rejects.toMatchObject({ code: "rate_limited" });
});

test("raising the owner-launched limit does not jump an exhausted bucket up to the new capacity", async () => {
  const { core, alex } = owner();
  writeFileSync(core.paths.config, JSON.stringify({ vault_own_lease_limit: 80 }));
  const d = { vault: vault([{ policy: "own" }]), sharing: false, nonces: new NonceBook() };
  const clock = now();
  for (let i = 0; i < 80; i++) await grantLease(core, d, "alex-host", alex, req({ launcher: "alex", ts: clock }), clock);
  writeFileSync(core.paths.config, JSON.stringify({ vault_own_lease_limit: 256 }));
  await expect(grantLease(core, d, "alex-host", alex, req({ launcher: "alex", ts: clock }), clock)).rejects.toMatchObject({ code: "rate_limited" });
});

test("a caller made an observer while the vault read is in flight does not receive the sealed token", async () => {
  const alexNode = tnode("alex");
  const { team, create } = createTeam(alexNode);
  const core = makeCore(alexNode, team, cleanups);
  core.ingest(create, "local");
  (core as unknown as { log: Logger }).log = spy;
  const kira = tnode("kira");
  const node = { node_id: kira.keys.nodeId, login: kira.login, hostname: kira.hostname, pubkey: kira.keys.pubkey, ip: "127.0.0.1", revoked: false };
  core.emit("team.member", { login: kira.login, handle: "kira", role: "member" });
  core.emit("team.node", node);
  const caller: MemberRec = { login: kira.login, handle: "kira", role: "member" };
  const clock = now();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const enteredP = new Promise<void>((r) => { entered = r; });
  const src = vault([{ policy: "shared", share_with: ["kira"] }]);
  const d = {
    vault: { ...src, claudeToken: async () => { entered(); await gate; return TOKEN; } },
    sharing: true, roomLeft: () => 90, nonces: new NonceBook(),
  };
  const pending = grantLease(core, d, kira.keys.nodeId, caller, req({ ts: clock }), clock);
  await enteredP;
  core.emit("team.member", { login: kira.login, handle: "kira", role: "observer" });
  release();
  await expect(pending).rejects.toMatchObject({ code: "not_allowed", status: 403 });
});
