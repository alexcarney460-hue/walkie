// The product website: the single place its origin is written (checkout, portal, renewal URLs).
// Production domain: sqwakie.si (Vercel project alex-carneys-projects/walkie).
import type { LicenseInterval, LicensePlan } from "./format.ts";

export const SITE_ORIGIN = "https://sqwakie.si";

/** `licId` (a team's existing license) lets the site refuse a second subscription for it (FINAL Codex 1). */
export function checkoutUrl(plan: LicensePlan, interval: LicenseInterval, seats: number, licId?: string): string {
  const n = Math.max(1, Math.min(10_000, Math.floor(seats)));
  const lic = licId && /^[A-Za-z0-9_]{1,200}$/.test(licId) ? `&lic_id=${licId}` : "";
  return `${SITE_ORIGIN}/api/checkout?plan=${plan}&interval=${interval}&seats=${n}${lic}`;
}

/**
 * The extra-board add-on checkout (WALKIE-PROJECTS-1). STUB: the site doesn't sell extra boards, so nothing links here
 * (E21b: the board 402 carries no link).
 */
export function boardAddonUrl(quantity: number, licId?: string): string {
  const n = Math.max(1, Math.min(1_000, Math.floor(quantity)));
  const lic = licId && /^[A-Za-z0-9_]{1,200}$/.test(licId) ? `&lic_id=${licId}` : "";
  return `${SITE_ORIGIN}/api/checkout?addon=board&quantity=${n}${lic}`;
}

/** Billing management: the site's portal function (Stripe's email-verified customer portal login). */
export const MANAGE_URL = `${SITE_ORIGIN}/api/portal`;
export const PRICING_URL = `${SITE_ORIGIN}/#pricing`;
