// v0.2.0-pre.17 (lane E): the release gate is OPEN. Rental compute ships switched on in code, and the deployment's
// environment decides the mode (handler.ts): fully off without COMPUTE_PRIVATE_CONFIG, drained with the config and the
// store but COMPUTE_ENABLED unset (the rollback lever), enabled with COMPUTE_ENABLED=1. No published endpoint answers the
// pre.10-to-pre.16 lock's `compute_unavailable_in_this_version` any more, and COMPUTE_ENABLED=1 is no longer refused.
// The GPU quota is 0 at launch: quotes list the CPU tiers only and a GPU rent is refused.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { GET as quotes, makeQuotes } from "../api/compute/quotes.ts";
import { POST as account } from "../api/compute/account.ts";
import { GET as state, makeState } from "../api/compute/state.ts";
import { POST as credit, makeCredit } from "../api/compute/credit.ts";
import { POST as rent, makeRent } from "../api/compute/rent.ts";
import { POST as start } from "../api/compute/start.ts";
import { POST as stop } from "../api/compute/stop.ts";
import { GET as tick } from "../api/compute/tick.ts";
import { POST as heartbeat } from "../api/compute/heartbeat.ts";
import { POST as handover } from "../api/compute/handover.ts";
import { POST as lease } from "../api/compute/lease.ts";
import { POST as webhook } from "../api/compute/webhook.ts";
import { POST as watchdog } from "../api/compute/watchdog-heartbeat.ts";
import { POST as licenceBackfill } from "../api/compute/licence-backfill.ts";
import { computeConfigurationError, computeReleaseGate, COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION } from "../api/_lib/compute/release-gate.ts";
import { computeFromEnv, type HandlerDeps } from "../api/_lib/compute/handler.ts";
import type { CreditStripe } from "../api/_lib/compute/credit.ts";
import { RENTED_MACHINE_RELEASES } from "../api/_lib/compute/releases.ts";
import { codes, configJson, createAccount, fixtureTeam, fund, idem, world, type World } from "./compute-helpers.ts";

const RELEASE = RENTED_MACHINE_RELEASES[RENTED_MACHINE_RELEASES.length - 1]!;
const CPU_ONLY = { cpu: 2, gpu: 0 };

