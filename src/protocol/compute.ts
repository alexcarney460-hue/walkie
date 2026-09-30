// Rental compute (RENT-1/RENT-2, docs/plans/RENT-1.md): the contract between the daemon (CLI, dashboard,
// WalkieTalkie) and the site's control plane (site/api/compute/*). The site keeps its own copy of these shapes
// (site/api/_lib/compute/types.ts) because Vercel deploys site/ on its own.
//
// CUSTOMERS NEVER SEE OUR COST (Alex, binding): nothing here carries a cost, a margin, a markup, a provider or an
// instance type. The catalogue a customer sees is tier id, name, specs and PRICE. Provider, instance type and cost
// live only in the control plane's private config (COMPUTE_PRIVATE_CONFIG on the site). test/unit/compute-no-cost
// fails when a customer-facing payload grows such a field or carries a cost number.
//
// Money is integer micro-dollars (1 USD = 1_000_000) everywhere on the wire; `usd()` formats it for people.
import { z } from "zod";

export const TIER_IDS = ["agent", "agent-xl", "gpu-20", "gpu-48", "gpu-80"] as const;
export const TierId = z.enum(TIER_IDS);
export type TierId = z.infer<typeof TierId>;

/** Prepaid credit blocks, in whole dollars (Stripe Checkout, mode=payment). */
export const CREDIT_BLOCKS = [50, 200, 1000] as const;
export const CreditBlock = z.union([z.literal(50), z.literal(200), z.literal(1000)]);
export type CreditBlock = z.infer<typeof CreditBlock>;

/** Each rented machine joins with its own add-machine code, valid this long (the authority accepts any expiry up to 7 days). */
export const RENTAL_CODE_TTL_MS = 60 * 60 * 1000;
/** Most machines in one rent request (any mix of tiers; excess beyond quota is queued, not refused). */
export const MAX_MACHINES_PER_REQUEST = 50;
/** Idle stop: no busy seat and no pool job for this long (minutes). */
export const IDLE_MINUTES_DEFAULT = 30;
export const IDLE_MINUTES_MIN = 10;
export const IDLE_MINUTES_MAX = 1440;

export const MICROS_PER_USD = 1_000_000;

/** Keys that must never appear in a customer-facing compute payload (checked by tests, recursively). */
export const FORBIDDEN_CUSTOMER_KEYS = /cost|margin|markup|wholesale|instance_?type|provider/i;

const Micros = z.number().int().min(-1e15).max(1e15);

export const QuoteTier = z.object({
  id: TierId,
  name: z.string().min(1).max(60),
  /** "8 vCPU · 32 GB RAM · 100 GB disk" */
  specs: z.string().min(1).max(160),
  /** "NVIDIA L40S 48 GB", or null for CPU tiers. */
  gpu: z.string().max(80).nullable(),
  good_for: z.string().max(300),
  price_per_hour_micros: Micros,
  /** 730 hours. */
  price_per_month_micros: Micros,
  /** Each start is billed at least this many minutes (GPU tiers: 5). */
  min_minutes: z.number().int().min(1).max(60),
}).strict();
export type QuoteTier = z.infer<typeof QuoteTier>;

export const Quotes = z.object({
  available: z.boolean().optional(),
  currency: z.literal("usd"),
  tiers: z.array(QuoteTier).max(20),
  credit_blocks: z.array(z.number().int()).max(10),
  /** A rent request needs this much credit per requested machine: its first hour (so `min_hours_covered` = 1). */
  min_hours_covered: z.number().int().min(1).max(24),
  /** Outbound data included per machine per 730 hours, then `egress_price_per_gib_micros` per GiB. */
  egress_included_gib: z.number().int().min(0),
  egress_price_per_gib_micros: Micros,
}).strict();
export type Quotes = z.infer<typeof Quotes>;

export const RENTAL_STATES = ["queued", "needs_code", "starting", "running", "stopping", "ended", "failed"] as const;
export const RentalState = z.enum(RENTAL_STATES);
export type RentalState = z.infer<typeof RentalState>;
/** Still holds (or will hold) a machine: counts toward burn, the dashboard lists it. */
export const ACTIVE_STATES: ReadonlySet<RentalState> = new Set(["queued", "needs_code", "starting", "running", "stopping"]);

export const STOP_REASONS = [
  "user", "no_credit", "idle", "heartbeat_lost", "boot_timeout", "mining", "egress_cap", "frozen", "launch_failed", "watchdog_expired",
] as const;
export const StopReason = z.enum(STOP_REASONS);
export type StopReason = z.infer<typeof StopReason>;

export const RentalView = z.object({
  id: z.string().regex(/^r_[0-9a-f]{16}$/),
  tier: TierId,
  /** The machine's hostname on the team: rent-<tier>-<4 hex>. */
  name: z.string().max(64),
  state: RentalState,
  /** Place in the queue (1 = next) while queued. */
  queue_position: z.number().int().min(1).nullable(),
  price_per_hour_micros: Micros,
  /** What this rental has used so far. */
  spent_micros: Micros,
  created_at: z.number().int(),
  started_at: z.number().int().nullable(),
  ended_at: z.number().int().nullable(),
  end_reason: StopReason.nullable(),
  /** The Walkie node id once the machine has joined and reported it (heartbeat). */
  node_id: z.string().regex(/^[0-9a-f]{16}$/).nullable(),
  idle_minutes: z.number().int(),
}).strict();
export type RentalView = z.infer<typeof RentalView>;

