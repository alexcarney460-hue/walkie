// The site's copy of the rental-compute contract (src/protocol/compute.ts is the daemon's; Vercel deploys site/
// on its own, so the shapes are duplicated). site/test/compute-contract.test.ts parses every response built here
// with the daemon's zod schemas, so the two copies can't drift unnoticed. PRICES ONLY: no cost field anywhere.

export const TIER_IDS = ["agent", "agent-xl", "gpu-20", "gpu-48", "gpu-80"] as const;
export type TierId = (typeof TIER_IDS)[number];
export const isTierId = (s: unknown): s is TierId => typeof s === "string" && (TIER_IDS as readonly string[]).includes(s);

export type RentalState = "queued" | "needs_code" | "starting" | "running" | "stopping" | "ended" | "failed";
export const ACTIVE_STATES: ReadonlySet<RentalState> = new Set(["queued", "needs_code", "starting", "running", "stopping"]);
/** A machine exists (or is being made) and burns credit. */
export const BURNING_STATES: ReadonlySet<RentalState> = new Set(["starting", "running", "stopping"]);
/** Holds provider quota. */
export const CAPACITY_STATES: ReadonlySet<RentalState> = new Set(["needs_code", "starting", "running", "stopping"]);

export type StopReason =
  | "user" | "no_credit" | "idle" | "heartbeat_lost" | "boot_timeout" | "mining" | "egress_cap" | "frozen" | "launch_failed" | "watchdog_expired";

export const MAX_MACHINES_PER_REQUEST = 50;
export const IDLE_MINUTES_DEFAULT = 30;
export const IDLE_MINUTES_MIN = 10;
export const IDLE_MINUTES_MAX = 1440;
export const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,40})?$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
export const RENTAL_ID = /^r_[0-9a-f]{16}$/;
export const ACCOUNT_ID = /^ca_[0-9a-f]{16}$/;
export const TEAM_ID = /^[0-9a-f]{16}$/;
export const NODE_ID = /^[0-9a-f]{16}$/;
/** A Walkie Direct add-machine code: "wk1" + base64url, at most 300 characters (src/daemon/invite.ts). */
export const JOIN_CODE = /^wk1[A-Za-z0-9_-]{37,297}$/;
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface QuoteTier {
  id: TierId; name: string; specs: string; gpu: string | null; good_for: string;
  price_per_hour_micros: number; price_per_month_micros: number; min_minutes: number;
}
export interface Quotes {
  available?: boolean;
  currency: "usd"; tiers: QuoteTier[]; credit_blocks: number[]; min_hours_covered: number;
  egress_included_gib: number; egress_price_per_gib_micros: number;
}

export interface RentalView {
  id: string; tier: TierId; name: string; state: RentalState; queue_position: number | null;
  price_per_hour_micros: number; spent_micros: number; created_at: number; started_at: number | null;
  ended_at: number | null; end_reason: StopReason | null; node_id: string | null; idle_minutes: number;
}
export interface ComputeStateView {
  alerts?: ("tick_stale" | "termination_delayed")[];
  account_id: string; team_id: string; status: "active" | "frozen"; balance_micros: number;
  burn_per_hour_micros: number; hours_left: number | null; rentals: RentalView[];
}
export interface RentResult {
  rentals: RentalView[]; started: number; queued: number; code_index: Record<string, number>;
  balance_micros: number; replay: boolean;
}
export interface MachineAsk { tier: TierId; count: number }
export interface RentReq {
  idempotency_key: string; machines: MachineAsk[]; codes: string[]; walkie_version: string; idle_minutes?: number;
}
