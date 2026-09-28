// Limit resets on an account tile (ACCOUNTS-RESET-1). Codex: "Resets available: N" and a "Use a reset" button that
// asks first, then has THIS machine's daemon use one through the Codex CLI. Claude: its resets are used on claude.ai
// (Anthropic's help centre: Settings > Usage > "Reset for free"), so the button opens that page and Walkie re-reads the
// meter when the person comes back. Kimi and Grok have no resets. Agents can't reach any of this: the daemon serves
// the reset routes to a dashboard session only and refuses a request that names an agent.
import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountView, ResetAttemptView, ResetResult } from "../api/types.ts";
import { api, ApiError, friendlyError } from "../api/client.ts";
import {
  nextWindowReset, PROVIDER_NAME, RESET_REDEEM, resetOutcomeText, resetsDisplay, resetsText, USAGE_PAGE, type ResetsDisplay,
} from "../../../src/protocol/accounts-format.ts";
import { ResetSheetFlow, type PrepareReset, type UseReset } from "../lib/resets.ts";

type Note = { text: string; tone: "ok" | "bad" | "info" };

/** The resets row of a tile. `useReset` is injectable for tests; `initialSheet` renders the sheet open (tests). */
export function ResetsRow({ account: a, now, useReset = api.useReset, prepareReset = api.prepareReset, initialSheet = false }: {
  account: AccountView; now: number; useReset?: UseReset; prepareReset?: PrepareReset; initialSheet?: boolean;
}) {
  const d = resetsDisplay(a.usage);
  const how = RESET_REDEEM[a.provider];
  const page = USAGE_PAGE[a.provider];
  const here = a.machines.some((m) => m.self);
  const holder = a.machines.find((m) => m.online) ?? a.machines[0];
  const next = nextWindowReset(a.usage, now);
  // The count when the sheet opened: the sheet stays up (with its answer) when the meter updates underneath it.
  const [sheet, setSheet] = useState<Extract<ResetsDisplay, { kind: "available" }> | null>(initialSheet && d.kind === "available" ? d : null);
  const [note, setNote] = useState<Note | null>(null);
  const openedPage = useRef(false);

  // After the provider's page was opened: re-read the meter when the person comes back to this tab.
  useEffect(() => {
    if (how !== "web" || !here) return;
    const back = () => {
      if (!openedPage.current) return;
      openedPage.current = false;
      api.refreshAccount(a.id)
        .then((r) => setNote({ tone: "info", text: r.scheduled ? "Re-reading this account's usage now."
          : r.held ? "The provider asked Walkie to wait before reading usage again; the meter updates when it allows." : "Usage was re-read moments ago; the meter updates on the next reading." }))
        .catch((err) => setNote({ tone: "bad", text: friendlyError(err) }));
    };
    window.addEventListener("focus", back);
    return () => window.removeEventListener("focus", back);
  }, [how, here, a.id]);

  if (how === "none" && !page && d.kind === "not_reported") {
    return (
      <div className="acct-resets">
        <div className="acct-resets-line"><span className="acct-resets-n is-not_reported">{resetsText(a.provider, d)}</span></div>
      </div>
    );
  }

  return (
    <div className="acct-resets">
      <div className="acct-resets-line">
        <span className={`acct-resets-n is-${d.kind}`}>{resetsText(a.provider, d)}</span>
        {next && <span className="acct-resets-next muted tnum">{next}</span>}
      </div>
      {how === "walkie" && (here || d.kind === "available") && (here ? (
        <div className="acct-resets-act">
          <button type="button" className="btn btn-sm" disabled={d.kind !== "available"} onClick={() => { if (d.kind === "available") { setNote(null); setSheet(d); } }}>
            Use a reset
          </button>
          {d.kind === "available" && d.applicable === 0 && (
            <span className="acct-resets-hint muted">{PROVIDER_NAME[a.provider]} says this account's usage doesn't need a reset right now.</span>
          )}
        </div>
      ) : (
        <p className="acct-resets-hint muted">
          Use on {holder?.hostname ?? "the machine with this login"}: a reset is used from Walkie's dashboard on the machine that holds the login.
        </p>
      ))}
      {page && (
        <div className="acct-resets-act">
          <a className="btn btn-sm" href={page} target="_blank" rel="noopener noreferrer" onClick={() => { openedPage.current = true; }}>
            Open {PROVIDER_NAME[a.provider]} {how === "web" ? "usage page" : "page"}
          </a>
          <span className="acct-resets-hint muted">
            {how === "web"
              ? `${PROVIDER_NAME[a.provider]} resets are used on its own page (Settings › Usage › Reset for free), not in Walkie. ${here ? "Walkie re-reads this meter when you come back." : `Walkie on ${holder?.hostname ?? "that machine"} re-reads it within 5 minutes.`}`
              : `${PROVIDER_NAME[a.provider]} has no limit resets.`}
          </span>
        </div>
      )}
      {note && <p className={`acct-resets-note tone-${note.tone}`} role="status">{note.text}</p>}
      {sheet && (
        <ResetSheet account={a} resets={sheet} useReset={useReset} prepareReset={prepareReset} onClose={(n) => { setSheet(null); if (n) setNote(n); }} />
      )}
    </div>
  );
}

