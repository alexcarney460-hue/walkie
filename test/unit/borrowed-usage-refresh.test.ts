import { afterEach, expect, test } from "bun:test";
import { refreshBorrowedUsage } from "../../src/daemon/vault-lease.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, tnode } from "../helpers/events.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()?.(); });

test("usage refresh requires this borrower's account grant and is throttled", () => {
  const a = tnode("owner"), { team } = createTeam(a);
  const core = makeCore(a, team, cleanup);
  const account = "b".repeat(24), node = "c".repeat(16);
  const grant = core.vaultGrants.record(account, node, Date.now());
  let refreshes = 0;
  core.vaultRefresh = () => { refreshes++; };
  expect(() => refreshBorrowedUsage(core, "d".repeat(16), { account, grant })).toThrow("current account grant");
  expect(() => refreshBorrowedUsage(core, node, { account: "a".repeat(24), grant })).toThrow("current account grant");
  expect(refreshes).toBe(0);
  for (let i = 0; i < 10; i++) expect(refreshBorrowedUsage(core, node, { account, grant })).toEqual({ usage: null });
  expect(() => refreshBorrowedUsage(core, node, { account, grant })).toThrow("throttled");
  expect(refreshes).toBe(10);
});
