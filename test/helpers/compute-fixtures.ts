// RENT-2 fixtures: the site's customer-facing shapes (prices only) for daemon and CLI tests.
import type { ComputeState, Quotes, RentalView } from "../../src/protocol/compute.ts";

export const QUOTES: Quotes = {
  available: true,
  currency: "usd",
  tiers: [
    { id: "agent", name: "Agent box", specs: "8 dedicated vCPU · 32 GB RAM · 100 GB disk", gpu: null, good_for: "About 6-10 coding agents at once, with their builds and tests.", price_per_hour_micros: 750_000, price_per_month_micros: 547_500_000, min_minutes: 1 },
    { id: "agent-xl", name: "Agent box XL", specs: "16 dedicated vCPU · 64 GB RAM · 200 GB disk", gpu: null, good_for: "About 15-20 agents, or heavy builds (Rust, monorepos, browser tests).", price_per_hour_micros: 1_500_000, price_per_month_micros: 1_095_000_000, min_minutes: 1 },
    { id: "gpu-20", name: "GPU 20 GB", specs: "8 vCPU · 32 GB RAM · 500 GB NVMe · Toronto", gpu: "NVIDIA RTX 4000 Ada 20 GB", good_for: "One 20B-class open model at 4-bit (or 14B at 8-bit) for the team's pool.", price_per_hour_micros: 1_520_000, price_per_month_micros: 1_109_600_000, min_minutes: 5 },
    { id: "gpu-48", name: "GPU 48 GB", specs: "8 vCPU · 64 GB RAM · 500 GB NVMe · Toronto", gpu: "NVIDIA L40S 48 GB", good_for: "30B-class open models; a 70B model at 4-bit with a short context.", price_per_hour_micros: 3_140_000, price_per_month_micros: 2_292_200_000, min_minutes: 5 },
    { id: "gpu-80", name: "GPU 80 GB", specs: "20 vCPU · 240 GB RAM", gpu: "NVIDIA H100 80 GB", good_for: "70B-class open models at 4-bit with room for context.", price_per_hour_micros: 8_820_000, price_per_month_micros: 6_438_600_000, min_minutes: 5 },
  ],
  credit_blocks: [50, 200, 1000],
  min_hours_covered: 1,
  egress_included_gib: 1024,
  egress_price_per_gib_micros: 20_000,
};

export function rental(over: Partial<RentalView> = {}): RentalView {
  return {
    id: "r_00000000000000a1", tier: "agent", name: "rent-agent-7f3a", state: "running", queue_position: null,
    price_per_hour_micros: 750_000, spent_micros: 250_000, created_at: 1_790_000_000_000, started_at: 1_790_000_000_000,
    ended_at: null, end_reason: null, node_id: null, idle_minutes: 30, ...over,
  };
}

export function state(rentals: RentalView[] = [rental()], over: Partial<ComputeState> = {}): ComputeState {
  return {
    account_id: "ca_00000000000000c1", team_id: "0123456789abcdef", status: "active", balance_micros: 49_160_000,
    burn_per_hour_micros: rentals.filter((r) => r.state === "running" || r.state === "starting").reduce((a, r) => a + r.price_per_hour_micros, 0),
    hours_left: 58.5, rentals, ...over,
  };
}

/**
 * Private numbers from the plan's cost column (DigitalOcean, §3A.4): if any shows up in a customer-facing payload, a
 * test fails. 0.75 / 750000 is left out on purpose: it is the Agent box XL's cost but also the Agent box's PRICE.
 */
export const COST_NUMBERS = ["0.375", "0.76", "1.57", "4.41", "375000", "760000", "1570000", "4410000", "273.75", "554.80", "1146.10", "3219.30"];
/** Private provider words (provider, size slugs, regions): never in a customer-facing payload. */
export const PRIVATE_WORDS = ["digitalocean", "g-8vcpu-32gb", "g-16vcpu-64gb", "gpu-4000adax1-20gb", "gpu-l40sx1-48gb", "gpu-h100x1-80gb", "tor1", "nyc3", "AWS"];

/** Every key path in `v` that names a cost, margin, markup, provider or instance type. */
export function forbiddenKeys(v: unknown, re: RegExp, path = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => forbiddenKeys(x, re, `${path}[${i}]`));
  if (typeof v !== "object" || v === null) return [];
  return Object.entries(v).flatMap(([k, x]) => [...(re.test(k) ? [`${path}.${k}`] : []), ...forbiddenKeys(x, re, `${path}.${k}`)]);
}