// Every compute setting the published handlers read from process.env: cleared for each test so the fully-off case is
// what it claims to be (no config, no store, no keys) whatever the shell running the suite has set.
const COMPUTE_ENV = ["COMPUTE_ENABLED", "COMPUTE_PRIVATE_CONFIG", "DATABASE_URL", "CRON_SECRET", "COMPUTE_STRIPE_SECRET_KEY",
  "COMPUTE_STRIPE_LIVE", "COMPUTE_STRIPE_WEBHOOK_SECRET", "COMPUTE_WATCHDOG_HMAC_SECRET", "COMPUTE_HANDOVER_TOKEN_KEY",
  "COMPUTE_HANDOVER_OPERATOR_SECRET", "DIGITALOCEAN_TOKEN", "COMPUTE_ALLOW_FAKE", "COMPUTE_ALERT_TELEGRAM_TOKEN",
  "COMPUTE_ALERT_TELEGRAM_CHAT", "COMPUTE_ALERT_SPEND_USD_PER_DAY", "STRIPE_SECRET_KEY", "SITE_URL"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(COMPUTE_ENV.map((k) => [k, process.env[k]]));
  for (const k of COMPUTE_ENV) delete process.env[k];
});
afterEach(() => {
  for (const k of COMPUTE_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const PUBLISHED = { quotes, account, state, credit, rent, start, stop, tick, heartbeat, handover, lease, webhook, watchdog,
  licenceBackfill } as const;

test("the release gate is open: no environment is refused by the code lock", () => {
  expect(COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION).toBe(true);
  for (const env of [{}, { COMPUTE_ENABLED: "1" }, { COMPUTE_ENABLED: "0" }, { COMPUTE_PRIVATE_CONFIG: "fixture" },
    { COMPUTE_ENABLED: "1", COMPUTE_PRIVATE_CONFIG: "fixture", DATABASE_URL: "postgres://127.0.0.1:1/unused" }]) {
    expect(computeReleaseGate(env)).toBeNull();
    // The licence bind's entrypoint no longer refuses COMPUTE_ENABLED=1 as a configuration error.
    expect(computeConfigurationError(env)).toBeNull();
  }
});

test("fully off (no COMPUTE_PRIVATE_CONFIG): every published endpoint gives its own answer, never the old lock's", async () => {
  const answers: Record<string, [number, unknown]> = {};
  for (const [name, handler] of Object.entries(PUBLISHED)) {
    const res = await handler(new Request(`https://site.test/api/compute/${name}`, { method: name === "quotes" || name === "state" || name === "tick" ? "GET" : "POST",
      ...(name === "quotes" || name === "state" || name === "tick" ? {} : { body: "{}" }), headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" } }));
    answers[name] = [res.status, await res.json()];
  }
  for (const [, [, b]] of Object.entries(answers)) expect(JSON.stringify(b)).not.toContain("compute_unavailable_in_this_version");
  // Quotes: the public catalogue, not for sale. The tick: the cron's bearer check comes first (no CRON_SECRET here).
  const [qStatus, q] = answers.quotes as [number, { available: boolean; tiers: unknown[] }];
  expect([qStatus, q.available]).toEqual([200, false]);
  expect(answers.tick).toEqual([401, { error: "unauthorized" }]);
  // Everything else: compute is not configured (no store is opened: there is no DATABASE_URL to open).
  for (const name of Object.keys(PUBLISHED).filter((n) => n !== "quotes" && n !== "tick"))
    expect([name, ...answers[name]!]).toEqual([name, 503, { error: "compute_not_configured" }]);
});

test("the published quotes with a CPU-only config list the CPU tiers only, unavailable while not enabled", async () => {
  process.env.COMPUTE_PRIVATE_CONFIG = configJson(CPU_ONLY);
  const res = await quotes(new Request("https://site.test/api/compute/quotes"));
  expect(res.status).toBe(200);
  const q = await res.json() as { available: boolean; tiers: { id: string; gpu: string | null }[] };
  expect(q.tiers.map((t) => t.id)).toEqual(["agent", "agent-xl"]);
  expect(q.tiers.every((t) => t.gpu === null)).toBe(true);
  expect(q.available).toBe(false);
});

/** The handlers on the env's mode (computeFromEnv decides it), backed by the world's store, clock and FakeCloud. */
function site(w: World, enabled: boolean): { deps: HandlerDeps; checkouts: unknown[] } {
  const env: Record<string, string> = { COMPUTE_PRIVATE_CONFIG: configJson(CPU_ONLY), DATABASE_URL: "postgres://127.0.0.1:1/unused",
    COMPUTE_HANDOVER_TOKEN_KEY: "rent-fixture-handover-key-32-bytes", SITE_URL: "https://site.test", ...(enabled ? { COMPUTE_ENABLED: "1" } : {}) };
  const checkouts: unknown[] = [];
  const stripe: CreditStripe = { createCreditCheckout: async (p) => { checkouts.push(p); return { url: "https://checkout.stripe.test/x" }; } };
  const deps: HandlerDeps = { env, stripe: () => stripe, alertStore: () => w.store, alertFetch: async () => Response.json({ ok: true }),
    compute: async () => { const base = await computeFromEnv(env, w.store); return base && { ...base, driver: w.d.driver, now: w.d.now, log: w.d.log }; } };
  return { deps, checkouts };
}
const req = (path: string, body?: unknown, token?: string) => new Request(`https://site.test${path}`, {
  method: body === undefined ? "GET" : "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
const rentBody = (tier: string) => ({ idempotency_key: idem(), machines: [{ tier, count: 1 }], codes: codes(1), walkie_version: RELEASE });

test("drained (config and store, COMPUTE_ENABLED unset): admissions refuse, state answers, quotes are CPU-only and unavailable", async () => {
  const w = world({ quotas: CPU_ONLY });
  const a = await createAccount(w.d, fixtureTeam);
  await fund(w.store, a.account_id, 50_000_000);
  const { deps, checkouts } = site(w, false);
  const q = await (await makeQuotes(deps)(req("/api/compute/quotes"))).json() as { available: boolean; tiers: { id: string }[] };
  expect([q.available, q.tiers.map((t) => t.id)]).toEqual([false, ["agent", "agent-xl"]]);
  const rented = await makeRent(deps)(req("/api/compute/rent", rentBody("agent"), a.token));
  expect([rented.status, await rented.json()]).toEqual([503, { error: "compute_not_configured" }]);
  const bought = await makeCredit(deps)(req("/api/compute/credit", { block: 50 }, a.token));
  expect(bought.status).toBe(503);
  expect(checkouts).toEqual([]);
  const s = await makeState(deps)(req("/api/compute/state", undefined, a.token));
  expect(s.status).toBe(200);
  expect((await s.json() as { rentals: unknown[] }).rentals).toEqual([]);
});

test("enabled (COMPUTE_ENABLED=1, GPU quota 0): quotes are available with the CPU tiers only; a GPU rent is refused, a CPU rent starts", async () => {
  const w = world({ quotas: CPU_ONLY });
  const a = await createAccount(w.d, fixtureTeam);
  await fund(w.store, a.account_id, 50_000_000);
  const { deps } = site(w, true);
  const q = await (await makeQuotes(deps)(req("/api/compute/quotes"))).json() as { available: boolean; tiers: { id: string }[] };
  expect([q.available, q.tiers.map((t) => t.id)]).toEqual([true, ["agent", "agent-xl"]]);
  const gpu = await makeRent(deps)(req("/api/compute/rent", rentBody("gpu-20"), a.token));
  expect([gpu.status, await gpu.json()]).toEqual([409, { error: "tier_unavailable" }]);
  const cpu = await makeRent(deps)(req("/api/compute/rent", rentBody("agent"), a.token));
  expect(cpu.status).toBe(200);
  const result = await cpu.json() as { started: number; queued: number };
  expect(result.started + result.queued).toBe(1);
});
