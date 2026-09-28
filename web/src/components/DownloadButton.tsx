import { useState } from "react";
import { Download } from "lucide-react";
import { api, friendlyError } from "../api/client.ts";

/**
 * Downloads an artifact with the dashboard session header (SEC-COOKIE-2: a plain link would carry no credential).
 * A failure is shown on the button, which retries on the next click.
 */
export function DownloadButton({ hash, name, labelClass }: { hash: string; name: string; labelClass: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.download(hash, name);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn btn-sm" onClick={() => void run()} disabled={busy}
      aria-label={error ? `Download ${name} failed: ${error}. Retry` : `Download ${name}`} title={error ?? undefined}>
      <Download size={13} strokeWidth={1.75} aria-hidden="true" />
      <span className={labelClass}>{error ? "Retry" : "Download"}</span>
    </button>
  );
}
