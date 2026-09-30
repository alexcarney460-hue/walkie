import { METADATA_PATHS, METADATA_SCRIPT } from '../api/_lib/compute/guest-safety.ts';
// CUSTOMERS NEVER SEE OUR COST (Alex, binding). Every customer-facing payload the control plane produces — quotes,
// state, rent/start/stop answers, error bodies, the Stripe checkout text (the receipt), the heartbeat answer and the
// user-data a rented machine boots with — plus every control-plane log line, is checked for (1) any key matching
// cost/margin/markup/provider/instance type and (2) any cost figure, provider size slug, region slug or provider name
// from the private config. The same payloads are then parsed with the daemon's STRICT zod schemas
// (src/protocol/compute.ts), so a field the contract doesn't name can't slip through to the CLI or dashboard either.
import { describe, expect, test } from "bun:test";
import { ComputeState, FORBIDDEN_CUSTOMER_KEYS, Quotes, RentalView, RentResult } from "../../src/protocol/compute.ts";
import { quotes, TIERS } from "../api/_lib/compute/catalog.ts";
import { heartbeat, state, stop, ComputeError } from "../api/_lib/compute/service.ts";
import { fixtureTeam, createAccount, rent, start } from "./compute-helpers.ts";
import { tick } from "../api/_lib/compute/tick.ts";
import { TAG_RENTAL } from "../api/_lib/compute/driver.ts";
import { creditSessionParams } from "../api/_lib/compute/credit.ts";
import { COSTS, SIZES, codes, fund, idem, MIN, world } from "./compute-helpers.ts";

const PRICES = new Set(TIERS.map((t) => t.price_per_hour_micros));

/** Cost figures as they could appear: micros, dollars per hour, dollars per 730-hour month. */
function costNeedles(): string[] {
  const out: string[] = [];
  for (const micros of Object.values(COSTS)) {
    // $0.75/h is both the Agent box XL's cost and the Agent box's price: a price may be shown, so that one figure
    // can't be told apart from a leak by value. The key check still catches it under any cost-ish name.
    if (PRICES.has(micros)) continue;
    const usd = micros / 1_000_000;
    out.push(String(micros), usd.toFixed(3).replace(/0+$/, "").replace(/\.$/, ""), usd.toFixed(2), (usd * 730).toFixed(2));
  }
  return out;
}

const PRIVATE_WORDS = [...Object.values(SIZES), "nyc3", "tor1", "nyc2", "ubuntu-24-04-x64", "quota_group"];

function forbiddenKeys(v: unknown, path = "$"): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => forbiddenKeys(x, `${path}[${i}]`));
  if (typeof v !== "object" || v === null) return [];
  return Object.entries(v).flatMap(([k, x]) => [...(FORBIDDEN_CUSTOMER_KEYS.test(k) ? [`${path}.${k}`] : []), ...forbiddenKeys(x, `${path}.${k}`)]);
}

function leaks(label: string, payload: unknown): string[] {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  const found = [
    ...forbiddenKeys(typeof payload === "string" ? {} : payload).map((k) => `${label}: key ${k}`),
    ...costNeedles().filter((n) => new RegExp(`(^|[^0-9.])${n.replace(".", "\\.")}([^0-9]|$)`).test(text)).map((n) => `${label}: cost figure ${n}`),
    ...PRIVATE_WORDS.filter((w) => text.toLowerCase().includes(w)).map((w) => `${label}: private word ${w}`),
  ];
  return found;
}

describe("no cost in any customer-facing payload", () => {
  test("the check itself catches a leak (so a pass means something)", () => {
    expect(leaks("probe", { tiers: [{ cost_per_hour_micros: 1 }] })).toContain("probe: key $.tiers[0].cost_per_hour_micros");
    expect(leaks("probe", { price: 375_000 })).toContain("probe: cost figure 375000");
    expect(leaks("probe", "costs $0.76 an hour")).toContain("probe: cost figure 0.76");
    expect(leaks("probe", { size: "gpu-h100x1-80gb" })).toContain("probe: private word gpu-h100x1-80gb");
  });

  test("quotes, state, rent, start, stop, errors, heartbeat, user-data and logs are clean and match the strict contract", async () => {
    const w = world({ quotas: { cpu: 1, gpu: 16 } });
    const payloads: [string, unknown][] = [['metadata verification paths', METADATA_PATHS], ['metadata verification script', METADATA_SCRIPT]];
    const a = await createAccount(w.d, fixtureTeam);
    payloads.push(["account", { account_id: a.account_id }]);
    const err = await rent(w.d, a.account_id, { idempotency_key: idem(), machines: [{ tier: "gpu-80", count: 1 }], codes: codes(1), walkie_version: "v0.2.0-pre.7" }).catch((e: ComputeError) => ({ error: e.code, ...e.extra }));
    payloads.push(["402", err]);
    await fund(w.store, a.account_id, 200_000_000);
    const q = quotes();
    payloads.push(["quotes", q]);
    expect(() => Quotes.parse(q)).not.toThrow();
    const r = await rent(w.d, a.account_id, {
      idempotency_key: idem(), machines: [{ tier: "agent", count: 2 }, { tier: "gpu-20", count: 1 }, { tier: "gpu-48", count: 1 }, { tier: "gpu-80", count: 1 }],
      codes: codes(5), walkie_version: "v0.2.0-pre.7",
    });
    payloads.push(["rent", r]);
    expect(() => RentResult.parse(r)).not.toThrow();
    const queued = r.rentals.find((x) => x.state === "queued")!;
    const running = r.rentals.find((x) => x.tier === "gpu-48")!;
    const token = /printf '%s' '([A-Za-z0-9_-]{43})'/.exec(w.cloud.provisions.find((p) => p.tags[TAG_RENTAL] === running.id)!.user_data)![1]!;
    w.advance(MIN);
    payloads.push(["heartbeat", await heartbeat(w.d, { rental_id: running.id, token, busy_seats: 1, pool_jobs: 0, cpu_pct: 5, gpu_pct: 30, egress_bytes: 10 })]);
    await stop(w.d, a.account_id, { rental_id: r.rentals[0]!.id });
    await tick(w.d);
    const st = await state(w.d, a.account_id);
    payloads.push(["state", st]);
    expect(() => ComputeState.parse(st)).not.toThrow();
    const waiting = st.rentals.find((x) => x.id === queued.id)!;
    expect(waiting.state).toBe("needs_code");
    const started = await start(w.d, a.account_id, queued.id, codes(1)[0]!, "v0.2.0-pre.7");
    payloads.push(["start", { rental: started }]);
    expect(() => RentalView.parse(started)).not.toThrow();
    payloads.push(["stop", await stop(w.d, a.account_id, { all: true })]);
    for (const p of w.cloud.provisions) payloads.push([`user-data ${p.name}`, p.user_data]);
    payloads.push(["logs", w.logs]);
    const found = payloads.flatMap(([label, p]) => leaks(label, p));
    expect(found).toEqual([]);
    expect(w.cloud.provisions.length).toBeGreaterThanOrEqual(5);
  });

  test("the Stripe Checkout the customer pays on (and its receipt) names the credit, not a cost", () => {
    const params = creditSessionParams({ accountId: "ca_0123456789abcdef", block: 200, successUrl: "https://site.test/ok", cancelUrl: "https://site.test/no" });
    expect(params.line_items?.[0]?.price_data?.product_data?.name).toBe("Walkie compute credit ($200)");
    expect(params.line_items?.[0]?.price_data?.unit_amount).toBe(20_000);
    expect(leaks("checkout", params)).toEqual([]);
  });
});
