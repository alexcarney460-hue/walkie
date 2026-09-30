// The PUBLIC tier catalogue for rental compute (docs/plans/RENT-1.md §3A.4, Alex's decisions): what a customer may
// see — tier id, name, specs, price and billing terms. Prices are fixed data here; they are NOT derived from any cost
// at runtime. Which provider, size, region and image back a tier, what it costs us, and our provider limits live only
// in the private control-plane config (private-config.ts, env COMPUTE_PRIVATE_CONFIG).
import type { QuoteTier, Quotes, TierId } from "./types.js";

export const HOURS_PER_MONTH = 730;
export const GIB = 1024 ** 3;
/** Outbound data included per rental per 730 hours of its life; beyond it, EGRESS_PRICE_PER_GIB_MICROS per GiB. */
export const EGRESS_INCLUDED_GIB = 1024;
export const EGRESS_PRICE_PER_GIB_MICROS = 20_000;

interface TierSpec {
  readonly id: TierId;
  readonly name: string;
  readonly specs: string;
  readonly gpu: string | null;
  readonly good_for: string;
  readonly price_per_hour_micros: number;
  /** Every start is billed at least this long (GPU machines: 5 minutes). */
  readonly min_minutes: number;
}

export const TIERS: readonly TierSpec[] = [
  {
    id: "agent", name: "Agent box", specs: "8 dedicated vCPU · 32 GB RAM · 100 GB disk", gpu: null, min_minutes: 1,
    good_for: "About 6-10 coding agents at once, with their builds and tests.",
    price_per_hour_micros: 750_000,
  },
  {
    id: "agent-xl", name: "Agent box XL", specs: "16 dedicated vCPU · 64 GB RAM · 200 GB disk", gpu: null, min_minutes: 1,
    good_for: "About 15-20 agents, or heavy builds (Rust, monorepos, browser tests).",
    price_per_hour_micros: 1_500_000,
  },
  {
    id: "gpu-20", name: "GPU 20 GB", specs: "8 vCPU · 32 GB RAM · 500 GB NVMe · Toronto", gpu: "NVIDIA RTX 4000 Ada 20 GB", min_minutes: 5,
    good_for: "One 20B-class open model at 4-bit (or 14B at 8-bit) for the team's pool.",
    price_per_hour_micros: 1_520_000,
  },
  {
    id: "gpu-48", name: "GPU 48 GB", specs: "8 vCPU · 64 GB RAM · 500 GB NVMe · Toronto", gpu: "NVIDIA L40S 48 GB", min_minutes: 5,
    good_for: "30B-class open models; a 70B model at 4-bit with a short context.",
    price_per_hour_micros: 3_140_000,
  },
  {
    id: "gpu-80", name: "GPU 80 GB", specs: "20 vCPU · 240 GB RAM", gpu: "NVIDIA H100 80 GB", min_minutes: 5,
    good_for: "70B-class open models at 4-bit with room for context.",
    price_per_hour_micros: 8_820_000,
  },
];

export const CREDIT_BLOCKS_USD = [50, 200, 1000] as const;
/** Credit must cover this many hours of every requested machine before a rent is accepted. */
export const MIN_HOURS_COVERED = 1;

export function tierSpec(id: TierId): TierSpec {
  const t = TIERS.find((x) => x.id === id);
  if (!t) throw new Error(`unknown tier ${id}`);
  return t;
}

export function quoteTier(t: TierSpec): QuoteTier {
  return {
    id: t.id, name: t.name, specs: t.specs, gpu: t.gpu, good_for: t.good_for,
    price_per_hour_micros: t.price_per_hour_micros,
    price_per_month_micros: t.price_per_hour_micros * HOURS_PER_MONTH,
    min_minutes: t.min_minutes,
  };
}

export function quotes(): Quotes {
  return {
    currency: "usd", tiers: TIERS.map(quoteTier), credit_blocks: [...CREDIT_BLOCKS_USD], min_hours_covered: MIN_HOURS_COVERED,
    egress_included_gib: EGRESS_INCLUDED_GIB, egress_price_per_gib_micros: EGRESS_PRICE_PER_GIB_MICROS,
  };
}
