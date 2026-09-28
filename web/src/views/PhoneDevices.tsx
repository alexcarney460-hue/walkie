// Team → Devices (WALKIE-PWA-1): pair a phone with a one-time QR code, and see or sign out paired phones. The phone
// app talks to this computer through an end-to-end encrypted relay link; the QR code's secret is the only key to it.
import { useCallback, useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import { api, friendlyError } from "../api/client.ts";
import type { MobileStatus, PairView } from "../api/types.ts";
import { ErrorState, RelTime, SkeletonRows } from "../components/primitives.tsx";

/** SVG path for the dark modules (one 1×1 square each), offset by the quiet zone. */
export function qrPath(rows: readonly string[], quiet = 4): string {
  let d = "";
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "1") d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  });
  return d;
}

export function QrCode({ rows, size = 208 }: { rows: readonly string[]; size?: number }) {
  const n = rows.length + 8;
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${n} ${n}`} role="img" aria-label="QR code for the pairing link" shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={qrPath(rows)} fill="#000" />
    </svg>
  );
}

function PairPanel({ pair, onDone }: { pair: PairView; onDone: () => void }) {
  const [left, setLeft] = useState(() => Math.max(0, pair.expires_at - Date.now()));
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, pair.expires_at - Date.now())), 1_000);
    return () => clearInterval(t);
  }, [pair.expires_at]);
  if (left === 0) return <p className="panel-empty">That code expired. <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>Close</button></p>;
  const mins = Math.floor(left / 60_000);
  const secs = Math.floor((left % 60_000) / 1000).toString().padStart(2, "0");
  return (
    <div className="phone-pair">
      <QrCode rows={pair.qr} />
      <ol className="phone-steps">
        <li>Scan it with your phone's camera and open the link.</li>
        <li>iPhone: tap Share, then Add to Home Screen, open Walkie there and paste the code.</li>
      </ol>
      <div className="phone-code">
        <code className="mono">{pair.code}</code>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => { void navigator.clipboard?.writeText(pair.code).then(() => setCopied(true), () => undefined); }}>{copied ? "Copied" : "Copy code"}</button>
      </div>
      <p className="field-hint">One use, expires in <span className="tnum">{mins}:{secs}</span>. Anyone with this code can pair a phone to you until then: don't share it.</p>
      <button type="button" className="btn btn-sm btn-ghost" onClick={onDone}>Done</button>
    </div>
  );
}

export function PhoneDevices() {
  const [status, setStatus] = useState<MobileStatus | null>(null);
  const [pair, setPair] = useState<PairView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api.mobile());
      setError(null);
    } catch (err) {
      // An older daemon (404) has no phone support: leave the section out.
      if ((err as { status?: number }).status === 404) setHidden(true); else setError(friendlyError(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // While a code is showing, watch for the phone to appear.
  useEffect(() => {
    if (!pair) return;
    const before = status?.devices.length ?? 0;
    const t = setInterval(async () => {
      const s = await api.mobile().catch(() => null);
      if (!s) return;
      setStatus(s);
      if (s.devices.length > before) setPair(null);
      else if (s.notice && s.pairing === 0) { setPair(null); setError(s.notice); } // the relay withdrew the code
    }, 2_000);
    return () => clearInterval(t);
  }, [pair]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try { setPair(await api.mobilePair()); } catch (err) { setError(friendlyError(err)); } finally { setBusy(false); }
  };
  const revoke = async (id: string, name: string) => {
    if (!window.confirm(`Sign out ${name}? It will need a new pairing code to connect again.`)) return;
    try { await api.mobileRevoke(id); await load(); } catch (err) { setError(friendlyError(err)); }
  };

  if (hidden) return null;
  if (!status && error) return <ErrorState compact message={error} onRetry={() => void load()} />;
  if (!status) return <SkeletonRows rows={1} />;
  return (
    <div className="phone-devices">
      <p className="panel-empty">Mission Control, asks and posts on your phone, end-to-end encrypted to this computer. Nothing to install but the web app.</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      {!error && status.notice && <p className="field-error" role="status">{status.notice}</p>}
      {pair
        ? <PairPanel pair={pair} onDone={() => { setPair(null); void load(); }} />
        : <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start()}><Smartphone size={14} strokeWidth={1.75} aria-hidden="true" />{busy ? "Opening…" : "Pair a phone"}</button>}
      {status.devices.length > 0 && (
        <ul className="phone-list">
          {status.devices.map((d) => (
            <li key={d.id} className="phone-row">
              <span className="phone-name">{d.name} <span className="mono muted">{d.id}</span></span>
              <span className="muted">paired <RelTime ts={d.created_at} long /> · last used <RelTime ts={d.last_seen} long /></span>
              <button type="button" className="btn btn-sm btn-danger" onClick={() => void revoke(d.id, d.name)}>Sign out</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
