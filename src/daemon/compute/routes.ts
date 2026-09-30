// Local API for rental compute (RENT-2, PROTOCOL §5 "Compute"): the CLI (`walkie compute …`) and the dashboard's
// "Add compute". Owner machines only (the codes a rented machine joins with are an owner node's signature). Renting,
// stopping and buying are admin actions (AGENT-ADMIN-1): an agent may, while its person has agent admin on, and each
// is audited in #general. Every answer carries PRICES only; the site's contract has no cost field to pass on.
import { CreditCheckoutReq, LocalRentReq, SiteStopReq, usd } from "../../protocol/compute.ts";
import { adminGate, adminRead, agentCaller } from "../admin/gate.ts";
import { readSwitches } from "../admin/switches.ts";
import type { Core } from "../core.ts";
import { HttpError, json, parseWith, readJson } from "../http.ts";
import { LOCAL_BODY_MAX, limitWrite, requireTeam, route, type RouteCtx } from "../local-routes.ts";
import type { ComputeService } from "./service.ts";

const services = new WeakMap<Core, ComputeService>();
export function registerCompute(core: Core, svc: ComputeService): void { services.set(core, svc); }
export function computeFor(core: Core): ComputeService | undefined { return services.get(core); }

function svcFor(c: RouteCtx): ComputeService {
  const s = services.get(c.core);
  if (!s) throw new HttpError(503, "compute_unavailable", "rental compute is not available in this version");
  return s;
}

function requireOwner(c: RouteCtx): void {
  requireTeam(c);
  if (c.core.me()?.role !== "owner") throw new HttpError(403, "forbidden", "owner role required: renting compute is an owner's");
}

route("GET", "/v1/compute/quotes", async (c) => {
  requireTeam(c);
  return json(await svcFor(c).quotes());
});

route("GET", "/v1/compute/state", async (c) => {
  requireOwner(c);
  adminRead(c);
  return json(await svcFor(c).state());
});

route("POST", "/v1/compute/rent", async (c) => {
  requireOwner(c);
  limitWrite(c);
  const b = parseWith(LocalRentReq, await readJson(c.req, LOCAL_BODY_MAX));
  const handle = c.core.myHandle();
  if (!handle) throw new HttpError(403, "forbidden", "this node is not an admitted member");
  const svc = svcFor(c);
  const count = b.machines.reduce((a, m) => a + m.count, 0);
  const what = `${count} machine${count === 1 ? "" : "s"} (${b.machines.map((m) => `${m.tier}×${m.count}`).join(", ")}`;
  if (agentCaller(c)) {
    // Refused (and audited as refused) before any site call while agent admin is off; else one audit line with the price.
    if (!readSwitches(c.core.paths.config).agent_admin) adminGate(c, `rent ${what})`);
    const quotes = await svc.quotes();
    const perHour = b.machines.reduce((a, m) => a + m.count * (quotes.tiers.find((t) => t.id === m.tier)?.price_per_hour_micros ?? 0), 0);
    adminGate(c, `rented ${what}; ${usd(perHour)}/h)`);
  }
  c.noTimeout();
  return json(await svc.rent(handle, b));
});

route("POST", "/v1/compute/stop", async (c) => {
  requireOwner(c);
  limitWrite(c);
  const b = parseWith(SiteStopReq, await readJson(c.req, LOCAL_BODY_MAX));
  const svc = svcFor(c);
  adminGate(c, "rental_id" in b ? `stopped the rented machine ${b.rental_id}` : "stopped every rented machine");
  return json(await svc.stop(b));
});

route("POST", "/v1/compute/credit", async (c) => {
  requireOwner(c);
  limitWrite(c);
  const b = parseWith(CreditCheckoutReq, await readJson(c.req, LOCAL_BODY_MAX));
  const svc = svcFor(c);
  // A checkout link: a person pays in Stripe Checkout (an agent can open the link, never add money itself).
  adminGate(c, `opened a $${b.block} compute credit checkout`);
  return json(await svc.credit(b.block, b.account_id));
});

route('POST', '/v1/compute/handover/object', async c => {
  requireOwner(c);
  limitWrite(c);
  const svc = svcFor(c);
  adminGate(c, 'objected to a compute account handover');
  return json(await svc.objectHandover());
});
