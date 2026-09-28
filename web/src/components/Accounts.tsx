import { useState } from "react";
// Provider accounts (ACCOUNTS-1): neutral monogram icons, green meters of usage LEFT that fall as usage depletes
// (green ≥ 30 % left, amber 10–30 %, red < 10 %), reset countdowns, and the unknown / stale / exhausted / re-login states.
// Used by the Accounts page, the strip on Mission Control and the chip on agent cards.
import type { CSSProperties } from "react";
import type { AccountView, AccountWindow, AgentView } from "../api/types.ts";
import type { ResetClock } from "../../../src/protocol/accounts.ts";
import {
  absTime, clockAvailability, clockFor, clockRows, displayState, fullTime, initials as handleInitials, leftPct, mainWindows, meterLevel,
  PROVIDER_MONOGRAM, PROVIDER_NAME, reasonText, reloginStep, resetText, usageLine, usageUntil, windowLabel, windowResetAt, type Availability,
  type DisplayState,
} from "../../../src/protocol/accounts-format.ts";
import { hueFor } from "../lib/format.ts";
import { ResetsRow } from "./AccountResets.tsx";
import { ago, agoLong } from "../lib/time.ts";

/** What the tile's badge says: the reading's state, or what the remembered reset times say (RESET-CLOCK-1). */
type BadgeState = DisplayState | "likely";

const STATE_TEXT: Record<BadgeState, string> = {
  ok: "Live", stale: "Stale", unknown: "Unknown", exhausted: "Exhausted", relogin: "Needs re-login", likely: "Likely available",
};

/**
 * RESET-CLOCK-1: a limit whose reset passed with no reading since reads "Likely available", and a limit remembered from
 * an older reading still reads "Exhausted" while its reset is ahead. A re-login need always wins.
 */
function badgeState(state: DisplayState, avail: Availability): BadgeState {
  if (state === "relogin") return state;
  if (avail.kind === "available_unconfirmed") return "likely";
  if (avail.kind === "exhausted" && (state === "unknown" || state === "stale")) return "exhausted";
  return state;
}

/** A reset time that counts down live (the shared 1 s clock re-renders it) with the exact local time on hover. */
function ResetAt({ at, now, text }: { at: number; now: number; text?: string }) {
  return (
    <time dateTime={new Date(at).toISOString()} title={`${fullTime(at)}${at > now ? "" : " (passed)"}`}>
      {text ?? (at > now ? resetText(at, now) : `reset passed at ${absTime(at, now)}, not yet confirmed`)}
    </time>
  );
}

/**
 * The account an agent uses, by machine and agent name, with THAT machine's reading (ACCOUNTS-FIX-1, Codex 3): the
 * chip never shows a reading another machine reported.
 */
export function accountForAgent(accounts: readonly AccountView[], agent: Pick<AgentView, "node" | "agent">): AccountView | undefined {
  for (const a of accounts) {
    const m = a.machines.find((x) => x.node_id === agent.node && x.agents.includes(agent.agent));
    if (m) return { ...a, usage: m.usage ?? null, usage_host: m.usage ? m.hostname : null };
  }
  // ACCOUNTS-2: a session the switcher launched (a lease), possibly on a teammate's shared account: the pooled reading.
  return accounts.find((a) => (a.leases ?? []).some((l) => l.node_id === agent.node && l.agent === agent.agent));
}

const POLICY_TEXT = { local: "this machine only", own: "the owner's machines", shared: "shared" } as const;

/** ACCOUNTS-2: the account is in a vault (sessions can switch to it) and who may use it. */
function VaultLine({ account: a }: { account: AccountView }) {
  if (!a.vault) return null;
  const who = a.vault.policy === "shared" && a.vault.share_with?.length ? ` with ${a.vault.share_with.join(", ")}` : "";
  return (
    <p className="acct-vault">
      <span className="chip acct-vault-badge">Switchable</span>
      {/* COMPANY POOL: a pooled login travels as policy own + company. */}
      <span className="muted">{a.machines.some((m) => m.vault?.company) ? "company pool: every machine (leased)" : `${POLICY_TEXT[a.vault.policy]}${who}${a.machines.some((m) => m.vault?.personal) ? " · personal" : ""}`}</span>
    </p>
  );
}

/** ACCOUNTS-2: the wrapped sessions running on the account right now (team-wide). */
function LeaseList({ account: a, now }: { account: AccountView; now: number }) {
  const leases = a.leases ?? [];
  if (!leases.length) return null;
  return (
    <ul className="acct-leases" aria-label="Sessions on this account">
      {leases.slice(0, 8).map((l) => (
        <li key={`${l.node_id}:${l.agent ?? ""}:${l.since}`}>
          <span className="mono truncate">{l.handle}/{l.hostname}{l.agent ? ` · ${l.agent}` : ""}</span>
          <span className="muted tnum">{agoLong(l.since, now)}</span>
        </li>
      ))}
      {leases.length > 8 && <li className="muted">+{leases.length - 8} more</li>}
    </ul>
  );
}

