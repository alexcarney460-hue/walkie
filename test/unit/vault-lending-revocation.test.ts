// WALK-74 (ASYNC-PERMS-1) review round: who a vault account is lent to is judged in one place (lending) for hand-outs,
// readiness probes and borrowed-usage refreshes. An observer (or removed member) named in a shared account's list gets
// none of the three; the company pool's own revocations (the pool turned off, the account made personal) end a
// borrower's refreshes; a refusal is logged once while it lasts. The borrower's running seat learns of a pool
// revocation from the holder's advertised badge (planSeatAccount, what its account watcher re-plans every 10 s).
import { afterEach, describe, expect, test } from "bun:test";
import type { VaultSource } from "../../src/accounts/service.ts";
import type { VaultEntry } from "../../src/accounts/vault/vault.ts";
import { ephemeralKey } from "../../src/accounts/vault/seal.ts";
import type { Core } from "../../src/daemon/core.ts";
import type { Logger } from "../../src/daemon/logger.ts";
import type { MemberRec } from "../../src/daemon/roster.ts";
import { planSeatAccount } from "../../src/daemon/seats/account.ts";
import { grantLease, NonceBook, probeLease, refreshBorrowedUsage } from "../../src/daemon/vault-lease.ts";
import type { AccountView, TeamPolicy } from "../../src/protocol/accounts.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const TOKEN = ("sk" + "-ant-oat01-FAKEHANDOUTTOKEN0123456789abcdefghijk");
const A = "a".repeat(24);
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const kira: MemberRec = { login: "kira@example.com", handle: "kira", role: "member" };
const olga: MemberRec = { login: "olga@example.com", handle: "olga", role: "observer" };

/** The lender (alex's machine, alex its person) with one Claude account the test re-shapes, and a log spy. */
function lender(entry: Partial<VaultEntry>, team: TeamPolicy = "per-account") {
  const alex = tnode("alex");
  const { team: id, create } = createTeam(alex);
  const core = makeCore(alex, id, cleanups);
  core.ingest(create, "local");
  const logs: Array<{ m: string } & Record<string, unknown>> = [];
  const log = (m: string, f?: Record<string, unknown>) => { logs.push({ m, ...f }); };
  (core as unknown as { log: Logger }).log = { debug: () => undefined, info: log, warn: log, error: log };
  const e = { id: A, provider: "claude", label: "Claude account", plan: null, policy: "own", share_with: [], created_at: 1, expires_at: null,
    home: null, linked: false, gen: "g1", ...entry } as VaultEntry;
  const source: VaultSource = { list: () => [e], claudeToken: async () => TOKEN };
  const d = { vault: source, sharing: true as boolean, teamPolicy: (): TeamPolicy => team, roomLeft: () => 50, nonces: new NonceBook() };
  return { core, d, e, logs };
}

function leaseReq() {
  const key = ephemeralKey();
  return { account: A, epk: key.publicKey, nonce: crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), ""), ts: now() };
}

async function probed(core: Core, d: ReturnType<typeof lender>["d"], caller: MemberRec): Promise<unknown> {
  // The first probe only warms the owner's readiness cache (one unavailable answer), the second answers.
  await probeLease(core, d, "node-x", caller, { account: A, provider: "claude" }, now()).catch(() => undefined);
  return probeLease(core, d, "node-x", caller, { account: A, provider: "claude" }, now()).then((r) => r, (e: { code?: string }) => ({ refused: e.code }));
}

describe("an observer named in a shared account's list", () => {
  test("control: a member named there gets the hand-out, a ready probe and usage refreshes", async () => {
    const { core, d } = lender({ policy: "shared", share_with: ["kira"] });
    expect((await grantLease(core, d, "node-kira", kira, leaseReq(), now())).owner).toBe("alex");
    expect(await probed(core, d, kira)).toEqual({ ready: true });
    const grant = core.vaultGrants.record(A, "node-kira", Date.now());
    core.vaultRefresh = () => undefined;
    expect(refreshBorrowedUsage(core, d, "node-kira", kira, { account: A, grant })).toEqual({ usage: null });
  }, 15_000);

  test("gets no hand-out", async () => {
    const { core, d, logs } = lender({ policy: "shared", share_with: ["olga"] });
    await expect(grantLease(core, d, "node-olga", olga, leaseReq(), now()))
      .rejects.toMatchObject({ status: 403, code: "not_allowed", message: "observers and removed members can't borrow accounts" });
    expect(logs.some((l) => l.m === "vault_lease_denied" && l.reason === "not_allowed" && l.to_handle === "olga")).toBe(true);
  });

  test("gets no ready probe", async () => {
    const { core, d, logs } = lender({ policy: "shared", share_with: ["olga"] });
    expect(await probed(core, d, olga)).toEqual({ refused: "unavailable" });
    expect(logs.some((l) => l.m === "vault_probe_denied" && l.reason === "not_allowed" && l.to_handle === "olga")).toBe(true);
  }, 15_000);

  test("gets no usage refresh, even with a grant from before it was made an observer", () => {
    const { core, d } = lender({ policy: "shared", share_with: ["olga"] });
    const grant = core.vaultGrants.record(A, "node-olga", Date.now());
    core.vaultRefresh = () => { throw new Error("must not refresh"); };
    expect(() => refreshBorrowedUsage(core, d, "node-olga", olga, { account: A, grant })).toThrow("this account is no longer lent to you");
  });
});

