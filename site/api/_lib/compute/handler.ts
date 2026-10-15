// Glue between the /api/compute/* functions and the control plane: config from env, bearer auth, rate limits and
// error mapping. Env (names only; values live in Vercel):
//   COMPUTE_ENABLED=1              admissions: quotes available, new rentals, starts and credit purchases. Unset (with
//                                  the private config and the store still set) DRAINS, the rollback lever: state, stop,
//                                  heartbeat, lease, the webhook, the watchdog heartbeat, account and handover requests
//                                  keep working, and while any rental is active or a cleanup is pending the tick keeps
//                                  metering, stopping, deleting and reconciling; nothing new launches or sells. Without
//                                  COMPUTE_PRIVATE_CONFIG or DATABASE_URL compute is fully off (no store access), which
//                                  strands running machines: never remove those while any rental is active.
//   COMPUTE_PRIVATE_CONFIG         provider / instance type / cost / quota per tier (private-config.ts)
//   DATABASE_URL                   Neon Postgres (Vercel Marketplace)
//   COMPUTE_STRIPE_SECRET_KEY      Stripe key for credit checkout: sk_test_… unless COMPUTE_STRIPE_LIVE=1; also reads the
//                                  charge of a held freeze (the webhook, and the tick's retry while drained too)
//   COMPUTE_STRIPE_WEBHOOK_SECRET  signing secret of the /api/compute/webhook endpoint
//   CRON_SECRET                    Vercel cron's bearer for /api/compute/tick (minute cron in site/vercel.json, 60 s)
//   DIGITALOCEAN_TOKEN             the DigitalOcean API token (droplet create/read/delete, tag create/read)
//   COMPUTE_ALLOW_FAKE=1           previews/demo only: the "fake" provider (FakeCloud) may back tiers
//   SITE_URL                       the https origin machines install from and heartbeat to
//   COMPUTE_HANDOVER_TOKEN_KEY     at least 32 characters; seals pending handover token copies (every route 503s without)
//   COMPUTE_HANDOVER_OPERATOR_SECRET  at least 32 characters; the operator's bearer for handover decisions
//   COMPUTE_WATCHDOG_HMAC_SECRET   signs the independent watchdog's heartbeat (compute/watchdog-heartbeat.ts); the
//                                  tick alerts watchdog_stale once per UTC day while it is missing or quiet
//   COMPUTE_ALERT_TELEGRAM_TOKEN / COMPUTE_ALERT_TELEGRAM_CHAT / COMPUTE_ALERT_SPEND_USD_PER_DAY  operator alerts
import { realStripe } from "../stripe.js";
import type { StripeLike } from '../stripe.js';
import { licenseVerifier } from "./license-proof.js";
import { timingSafeEqual } from "node:crypto";
import { optionalEnv, type Env } from "../env.js";
import { fail, json, logError } from "../http.js";
import { readJsonObject } from "../body.js";
import { computeKeyAllowed, realCreditStripe, type ChargeLookup, type CreditStripe } from "./credit.js";
import { stderrLog, type ComputeDeps } from "./deps.js";
import type { CloudDriver } from "./driver.js";
import { FakeCloud } from "./fake-cloud.js";
import { DigitalOceanDriver } from "./digitalocean.js";
import { ConfigError, parsePrivateConfig } from "./private-config.js";
import type { PgStore } from "./pg-store.js";
import { accountForToken, ComputeError } from "./service.js";
import type { ComputeStore } from "./store.js";
import type { Account } from "./store.js";
import { TOKEN } from "./types.js";
import { requireHandoverTokenKey } from './handover.js';
import { licenceReads } from './licence-records.js';

export const DEFAULT_SITE_ORIGIN = "https://sqwakie.si";

export interface HandlerDeps {
  readonly alertFetch?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly alertStore?: () => ComputeStore | null | Promise<ComputeStore | null>;
  readonly env: Env;
  /** The control plane, or null when compute isn't configured (→ 503 compute_not_configured). */
  readonly compute: () => ComputeDeps | null | Promise<ComputeDeps | null>;
  readonly stripe: () => CreditStripe | null;
  readonly licenseStripe?: () => Pick<StripeLike, 'listSubscriptionsByTeam' | 'getSubscription' | 'setSubscriptionMetadata' |
    'listSubscriptionsPage'> | null;
}

let cachedStore: { url: string; store: Promise<PgStore> } | null = null;
let fake: FakeCloud | null = null;
let digitalocean: DigitalOceanDriver | null = null;

/** Driver registry: provider name → driver, only for providers whose credentials are configured. */
export function driverFor(env: Env): (provider: string) => CloudDriver | null {
  return (provider) => {
    if (provider === "fake" && optionalEnv(env, "COMPUTE_ALLOW_FAKE") === "1") return (fake ??= new FakeCloud());
    const doToken = optionalEnv(env, "DIGITALOCEAN_TOKEN");
    if (provider === "digitalocean" && doToken) {
      try {
        return (digitalocean ??= new DigitalOceanDriver(doToken));
      } catch {
        return null;
      }
    }
    return null;
  };
}

async function pgStore(url: string): Promise<PgStore> {
  if (!cachedStore || cachedStore.url !== url) {
    const promise = import('./pg-store.js').then(({ PgStore }) => PgStore.connect(url));
    cachedStore = { url, store: promise };
    void promise.catch(() => { if (cachedStore?.store === promise) cachedStore = null; });
  }
  return cachedStore.store;
}

/** Charge reads with the compute Stripe key for the tick; the Stripe client is built on the first read only. */
function chargeLookup(key: string): ChargeLookup {
  let client: CreditStripe | null = null;
  return { paymentIntentOfCharge: async (charge) => {
    const stripe = (client ??= realCreditStripe(key));
    if (!stripe.paymentIntentOfCharge) throw new Error("compute_stripe_unavailable");
    return stripe.paymentIntentOfCharge(charge);
  } };
}