export function inUse(a: AccountView): boolean {
  return a.machines.some((m) => m.agents.length > 0);
}

/** The tighter of the 5-hour and weekly windows (what runs out first). */
export function tightest(a: AccountView): AccountWindow | undefined {
  const ws = mainWindows(a.usage);
  return [ws.session, ws.weekly, ...ws.model].filter((w): w is AccountWindow => !!w).sort((x, y) => leftPct(x) - leftPct(y))[0];
}

/** Neutral monogram for the provider (no logos) with the owner's initials. */
export function AccountIcon({ account, size = 30 }: { account: AccountView; size?: number }) {
  const owner = account.owners[0] ?? "?";
  const style = { width: size, height: size, "--own-h": hueFor(owner) } as CSSProperties;
  return (
    <span className={`acct-icon acct-p-${account.provider}`} style={style} aria-hidden="true">
      <span className="acct-mono">{PROVIDER_MONOGRAM[account.provider]}</span>
      <span className="acct-owner">{handleInitials(owner)}</span>
    </span>
  );
}

function levelOf(state: DisplayState, w: AccountWindow | undefined): string {
  if (state === "unknown" || state === "relogin" || !w) return "lv-none";
  return `lv-${meterLevel(leftPct(w))}${state === "stale" ? " is-stale" : ""}`;
}

/**
 * One window as a meter of what is LEFT (role=meter, aria values). `thin`: the model-scoped weekly bar. `remembered`:
 * the window's last reported reset (RESET-CLOCK-1), which keeps counting down when there is no current reading.
 */
export function UsageMeter({ account, window: w, label, now, thin, compact, remembered }: {
  account: AccountView; window: AccountWindow | undefined; label: string; now: number; thin?: boolean; compact?: boolean;
  remembered?: ResetClock;
}) {
  const state = displayState(account.usage, now);
  const known = !!w && state !== "unknown" && state !== "relogin";
  const left = known ? leftPct(w) : 0;
  const resetAt = w ? windowResetAt(account.clock, w) : remembered?.resets_at ?? null;
  const reset = resetText(resetAt, now);
  const foot = resetAt !== null
    ? <ResetAt at={resetAt} now={now} />
    : known ? " " : state === "unknown" ? (remembered ? "reset time not reported" : "no reading") : " ";
  const valueText = known ? `${left}% left${reset ? `, ${reset}` : ""}${state === "stale" ? " (stale)" : ""}` : "unknown";
  return (
    <div className={`acct-meter ${levelOf(state, w)}${thin ? " is-thin" : ""}${compact ? " is-compact" : ""}`}>
      {!compact && (
        <div className="acct-meter-head">
          <span className="acct-meter-label">{label}</span>
          <span className="acct-meter-val tnum">{known ? `${left}% left` : "—"}</span>
        </div>
      )}
      <div
        className="acct-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={left} aria-valuetext={valueText}
        aria-label={`${PROVIDER_NAME[account.provider]} ${account.label}: ${label} usage left`}
      >
        <span className="acct-fill" style={{ width: `${left}%` }} />
      </div>
      {!compact && (!thin || (!known && resetAt !== null)) && <div className="acct-meter-foot tnum">{foot}</div>}
    </div>
  );
}

function StateBadge({ state }: { state: BadgeState }) {
  return <span className={`acct-state acct-state-${state}`}>{STATE_TEXT[state]}</span>;
}

