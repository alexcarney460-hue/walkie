// walkie license [activate <code|key>] / walkie upgrade, plus the plan line shared by who and doctor.
import { WalkieError } from "../../client/index.ts";
import { MANAGE_URL, checkoutUrl } from "../../license/site.ts";
import type { PlanLimitDetails, PlanView } from "../../protocol/schemas.ts";
import { bool, need, str, UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { c } from "../format.ts";

const PLAN_NAME: Record<PlanView["plan"], string> = { free: "Free", team: "Team", business: "Business" };
const DAY_MS = 24 * 60 * 60 * 1000;

function date(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function limitText(used: number, limit: number | null, noun: string): string {
  return limit === null ? `${used} ${noun}` : `${used}/${limit} ${noun}`;
}

/** One line: "Free · 2/2 people", "Team trial · 9 days left", "Team · 7/10 seats", "Team · grace until 2026-10-09". */
export function planLine(p: PlanView, now = Date.now()): string {
  const name = PLAN_NAME[p.plan];
  if (p.status === "trial" && p.trial) return `${name} trial · ${p.trial.days_left} day${p.trial.days_left === 1 ? "" : "s"} left`;
  if (p.status === "free") return `${name} · ${limitText(p.seats.used, p.seats.limit, "people")}`;
  const seats = limitText(p.seats.used, p.seats.limit, "seats");
  if (p.status === "grace" && p.license) return `${name} · ${seats} · renewal overdue, grace until ${date(p.license.grace_ends_at)}`;
  const days = p.license ? Math.ceil((p.license.expires_at - now) / DAY_MS) : null;
  return `${name} · ${seats}${days !== null && days <= 7 ? ` · renews in ${Math.max(0, days)} day${days === 1 ? "" : "s"}` : ""}`;
}

/** The multi-line `walkie license` view. */
export function renderLicense(p: PlanView, now = Date.now()): string {
  const lines = [`${c.bold("plan")}      ${planLine(p, now)}`];
  lines.push(`${c.bold("people")}    ${limitText(p.seats.used, p.seats.limit, "")}`.trimEnd());
  lines.push(`${c.bold("machines")}  ${limitText(p.machines.used, p.machines.limit, "")}`.trimEnd());
  if (p.license) {
    const l = p.license;
    const state = now > l.grace_ends_at ? c.red("expired (grace over: Free limits apply)")
      : now > l.expires_at ? c.yellow(`expired, grace until ${date(l.grace_ends_at)}`) : `expires ${date(l.expires_at)} (renews automatically)`;
    lines.push(`${c.bold("license")}   ${PLAN_NAME[l.plan]}, ${l.seats} seats, billed per ${l.interval} · ${l.email}`);
    lines.push(`${c.bold("status")}    ${state}`);
  } else if (p.trial) {
    lines.push(`${c.bold("trial")}     ends ${date(p.trial.ends_at)} (${p.trial.days_left} days left)`);
  }
  if (p.status !== "active") lines.push(`${c.bold("upgrade")}   walkie upgrade   ${c.dim(p.upgrade_url)}`);
  if (p.license) lines.push(`${c.bold("manage")}    ${c.dim(p.manage_url)}`);
  return lines.join("\n");
}

/** Friendly text for a 402 plan_limit (invite, channel, join approval): what's used and where to upgrade. */
export function planLimitText(err: WalkieError): string | null {
  if (err.code !== "plan_limit") return null;
  const d = err.details as Partial<PlanLimitDetails> | undefined;
  const plan = d?.plan ? PLAN_NAME[d.plan] : "current";
  const url = typeof d?.upgrade_url === "string" ? d.upgrade_url : "walkie upgrade";
  const what = d?.resource === "restricted_channels"
    ? `Restricted channels need the Team plan (this team is on ${plan}).`
    : d?.resource && typeof d.limit === "number"
      ? d.resource === "boards"
        ? `Each project includes ${d.limit} boards (this one has ${d.used ?? "?"}); every extra board is a $15/month add-on.`
        : `Your ${plan} plan includes ${d.limit} ${d.resource === "people" ? (d.limit === 1 ? "person" : "people") : d.resource === "projects" && d.limit === 1 ? "project" : d.resource} (${d.used ?? "?"} in use).`
      : err.message;
  // FINAL Codex 1: a subscriber adds seats to its subscription in the billing portal, never through a second checkout.
  if (d?.subscribed) return `${what} Nothing was removed. You already subscribe: add seats in the billing portal.\nbilling portal: ${c.bold(url)}`;
  return `${what} Nothing was removed; adding more needs an upgrade.\nupgrade: ${c.bold(url)}`;
}

export async function license(ctx: Ctx): Promise<number> {
  const sub = ctx.args.pos[0];
  const client = ctx.client();
  if (sub === undefined || sub === "show") {
    const p = await client.license();
    ctx.out(ctx.json ? JSON.stringify(p) : renderLicense(p));
    return EXIT.ok;
  }
  if (sub === "refresh") {
    const res = await client.refreshLicense();
    if (ctx.json) { ctx.out(JSON.stringify(res)); return EXIT.ok; }
    const p = res.plan ?? await client.license();
    const said: Record<string, string> = {
      refreshed: c.green("license refreshed"), renewed: c.green("license renewed"), unchanged: c.dim("already current"),
      superseded: c.yellow("another license was activated meanwhile; nothing changed"),
    };
    ctx.out(`${said[res.outcome] ?? res.outcome} · ${planLine(p)}`);
    return EXIT.ok;
  }
  if (sub !== "activate") throw new UsageError(`unknown license subcommand: ${sub} (show | activate <code> | refresh)`);
  const key = need(ctx.args, 1, "activation code or license key");
  const res = await client.activateLicense(key);
  if (ctx.json) { ctx.out(JSON.stringify(res)); return EXIT.ok; }
  if ("queued" in res) {
    ctx.out(c.yellow("queued: the roster authority is offline; the license is recorded when it comes back"));
    return EXIT.ok;
  }
  const p = res.plan ?? await client.license();
  ctx.out(`${res.event ? c.green("license activated") : c.dim("already active")} · ${planLine(p)}`);
  if (res.renewal === "missing") {
    ctx.out(c.yellow("no renewal token on this machine: the license won't renew by itself. If the team's code was activated elsewhere, copy ~/.walkie/license-renew-token from there, or email support."));
  }
  return EXIT.ok;
}

/**
 * `walkie upgrade`: a team that already subscribes (an active license) goes to the billing portal, where
 * the seat count is changed on the existing subscription (FINAL Codex 1: never a second checkout);
 * a team positively known to have no active license gets checkout for its people count (a lapsed
 * license's id rides along so the site can refuse a duplicate too). When the plan can't be read (no
 * daemon, a timeout, no team on this machine) it FAILS CLOSED (FINAL-2 Codex 2): a subscriber whose
 * daemon happens to be stopped is never handed a second subscription.
 */
export async function upgrade(ctx: Ctx): Promise<number> {
  const plan = str(ctx.args, "plan") ?? "team";
  const interval = str(ctx.args, "interval") ?? "month";
  if (plan !== "team" && plan !== "business") throw new UsageError("--plan must be team or business");
  if (interval !== "month" && interval !== "year") throw new UsageError("--interval must be month or year");
  let seats = Number(str(ctx.args, "seats") ?? "0");
  if (!Number.isInteger(seats) || seats < 0) throw new UsageError("--seats must be a whole number");
  let current: PlanView;
  try {
    current = await ctx.client().license();
  } catch (err) {
    const why = err instanceof WalkieError ? err.code : "error";
    if (ctx.json) ctx.out(JSON.stringify({ error: "plan_unavailable", reason: why, portal: MANAGE_URL }));
    else ctx.err(`${c.red("walkie upgrade:")} can't read your plan (${why}); if you already pay, manage seats at ${c.bold(MANAGE_URL)}; if not, run \`walkie upgrade\` again with the daemon running${why === "no_team" ? " on a machine that is in the team" : " (walkie daemon start)"}.`);
    return why === "daemon_unreachable" ? EXIT.unreachable : EXIT.error;
  }
  if (!seats) seats = current.seats.used;
  const portal = current.status === "active" ? current.manage_url : null;
  const url = portal ?? checkoutUrl(plan, interval, Math.max(1, seats), current.license?.lic_id);
  if (ctx.json) ctx.out(JSON.stringify(portal ? { url, portal: true, plan: current.plan, seats: current.seats } : { url }));
  else if (portal) ctx.out(`this team already subscribes (${planLine(current)}): change the seat count in the billing portal, not a new checkout:\n  ${c.bold(url)}`);
  else ctx.out(`checkout (${plan}, per ${interval}, ${Math.max(1, seats)} seats):\n  ${c.bold(url)}`);
  if (!ctx.json && !bool(ctx.args, "no-open")) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    if (Bun.which(opener)) Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
  }
  return EXIT.ok;
}
