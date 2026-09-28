// COMPANY POOL / RESET-CLOCK-1 on the Accounts page: the team accounts policy, which machine uses which account right
// now, when the next account frees (from the remembered reset times, counting down live), and a suggested split of
// seats over the pooled logins. Read-only: nothing here moves a login.
import type { AccountsPool, AccountView, NodeView } from "../api/types.ts";
import { absTime, fullTime, PROVIDER_NAME, resetText } from "../../../src/protocol/accounts-format.ts";
import { DEFAULT_SEAT_CAP, fleetView, nextFreeByProvider, splitLogin, suggestSplit, type SplitResult } from "../../../src/protocol/fleet.ts";
import { DEFAULT_TEAM_POLICY, PERSONAL_RESERVE_PCT } from "../../../src/protocol/pool-rules.ts";
import { useState } from "react";
import { load, save } from "../lib/storage.ts";

interface Props { accounts: readonly AccountView[]; nodes: readonly NodeView[]; pool: AccountsPool | null; now: number }

function Countdown({ at, now }: { at: number; now: number }) {
  return <time dateTime={new Date(at).toISOString()} title={fullTime(at)}>{resetText(at, now).replace("resets ", "")} ({absTime(at, now)})</time>;
}

function SplitLine({ provider, split }: { provider: string; split: SplitResult }) {
  const busy = split.machines.filter((m) => m.seats.length);
  if (!busy.length) return null;
  return (
    <li>
      <span className="acct-pool-k">{PROVIDER_NAME[provider as keyof typeof PROVIDER_NAME] ?? provider}</span>{" "}
      {busy.map((m, i) => (
        <span key={m.node_id}>
          {i > 0 ? " · " : ""}
          <span className="mono">{m.hostname}</span> {m.seats.map((s) => `${s.seats} × ${s.label}${s.plan ? ` (${s.plan})` : ""}`).join(", ")}
        </span>
      ))}
    </li>
  );
}

export function PoolPanel({ accounts, nodes, pool, now }: Props) {
  const policy = pool?.policy ?? DEFAULT_TEAM_POLICY;
  const fleet = fleetView(accounts, policy, now);
  const pooled = policy === "company" ? accounts.filter((a) => a.machines.some((m) => m.vault?.company && !m.vault.personal)) : [];
  const direct = fleet.machines.flatMap((m) => m.accounts.filter((a) => a.agents.length).map((a) => ({ host: m.hostname, agents: a.agents, label: a.label, owner: a.owner })));
  const using = [
    ...fleet.using_now.map((u) => ({ key: `${u.hostname}|${u.agent ?? ""}|${u.key}`, host: u.hostname, who: u.agent ?? u.handle, label: u.label, owner: u.owner, via: "switched" as const })),
    ...direct.map((d) => ({ key: `${d.host}|${d.agents.join(",")}|${d.label}`, host: d.host, who: d.agents.join(", "), label: d.label, owner: d.owner, via: "own login" as const })),
  ];
  const frees = nextFreeByProvider(accounts, now);
  const machines = nodes.map((n) => ({ node_id: n.node_id, hostname: n.hostname, handle: n.handle, online: n.self || n.online, cap: DEFAULT_SEAT_CAP }));
  const providers = [...new Set(pooled.map((a) => a.provider))];
  const splits = providers.map((p) => ({ provider: p, split: suggestSplit(machines, accounts.filter((a) => a.provider === p).map((a) => splitLogin(a, policy, now))) }));
  return (
    <section className="acct-pool" aria-label="Company pool">
      <header className="acct-pool-head">
        <h2 className="acct-pool-title">Company pool</h2>
        <span className={`chip acct-pool-policy${policy === "company" ? " is-on" : ""}`}>{policy === "company" ? "On" : "Off"}</span>
      </header>
      <p className="muted acct-pool-intro">
        {policy === "company"
          ? `${pooled.length} login${pooled.length === 1 ? "" : "s"} pooled: any machine of the team leases them from the machine that holds them (never a copy of the login). The last ${PERSONAL_RESERVE_PCT}% of each is kept for its person.`
          : "Off: each login's own policy applies (a team owner turns the pool on with walkie accounts pool on)."}
        {pool?.by ? ` Set by @${pool.by}.` : ""}
      </p>
      <ul className="acct-pool-list">
        {Object.entries(frees).map(([provider, f]) => f && (
          <li key={provider} role="status">
            <span className="acct-pool-k">Next {PROVIDER_NAME[provider as keyof typeof PROVIDER_NAME] ?? provider} frees</span>{" "}
            <Countdown at={f.at} now={now} /> · <span className="mono">{f.label}</span>
          </li>
        ))}
        {using.length > 0 && (
          <li>
            <span className="acct-pool-k">In use now</span>
            <ul className="acct-pool-uses" aria-label="Which machine uses which account now">
              {using.slice(0, 12).map((u) => (
                <li key={u.key}>
                  <span className="mono">{u.host}</span> <span className="muted">{u.who}</span> → <span className="mono">{u.label}</span>
                  {u.via === "switched" && <span className="muted"> · leased</span>}
                </li>
              ))}
              {using.length > 12 && <li className="muted">and {using.length - 12} more</li>}
            </ul>
          </li>
        )}
        {splits.length > 0 && <li className="acct-pool-split-h"><span className="acct-pool-k">Suggested split</span> <span className="muted">(seats per login per machine, {DEFAULT_SEAT_CAP} per machine)</span></li>}
        {splits.map((s) => <SplitLine key={s.provider} provider={s.provider} split={s.split} />)}
      </ul>
    </section>
  );
}

const SEEN_KEY = "walkie.poolNoticeSeen";

/**
 * COMPANY POOL: the notice each member gets when an owner turns the team's pool on (shown on every page until
 * dismissed, once per time it was turned on). Nothing is pooled before that.
 */
export function PoolBanner({ pool }: { pool: AccountsPool | null }) {
  const [seen, setSeen] = useState(() => load<number>(SEEN_KEY, 0));
  if (!pool || pool.policy !== "company" || pool.at === null || seen >= pool.at) return null;
  const dismiss = () => { save(SEEN_KEY, pool.at); setSeen(pool.at as number); };
  return (
    <div className="acct-note acct-note-info pool-banner" role="status">
      <strong>The company account pool is on</strong>{pool.by ? ` (turned on by @${pool.by})` : ""}: every vault login not marked
      personal can be leased by every member's machines; the last {PERSONAL_RESERVE_PCT}% of each stays with its person. Keep one
      of yours out any time: <code>walkie accounts personal &lt;account&gt;</code>.{" "}
      <button type="button" className="btn btn-sm" onClick={dismiss}>Got it</button>
    </div>
  );
}