/** A full tile: icon, label, plan, where it's logged in, meters and state. */
export function AccountTile({ account: a, now }: { account: AccountView; now: number }) {
  const state = displayState(a.usage, now);
  const avail = clockAvailability(a.clock, a.usage, now);
  const badge = badgeState(state, avail);
  const ws = mainWindows(a.usage);
  const remembered = (kind: ResetClock["kind"]) => clockFor(a.clock, { kind, scope: null });
  // RESET-CLOCK-1: model windows remembered from an older reading (no current one lists them).
  const modelRows = ws.model.length ? [] : clockRows(a.clock, now).filter((r) => r.kind === "weekly_model");
  const agents = a.machines.reduce((n, m) => n + m.agents.length, 0);
  const host = a.usage_host ?? a.machines[0]?.hostname ?? "the machine with this login";
  return (
    <article className={`acct-tile is-${badge}${agents ? "" : " is-idle"}`} data-provider={a.provider} aria-label={`${PROVIDER_NAME[a.provider]} account ${a.label}: ${STATE_TEXT[badge]}`}>
      <header className="acct-tile-head">
        <AccountIcon account={a} size={34} />
        <div className="acct-tile-id">
          <span className="acct-tile-name">
            <span className="acct-provider">{PROVIDER_NAME[a.provider]}</span>
            {a.plan && <span className="chip acct-plan">{a.plan}</span>}
          </span>
          <span className="acct-label mono truncate" title={a.label}>{a.label}</span>
        </div>
        <StateBadge state={badge} />
      </header>
      <ul className="acct-machines">
        {a.machines.map((m) => (
          <li key={m.node_id} className={m.online ? "" : "is-off"}>
            <span className={`dot ${m.online ? "dot-on" : "dot-off"}`} aria-hidden="true" />
            <span className="mono truncate">{m.handle}/{m.hostname}</span>
            <span className="muted tnum">{m.online ? (m.agents.length ? `${m.agents.length} agent${m.agents.length === 1 ? "" : "s"}` : "idle") : "offline"}</span>
          </li>
        ))}
      </ul>
      {state === "relogin" ? (
        <div className="acct-note acct-note-bad" role="status">
          <strong>Login expired.</strong> {reloginStep(a.provider, host)}.
        </div>
      ) : (
        <div className="acct-meters">
          {state === "exhausted" && (
            <div className="acct-note acct-note-bad" role="status">
              <strong>Limit reached.</strong>{" "}
              {usageUntil(a.usage) !== null
                ? <>Usable again <ResetAt at={usageUntil(a.usage) as number} now={now} text={resetText(usageUntil(a.usage) as number, now).replace("resets ", "")} />.</>
                : "Reset time not reported."}
            </div>
          )}
          {state !== "exhausted" && avail.kind === "exhausted" && (
            <div className="acct-note acct-note-bad" role="status">
              <strong>Limit reached</strong> (last known).{" "}
              {avail.until !== null ? <>Usable again <ResetAt at={avail.until} now={now} text={resetText(avail.until, now).replace("resets ", "")} />.</> : "Reset time not reported."}
            </div>
          )}
          {avail.kind === "available_unconfirmed" && (
            <div className="acct-note acct-note-info" role="status">
              <strong>Should be available again</strong> (not yet confirmed). The limit reset at{" "}
              <ResetAt at={avail.since} now={now} text={absTime(avail.since, now)} />; no reading since.
            </div>
          )}
          {(ws.session || !ws.weekly) && <UsageMeter account={a} window={ws.session} label={ws.session ? windowLabel(ws.session) : "5-hour"} now={now} remembered={remembered("session")} />}
          {(ws.weekly || !ws.session) && <UsageMeter account={a} window={ws.weekly} label="Weekly" now={now} remembered={remembered("weekly")} />}
          {ws.model.map((w) => <UsageMeter key={w.scope ?? "model"} account={a} window={w} label={windowLabel(w)} now={now} thin />)}
          {modelRows.map((r) => (
            <UsageMeter key={r.scope ?? "model"} account={a} window={undefined} label={r.label} now={now} thin remembered={clockFor(a.clock, r)} />
          ))}
        </div>
      )}
      <ResetsRow account={a} now={now} />
      <VaultLine account={a} />
      <LeaseList account={a} now={now} />
      {a.claimed_by.length > 0 && (
        <p className="acct-claim muted">Also reported by {a.claimed_by.join(", ")}: unverified, shown separately.</p>
      )}
      <footer className="acct-tile-foot muted">
        {state === "unknown" && a.usage && a.usage.state !== "unknown"
          ? `No current reading: the last one is ${ago(a.usage.at, now)} old, from ${a.usage_host ?? "?"}.`
          : state === "unknown"
          ? `Usage unknown: ${reasonText(a.usage?.reason ?? null)}.`
          : a.usage
            ? `${state === "stale" ? "Stale: last reading" : "Updated"} ${agoLong(a.usage.at, now)} from ${a.usage_host ?? "?"}${a.usage.source === "session" ? " (session file)" : a.usage.source === "log" ? " (CLI log)" : ""}.`
            : "No reading yet."}
      </footer>
    </article>
  );
}