export const ComputeState = z.object({
  handover_notice: z.string().max(4096).optional(),
  alerts: z.array(z.enum(["tick_stale", "termination_delayed"])).optional(),
  account_id: z.string().regex(/^ca_[0-9a-f]{16}$/),
  team_id: z.string().regex(/^[0-9a-f]{16}$/),
  status: z.enum(["active", "frozen"]),
  balance_micros: Micros,
  /** Sum of the hourly prices of every machine that is burning now (starting or running). */
  burn_per_hour_micros: Micros,
  /** Hours of credit left at the current burn; null when nothing burns. */
  hours_left: z.number().nullable(),
  rentals: z.array(RentalView).max(1000),
  accounts: z.array(z.object({ account_id: z.string().regex(/^ca_[0-9a-f]{16}$/), status: z.enum(['active', 'frozen']),
    balance_micros: Micros, burn_per_hour_micros: Micros, hours_left: z.number().nullable() }).strict()).optional(),
}).strict();
export type ComputeState = z.infer<typeof ComputeState>;

/**
 * GET /v1/compute/state (the daemon) before this machine has a compute account (nothing rented or bought here yet):
 * the ComputeState fields with account_id null and status "none". The account is created on the first rent or buy.
 */
export interface NoComputeAccount {
  account_id: null; team_id: string; status: "none"; balance_micros: 0; burn_per_hour_micros: 0; hours_left: null; rentals: [];
  handover_pending_until?: number;
}
export type LocalComputeState = ComputeState | NoComputeAccount;

export const MachineAsk = z.object({ tier: TierId, count: z.number().int().min(1).max(MAX_MACHINES_PER_REQUEST) }).strict();
export type MachineAsk = z.infer<typeof MachineAsk>;

/** The daemon → site rent request. `codes[i]` is the join code for the i-th machine, in `machines` order expanded. */
export const SiteRentReq = z.object({
  idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  machines: z.array(MachineAsk).min(1).max(TIER_IDS.length),
  codes: z.array(z.string().min(40).max(300)).min(1).max(MAX_MACHINES_PER_REQUEST),
  walkie_version: z.string().regex(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/),
  idle_minutes: z.number().int().min(IDLE_MINUTES_MIN).max(IDLE_MINUTES_MAX).optional(),
}).strict();
export type SiteRentReq = z.infer<typeof SiteRentReq>;

export const RentResult = z.object({
  rentals: z.array(RentalView),
  started: z.number().int().min(0),
  queued: z.number().int().min(0),
  /** For each started rental, the index into `codes` it consumed (the daemon ties code chain id → rental). */
  code_index: z.record(z.string(), z.number().int().min(0)),
  balance_micros: Micros,
  /** True when this answered a repeat of an earlier request (same idempotency key): nothing new was launched. */
  replay: z.boolean(),
}).strict();
export type RentResult = z.infer<typeof RentResult>;

/** The daemon supplies a fresh code for a rental the site moved from the queue to `needs_code`. */
export const SiteStartReq = z.object({
  rental_id: z.string().regex(/^r_[0-9a-f]{16}$/),
  code: z.string().min(40).max(300),
  /** The release to install; absent = the one pinned at rent. */
  walkie_version: z.string().regex(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/).optional(),
}).strict();
export const SiteStopReq = z.union([
  z.object({ rental_id: z.string().regex(/^r_[0-9a-f]{16}$/), account_id: z.string().regex(/^ca_[0-9a-f]{16}$/).optional() }).strict(),
  z.object({ all: z.literal(true), account_id: z.string().regex(/^ca_[0-9a-f]{16}$/).optional() }).strict(),
]);
export const CreditCheckoutReq = z.object({ block: CreditBlock, account_id: z.string().regex(/^ca_[0-9a-f]{16}$/).optional() }).strict();
export const CreditCheckout = z.object({ url: z.string().url() }).strict();

/** Local API (daemon, PROTOCOL §5): POST /v1/compute/rent. */
export const LocalRentReq = z.object({
  machines: z.array(MachineAsk).min(1).max(TIER_IDS.length),
  idle_minutes: z.number().int().min(IDLE_MINUTES_MIN).max(IDLE_MINUTES_MAX).optional(),
  account_id: z.string().regex(/^ca_[0-9a-f]{16}$/).optional(),
}).strict();
export type LocalRentReq = z.infer<typeof LocalRentReq>;

/** "$0.84" (cents; whole micros below a cent round up so a price never reads as less than it is). */
export function usd(micros: number): string {
  const neg = micros < 0;
  const cents = Math.ceil(Math.abs(micros) / 10_000);
  const s = `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

/**
 * `agent=2 gpu-20` → [{tier:"agent",count:2},{tier:"gpu-20",count:1}] (same tier twice adds up). Throws a plain
 * Error naming the bad token.
 */
export function parseMachineAsks(tokens: readonly string[]): MachineAsk[] {
  const counts = new Map<TierId, number>();
  for (const t of tokens) {
    const m = /^([a-z0-9-]+)(?:=(\d{1,3}))?$/.exec(t);
    const tier = TierId.safeParse(m?.[1]);
    if (!m || !tier.success) throw new Error(`unknown tier "${t}" (one of: ${TIER_IDS.join(", ")}; add =N for a count)`);
    const n = m[2] === undefined ? 1 : Number(m[2]);
    if (n < 1) throw new Error(`count must be at least 1 in "${t}"`);
    counts.set(tier.data, (counts.get(tier.data) ?? 0) + n);
  }
  const out = [...counts].map(([tier, count]) => ({ tier, count }));
  const total = out.reduce((a, b) => a + b.count, 0);
  if (total < 1) throw new Error("name at least one tier");
  if (total > MAX_MACHINES_PER_REQUEST) throw new Error(`at most ${MAX_MACHINES_PER_REQUEST} machines per request`);
  return out;
}
