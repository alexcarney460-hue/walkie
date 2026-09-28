// Billing configuration, entirely from env vars (docs/BUSINESS.md "Billing"). A handler whose
// required vars are missing answers 503 {error: "billing_not_configured"}; it never says which.
import type { LicenseInterval, LicensePlan } from "./license.js";
import { fail } from "./http.js";

export type Env = Readonly<Record<string, string | undefined>>;

export const PRICE_ENV: Readonly<Record<LicensePlan, Readonly<Record<LicenseInterval, string>>>> = {
  team: { month: "STRIPE_PRICE_TEAM_MONTH", year: "STRIPE_PRICE_TEAM_YEAR" },
  business: { month: "STRIPE_PRICE_BUSINESS_MONTH", year: "STRIPE_PRICE_BUSINESS_YEAR" },
};

/** Every env var the site reads (names only; documented in site/README.md). */
export const ENV_NAMES = [
  "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "WALKIE_LICENSE_SIGNING_KEY",
  "STRIPE_PRICE_TEAM_MONTH", "STRIPE_PRICE_TEAM_YEAR", "STRIPE_PRICE_BUSINESS_MONTH", "STRIPE_PRICE_BUSINESS_YEAR",
  "SITE_URL", "STRIPE_PORTAL_LOGIN_URL",
] as const;

export type Required<K extends string> = { readonly [P in K]: string };

/** The named vars (non-empty, trimmed), or the 503 response to return. */
export function requireEnv<K extends string>(env: Env, names: readonly K[]): { ok: true; values: Required<K> } | { ok: false; response: Response } {
  const values: Record<string, string> = {};
  for (const n of names) {
    const v = env[n]?.trim();
    if (!v) return { ok: false, response: fail(503, "billing_not_configured") };
    values[n] = v;
  }
  return { ok: true, values: values as Required<K> };
}

export function optionalEnv(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

/** Which plan/interval a price id is, by matching the configured price env vars. */
export function planForPriceId(env: Env, priceId: string): { plan: LicensePlan; interval: LicenseInterval } | null {
  for (const plan of ["team", "business"] as const) {
    for (const interval of ["month", "year"] as const) {
      if (optionalEnv(env, PRICE_ENV[plan][interval]) === priceId) return { plan, interval };
    }
  }
  return null;
}
