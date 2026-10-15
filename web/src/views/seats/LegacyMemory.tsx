import { useState } from "react";
import { api, friendlyError } from "../../api/client.ts";

const CONFIRM = "delete legacy memory";

/** An authenticated dashboard session is required to delete quarantined notes. */
export function LegacyMemory() {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { deleted } = await api.deleteLegacyMemory(CONFIRM);
      setResult(`${deleted} quarantined legacy note${deleted === 1 ? "" : "s"} deleted.`);
      setTyped("");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  return <article className="seat-host-card" aria-labelledby="legacy-memory-title">
    <h2 className="int-title" id="legacy-memory-title">Legacy memory</h2>
    <p className="field-hint">Notes from a machine with one recorded holder are assigned to that person automatically. Notes with uncertain ownership stay hidden and can only be deleted.</p>
    <label htmlFor="legacy-memory-confirm">Type “{CONFIRM}” to delete quarantined notes</label>
    <input id="legacy-memory-confirm" value={typed} onChange={(event) => setTyped(event.currentTarget.value)} disabled={busy} autoComplete="off" />
    <button type="button" className="btn btn-sm" disabled={busy || typed !== CONFIRM} onClick={() => void remove()}>Delete quarantined notes</button>
    {result && <p role="status">{result}</p>}
    {error && <p className="int-error" role="alert">{error}</p>}
  </article>;
}
