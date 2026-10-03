import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { admitJoin } from "../../src/daemon/requests.ts";
import type { VaultEntry } from "../../src/accounts/vault/vault.ts";
import { ephemeralKey } from "../../src/accounts/vault/seal.ts";
import { requestLease } from "../../src/daemon/vault-lease.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { signedPeerFetch } from "../helpers/signed-peer-fetch.ts";

const account = "a".repeat(24);
let cluster: Cluster;
let owner: TestNode;
let teammate: TestNode;
let ownerSecond: TestNode;

beforeAll(async () => {
  cluster = new Cluster();
  owner = await cluster.add({ name: "owner", login: "owner@example.com" });
  await owner.client().init("fleet-limit", "owner");
  await owner.client().invite("teammate@example.com", "teammate", "member");
  teammate = await cluster.add({ name: "teammate", login: "teammate@example.com" });
  expect((await teammate.client().join(owner.peerAddr)).admitted).toBe(true);
  ownerSecond = await cluster.add({ name: "owner-second", login: "owner@example.com" });
  let second = await ownerSecond.client().join(owner.peerAddr);
  if (!second.admitted) {
    admitJoin(owner.d.core, ownerSecond.d.nodeId, true);
    second = await ownerSecond.client().join(owner.peerAddr);
  }
  expect(second.admitted).toBe(true);
  owner.d.core.vault = {
    list: () => [{ id: account, provider: "claude", label: "fixture", plan: null, policy: "shared",
      share_with: ["teammate"], created_at: 1, expires_at: null, home: null, linked: false, gen: "0a1b" } as VaultEntry],
    claudeToken: async () => "sk-ant-oat01-FAKEHANDOUTTOKEN0123456789abcdefghijk",
  };
  owner.d.core.vaultSharing = () => true;
  owner.d.core.vaultRoomLeft = () => 90;
}, 30_000);
afterAll(async () => { await cluster.close(); });

test("a signed request from a real teammate node stays at ten even when it claims the owner launcher", async () => {
  const request = () => JSON.stringify({ account, launcher: "owner", epk: ephemeralKey().publicKey,
    nonce: crypto.randomUUID().replaceAll("-", ""), ts: Date.now() });
  for (let i = 0; i < 10; i++) {
    const response = await signedPeerFetch(teammate, owner, "/peer/v1/vault/lease", { method: "POST", body: request() });
    expect(response.status).toBe(200);
    expect((await response.json() as { grant: string }).grant).toMatch(/^[0-9a-f]{16}$/);
  }
  const response = await signedPeerFetch(teammate, owner, "/peer/v1/vault/lease", { method: "POST", body: request() });
  expect(response.status).toBe(429);
  expect((await response.json() as { error: { code: string } }).error.code).toBe("rate_limited");
});

test("the owner's second machine: owner-launched seats use the raised budget; launcher-less requests stay at ten and cannot shrink it", async () => {
  const path = owner.d.core.paths.config;
  const current = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> : {};
  writeFileSync(path, JSON.stringify({ ...current, vault_own_lease_limit: 40 }));
  // The upgraded holder announces the launcher field; the requester learns it from a verified vv exchange.
  await waitFor(() => ownerSecond.d.sync.peerCapabilities(owner.d.nodeId)?.caps.includes("lease_launcher_v1") ?? false,
    { what: "the holder's lease_launcher_v1 capability", timeoutMs: 20_000 });
  // What SeatsHost does for an owner-launched seat: requestLease over the daemon's own peer client.
  const seatLease = () => requestLease(ownerSecond.d.core, (_addr, body, node) => {
    const addr = ownerSecond.d.client.addrOf(node);
    if (!addr) throw new Error("no transport to the holder");
    return ownerSecond.d.client.vaultLease(addr, body);
  }, { account, node: owner.d.nodeId, agent: "seat-fleet", launcher: "owner" });
  const raw = (launcher?: string) => signedPeerFetch(ownerSecond, owner, "/peer/v1/vault/lease", { method: "POST",
    body: JSON.stringify({ account, ...(launcher ? { launcher } : {}), epk: ephemeralKey().publicKey,
      nonce: crypto.randomUUID().replaceAll("-", ""), ts: Date.now() }) });
  for (let i = 0; i < 5; i++) expect((await seatLease()).token).toMatch(/^sk-ant-oat01-/);
  for (let i = 0; i < 10; i++) expect((await raw()).status).toBe(200);
  expect((await raw()).status).toBe(429);
  expect((await raw("teammate")).status).toBe(429); // another launcher on the owner's machine shares the base ten
  for (let i = 0; i < 35; i++) expect((await seatLease()).token).toMatch(/^sk-ant-oat01-/); // only the raised bucket has room
  await expect(seatLease()).rejects.toMatchObject({ status: 429 });
});
