import type { ComputeDeps } from './deps.js';

/** UTC-day accrued compute estimate, including ended and uncertain rentals; never customer-facing. */
export async function checkProviderSpend(d: ComputeDeps): Promise<void> {
  const now = d.now(), day = Math.floor(now / 86_400_000) * 86_400_000;
  const rentals = await d.store.tx(t => t.rentalsSince(day));
  const totals = new Map<string, number>();
  for (const r of rentals) {
    const provider = r.safety?.provider ?? d.config.tiers[r.tier].provider;
    if (provider === 'fake' || r.started_at === null) continue;
    const cost = r.safety?.cost_per_hour_micros ?? d.config.tiers[r.tier].cost_per_hour_micros;
    const ms = Math.max(0, Math.min(r.ended_at ?? now, now) - Math.max(r.started_at, day));
    totals.set(provider, (totals.get(provider) ?? 0) + cost * ms / 3_600_000 / 1_000_000);
  }
  const threshold = d.spendAlertUsdPerDay ?? 50;
  for (const [provider, cost] of totals) if (cost > threshold) {
    d.log('provider_spend', { provider, day, cost_usd: Math.round(cost * 100) / 100, threshold_usd: threshold });
  }
}
