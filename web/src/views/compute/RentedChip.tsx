import { useState } from "react";
import { stopRental, tierName, type Quotes, type RentalView } from "../../api/compute.ts";
import { usd } from "../../../../src/protocol/compute.ts";

/** "Rented · Agent box · $0.84/h" (prices only). */
export function rentedLabel(quotes: Quotes | null, r: RentalView): string {
  return `Rented · ${tierName(quotes, r.tier)} · ${usd(r.price_per_hour_micros)}/h`;
}

/**
 * On a machine that is a rental (RENT-2): the chip, and for owners a Stop button (confirm first; stopping deletes the
 * machine and its disk).
 */
export function RentedChip({ rental, quotes, canStop }: { rental: RentalView; quotes: Quotes | null; canStop: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stop = async () => {
    setBusy(true); setError(null);
    try { await stopRental(rental.id, rental.name); } catch { setError("Couldn't stop it. Try again."); } finally { setBusy(false); }
  };
  return (
    <span className="rented" data-testid={`rented-${rental.id}`}>
      <span className="chip chip-rented" title="A rented machine, paid from the team's compute credit">{rentedLabel(quotes, rental)}</span>
      {canStop && rental.state !== "stopping" && (
        <button type="button" className="btn btn-sm rented-stop" disabled={busy} onClick={() => void stop()} aria-label={`Stop ${rental.name}`}>
          {busy ? "Stopping…" : "Stop"}
        </button>
      )}
      {rental.state === "stopping" && <span className="muted">stopping…</span>}
      {error && <span className="text-red" role="alert">{error}</span>}
    </span>
  );
}
