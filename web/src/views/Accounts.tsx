// Accounts page (ACCOUNTS-1 phase 1, ACCOUNTS-2): every provider account the team's agents run on, pooled across
// machines, with what is left of each usage window, limit resets (ACCOUNTS-RESET-1), which accounts are switchable (in
// a vault), the sessions running on each, and sessions still outside the switcher. Nothing here can move or change a
// login.
import { useMemo, useState } from "react";
import { AccountTile, inUse } from "../components/Accounts.tsx";
import { PageHeader } from "../components/Shell.tsx";
import { EmptyState } from "../components/primitives.tsx";
import { displayState, unswitchedSessions } from "../../../src/protocol/accounts-format.ts";
import { useNow } from "../lib/time.ts";
import { useStore } from "../state/store.tsx";

type Filter = "all" | "in-use" | "attention";
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "in-use", label: "In use" },
  { id: "attention", label: "Needs attention" },
];

export function Accounts() {
  const { accounts, agents } = useStore();
  const unswitched = useMemo(() => unswitchedSessions(agents, accounts), [agents, accounts]);
  const now = useNow();
  const [filter, setFilter] = useState<Filter>("all");
  const attention = (st: string) => st === "exhausted" || st === "relogin" || st === "stale";
  const shown = useMemo(() => accounts.filter((a) =>
    filter === "all" ? true : filter === "in-use" ? inUse(a) : attention(displayState(a.usage, now)),
  ), [accounts, filter, now]);
  const count = (f: Filter) => accounts.filter((a) => (f === "all" ? true : f === "in-use" ? inUse(a) : attention(displayState(a.usage, now)))).length;

  return (
    <div className="page accounts-page">
      <PageHeader
        title="Accounts"
        meta={<>{accounts.length} account{accounts.length === 1 ? "" : "s"} · {accounts.filter(inUse).length} in use · usage left per window</>}
      />
      <p className="acct-intro muted">
        Each machine reads the usage of the logins it holds and shares the numbers with the team; Walkie never refreshes a
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
      {accounts.length > 0 && (
        <div className="segmented acct-filter" role="radiogroup" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={filter === f.id} className={filter === f.id ? "seg is-on" : "seg"} onClick={() => setFilter(f.id)}>
              {f.label}
              <span className="seg-n tnum">{count(f.id)}</span>
            </button>
          ))}
        </div>
      )}
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
