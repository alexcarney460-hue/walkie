/** The local daemon's worst observed event-loop delay in the last minute. */
export interface LocalLag { max_ms: number; at: number }

export function LocalLagBanner({ lag, now }: { lag: LocalLag | null; now: number }) {
  if (!lag || lag.max_ms <= 2_000 || lag.at > now || now - lag.at >= 60_000) return null;
  const seconds = Math.round(lag.max_ms / 1_000);
  return <p className="local-lag-banner" role="status" data-testid="local-lag-banner">
    Walkie on this machine is lagging (stalled {seconds} s); machine states may be stale
  </p>;
}