/** Compact: icon + label + mini meters (5-hour, weekly). For the Mission Control strip. */
export function AccountMini({ account: a, now }: { account: AccountView; now: number }) {
  const state = displayState(a.usage, now);
  const ws = mainWindows(a.usage);
  return (
    <a href="#/accounts" className={`acct-mini is-${state}${inUse(a) ? "" : " is-idle"}`} data-provider={a.provider} title={`${PROVIDER_NAME[a.provider]} ${a.label} (${a.owners.join(", ")}): ${usageLine(a, now)}`}>
      <AccountIcon account={a} size={30} />
      <span className="acct-mini-body">
        <span className="acct-mini-top">
          <span className="acct-mini-name truncate">{PROVIDER_NAME[a.provider]} <span className="mono muted">{a.label}</span></span>
          {state !== "ok" && <StateBadge state={state} />}
        </span>
        <span className="acct-mini-bars">
          {/* The windows the provider reports (Codex may report only the weekly one); both, unknown, when none. */}
          {(ws.session || !ws.weekly) && <span className="acct-mini-row"><span className="acct-mini-k">5h</span><UsageMeter account={a} window={ws.session} label="5-hour" now={now} compact /></span>}
          {(ws.weekly || !ws.session) && <span className="acct-mini-row"><span className="acct-mini-k">wk</span><UsageMeter account={a} window={ws.weekly} label="Weekly" now={now} compact /></span>}
        </span>
      </span>
    </a>
  );
}

/** On an agent card: which account it runs on and what is left of its tightest window (`labelled`: with its label). */
export function AccountChip({ account: a, now, labelled }: { account: AccountView; now: number; labelled?: boolean }) {
  const state = displayState(a.usage, now);
  const w = tightest(a);
  const known = !!w && state !== "unknown" && state !== "relogin";
  const left = known ? leftPct(w) : null;
  return (
    <span className={`acct-chip is-${state} ${levelOf(state, w)}`} data-provider={a.provider} title={`${PROVIDER_NAME[a.provider]} ${a.label}: ${usageLine(a, now)}`}>
      <span className="acct-chip-mono" aria-hidden="true">{PROVIDER_MONOGRAM[a.provider]}</span>
      {labelled && <span className="acct-chip-label mono truncate" aria-hidden="true">{a.label}</span>}
      <span className="acct-chip-bar" aria-hidden="true"><span className="acct-fill" style={{ width: `${left ?? 0}%` }} /></span>
      <span className="tnum">{state === "relogin" ? "re-login" : state === "exhausted" ? "0%" : left === null ? "?" : `${left}%`}</span>
      <span className="sr-only">{` ${PROVIDER_NAME[a.provider]} account ${a.label}, ${usageLine(a, now)}`}</span>
    </span>
  );
}

/** Mission Control: every account at a glance, the ones in use first. */
export function AccountsStrip({ accounts, now }: { accounts: readonly AccountView[]; now: number }) {
  if (!accounts.length) return null;
  const sorted = [...accounts].sort((x, y) => Number(inUse(y)) - Number(inUse(x)));
  const used = accounts.filter(inUse).length;
  return (
    <section className="acct-strip" aria-labelledby="acct-strip-h">
      <h2 className="section-title" id="acct-strip-h">
        Accounts <span className="section-count tnum">{used} in use of {accounts.length}</span>
        <a className="acct-strip-all" href="#/accounts">All accounts</a>
      </h2>
      <div className="acct-strip-list">
        {sorted.slice(0, 12).map((a) => <AccountMini key={a.key} account={a} now={now} />)}
      </div>
    </section>
  );
}

/**
 * Mission Control, below the feed (LIVE-2): every account as one compact row of chips, the ones in use first; a click
 * opens the full grid of meters (AccountsStrip's), and closes it again.
 */
export function AccountsRow({ accounts, now }: { accounts: readonly AccountView[]; now: number }) {
  const [open, setOpen] = useState(false);
  if (!accounts.length) return null;
  const sorted = [...accounts].sort((x, y) => Number(inUse(y)) - Number(inUse(x)));
  const used = accounts.filter(inUse).length;
  return (
    <section className={`acct-row${open ? " is-open" : ""}`} aria-labelledby="acct-row-h">
      <h2 className="section-title" id="acct-row-h">
        Accounts <span className="section-count tnum">{used} in use of {accounts.length}</span>
        <a className="acct-strip-all" href="#/accounts">All accounts</a>
      </h2>
      <button
        type="button" className="acct-row-toggle" aria-expanded={open} aria-controls="acct-row-grid" onClick={() => setOpen((o) => !o)}
        data-testid="accounts-row"
      >
        {open ? (
          <span className="acct-row-less">Show less</span>
        ) : (
          <span className="acct-row-list">
            {sorted.map((a) => <AccountChip key={a.key} account={a} now={now} labelled />)}
            <span className="acct-row-more">Meters</span>
          </span>
        )}
      </button>
      {open && (
        <div className="acct-strip-list" id="acct-row-grid">
          {sorted.map((a) => <AccountMini key={a.key} account={a} now={now} />)}
        </div>
      )}
    </section>
  );
}
