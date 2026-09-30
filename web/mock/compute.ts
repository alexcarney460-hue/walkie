// Rental compute for the mock (RENT-2): the daemon's /v1/compute/* with fictional data. Prices only, like the real
// routes: no cost, provider or instance type anywhere. Two rentals to start: one running (its machine, rent-agent-7f3a,
// is on the team when WALKIE_MOCK_COMPUTE=1 adds it to the seed) and one queued.
import { ACTIVE_STATES, type ComputeState, type MachineAsk, type Quotes, type RentResult, type RentalView, type TierId } from "../../src/protocol/compute.ts";
import { nodeIdFor, sha256Hex } from "./world.ts";

export const RENTED_HOST = "rent-agent-7f3a";

export const MOCK_QUOTES: Quotes = {
  currency: "usd",
  min_hours_covered: 1,
  egress_included_gib: 1024,
  egress_price_per_gib_micros: 20_000,
  credit_blocks: [50, 200, 1000],
  tiers: [
    { id: "agent", name: "Agent box", specs: "8 dedicated vCPU · 32 GB RAM · 100 GB disk", gpu: null, good_for: "About 6-10 coding agents at once, with their builds and tests.", price_per_hour_micros: 750_000, price_per_month_micros: 547_500_000, min_minutes: 1 },
    { id: "agent-xl", name: "Agent box XL", specs: "16 dedicated vCPU · 64 GB RAM · 200 GB disk", gpu: null, good_for: "About 15-20 agents, or heavy builds (Rust, monorepos, browser tests).", price_per_hour_micros: 1_500_000, price_per_month_micros: 1_095_000_000, min_minutes: 1 },
    { id: "gpu-20", name: "GPU 20 GB", specs: "8 vCPU · 32 GB RAM · 500 GB NVMe · Toronto", gpu: "NVIDIA RTX 4000 Ada 20 GB", good_for: "One 20B-class open model at 4-bit (or 14B at 8-bit) for the team's pool.", price_per_hour_micros: 1_520_000, price_per_month_micros: 1_109_600_000, min_minutes: 5 },
    { id: "gpu-48", name: "GPU 48 GB", specs: "8 vCPU · 64 GB RAM · 500 GB NVMe · Toronto", gpu: "NVIDIA L40S 48 GB", good_for: "30B-class open models; a 70B model at 4-bit with a short context.", price_per_hour_micros: 3_140_000, price_per_month_micros: 2_292_200_000, min_minutes: 5 },
    { id: "gpu-80", name: "GPU 80 GB", specs: "20 vCPU · 240 GB RAM", gpu: "NVIDIA H100 80 GB", good_for: "70B-class open models at 4-bit with room for context.", price_per_hour_micros: 8_820_000, price_per_month_micros: 6_438_600_000, min_minutes: 5 },
  ],
};

const price = (tier: TierId) => MOCK_QUOTES.tiers.find((t) => t.id === tier)?.price_per_hour_micros ?? 0;
const rid = (seed: string) => `r_${sha256Hex(`rental:${seed}`).slice(0, 16)}`;

export class MockCompute {
  balance = 143_200_000;
  rentals: RentalView[];
  private n = 0;

  constructor(now = Date.now()) {
    this.rentals = [
      {
        id: rid("running"), tier: "agent", name: RENTED_HOST, state: "running", queue_position: null, price_per_hour_micros: price("agent"),
        spent_micros: 2_380_000, created_at: now - 172 * 60_000, started_at: now - 170 * 60_000, ended_at: null, end_reason: null,
        node_id: nodeIdFor(RENTED_HOST), idle_minutes: 30,
      },
      {
        id: rid("queued"), tier: "gpu-20", name: "rent-gpu-20-c21d", state: "queued", queue_position: 1, price_per_hour_micros: price("gpu-20"),
        spent_micros: 0, created_at: now - 4 * 60_000, started_at: null, ended_at: null, end_reason: null, node_id: null, idle_minutes: 30,
      },
    ];
  }

  state(): ComputeState {
    const burn = this.rentals.filter((r) => r.state === "running" || r.state === "starting").reduce((a, r) => a + r.price_per_hour_micros, 0);
    return {
      account_id: "ca_5e2b9d0c41a7f836", team_id: "7c1e4a90b25fd318", status: "active", balance_micros: this.balance,
      burn_per_hour_micros: burn, hours_left: burn > 0 ? Math.round((this.balance / burn) * 10) / 10 : null, rentals: this.rentals,
    };
  }

  /** Needs the first hour of every asked machine; starts the first two, queues the rest (a small quota). */
  rent(machines: MachineAsk[], now = Date.now()): RentResult | { error: "insufficient_credit"; needed_micros: number } {
    const needed = machines.reduce((a, m) => a + price(m.tier) * m.count, 0);
    if (needed > this.balance) return { error: "insufficient_credit", needed_micros: needed };
    const made: RentalView[] = [];
    const code_index: Record<string, number> = {};
    let running = this.rentals.filter((r) => r.state === "starting" || r.state === "running").length;
    let queued = this.rentals.filter((r) => r.state === "queued").length;
    for (const m of machines) {
      for (let i = 0; i < m.count; i++) {
        this.n += 1;
        const id = rid(`new:${this.n}:${now}`);
        const start = running < 3;
        if (start) { code_index[id] = made.length; running += 1; } else queued += 1;
        made.push({
          id, tier: m.tier, name: `rent-${m.tier}-${id.slice(2, 6)}`, state: start ? "starting" : "queued", queue_position: start ? null : queued,
          price_per_hour_micros: price(m.tier), spent_micros: 0, created_at: now, started_at: start ? now : null, ended_at: null,
          end_reason: null, node_id: null, idle_minutes: 30,
        });
      }
    }
    this.rentals = [...this.rentals, ...made];
    const started = Object.keys(code_index).length;
    return { rentals: made, started, queued: made.length - started, code_index, balance_micros: this.balance, replay: false };
  }

  stop(target: { rental_id?: unknown; all?: unknown }, now = Date.now()): { stopped: number; rentals: RentalView[] } | null {
    const hit = (r: RentalView) => ACTIVE_STATES.has(r.state) && (target.all === true || r.id === target.rental_id);
    if (target.all !== true && !this.rentals.some(hit)) return null;
    const stopped = this.rentals.filter(hit);
    this.rentals = this.rentals.map((r) => (hit(r) ? { ...r, state: "ended", ended_at: now, end_reason: "user", queue_position: null } : r));
    return { stopped: stopped.length, rentals: this.rentals.filter((r) => stopped.some((s) => s.id === r.id)) };
  }

  /** A fictional Stripe test-mode checkout link. */
  creditUrl(block: number): string {
    return `https://checkout.stripe.com/c/pay/cs_test_mock${block}`;
  }
}
