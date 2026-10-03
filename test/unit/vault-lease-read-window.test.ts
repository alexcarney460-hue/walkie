// A hand-out is judged again after the vault read: the caller's role, vault sharing, the account's policy and share list,
// and whether the account still exists, all as a fresh request would be. Fictional names only.
import { afterEach, expect, test } from "bun:test";
import type { VaultEntry } from "../../src/accounts/vault/vault.ts";
import type { Core } from "../../src/daemon/core.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import type { MemberRec } from "../../src/daemon/roster.ts";
import { grantLease, NonceBook, type PeerLeaseReq } from "../../src/daemon/vault-lease.ts";
import { ephemeralKey } from "../../src/accounts/vault/seal.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const TOKEN = "sk-ant-oat01-FAKEHANDOUTTOKEN0123456789abcdefghijk";
const A = "a".repeat(24);
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
const spy: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const entry = (e: Partial<VaultEntry>): VaultEntry => ({ id: A, provider: "claude", label: "Claude account", plan: null, policy: "own", share_with: [], created_at: 1, expires_at: null, home: null, linked: false, gen: "g1", ...e }) as VaultEntry;
function req(over: Partial<PeerLeaseReq> = {}): PeerLeaseReq {
  const key = ephemeralKey();
  return { account: A, epk: key.publicKey, nonce: crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), ""), ts: now(), ...over };
}

/** Owner alex lends A (shared with kira). `during` runs inside the vault read; returns what grantLease did. */
type Ctx = { core: Core; kira: ReturnType<typeof tnode>; setEntries: (e: VaultEntry[]) => void; setSharing: (v: boolean) => void; setRoom: (v: number | null) => void };
async function scenario(during: (ctx: Ctx) => void): Promise<string> {
  const alexNode = tnode("alex");
  const { team, create } = createTeam(alexNode);
  const core = makeCore(alexNode, team, cleanups);
  core.ingest(create, "local");
  (core as unknown as { log: Logger }).log = spy;
  const kira = tnode("kira");
  core.emit("team.member", { login: kira.login, handle: "kira", role: "member" });
  core.emit("team.node", { node_id: kira.keys.nodeId, login: kira.login, hostname: kira.hostname, pubkey: kira.keys.pubkey, ip: "127.0.0.1", revoked: false });
  const caller: MemberRec = { login: kira.login, handle: "kira", role: "member" };
  let entries: VaultEntry[] = [entry({ policy: "shared", share_with: ["kira"] })];
  let sharing = true;
  let room: number | null = 90;
  const d = {
    vault: { list: () => entries, claudeToken: async () => { during({ core, kira, setEntries: (e) => { entries = e; }, setSharing: (v) => { sharing = v; }, setRoom: (v) => { room = v; } }); return TOKEN; } },
    sharing: () => sharing, roomLeft: () => room, nonces: new NonceBook(),
  };
  const clock = now();
  try {
    const r = await grantLease(core, d, kira.keys.nodeId, caller, req({ ts: clock }), clock);
    return `GRANTED owner=${r.owner}`;
  } catch (err) {
    const e = err as { code?: string; status?: number; message?: string };
    return `REFUSED ${e.code} ${e.status} ${e.message}`;
  }
}

test("control: nothing changes during the vault read -> granted", async () => {
  const r = await scenario(() => undefined);
  expect(r.startsWith("GRANTED")).toBe(true);
});

test("caller made an observer during the vault read -> not_allowed", async () => {
  const r = await scenario(({ core, kira }) => { core.emit("team.member", { login: kira.login, handle: "kira", role: "observer" }); });
  expect(r).toMatch(/^REFUSED not_allowed 403/);
});

test("vault sharing turned off during the vault read -> refused", async () => {
  const r = await scenario(({ setSharing }) => setSharing(false));
  expect(r).toMatch(/^REFUSED not_allowed/);
});

test("account policy changed shared -> own during the vault read -> not_allowed", async () => {
  const r = await scenario(({ setEntries }) => setEntries([entry({ policy: "own", share_with: [] })]));
  expect(r).toMatch(/^REFUSED not_allowed/);
});

test("caller taken off the share list during the vault read -> not_allowed", async () => {
  const r = await scenario(({ setEntries }) => setEntries([entry({ policy: "shared", share_with: [] })]));
  expect(r).toMatch(/^REFUSED not_allowed/);
});

test("caller removed during the vault read -> refused", async () => {
  const r = await scenario(({ core, kira }) => { core.emit("team.member", { login: kira.login, handle: "kira", role: "removed" }); });
  expect(r.startsWith("REFUSED")).toBe(true);
});

test("account removed from the vault during the read -> not_found", async () => {
  const r = await scenario(({ setEntries }) => setEntries([]));
  expect(r).toMatch(/^REFUSED not_found 404/);
});

// Codex pre.12 audit SHOULD 2 and 3: the rest of what the hand-out was judged on is judged again after the read too.
test("account removed and added again under the same id during the read (a new credential generation) -> not handed out", async () => {
  const r = await scenario(({ setEntries }) => setEntries([entry({ policy: "shared", share_with: ["kira"], gen: "g2" })]));
  expect(r).toMatch(/^REFUSED unavailable 503 the account was replaced while it was being read/);
});

test("a usage reading that crosses its person's 10% reserve during the read -> reserved", async () => {
  const r = await scenario(({ setRoom }) => setRoom(8));
  expect(r).toMatch(/^REFUSED reserved 409/);
});

test("the usage reading lost during the read -> reserved (it cannot be checked)", async () => {
  const r = await scenario(({ setRoom }) => setRoom(null));
  expect(r).toMatch(/^REFUSED reserved 409/);
});

test("this machine no longer a member when the read returns -> not handed out", async () => {
  // The roster can't remove a team's only owner, so the lender's own record going away is simulated directly.
  const r = await scenario(({ core }) => { (core as unknown as { me: () => null }).me = () => null; });
  expect(r).toMatch(/^REFUSED not_ready 409/);
});

test("the Claude token's expiry pulled in during the read -> expired", async () => {
  const r = await scenario(({ setEntries }) => setEntries([entry({ policy: "shared", share_with: ["kira"], expires_at: 1 })]));
  expect(r).toMatch(/^REFUSED expired 409/);
});