describe("the company pool's revocations end a borrower's usage refreshes (the pooled branch)", () => {
  // Policy "own": only the pool lends it to kira; her seat's reserve check is what refreshes (plan.pooled).
  const pooled = () => {
    const l = lender({ policy: "own" }, "company");
    const grant = l.core.vaultGrants.record(A, "node-kira", Date.now());
    let refreshes = 0;
    l.core.vaultRefresh = () => { refreshes++; };
    return { ...l, grant, refreshes: () => refreshes };
  };

  test("control: while the pool lends it, the refresh goes through", () => {
    const p = pooled();
    expect(refreshBorrowedUsage(p.core, p.d, "node-kira", kira, { account: A, grant: p.grant })).toEqual({ usage: null });
    expect(p.refreshes()).toBe(1);
  });

  for (const [what, revoke] of [
    ["the team's pool is turned off", (p: ReturnType<typeof pooled>) => { p.d.teamPolicy = () => "per-account"; }],
    ["its person makes the account personal", (p: ReturnType<typeof pooled>) => { (p.e as { personal?: boolean }).personal = true; }],
  ] as const) {
    test(`${what}: refused, logged once while it lasts, and logged again after it was lent again and then not`, () => {
      const p = pooled();
      revoke(p);
      for (let i = 0; i < 3; i++) expect(() => refreshBorrowedUsage(p.core, p.d, "node-kira", kira, { account: A, grant: p.grant })).toThrow("this account is no longer lent to you");
      expect(p.refreshes()).toBe(0);
      expect(p.logs.filter((l) => l.m === "vault_usage_denied")).toEqual([{ m: "vault_usage_denied", to_node: "node-kira", to_handle: "kira", reason: "not_allowed" }]);
      p.d.teamPolicy = () => "company";
      (p.e as { personal?: boolean }).personal = undefined;
      expect(refreshBorrowedUsage(p.core, p.d, "node-kira", kira, { account: A, grant: p.grant })).toEqual({ usage: null });
      revoke(p);
      expect(() => refreshBorrowedUsage(p.core, p.d, "node-kira", kira, { account: A, grant: p.grant })).toThrow("this account is no longer lent to you");
      expect(p.logs.filter((l) => l.m === "vault_usage_denied")).toHaveLength(2);
    });
  }

  test("a Codex entry this vault can't lease (no Codex access) is refused like a hand-out would be", () => {
    const p = pooled();
    (p.e as { provider: string }).provider = "codex";
    expect(() => refreshBorrowedUsage(p.core, p.d, "node-kira", kira, { account: A, grant: p.grant })).toThrow("this account is no longer lent to you");
    expect(p.logs.find((l) => l.m === "vault_usage_denied")?.reason).toBe("not_found");
  });
});

describe("the borrower's account watcher sees a pool revocation in the holder's badge", () => {
  const view = (vault: Record<string, unknown>): AccountView => ({
    key: `alex:${A}`, id: A, provider: "claude", label: "Claude account", plan: null, owners: ["alex"], claimed_by: [], usage: null, usage_host: null, last_seen: 0,
    machines: [{ node_id: "n-alex", hostname: "alex-mbp", handle: "alex", online: true, self: false, agents: [], usage: null, vault: { policy: "own", ...vault } }],
  } as unknown as AccountView);
  const plan = (v: AccountView, team: TeamPolicy) => planSeatAccount(`alex:${A}`, { runtime: "claude", me: "kira", launcher: "kira", vault: [], pooled: [v],
    pool: { team, roleOf: () => "member" } });

  test("pooled while lent; refused once the badge says the pool is off or the account is personal", () => {
    expect(plan(view({ company: true }), "company")).toMatchObject({ kind: "peer", node: "n-alex", pooled: true });
    expect(plan(view({}), "company")).toMatchObject({ kind: "refused" }); // the holder stopped advertising it to the pool
    expect(plan(view({ company: true }), "per-account")).toMatchObject({ kind: "refused" }); // this machine knows the pool is off
    expect(plan(view({ company: true, personal: true }), "company")).toMatchObject({ kind: "refused" });
  });
});