/**
 * True when COMPUTE_PRIVATE_CONFIG is set but does not parse. That turns compute fully off by mistake (stop and state
 * answer 503, nothing is metered or deleted), so the tick answers 500 and the operator is paged without a store
 * (REVIEW-merged-opus.md 6). Absent means fully off on purpose. Pre-deploy check: parsePrivateConfig on the new value.
 */
export function privateConfigInvalid(env: Env): boolean {
  const raw = optionalEnv(env, "COMPUTE_PRIVATE_CONFIG");
  if (!raw) return false;
  try {
    parsePrivateConfig(raw);
    return false;
  } catch (err) {
    if (err instanceof ConfigError) return true;
    throw err;
  }
}

/** The control plane from env: null when compute is fully off; `enabled: false` while it drains (see above). */
export async function computeFromEnv(env: Env, store?: ComputeStore): Promise<ComputeDeps | null> {
  if (!optionalEnv(env, "COMPUTE_PRIVATE_CONFIG")) return null;
  let config;
  try {
    config = parsePrivateConfig(optionalEnv(env, "COMPUTE_PRIVATE_CONFIG"));
  } catch (err) {
    if (err instanceof ConfigError) {
      stderrLog("config_invalid", {});
      return null;
    }
    throw err;
  }
  const threshold = Number(optionalEnv(env, 'COMPUTE_ALERT_SPEND_USD_PER_DAY') ?? '50');
  const alertConfigInvalid = !Number.isFinite(threshold) || threshold <= 0;
  const url = optionalEnv(env, "DATABASE_URL");
  if (!store && !url) return null;
  const handoverTokenKey = requireHandoverTokenKey(env);
  const origin = (optionalEnv(env, "SITE_URL") ?? DEFAULT_SITE_ORIGIN).replace(/\/+$/, "");
  const s = store ?? await pgStore(url as string);
  const licenseKey = optionalEnv(env, "STRIPE_SECRET_KEY");
  const licenceStripe = licenseKey ? realStripe(licenseKey) : null;
  const computeKey = optionalEnv(env, "COMPUTE_STRIPE_SECRET_KEY");
  return {
    spendAlertUsdPerDay: alertConfigInvalid ? 50 : threshold, alertConfigInvalid,
    verifyLicense: licenceStripe ? licenseVerifier(licenceStripe) : undefined,
    // A first enrollment fails closed when the licence account cannot be read (lane C round 7).
    ...licenceReads(licenceStripe),
    enabled: optionalEnv(env, 'COMPUTE_ENABLED') === '1', handoverTokenKey,
    // Whatever the switch: a held freeze is retried by the tick while drained too.
    charges: computeKey && computeKeyAllowed(computeKey, optionalEnv(env, "COMPUTE_STRIPE_LIVE")) ? chargeLookup(computeKey) : undefined,
    store: s, config, driver: driverFor(env),
    now: () => Date.now(), siteOrigin: origin, log: stderrLog,
  };
}

export function defaultHandlerDeps(): HandlerDeps {
  const env = process.env as Env;
  return {
    env,
    compute: () => computeFromEnv(env),
    alertStore: async () => {
      if (optionalEnv(env, 'COMPUTE_ENABLED') !== '1') return null;
      const url = optionalEnv(env, 'DATABASE_URL');
      if (!url) return null;
      return pgStore(url);
    },
    stripe: () => {
      const key = optionalEnv(env, "COMPUTE_STRIPE_SECRET_KEY");
      return key && computeKeyAllowed(key, optionalEnv(env, "COMPUTE_STRIPE_LIVE")) ? realCreditStripe(key) : null;
    },
    licenseStripe: () => {
      const key = optionalEnv(env, 'STRIPE_SECRET_KEY');
      return key ? realStripe(key) : null;
    },
  };
}

export const notConfigured = (): Response => fail(503, "compute_not_configured");

/** The client's IP as Vercel's edge reports it (x-real-ip is set by the platform, not the caller). */
export function clientIp(req: Request): string {
  return req.headers.get("x-real-ip")?.trim() || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** Fixed-window limit; true when the caller is still within it. */
export async function allow(d: ComputeDeps, key: string, max: number, windowMs: number): Promise<boolean> {
  const start = Math.floor(d.now() / windowMs) * windowMs;
  return d.store.tx((t) => t.hit(key, start, max));
}

export function bearer(req: Request): string | null {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.get("authorization") ?? "");
  return m && TOKEN.test(m[1] as string) ? (m[1] as string) : null;
}

export function secretMatches(given: string | null, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Runs `fn` for an authenticated account (bearer compute token), within the per-token request limit. */
export async function withAccount(
  deps: HandlerDeps, req: Request, fn: (d: ComputeDeps, a: Account, body: Record<string, unknown>) => Promise<Response>,
  opts: { body: boolean },
): Promise<Response> {
  const d = await deps.compute();
  if (!d) return notConfigured();
  const token = bearer(req);
  if (!token) return fail(401, "invalid_token");
  let body: Record<string, unknown> = {};
  if (opts.body) {
    const b = await readJsonObject(req);
    if ("response" in b) return b.response;
    body = b.value;
  }
  try {
    const a = await accountForToken(d, token);
    if (!a) return fail(401, "invalid_token");
    if (!(await allow(d, `acct:${a.id}`, 600, 3_600_000))) return fail(429, "rate_limited");
    return await fn(d, a, body);
  } catch (err) {
    return errorResponse(err);
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ComputeError) return fail(err.status, err.code, err.extra);
  logError("compute", err);
  return fail(500, "compute_error");
}

export { json, fail };
