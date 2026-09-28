// Plans and effective entitlements (docs/BUSINESS.md "Plans"). Pure: every function takes `now`.
// Effective = the license on the chain (valid, or expired less than GRACE_MS ago), else the 14-day
// Team trial counted from team.create, else Free.
import type { EntitlementsView, PlanName, PlanView } from "../protocol/schemas.ts";
import type { LicensePayload } from "./format.ts";
import { MANAGE_URL, checkoutUrl } from "./site.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How far ahead of a node's own clock anything another node stamped may move clock-derived state
 * (the plan floor from the chain, agent staleness, ask expiry; FINAL Fable 1/8). Five minutes covers
 * honest clock skew; beyond it a timestamp is treated as "now + 5 min".
 */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
/** An expired license keeps its entitlements this long (BUSINESS "Renewal"). */
export const GRACE_MS = 14 * DAY_MS;
/** Team entitlements from team.create, when no license applies (BUSINESS "Trial"). */
export const TRIAL_MS = 14 * DAY_MS;
/** The Team plan's people cap, which the trial also gets. */
export const TEAM_MAX_PEOPLE = 50;

export type Entitlements = Readonly<EntitlementsView>;

export const FREE: Entitlements = Object.freeze({
  people: 2, machines: 4, restricted_channels: false, integrations: 1, audit_export: false, join_approval: false,
});

/** Team is "up to 50 people" whatever the license says; more seats than that need Business. */
export function teamEntitlements(seats: number): Entitlements {
  return { people: Math.min(seats, TEAM_MAX_PEOPLE), machines: null, restricted_channels: true, integrations: null, audit_export: false, join_approval: false };
}

export function businessEntitlements(seats: number): Entitlements {
  return { ...teamEntitlements(seats), people: seats, audit_export: true, join_approval: true };
}

/** The license the chain holds (its latest applied `team.license`). */
export interface LicenseState { readonly key: string; readonly payload: LicensePayload; readonly event_id: string }

export interface Effective {
  readonly plan: PlanName;
  readonly status: PlanView["status"];
  readonly entitlements: Entitlements;
}

export function trialEndsAt(createdTs: number): number { return createdTs + TRIAL_MS; }

/**
 * `now` is the plan time (the clock floored by what the node recorded, Core.planNow); `clock` is the
 * raw clock. The trial needs the team's creation to be at most FUTURE_SKEW_MS ahead of the RAW clock
 * (FINAL Fable 2): a team created with a clock in the future has no trial once the clock is corrected,
 * because the floor keeps plan time pinned at the fake time and the trial would never end.
 */
export function effective(license: LicenseState | null | undefined, createdTs: number | null, now: number, clock = now): Effective {
  if (license && now <= license.payload.expires_at + GRACE_MS) {
    const p = license.payload;
    return {
      plan: p.plan,
      status: now <= p.expires_at ? "active" : "grace",
      entitlements: p.plan === "business" ? businessEntitlements(p.seats) : teamEntitlements(p.seats),
    };
  }
  if (createdTs !== null && now < trialEndsAt(createdTs) && createdTs <= clock + FUTURE_SKEW_MS) {
    return { plan: "team", status: "trial", entitlements: teamEntitlements(TEAM_MAX_PEOPLE) };
  }
  return { plan: "free", status: "free", entitlements: FREE };
}

/** Whole days left, rounded up (9.2 days → 10; 0 once it ended). */
export function daysLeft(endsAt: number, now: number): number {
  return Math.max(0, Math.ceil((endsAt - now) / DAY_MS));
}

/**
 * Where "upgrade" leads (FINAL Codex 1): a team with an ACTIVE license already subscribes, so it goes to
 * the billing portal (Stripe's email login) to change its seat count, never to a new-subscription
 * checkout. Anyone else gets checkout for `people` seats of the plan that lifts the current limit; a
 * team whose license lapsed passes its `lic_id` so the site can refuse a second subscription too.
 */
export function upgradeUrl(e: Effective, people: number, license?: LicenseState | null): string {
  if (e.status === "active") return MANAGE_URL;
  const plan = e.plan === "business" ? "business" : "team";
  return checkoutUrl(plan, "month", Math.max(1, people), license?.payload.lic_id);
}

export interface Usage { readonly people: number; readonly machines: number }

export function planView(license: LicenseState | null | undefined, createdTs: number, usage: Usage, now: number, clock = now): PlanView {
  const e = effective(license, createdTs, now, clock);
  const p = license?.payload;
  const trialEnd = trialEndsAt(createdTs);
  return {
    plan: e.plan,
    status: e.status,
    entitlements: { ...e.entitlements },
    seats: { used: usage.people, limit: e.entitlements.people },
    machines: { used: usage.machines, limit: e.entitlements.machines },
    license: p ? {
      lic_id: p.lic_id, plan: p.plan, seats: p.seats, email: p.email,
      interval: p.interval, issued_at: p.issued_at, expires_at: p.expires_at, grace_ends_at: p.expires_at + GRACE_MS,
    } : null,
    trial: e.status === "trial" ? { ends_at: trialEnd, days_left: daysLeft(trialEnd, now) } : null,
    upgrade_url: upgradeUrl(e, usage.people, license),
    manage_url: MANAGE_URL,
  };
}
