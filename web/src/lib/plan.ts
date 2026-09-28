// Pure formatting for the team's plan (PlanView from the daemon) and 402 plan_limit refusals.
import type { PlanLimitDetails, PlanName, PlanView } from "../api/types.ts";

export const PLAN_LABEL: Record<PlanName, string> = { free: "Free", team: "Team", business: "Business" };

export type PlanTone = "neutral" | "signal" | "amber";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "4/10" or just "4" when the limit is unlimited (null). */
export function usage(used: number, limit: number | null): string {
  return limit === null ? String(used) : `${used}/${limit}`;
}

/** Trial countdown: "9 days left", "1 day left", "ends today". */
export function trialLeft(daysLeft: number): string {
  if (daysLeft <= 0) return "ends today";
  return `${plural(daysLeft, "day", "days")} left`;
}

/**
 * The shell badge:
 *   Free · 2/2 people · Team trial · 9 days left · Team · 7/10 seats · Business · 7 seats · Team · renewal overdue
 */
export function planBadgeText(p: PlanView): string {
  const label = PLAN_LABEL[p.plan];
  switch (p.status) {
    case "trial":
      return `${label} trial · ${trialLeft(p.trial?.days_left ?? 0)}`;
    case "grace":
      return `${label} · renewal overdue`;
    case "active":
      return `${label} · ${usage(p.seats.used, p.seats.limit)} seats`;
    default:
      return `Free · ${usage(p.seats.used, p.seats.limit)} people`;
  }
}

/** A limit this team is at or past (people or machines). */
export function overLimit(p: PlanView): boolean {
  const over = (u: { used: number; limit: number | null }) => u.limit !== null && u.used > u.limit;
  return over(p.seats) || over(p.machines);
}

export function planTone(p: PlanView): PlanTone {
  if (p.status === "grace" || overLimit(p)) return "amber";
  if (p.status === "active") return "signal";
  return "neutral";
}

/** The status chip next to the plan name; null when the name says it all (plain Free). */
export function statusLabel(p: PlanView): string | null {
  switch (p.status) {
    case "active": return "Active";
    case "grace": return "Renewal overdue";
    case "trial": return "Trial";
    default: return p.license ? "Lapsed" : overLimit(p) ? "Over the limit" : null;
  }
}

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

export function formatDate(ts: number): string {
  return DATE.format(new Date(ts));
}

/** One line about when the plan changes next, or null. */
export function planDeadline(p: PlanView): string | null {
  if (p.status === "trial" && p.trial) return `Trial ends ${formatDate(p.trial.ends_at)} (${trialLeft(p.trial.days_left)})`;
  if (p.status === "grace" && p.license) return `Expired ${formatDate(p.license.expires_at)}. Free limits apply after ${formatDate(p.license.grace_ends_at)}.`;
  if (p.status === "active" && p.license) return `Renews by ${formatDate(p.license.expires_at)}`;
  if (p.license) return `Expired ${formatDate(p.license.expires_at)}`;
  return null;
}

/** The friendly sentence for a 402 plan_limit refusal. */
export function limitMessage(d: PlanLimitDetails): string {
  const plan = PLAN_LABEL[d.plan];
  switch (d.resource) {
    case "people":
      return `Your ${plan} plan includes ${plural(d.limit, "person", "people")} (${d.used} used). Upgrade to add more.`;
    case "machines":
      return `Your ${plan} plan includes ${plural(d.limit, "machine", "machines")} (${d.used} used). Upgrade for unlimited machines.`;
    case "restricted_channels":
      return `Restricted channels are part of the Team plan. Upgrade to create one, or make this channel public.`;
    case "integrations":
      return `Your ${plan} plan includes ${plural(d.limit, "integration", "integrations")} (${d.used} enabled). Upgrade to enable more.`;
    case "projects":
      return `Your ${plan} plan includes ${plural(d.limit, "project", "projects")} (${d.used} in use). Upgrade for unlimited projects.`;
    case "boards":
      return `Each project includes ${plural(d.limit, "board", "boards")} (this one has ${d.used}). Extra boards are $15/month each.`;
  }
}

/** Only http(s) URLs become links (the URL comes from the daemon; never render javascript: etc.). */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** What POST /v1/license answers: applied (200), or queued while the roster authority is offline (202). */
export type ActivationResult =
  | { event: unknown; plan?: PlanView; renewal?: "saved" | "kept" | "missing" }
  | { queued: true; request_id: string };

/** The flash text after an activation (audit L10: a 202 queued answer is a success, not an error). */
export function activationMessage(res: ActivationResult): string {
  if ("queued" in res) return "Activation queued, the roster authority will apply it when it's online.";
  const p = res.plan;
  const head = p ? `License activated: ${PLAN_LABEL[p.plan]}${p.seats.limit !== null ? ` · ${p.seats.limit} seats` : ""}.` : "License activated.";
  return res.renewal === "missing"
    ? `${head} This machine has no renewal token, so the license won't renew by itself: copy ~/.walkie/license-renew-token from the machine that activated it, or email support.`
    : head;
}
