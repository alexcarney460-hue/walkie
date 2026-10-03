import { afterEach, expect, test } from "bun:test";
import type { VaultEntry } from "../../src/accounts/vault/vault.ts";
import type { TeamPolicy } from "../../src/protocol/accounts.ts";
import { memberByHandle, type MemberRec } from "../../src/daemon/roster.ts";
import { refreshBorrowedUsage } from "../../src/daemon/vault-lease.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, memberEv, nodeEv, tnode } from "../helpers/events.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()?.(); });

const account = "b".repeat(24);

/** The lender's machine (its person lena) with bob on the team, and a vault entry for `account` it can re-shape. */
function lender() {
  const a = tnode("alex"), l = tnode("lena"), b = tnode("bob"), { team, create } = createTeam(a);
  const core = makeCore(l, team, cleanup);
  feed(core, [create, memberEv(team, a, l, "owner"), nodeEv(team, a, l), memberEv(team, a, b, "member"), nodeEv(team, a, b)]);
  const entry = { id: account, provider: "claude", policy: "shared", share_with: ["bob"], personal: false } as unknown as VaultEntry;
  const d = { vault: { list: () => [entry] } as never, sharing: true as boolean, teamPolicy: (): TeamPolicy => "per-account" };
  const bob = memberByHandle(core.roster, "bob") as MemberRec;
  const self = memberByHandle(core.roster, "lena") as MemberRec;
  return { core, d, entry, bob, self, node: b.keys.nodeId };
}

test("usage refresh requires this borrower's account grant and is throttled", () => {
  const { core, d, self } = lender();
  const node = "c".repeat(16);
  const grant = core.vaultGrants.record(account, node, Date.now());
  let refreshes = 0;
  core.vaultRefresh = () => { refreshes++; };
  expect(() => refreshBorrowedUsage(core, d, "d".repeat(16), self, { account, grant })).toThrow("current account grant");
  expect(() => refreshBorrowedUsage(core, d, node, self, { account: "a".repeat(24), grant })).toThrow("current account grant");
  expect(refreshes).toBe(0);
  for (let i = 0; i < 10; i++) expect(refreshBorrowedUsage(core, d, node, self, { account, grant })).toEqual({ usage: null });
  expect(() => refreshBorrowedUsage(core, d, node, self, { account, grant })).toThrow("throttled");
  expect(refreshes).toBe(10);
});

// WALK-74 (ASYNC-PERMS-1): a grant made while the account was lent outlives the lending by a day; the refresh is
// judged against the account's policy as it is now. The control: still shared with bob, the refresh goes through.
test("control: an account still shared with the borrower refreshes", () => {
  const { core, d, bob, node } = lender();
  const grant = core.vaultGrants.record(account, node, Date.now());
  let refreshes = 0;
  core.vaultRefresh = () => { refreshes++; };
  expect(refreshBorrowedUsage(core, d, node, bob, { account, grant })).toEqual({ usage: null });
  expect(refreshes).toBe(1);
});

for (const [what, unlend] of [
  ["the owner stopped sharing it with bob", (l: ReturnType<typeof lender>) => { (l.entry as { share_with: string[] }).share_with = []; }],
  ["the owner turned vault sharing off", (l: ReturnType<typeof lender>) => { l.d.sharing = false; }],
  ["the owner made it local", (l: ReturnType<typeof lender>) => { (l.entry as { policy: string }).policy = "local"; }],
  ["the owner removed it from the vault", (l: ReturnType<typeof lender>) => { l.d.vault = { list: () => [] } as never; }],
] as const) {
  test(`a grant made while lent, then ${what}: the refresh is refused with the reason and logged`, () => {
    const l = lender();
    const grant = l.core.vaultGrants.record(account, l.node, Date.now());
    let refreshes = 0;
    l.core.vaultRefresh = () => { refreshes++; };
    const warns: Array<[string, Record<string, unknown> | undefined]> = [];
    (l.core.log as { warn: (msg: string, fields?: Record<string, unknown>) => void }).warn = (msg, fields) => { warns.push([msg, fields]); };
    unlend(l);
    expect(() => refreshBorrowedUsage(l.core, l.d, l.node, l.bob, { account, grant })).toThrow("this account is no longer lent to you: its owner changed who may use it");
    expect(refreshes).toBe(0);
    expect(warns).toEqual([["vault_usage_denied", { to_node: l.node, to_handle: "bob", reason: what.includes("removed") ? "not_found" : "not_allowed" }]]);
  });
}