/**
 * "This uses 1 of N resets on <account>; it can't be undone." The daemon mints and binds the attempt when the sheet
 * opens; while an earlier try on this account is unconfirmed it hands that one back, and the sheet says so and waits
 * for usage to be read again before offering to try again (the same attempt, so never a second reset).
 */
export function ResetSheet({ account: a, resets, useReset, prepareReset = api.prepareReset, onClose, initialAttempt = null, initialSuperseded = false }: {
  account: AccountView; resets: Extract<ResetsDisplay, { kind: "available" }>; useReset: UseReset; prepareReset?: PrepareReset;
  onClose: (note: Note | null) => void;
  /** Tests: the attempt as already prepared, and whether another window already finished it. */
  initialAttempt?: ResetAttemptView | null;
  initialSuperseded?: boolean;
}) {
  // The attempt is pinned for the sheet's lifetime (lib/resets.ts ResetSheetFlow): retries never use a new id.
  const flow = useMemo(() => {
    const f = new ResetSheetFlow(a.id, { prepare: prepareReset, use: useReset });
    if (initialAttempt) f.onPrepared(initialAttempt);
    if (initialSuperseded) f.superseded = true;
    return f;
  }, [a.id]);
  const [prepared, setPrepared] = useState<ResetAttemptView | null>(initialAttempt);
  const [superseded, setSuperseded] = useState(initialSuperseded);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ResetResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ledgerBlocked, setLedgerBlocked] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const keepRef = useRef<HTMLButtonElement>(null);
  const shown = result ? resetOutcomeText(result) : null;
  const earlier = prepared?.earlier ?? null;
  const usageAt = a.usage?.at ?? 0;
  const others = a.machines.filter((m) => !m.self).map((m) => m.hostname);
  const accept = (v: ResetAttemptView) => {
    const r = flow.onPrepared(v);
    if (r === "accept") setPrepared(v);
    else if (r === "superseded") setSuperseded(true);
  };

  // Prepare on open, and again when a new reading arrives (an unconfirmed earlier try is re-checked against it).
  const settled = !!result && !["unconfirmed", "failed", "check_usage"].includes(result.outcome);
  useEffect(() => {
    if (settled) return;
    let live = true;
    prepareReset(a.id)
      .then((r) => { if (live) { setLedgerBlocked(null); accept(r.attempt); } })
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && err.code === "ledger_unreadable") setLedgerBlocked(err.message);
        else setError(friendlyError(err));
      });
    return () => { live = false; };
  }, [a.id, usageAt, result?.outcome, settled, prepareReset, round]);
  // An earlier try that usage was not re-read after: ask for a re-read now.
  // Codex's count needs a reading that starts 30 s after the try (REREAD_DELAY_MS): ask again until one lands.
  useEffect(() => {
    if (!earlier || earlier.reread) return;
    const ask = () => { api.refreshAccount(a.id).catch(() => undefined); };
    ask();
    const t = setInterval(ask, 35_000);
    return () => clearInterval(t);
  }, [a.id, earlier?.tried_at, earlier?.reread]);
  useEffect(() => { keepRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(shown && !shown.retry ? shown : null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, shown, onClose]);

  const go = () => {
    if (busy || superseded || !prepared) return;
    setBusy(true);
    setError(null);
    flow.confirm()
      .then((r) => { if (r === "superseded") setSuperseded(true); else setResult(r); })
      .catch((err) => {
        // An open attempt the daemon dropped (30 min unconfirmed by anyone): never replaced silently.
        if (err instanceof ApiError && err.code === "unknown_attempt") setSuperseded(true);
        else setError(friendlyError(err));
      })
      .finally(() => setBusy(false));
  };
  // A person checked usage: release the earlier attempt (or the unreadable ledger). Never a retry.
  const resolve = () => {
    if (busy) return;
    setBusy(true);
    api.resolveReset(a.id)
      .then(() => {
        if (ledgerBlocked) { setLedgerBlocked(null); setRound((n) => n + 1); return; }
        onClose({ tone: "info", text: resetOutcomeText({ outcome: "dismissed", left: null }).text });
      })
      .catch((err) => setError(friendlyError(err)))
      .finally(() => setBusy(false));
  };
  const done = shown !== null && !shown.retry && result?.outcome !== "check_usage";
  const waiting = !!earlier && !earlier.reread;
  const label = `${PROVIDER_NAME[a.provider]} ${a.label}`;
  const retrying = earlier !== null || flow.sent;

  return (
    <div className="sheet-layer" role="presentation">
      <div className="scrim" onClick={() => { if (!busy) onClose(done ? shown : null); }} />
      <section className="sheet acct-reset-sheet" role="dialog" aria-modal="true" aria-labelledby={`reset-h-${a.id}`} aria-describedby={`reset-d-${a.id}`}>
        <h2 className="sheet-title" id={`reset-h-${a.id}`}>Use a reset?</h2>
        <p id={`reset-d-${a.id}`}>
          This uses 1 of {resets.n} reset{resets.n === 1 ? "" : "s"} on <strong className="mono">{label}</strong>; it can't be undone.
        </p>
        <p className="muted">Codex refills this account's limits; your weekly reset day stays the same.</p>
        {others.length > 0 && (
          <p className="acct-resets-note tone-info">
            This login is also on {others.join(", ")}. A reset used there counts against the same account, and Walkie can't
            coordinate the two machines.
          </p>
        )}
        {earlier && !result && (
          <p className="acct-resets-note tone-bad" role="status">
            An earlier attempt may have gone through. Check usage before trying again.{" "}
            {waiting ? "Walkie is re-reading it now…" : `Usage was re-read: ${resetsText(a.provider, resetsDisplay(a.usage))}. Trying again repeats that same attempt, so it can't use a second reset.`}
          </p>
        )}
        {resets.applicable === 0 && !result && !earlier && (
          <p className="acct-resets-note tone-info">Codex says the usage doesn't need a reset right now. If so, nothing is used.</p>
        )}
        {prepared?.interrupted && !result && (
          <p className="acct-resets-note tone-info" role="status">The last try stopped before anything was sent to Codex. Nothing was used.</p>
        )}
        {superseded && (
          <p className="acct-resets-note tone-bad" role="alert">This attempt is no longer current (another window used it, or it expired). Close this and reopen it.</p>
        )}
        {ledgerBlocked && (
          <p className="acct-resets-note tone-bad" role="alert">
            {ledgerBlocked} Confirming lets resets through again for every Codex account on this machine.
          </p>
        )}
        {!prepared && !error && !superseded && !ledgerBlocked && <p className="muted" role="status">Preparing…</p>}
        {busy && <p className="muted" role="status">Using a reset…</p>}
        {shown && <p className={`acct-resets-note tone-${shown.tone}`} role="status">{shown.text}</p>}
        {error && <p className="acct-resets-note tone-bad" role="alert">{error}</p>}
        <div className="sheet-actions">
          {done ? (
            <button type="button" className="btn btn-primary" onClick={() => onClose(shown)}>Close</button>
          ) : (
            <>
              <button type="button" className="btn" ref={keepRef} disabled={busy} onClick={() => onClose(null)}>No, keep it</button>
              {(ledgerBlocked || earlier) && (
                <button type="button" className="btn" disabled={busy} onClick={resolve}>
                  {ledgerBlocked ? "I checked usage on all my Codex accounts" : "I checked usage"}
                </button>
              )}
              <button type="button" className="btn btn-primary" disabled={busy || !prepared || waiting || superseded || !!ledgerBlocked} onClick={go} {...(prepared ? { "data-request-id": prepared.id } : {})}>
                {retrying || shown?.retry || error ? "Try the same attempt again" : "Yes, use a reset"}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
