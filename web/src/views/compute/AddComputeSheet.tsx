import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, Minus, Plus, X } from "lucide-react";
import {
  ComputeError, buyCredit, computeApi, computeStore, stopRental, tierName, useCompute,
  type ComputeState, type CreditBlock, type MachineAsk, type Quotes, type RentResult, type RentalView, type TierId,
} from "../../api/compute.ts";
import { ErrorState, SkeletonRows } from "../../components/primitives.tsx";
import { ACTIVE_STATES, CREDIT_BLOCKS, IDLE_MINUTES_DEFAULT, MAX_MACHINES_PER_REQUEST, usd } from "../../../../src/protocol/compute.ts";

export type Counts = Readonly<Partial<Record<TierId, number>>>;

/** Machines asked for, in catalogue order, without zero counts. */
export function asksFrom(quotes: Quotes, counts: Counts): MachineAsk[] {
  return quotes.tiers.flatMap((t) => ((counts[t.id] ?? 0) > 0 ? [{ tier: t.id, count: counts[t.id] as number }] : []));
}

/** What the asked machines cost per hour together (prices only). */
export function hourlyTotal(quotes: Quotes, counts: Counts): number {
  return quotes.tiers.reduce((sum, t) => sum + t.price_per_hour_micros * (counts[t.id] ?? 0), 0);
}

export function totalCount(counts: Counts): number {
  return Object.values(counts).reduce<number>((a, b) => a + (b ?? 0), 0);
}

const STATE_LABEL: Record<RentalView["state"], string> = {
  queued: "Queued", needs_code: "Starting soon", starting: "Starting", running: "Running", stopping: "Stopping", ended: "Stopped", failed: "Failed",
};

export function rentalStateLabel(r: RentalView): string {
  return r.state === "queued" && r.queue_position ? `Queued · #${r.queue_position}` : STATE_LABEL[r.state];
}

function errorText(err: unknown): string {
  if (err instanceof ComputeError) {
    if (err.code === "insufficient_credit") {
      return err.neededMicros !== undefined
        ? `Not enough credit: these machines need ${usd(err.neededMicros)} for their first hour${err.balanceMicros !== undefined ? ` and the balance is ${usd(err.balanceMicros)}` : ""}. Buy credit, then rent.`
        : "Not enough credit for the first hour of these machines. Buy credit, then rent.";
    }
    if (err.code === "account_frozen") return "Renting is paused on this team's account. Contact Walkie support.";
    if (err.code === "agent_admin_off") return "Agents can't rent machines here while agent admin is off.";
    if (err.code === "compute_not_configured") return "Rented machines aren't available yet.";
    return err.message;
  }
  return "Something went wrong. Try again.";
}

export interface AddComputeViewProps {
  quotes: Quotes;
  state: ComputeState;
  counts: Counts;
  onCount: (tier: TierId, n: number) => void;
  onRent: () => void;
  onBuy: (block: CreditBlock) => void;
  onStop: (r: RentalView) => void;
  busy: "rent" | "buy" | null;
  result: RentResult | null;
  error: string | null;
}

/** "Each machine includes 1,024 GiB of outbound data per 730 hours, prorated by rented hours, then $0.02 per GiB." (from the quote, prices only) */
export function egressLine(q: Quotes): string {
  return `Each machine includes ${q.egress_included_gib.toLocaleString("en-US")} GiB of outbound data per 730 hours, prorated by rented hours, then ${usd(q.egress_price_per_gib_micros)} per GiB.`;
}

