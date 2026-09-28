// Mock plan states for the dashboard (WALKIE_MOCK_PLAN=free|trial|team|business|grace, default trial).
// Mirrors the daemon's PlanView (src/license/plans.ts): license (valid or in grace) > trial > Free.
// All emails and ids are invented.
import type { EntitlementsView, PlanLimitDetails, PlanName, PlanView } from "../../src/protocol/schemas.ts";

export type MockPlanMode = "free" | "trial" | "team" | "business" | "grace";
export const MOCK_PLAN_MODES: readonly MockPlanMode[] = ["free", "trial", "team", "business", "grace"];

const DAY = 24 * 60 * 60_000;
const SITE = "https://getwalkie.vercel.app";

export interface MockLicense {
  lic_id: string; plan: "team" | "business"; seats: number; email: string;
  interval: "month" | "year"; issued_at: number; expires_at: number;
}

export interface MockPlanState {
  /** Team creation time (the trial runs 14 days from it). */
  created_ts: number;
  license: MockLicense | null;
}

export function parseMode(v: string | undefined): MockPlanMode {
  return MOCK_PLAN_MODES.includes(v as MockPlanMode) ? (v as MockPlanMode) : "trial";
}

export function seedPlan(mode: MockPlanMode, now = Date.now()): MockPlanState {
  const lic = (plan: "team" | "business", seats: number, expiresIn: number): MockLicense => ({
    lic_id: "sub_mock1KestrelA7", plan, seats, email: "maren@kestrel.example",
    interval: plan === "business" ? "year" : "month", issued_at: now - 30 * DAY + expiresIn, expires_at: now + expiresIn,
  });
  switch (mode) {
    case "free": return { created_ts: now - 40 * DAY, license: null };
    case "trial": return { created_ts: now - 5 * DAY, license: null };
    case "team": return { created_ts: now - 60 * DAY, license: lic("team", 10, 23 * DAY) };
    case "business": return { created_ts: now - 90 * DAY, license: lic("business", 25, 300 * DAY) };
    case "grace": return { created_ts: now - 60 * DAY, license: lic("team", 10, -3 * DAY) };
  }
}

const FREE: EntitlementsView = { people: 2, machines: 4, restricted_channels: false, integrations: 1, audit_export: false, join_approval: false };

function teamLike(people: number | null, business: boolean): EntitlementsView {
  return { people, machines: null, restricted_channels: true, integrations: null, audit_export: business, join_approval: business };
}

export function planView(s: MockPlanState, used: { people: number; machines: number }, now = Date.now()): PlanView {
  const l = s.license;
  const grace = l ? l.expires_at + 14 * DAY : 0;
  const trialEnds = s.created_ts + 14 * DAY;
  let plan: PlanName = "free";
  let status: PlanView["status"] = "free";
  let ent = FREE;
  if (l && now <= grace) {
    plan = l.plan; status = now <= l.expires_at ? "active" : "grace"; ent = teamLike(l.seats, l.plan === "business");
  } else if (now < trialEnds) {
    plan = "team"; status = "trial"; ent = teamLike(50, false);
  }
  const seatsFor = Math.max(1, used.people);
  return {
    plan, status, entitlements: ent,
    seats: { used: used.people, limit: ent.people },
    machines: { used: used.machines, limit: ent.machines },
    license: l ? { ...l, grace_ends_at: grace } : null,
    trial: status === "trial" ? { ends_at: trialEnds, days_left: Math.ceil((trialEnds - now) / DAY) } : null,
    upgrade_url: `${SITE}/api/checkout?plan=${plan === "business" ? "business" : "team"}&interval=month&seats=${seatsFor}`,
    manage_url: `${SITE}/api/portal`,
  };
}

/** A 402 plan_limit body for the mock routes. */
export function planLimitBody(p: PlanView, resource: PlanLimitDetails["resource"], limit: number, used: number, message: string): { error: Record<string, unknown> } {
  const seats = resource === "people" ? used + 1 : Math.max(1, p.seats.used);
  const details: PlanLimitDetails = {
    resource, limit, used, plan: p.plan,
    upgrade_url: `${SITE}/api/checkout?plan=team&interval=month&seats=${seats}`,
  };
  return { error: { code: "plan_limit", message, ...details } };
}

/** Mock license keys: "mock-team-<seats>" / "mock-business-<seats>" activate; anything else is invalid. */
export function mockActivate(key: string, now = Date.now()): MockLicense | null {
  const m = /^mock-(team|business)-(\d{1,4})$/.exec(key.trim());
  if (!m) return null;
  const seats = Number(m[2]);
  if (seats < 1) return null;
  return {
    lic_id: `sub_mock${now.toString(36)}`, plan: m[1] as "team" | "business", seats, email: "maren@kestrel.example",
    interval: "month", issued_at: now, expires_at: now + 35 * DAY,
  };
}
