// Rental compute (RENT-2): the daemon's /v1/compute/* routes, same-origin with the dashboard session header like
// api/client.ts. Responses are parsed with the shared contract (src/protocol/compute.ts): PRICES ONLY, a payload that
// grows any other field fails the strict schemas instead of reaching the page.
import { useEffect, useSyncExternalStore } from "react";
import { sessionHeaders } from "../lib/session.ts";
import { ApiError } from "./client.ts";
import {
  ComputeState, CreditCheckout, Quotes, RentResult, RentalView,
  type CreditBlock, type MachineAsk, type TierId,
} from "../../../src/protocol/compute.ts";

export type { ComputeState, Quotes, RentResult, RentalView, QuoteTier, TierId, MachineAsk, CreditBlock } from "../../../src/protocol/compute.ts";

/** A refusal from /v1/compute/*, with the 402 insufficient_credit amounts when the daemon sent them. */
export class ComputeError extends ApiError {
  constructor(code: string, message: string, status: number, readonly neededMicros?: number, readonly balanceMicros?: number) {
    super(code, message, status);
  }
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, {
      method, credentials: "omit", cache: "no-store",
      headers: sessionHeaders(body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ComputeError("network", "daemon unreachable", 0);
  }
  const text = await res.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw new ComputeError("bad_response", `unexpected response from ${path}`, res.status); }
  if (!res.ok) {
    const top = (data ?? {}) as Record<string, unknown>;
    const inner = (typeof top.error === "object" && top.error !== null ? top.error : {}) as Record<string, unknown>;
    const code = typeof inner.code === "string" ? inner.code : typeof top.error === "string" ? top.error : `http_${res.status}`;
    const message = typeof inner.message === "string" ? inner.message : typeof top.message === "string" ? top.message : res.statusText;
    throw new ComputeError(code, message, res.status, num(inner.needed_micros) ?? num(top.needed_micros), num(inner.balance_micros) ?? num(top.balance_micros));
  }
  return data;
}

function parse<T>(schema: { safeParse: (d: unknown) => { success: true; data: T } | { success: false } }, data: unknown, path: string): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new ComputeError("bad_response", `unexpected response from ${path}`, 200);
  return r.data;
}

export interface StopResult { stopped: number; rentals: RentalView[] }
/** { stopped, rentals } with every rental checked against the contract. */
const StopResult = {
  safeParse(d: unknown): { success: true; data: StopResult } | { success: false } {
    const o = (d ?? {}) as Record<string, unknown>;
    if (typeof o.stopped !== "number" || !Number.isInteger(o.stopped) || o.stopped < 0 || !Array.isArray(o.rentals)) return { success: false };
    const rentals: RentalView[] = [];
    for (const r of o.rentals) {
      const p = RentalView.safeParse(r);
      if (!p.success) return { success: false };
      rentals.push(p.data);
    }
    return { success: true, data: { stopped: o.stopped, rentals } };
  },
};

/** Before the team's first rental there is no compute account (status "none", or a 404): an empty state, not an error. */
export function emptyState(): ComputeState {
  return { account_id: "ca_0000000000000000", team_id: "0000000000000000", status: "active", balance_micros: 0, burn_per_hour_micros: 0, hours_left: null, rentals: [] };
}

export const computeApi = {
  quotes: async () => parse(Quotes, await call("GET", "/v1/compute/quotes"), "/v1/compute/quotes"),
  state: async (): Promise<ComputeState> => {
    try {
      const data = await call("GET", "/v1/compute/state");
      // No compute account on this machine yet (nothing rented or bought): the daemon says status "none".
      if ((data as { status?: unknown } | null)?.status === "none") return emptyState();
      return parse(ComputeState, data, "/v1/compute/state");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404 && err.code === "no_compute_account") return emptyState();
      throw err;
    }
  },
  rent: async (machines: MachineAsk[], idleMinutes?: number, accountId?: string) =>
    parse(RentResult, await call("POST", "/v1/compute/rent", { machines, ...(idleMinutes !== undefined ? { idle_minutes: idleMinutes } : {}),
      ...(accountId ? { account_id: accountId } : {}) }), "/v1/compute/rent"),
  stop: async (target: { rental_id: string } | { all: true }) => parse(StopResult, await call("POST", "/v1/compute/stop", target), "/v1/compute/stop"),
  credit: async (block: CreditBlock, accountId?: string) => parse(CreditCheckout, await call("POST", "/v1/compute/credit",
    { block, ...(accountId ? { account_id: accountId } : {}) }), "/v1/compute/credit"),
};

