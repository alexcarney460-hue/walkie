// Accounts page (ACCOUNTS-1 phase 1, ACCOUNTS-2): every provider account the team's agents run on, pooled across
// machines, with what is left of each usage window, limit resets (ACCOUNTS-RESET-1), which accounts are switchable (in
// a vault), the sessions running on each, and sessions still outside the switcher. Nothing here can move or change a
// login.
import { useMemo, useState } from "react";
import { AccountTile, effectiveAccountState, type BadgeState } from "../components/Accounts.tsx";
import { PoolBanner, PoolPanel } from "../components/AccountsPool.tsx";
import { RememberedDetails } from "../components/RememberedDetails.tsx";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { PageHeader } from "../components/Shell.tsx";
import { EmptyState } from "../components/primitives.tsx";
import { clockAvailability, resetText, unswitchedSessions, usageUntil } from "../../../src/protocol/accounts-format.ts";
import { useNow } from "../lib/time.ts";
import { useStore } from "../state/store.tsx";

type Filter = "all" | BadgeState;

export function accountSummary(accounts: Readonly<ReturnType<typeof useStore>["accounts"]>, now: number) {
  const count = (state: BadgeState) => accounts.filter((account) => effectiveAccountState(account, now) === state).length;
  const reset = accounts.filter((account) => effectiveAccountState(account, now) === "exhausted")
    .map((account) => {
      const availability = clockAvailability(account.clock, account.usage, now);
      return availability.kind === "exhausted" ? availability.until : usageUntil(account.usage);
    })
    .filter((value): value is number => value !== null && value > now).sort((a, b) => a - b)[0];
  return { room: count("ok"), exhausted: count("exhausted"), relogin: count("relogin"), stale: count("stale"), unknown: count("unknown"), likely: count("likely"), reset };
}

export function orderedAccounts(accounts: Readonly<ReturnType<typeof useStore>["accounts"]>, now: number) {
  const priority = (state: string) => state === "relogin" ? 0 : state === "exhausted" ? 1 : state === "stale" ? 2 : 3;
  return [...accounts].sort((a, b) => priority(effectiveAccountState(a, now)) - priority(effectiveAccountState(b, now)));
}

export function Accounts() {
  const { accounts, agents, nodes, accountsPool } = useStore();
  const unswitched = useMemo(() => unswitchedSessions(agents, accounts), [agents, accounts]);
  const now = useNow();
  const [filter, setFilter] = useState<Filter>("all");
  const summary = accountSummary(accounts, now);
  const shown = useMemo(() => orderedAccounts(accounts.filter((a) =>
    filter === "all" ? true : effectiveAccountState(a, now) === filter,
  ), now), [accounts, filter, now]);

  return (
    <div className="page accounts-page">
      <PageHeader
        title="Accounts"
        meta={<><button type="button" onClick={() => setFilter("all")}>{accounts.length} login{accounts.length === 1 ? "" : "s"}</button>
          {summary.room > 0 && <> · <button type="button" onClick={() => setFilter("ok")}>{summary.room} have room</button></>}
          {summary.exhausted > 0 && <> · <button type="button" onClick={() => setFilter("exhausted")}>{summary.exhausted} at {summary.exhausted === 1 ? "its" : "their"} limit{summary.reset ? ` (usable again ${resetText(summary.reset, now).replace("resets ", "")})` : ""}</button></>}
          {summary.relogin > 0 && <> · <button type="button" onClick={() => setFilter("relogin")}>{summary.relogin} needs signing in again</button></>}
          {summary.stale > 0 && <> · <button type="button" onClick={() => setFilter("stale")}>{summary.stale} stale</button></>}
          {summary.unknown > 0 && <> · <button type="button" onClick={() => setFilter("unknown")}>{summary.unknown} unknown</button></>}
          {summary.likely > 0 && <> · <button type="button" onClick={() => setFilter("likely")}>{summary.likely} likely available</button></>}
        </>}
      />
      <RememberedDetails id="accounts-sharing" summary="How accounts are shared">
      <ErrorBoundary scope="item" name="Accounts banner" resetKeys={[accountsPool]}><PoolBanner pool={accountsPool} /></ErrorBoundary>
      <p className="acct-intro muted">
        Each machine reads the usage of the logins it holds and shares the numbers with the team; Sqwakie never refreshes a
        token. The one action here is using a limit reset, after you confirm, on a login this machine holds. Accounts
        marked Switchable are in their owner's vault: sessions started with <code>walkie claude</code> /
        <code>walkie codex</code> (or the shims) switch when an account hits its limit and resume on one with room.
      </p>
      {unswitched.length > 0 && (
        <div className="acct-note" role="status">
          <strong>{unswitched.length} session{unswitched.length === 1 ? "" : "s"} outside the switcher:</strong>{" "}
          {unswitched.slice(0, 6).map((u) => `${u.handle}/${u.hostname} · ${u.agent}`).join(", ")}
          {unswitched.length > 6 ? ` and ${unswitched.length - 6} more` : ""}. Restart them to enable switching.
        </div>
      )}
      {accounts.length > 0 && <PoolPanel accounts={accounts} nodes={nodes} pool={accountsPool} now={now} />}
      </RememberedDetails>
      {accounts.length === 0 ? (
        <EmptyState title="No accounts recorded yet">
          <p>An account appears as soon as a Claude Code, Codex, Kimi or Grok session runs on a teammate's machine. Its usage is read on that machine and shared here.</p>
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title="Nothing matches">
          <button type="button" className="btn btn-sm" onClick={() => setFilter("all")}>Show all</button>
        </EmptyState>
      ) : (
        <div className="acct-grid">
          {shown.map((a) => <AccountTile key={a.key} account={a} now={now} />)}
        </div>
      )}
    </div>
  );
}
