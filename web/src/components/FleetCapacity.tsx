// WALK-65: free seats and what limits them, per machine. The same pure function the daemon summarizes. The badge is
// hidden until the seat hosts have loaded, so a machine whose cap this viewer cannot see is not flashed as "no seats"
// before that answer arrives. Once it has, a host this viewer is not a member of shows "seats hidden" instead of a
// free-seat count. A missing host (no seats agent) stays "limited by seats". The badge shows the raw reading; the
// owner-only schedule summary is what holds a limit across a noisy threshold.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { AccountView, NodeView, SeatsView } from "../api/types.ts";
import { api } from "../api/client.ts";
import { bestAccountRoom, factorLabel, fleetCapacity, type FleetCapacity, type LimitingFactor } from "../../../src/protocol/fleet-capacity.ts";
import { loadUnknown } from "../../../src/protocol/machine-stats.ts";

const SeatSnapshotContext = createContext<SeatsView | null | undefined>(undefined);

/** Tests pass a fixed seats view. A page that is not wrapped loads its own, and never a module-level cache. */
export function SeatSnapshotProvider({ seats, children }: { seats: SeatsView | null; children: ReactNode }) {
  return <SeatSnapshotContext.Provider value={seats}>{children}</SeatSnapshotContext.Provider>;
}

const SEAT_REFRESH_MS = 15_000;
const ACTIVE_SEAT = new Set(["running", "paused", "queued"]);

/** The latest seat hosts, or null until the first answer. An injected snapshot wins and does not fetch. */
export function useSeatSnapshot(): SeatsView | null {
  const injected = useContext(SeatSnapshotContext);
  const [loaded, setLoaded] = useState<SeatsView | null>(null);
  useEffect(() => {
    if (injected !== undefined) return;
    let stop = false;
    const load = () => {
      api.seats().then((view) => { if (!stop) setLoaded(view); }).catch(() => { if (!stop) setLoaded(null); });
    };
    load();
    const timer = setInterval(load, SEAT_REFRESH_MS);
    return () => { stop = true; clearInterval(timer); };
  }, [injected]);
  return injected === undefined ? loaded : injected;
}

/** The poll's own inputs: seat host cap, seats in flight, CPU, memory, an unknown load, and the roomiest account. */
export function capacityForMachine(node: NodeView, accounts: readonly AccountView[], seats: SeatsView, now: number): FleetCapacity {
  const host = seats.hosts.find((h) => h.node === node.node_id);
  const active = seats.seats.filter((s) => s.host.node === node.node_id && ACTIVE_SEAT.has(s.state)).length;
  const sys = node.stats?.sys;
  const load = sys && typeof sys.load1 === "number" && sys.cpus > 0 ? (sys.load1 / sys.cpus) * 100 : null;
  const cpu = sys?.cpu_busy_pct ?? load;
  const mem = node.stats?.mem;
  return fleetCapacity({
    online: node.online,
    seats: host ? { allows: host.allows, max: host.availability?.max ?? null, active } : null,
    ...(mem ? { mem: { pressure: mem.pressure, free: mem.free ?? null } } : {}),
    cpuBusyPct: typeof cpu === "number" ? cpu : null,
    loadUnknown: loadUnknown(node.stats),
    accountRoomPct: bestAccountRoom(accounts, node.node_id, now),
  });
}

function badgeText(cap: FleetCapacity): string {
  if (cap.score > 0) return `${cap.free_slots} free`;
  if (cap.limiting_factor === "offline") return "Offline";
  if (cap.limiting_factor === "load_unknown") return "Load unknown";
  return `Limited by ${factorLabel(cap.limiting_factor)}`;
}

function tone(cap: FleetCapacity, muted: boolean): string {
  if (muted) return "is-muted";
  if (cap.score > 0) return "is-open";
  return cap.limiting_factor === "offline" ? "is-offline" : "is-blocked";
}

/** One machine's capacity. `seats` null (still loading, or the request failed) renders nothing. */
export function FleetCapacityBadge({ node, accounts, seats, now }: {
  node: NodeView; accounts: readonly AccountView[]; seats: SeatsView | null; now: number;
}) {
  if (!seats) return null;
  const host = seats.hosts.find((h) => h.node === node.node_id);
  // member is false only when the host is listed and this viewer is not on its seats channel.
  const hidden = !!host && host.member !== true;
  const cap = capacityForMachine(node, accounts, seats, now);
  const limit: LimitingFactor = cap.limiting_factor;
  const seatsOnly = hidden && limit === "seats";
  const free = hidden ? "seats hidden" : cap.free_slots === 1 ? "1 free seat" : `${cap.free_slots} free seats`;
  const label = seatsOnly ? "Seats hidden" : badgeText(cap);
  const name = seatsOnly
    ? `${node.hostname}: seats hidden`
    : `${node.hostname}: score ${cap.score} of 100, ${free}, limited by ${factorLabel(limit)}`;
  return (
    <span
      role="img"
      className={`cap-badge ${tone(cap, seatsOnly)}`}
      data-testid={`capacity-${node.hostname}`}
      aria-label={name}
    >
      <span className="cap-badge-label">{label}</span>
      {seatsOnly ? null : <span className="cap-badge-score tnum">{cap.score}</span>}
    </span>
  );
}