/** "Buy credit": the daemon asks the site for a checkout page; the person pays there, in a new tab. */
export async function buyCredit(block: CreditBlock, open: (url: string) => void = (u) => { window.open(u, "_blank", "noopener,noreferrer"); }, accountId?: string): Promise<string> {
  const { url } = await computeApi.credit(block, accountId);
  if (!/^https:\/\//.test(url)) throw new ComputeError("bad_response", "the checkout link isn't https", 200);
  open(url);
  return url;
}

/** Stop one rented machine after the person confirms; false when they declined. */
export async function stopRental(id: string, name: string, confirm: (msg: string) => boolean = (m) => window.confirm(m)): Promise<boolean> {
  if (!confirm(`Stop ${name}? Stopping deletes the machine and its disk. Unused credit stays on the account.`)) return false;
  await computeApi.stop({ rental_id: id });
  computeStore.refresh();
  return true;
}

// ---- a tiny shared store: one poll for every view that shows rentals -------------------------------------------

export interface ComputeSnapshot {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly state: ComputeState | null;
  readonly quotes: Quotes | null;
  readonly error: string | null;
}

const IDLE: ComputeSnapshot = { status: "idle", state: null, quotes: null, error: null };
const POLL_MS = 30_000;

function createComputeStore() {
  let snap: ComputeSnapshot = IDLE;
  let users = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let seq = 0;
  const listeners = new Set<() => void>();
  const set = (next: ComputeSnapshot) => { snap = next; for (const l of listeners) l(); };

  async function refresh(): Promise<void> {
    const mine = ++seq;
    if (snap.status === "idle" || snap.status === "error") set({ ...snap, status: "loading", error: null });
    try {
      const quotes = await computeApi.quotes();
      // One state read preserves shutdown access. Disabled compute never starts a recurring poll.
      const state = await computeApi.state();
      if (quotes.available !== true && timer) { clearInterval(timer); timer = null; }
      if (quotes.available === true && users > 0 && !timer) timer = setInterval(() => { void refresh(); }, POLL_MS);
      if (mine === seq) set({ status: "ready", state, quotes, error: null });
    } catch (err) {
      if (mine !== seq) return;
      const message = err instanceof ApiError ? (err.code === "compute_not_configured" ? "Rented machines aren't available yet." : err.message) : "Something went wrong. Try again.";
      set({ ...snap, status: snap.state ? "ready" : "error", error: message });
    }
  }

  return {
    get: () => snap,
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    refresh: () => { void refresh(); },
    /** A view that shows rentals mounted: the first one starts the 30-second poll. */
    retain() {
      users += 1;
      if (users === 1) {
        void refresh();

      }
      return () => {
        users -= 1;
        if (users === 0 && timer) { clearInterval(timer); timer = null; }
      };
    },
    /** Tests and the mock: a fixed snapshot. */
    seed(next: ComputeSnapshot) { seq += 1; set(next); },
  };
}

export const computeStore = createComputeStore();

/** The team's rentals and quotes; `enabled` = the viewer is an owner (only owners rent, so only they poll). */
export function useCompute(enabled: boolean): ComputeSnapshot {
  const snap = useSyncExternalStore(computeStore.subscribe, computeStore.get, computeStore.get);
  useEffect(() => (enabled ? computeStore.retain() : undefined), [enabled]);
  return enabled ? snap : IDLE;
}

/** The rental that became this machine (it joined and reported its node id), if any. */
export function rentalForNode(state: ComputeState | null, nodeId: string): RentalView | undefined {
  return state?.rentals.find((r) => r.node_id === nodeId && r.state !== "ended" && r.state !== "failed");
}

const FALLBACK_TIER_NAMES: Readonly<Record<TierId, string>> = { agent: "Agent box", "agent-xl": "Agent box XL", "gpu-20": "GPU 20 GB", "gpu-48": "GPU 48 GB", "gpu-80": "GPU 80 GB" };

export function tierName(quotes: Quotes | null, tier: TierId): string {
  return quotes?.tiers.find((t) => t.id === tier)?.name ?? FALLBACK_TIER_NAMES[tier];
}