/** The dialog body, without effects (render tests use it directly). Prices only: no cost, no provider, no instance type. */
export function AddComputeView({ quotes, state, counts, onCount, onRent, onBuy, onStop, busy, result, error }: AddComputeViewProps) {
  if (quotes.available !== true) return <p>Rented machines are currently unavailable. Existing rentals can still be stopped from Machines.</p>;
  const n = totalCount(counts);
  const hourly = hourlyTotal(quotes, counts);
  const short = n > 0 && state.balance_micros < hourly;
  const frozen = state.status === "frozen";
  const pending = state.rentals.filter((r) => ACTIVE_STATES.has(r.state));
  return (
    <div className="ac-body">
      <div className="ac-credit" data-testid="ac-credit">
        <div className="ac-balance">
          <span className="ac-balance-label">Credit</span>
          <b className="tnum">{usd(state.balance_micros)}</b>
          <span className="muted tnum">
            {state.hours_left !== null ? `about ${state.hours_left < 10 ? state.hours_left.toFixed(1) : Math.floor(state.hours_left)} h left at ${usd(state.burn_per_hour_micros)}/h` : "nothing running"}
          </span>
        </div>
        <div className="ac-buy" role="group" aria-label="Buy credit">
          <span className="ac-buy-label">Buy credit</span>
          {CREDIT_BLOCKS.map((b) => (
            <button key={b} type="button" className="btn btn-sm" disabled={busy !== null || frozen} onClick={() => onBuy(b)}>
              ${b.toLocaleString("en-US")}
            </button>
          ))}
        </div>
      </div>

      <ul className="ac-tiers" aria-label="Machines to rent">
        {quotes.tiers.map((t) => {
          const c = counts[t.id] ?? 0;
          return (
            <li key={t.id} className={c > 0 ? "ac-tier is-on" : "ac-tier"} data-testid={`ac-tier-${t.id}`}>
              <div className="ac-tier-text">
                <h3 className="ac-tier-name">{t.name}</h3>
                <p className="ac-tier-specs mono">{t.specs}</p>
                {t.gpu && <p className="ac-tier-gpu">{t.gpu}</p>}
                <p className="ac-tier-good">{t.good_for}</p>
              </div>
              <div className="ac-tier-side">
                <span className="ac-price"><b className="tnum">{usd(t.price_per_hour_micros)}</b><span className="muted">/h</span></span>
                <span className="ac-price-month muted tnum">{usd(t.price_per_month_micros)}/month</span>
                {t.min_minutes > 1 && <span className="ac-price-min muted" data-testid={`ac-min-${t.id}`}>{t.min_minutes}-minute minimum</span>}
                <div className="ac-step" role="group" aria-label={`${t.name} count`}>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm" disabled={c === 0} onClick={() => onCount(t.id, c - 1)} aria-label={`Fewer ${t.name}`}>
                    <Minus size={13} strokeWidth={2} aria-hidden="true" />
                  </button>
                  <output className="ac-step-n tnum" aria-live="polite">{c}</output>
                  <button type="button" className="btn btn-ghost btn-icon btn-sm" disabled={c >= MAX_MACHINES_PER_REQUEST || n >= MAX_MACHINES_PER_REQUEST} onClick={() => onCount(t.id, c + 1)} aria-label={`More ${t.name}`}>
                    <Plus size={13} strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="ac-egress muted" data-testid="ac-egress">{egressLine(quotes)}</p>

      <div className="ac-total">
        <span className="tnum" data-testid="ac-total">
          {n === 0 ? "Pick at least one machine" : `${n} machine${n === 1 ? "" : "s"} · ${usd(hourly)}/h`}
        </span>
        <button type="button" className="btn btn-primary" disabled={n === 0 || short || frozen || busy !== null} onClick={onRent}>
          {busy === "rent" ? "Renting…" : n > 1 ? `Rent ${n} machines` : "Rent"}
        </button>
      </div>
      {short && (
        <p className="ac-short" role="note" data-testid="ac-short">
          Needs {usd(hourly)} of credit for the first hour; the balance is {usd(state.balance_micros)}.
        </p>
      )}
      {frozen && <p className="ac-short" role="note">Renting is paused on this team&rsquo;s account. Contact Walkie support.</p>}
      {error && <p className="ac-error" role="alert">{error}</p>}
      {result && (
        <p className="ac-result" role="status" data-testid="ac-result">
          {result.started} started, {result.queued} queued. {result.queued > 0 ? "Queued machines start as soon as there's room. " : ""}They join the team as your machines, with seats on.
        </p>
      )}
      <p className="field-hint">
        Credit is used per minute while a machine runs. Machines stop when credit reaches $0, and after {IDLE_MINUTES_DEFAULT} minutes
        with no agent or pool work. Stopping deletes the machine and its disk; unused credit stays on the account.
      </p>

      {pending.length > 0 && (
        <div className="ac-rentals">
          <h3 className="drawer-h">Your rented machines</h3>
          <ul className="ac-rental-list">
            {pending.map((r) => (
              <li key={r.id} className="ac-rental" data-testid={`ac-rental-${r.id}`}>
                <span className="mono">{r.name}</span>
                <span className="muted">{tierName(quotes, r.tier)} · {usd(r.price_per_hour_micros)}/h</span>
                <span className={`chip ac-state is-${r.state}`}>{rentalStateLabel(r)}</span>
                {r.state !== "stopping" && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onStop(r)} aria-label={`Stop ${r.name}`}>Stop</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * "Add compute" (RENT-2): rent machines by the hour from prepaid credit. Owners only (the Machines section and
 * Mission Control offer it). The machines join as the owner's, with seats on.
 */
export function AddComputeSheet({ onClose }: { onClose: () => void }) {
  const snap = useCompute(true);
  const [counts, setCounts] = useState<Counts>({});
  const [accountId, setAccountId] = useState<string | undefined>();
  const [busy, setBusy] = useState<"rent" | "buy" | null>(null);
  const [result, setResult] = useState<RentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<Element | null>(null);
  const close = useCallback(onClose, [onClose]);

  useEffect(() => {
    returnFocus.current = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      (returnFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [close]);

  const onCount = (tier: TierId, n: number) => { setResult(null); setCounts((c) => ({ ...c, [tier]: Math.max(0, Math.min(MAX_MACHINES_PER_REQUEST, n)) })); };
  const onRent = async () => {
    if (!snap.quotes) return;
    setBusy("rent"); setError(null); setResult(null);
    try {
      setResult(await computeApi.rent(asksFrom(snap.quotes, counts), undefined, accountId));
      setCounts({});
      computeStore.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const onBuy = async (block: CreditBlock) => {
    setBusy("buy"); setError(null);
    try { await buyCredit(block, undefined, accountId); } catch (err) { setError(errorText(err)); } finally { setBusy(null); }
  };
  const onStop = async (r: RentalView) => {
    setError(null);
    try { await stopRental(r.id, r.name); } catch (err) { setError(errorText(err)); }
  };
  const selected = snap.state?.accounts?.find(a => a.account_id === accountId) ?? snap.state?.accounts?.[0];
  const viewedState = snap.state && selected ? { ...snap.state, account_id: selected.account_id, status: selected.status,
    balance_micros: selected.balance_micros, burn_per_hour_micros: selected.burn_per_hour_micros,
    hours_left: selected.hours_left } : snap.state;

  return (
    <div className="drawer-layer">
      <div className="scrim" onClick={close} aria-hidden="true" />
      <aside className="drawer add-compute" role="dialog" aria-modal="true" aria-labelledby="ac-title">
        <header className="drawer-head">
          <div className="drawer-head-text">
            <div className="drawer-kicker"><span className="muted">Rented machines join as yours, with seats on</span></div>
            <h2 className="drawer-title" id="ac-title">Add compute</h2>
          </div>
          <button ref={closeRef} type="button" className="btn btn-ghost btn-icon" onClick={close} aria-label="Close">
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>
        <div className="drawer-body">
          {(snap.status === "idle" || snap.status === "loading") && <SkeletonRows rows={4} />}
          {snap.status === "error" && <ErrorState message={snap.error ?? "Couldn't load prices."} onRetry={() => computeStore.refresh()} />}
          {snap.status === "ready" && snap.quotes && snap.state && (
            snap.quotes.tiers.length === 0
              ? <p className="panel-empty">No machines are for rent right now.</p>
              : <>
                  {(snap.state.accounts?.length ?? 0) > 1 && <label className="field-hint">Compute account
                    <select value={selected?.account_id} onChange={e => setAccountId(e.target.value)} aria-label="Compute account">
                      {snap.state.accounts!.map(a => <option key={a.account_id} value={a.account_id}>{a.account_id} · {usd(a.balance_micros)}</option>)}
                    </select>
                  </label>}
                  <AddComputeView quotes={snap.quotes} state={viewedState!} counts={counts} onCount={onCount} onRent={() => void onRent()}
                    onBuy={(b) => void onBuy(b)} onStop={(r) => void onStop(r)} busy={busy} result={result} error={error ?? snap.error} />
                </>
          )}
        </div>
      </aside>
    </div>
  );
}

/** The button both views show to owners. */
export function AddComputeButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="btn btn-sm add-compute-btn" onClick={onOpen}>
      <Cpu size={13} strokeWidth={2} aria-hidden="true" />Add compute
    </button>
  );
}
