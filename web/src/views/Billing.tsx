// Billing panel on the Team page: the team's plan (license, trial or Free), usage against its
// limits, upgrade/manage links to the site, and license activation for owners.
import { useState, type FormEvent } from "react";
import { ArrowUpRight, Check, Minus } from "lucide-react";
import { api, friendlyError } from "../api/client.ts";
import type { PlanView } from "../api/types.ts";
import { PLAN_LABEL, activationMessage, overLimit, planDeadline, safeExternalUrl, statusLabel, usage } from "../lib/plan.ts";
import { useActions } from "../state/store.tsx";

function Limit({ used, limit, unit }: { used: number; limit: number | null; unit: string }) {
  const over = limit !== null && used > limit;
  return (
    <span className={over ? "text-amber tnum" : "tnum"}>
      {limit === null ? `${used} ${unit} · unlimited` : `${usage(used, limit)} ${unit}`}
    </span>
  );
}

function Flag({ on, label }: { on: boolean; label: string }) {
  return (
    <li className={on ? "billing-flag" : "billing-flag is-off"}>
      {on ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : <Minus size={13} strokeWidth={2} aria-hidden="true" />}
      <span>{label}</span>
      <span className="sr-only">{on ? "included" : "not included"}</span>
    </li>
  );
}

function ExternalButton({ href, primary, children }: { href: string | null; primary?: boolean; children: string }) {
  if (!href) return null;
  return (
    <a className={`btn btn-sm ${primary ? "btn-primary" : ""}`} href={href} target="_blank" rel="noopener noreferrer">
      {children}<ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function ActivateForm() {
  const { refreshTeam } = useActions();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const k = key.trim();
    if (!k) { setError("Paste the activation code from your welcome page."); return; }
    setBusy(true); setError(null); setDone(null);
    try {
      setDone(activationMessage(await api.activateLicense(k)));
      setKey("");
      refreshTeam();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form billing-activate" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="lic-key">Activation code</label>
        <textarea id="lic-key" className="input mono billing-key" rows={2} value={key} spellCheck={false} autoComplete="off"
          onChange={(e) => setKey(e.target.value)} placeholder="eyJ2IjoyLCJraW5kIjoi…" aria-describedby="lic-key-hint" />
        <span id="lic-key-hint" className="field-hint">Same as <span className="mono">walkie license activate &lt;code&gt;</span>, and like it, a code is exchanged on the roster authority&apos;s dashboard. Renewals happen automatically.</span>
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn-sm" disabled={busy}>{busy ? "Activating…" : "Activate license"}</button>
        {done && <span className="form-flash" role="status">{done}</span>}
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
    </form>
  );
}

export function BillingPanel({ plan, owner }: { plan: PlanView; owner: boolean }) {
  const e = plan.entitlements;
  const deadline = planDeadline(plan);
  const upgrade = safeExternalUrl(plan.upgrade_url);
  const manage = plan.license ? safeExternalUrl(plan.manage_url) : null;
  const showUpgrade = plan.status !== "active";
  const interval = plan.license ? (plan.license.interval === "year" ? " · billed yearly" : " · billed monthly") : "";
  const status = statusLabel(plan);

  return (
    <div className="billing">
      <div className="billing-head">
        <span className="billing-plan">{PLAN_LABEL[plan.plan]}{plan.status === "trial" ? " trial" : ""}</span>
        {status && <span className={`chip ${plan.status === "grace" || overLimit(plan) ? "chip-amber" : ""}`}>{status}</span>}
      </div>
      <dl className="billing-rows">
        <div><dt>People</dt><dd><Limit used={plan.seats.used} limit={plan.seats.limit} unit={plan.status === "active" || plan.status === "grace" ? "seats" : "people"} /></dd></div>
        <div><dt>Machines</dt><dd><Limit used={plan.machines.used} limit={plan.machines.limit} unit="machines" /></dd></div>
        {deadline && <div><dt>{plan.status === "trial" ? "Trial" : "Term"}</dt><dd>{deadline}{interval}</dd></div>}
        {plan.license && <div><dt>Licensed to</dt><dd className="truncate">{plan.license.email}</dd></div>}
      </dl>
      {overLimit(plan) && (
        <p className="billing-note">You're over the {PLAN_LABEL[plan.plan]} limits. Nothing was removed: everyone and every machine keeps working, but adding more waits for an upgrade.</p>
      )}
      <ul className="billing-flags" aria-label="Included features">
        <Flag on={e.restricted_channels} label="Restricted channels" />
        <Flag on={e.integrations !== 0} label={e.integrations === null ? "All integrations" : `${e.integrations} integration${e.integrations === 1 ? "" : "s"}`} />
        <Flag on={e.join_approval} label="Join approval" />
        <Flag on={e.audit_export} label="Audit export" />
      </ul>
      <div className="form-actions">
        {showUpgrade && <ExternalButton href={upgrade} primary={!manage || plan.status !== "grace"}>Upgrade</ExternalButton>}
        <ExternalButton href={manage} primary={plan.status === "grace"}>Manage billing</ExternalButton>
      </div>
      {owner && <ActivateForm />}
    </div>
  );
}
