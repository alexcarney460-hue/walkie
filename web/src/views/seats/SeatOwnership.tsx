import type { SeatsLocalView } from "../../api/types.ts";

const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const names = (users: readonly string[]): string => `${users.slice(0, 5).join(", ")}${users.length > 5 ? " …" : ""}`;

/**
 * WALK-103: which Walkie on this machine owns its seat users (the root-owned record setup-user writes), the helper's
 * list when it can't be read, seat users this Walkie leaves alone, and leftovers that still run. Shown whether seats are
 * on or off: these matter most when someone wonders why seat users stay.
 */
export function SeatOwnership({ local }: { local: SeatsLocalView }) {
  const foreign = local.foreign_users ?? [];
  const running = local.leftovers_running ?? [];
  if (!local.seat_scope && !local.reconcile_error && !foreign.length && !running.length) return null;
  return (
    <div className="seat-ownership">
      {local.seat_scope && (
        <p className={local.seat_scope.state === "other" ? "int-error" : "field-hint"} role={local.seat_scope.state === "other" ? "alert" : undefined}>
          {cap(local.seat_scope.why)}.
        </p>
      )}
      {local.reconcile_error && (
        <p className="int-error" role="alert">New seat users wait: the seat users the helper still holds couldn't be listed ({local.reconcile_error}). Walkie asks again every 30 s.</p>
      )}
      {foreign.length ? (
        <p className="field-hint">
          {foreign.length} seat user{foreign.length === 1 ? "" : "s"} here {foreign.length === 1 ? "isn't" : "aren't"} this Walkie's to remove (made before this update, or by another Walkie on this machine): <span className="mono">{names(foreign)}</span>. Walkie leaves {foreign.length === 1 ? "it" : "them"} and every process of {foreign.length === 1 ? "it" : "them"} as they are{local.seat_scope?.state === "other" ? "" : <>; after <span className="mono">walkie seats setup-user --apply</span> and a restart of Walkie, it removes them once nothing of them runs</>}.
        </p>
      ) : null}
      {running.length ? (
        <p className="int-error" role="alert">
          {running.length} leftover seat user{running.length === 1 ? "" : "s"} still {running.length === 1 ? "runs" : "run"} processes no current seat started (<span className="mono">{names(running)}</span>): each holds a seat slot until they end, then Walkie removes it. To end them now: <span className="mono">sudo pkill -KILL -u {running[0]}</span>.
        </p>
      ) : null}
    </div>
  );
}
