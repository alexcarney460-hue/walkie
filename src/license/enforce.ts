// Soft plan enforcement (docs/BUSINESS.md "Soft enforcement"). Checked ONLY where the roster authority
// is about to EMIT a roster event (and before it queues a join for approval): it never removes a
// member, machine, channel or any history, and it plays no part in any node's validity rules.
// Hitting a limit blocks only adding more, with 402 `plan_limit` and a checkout link.
import { z } from "zod";
import type { BodyOf, PlanLimitDetails } from "../protocol/schemas.ts";
import { HttpError } from "../daemon/http.ts";
import { seatsChannelNode } from "../protocol/seats.ts";
import { activeNodes, integrationInUse, integrationsUsed, type Roster } from "../daemon/roster.ts";
import { effective, upgradeUrl, type Effective } from "./plans.ts";

export function peopleUsed(r: Roster): number {
  let n = 0;
  for (const m of r.members.values()) if (m.role !== "removed") n++;
  return n;
}

export function machinesUsed(r: Roster): number { return activeNodes(r).length; }

export function restrictedChannels(r: Roster): number {
  let n = 0;
  for (const c of r.channels.values()) if (c.members) n++;
  return n;
}

export function effectiveFor(r: Roster, now: number, clock = now): Effective {
  return effective(r.license, r.team?.created_ts ?? null, now, clock);
}

export class PlanLimitError extends HttpError {
  constructor(readonly limit: PlanLimitDetails) {
    super(402, "plan_limit", planLimitMessage(limit), { ...limit });
  }
}

const RESOURCE_TEXT: Record<PlanLimitDetails["resource"], string> = {
  people: "people", machines: "machines", restricted_channels: "restricted channels", integrations: "integrations",
  projects: "projects", boards: "boards per project",
};

export function planLimitMessage(d: PlanLimitDetails): string {
  const plan = d.plan === "free" ? "Free" : d.plan === "team" ? "Team" : "Business";
  if (d.resource === "restricted_channels") return `restricted channels need the Team plan (this team is on ${plan}); upgrade: ${d.upgrade_url}`;
  if (d.resource === "boards") return `each project includes ${d.limit} boards (this one has ${d.used}); every extra board is a $15/month add-on: ${d.upgrade_url}`;
  return `the ${plan} plan includes ${d.limit} ${RESOURCE_TEXT[d.resource]} (${d.used} in use); nothing was removed. Upgrade: ${d.upgrade_url}`;
}

function limitHit(e: Effective, r: Roster, resource: PlanLimitDetails["resource"], limit: number, used: number, seats: number): PlanLimitDetails {
  return { resource, limit, used, plan: e.plan, subscribed: e.status === "active", upgrade_url: upgradeUrl(e, seats, r.license) };
}

/**
 * The limit a roster event the authority is about to emit would exceed, or null. Only ADDING counts:
 * a new person (or re-inviting a removed one), admitting a machine that isn't active, creating a
 * restricted channel or restricting a public one. Role changes, removals, revocations, re-pins,
 * topic/archive/member edits of an existing restricted channel, licenses and transfers never do.
 */
export function planLimitFor(r: Roster, kind: string, body: Record<string, unknown>, now: number, clock = now): PlanLimitDetails | null {
  const e = effectiveFor(r, now, clock);
  const people = peopleUsed(r);
  if (kind === "team.member") {
    const b = body as BodyOf<"team.member">;
    const existing = r.members.get(b.login);
    const adds = b.role !== "removed" && (!existing || existing.role === "removed");
    const limit = e.entitlements.people;
    if (adds && limit !== null && people + 1 > limit) return limitHit(e, r, "people", limit, people, people + 1);
    return null;
  }
  if (kind === "team.node") {
    const b = body as BodyOf<"team.node">;
    const active = activeNodes(r).some((n) => n.node_id === b.node_id);
    const limit = e.entitlements.machines;
    const used = machinesUsed(r);
    if (b.revoked !== true && !active && limit !== null && used + 1 > limit) return limitHit(e, r, "machines", limit, used, people);
    return null;
  }
  if (kind === "channel.upsert") {
    const b = body as BodyOf<"channel.upsert">;
    if (b.members === undefined || e.entitlements.restricted_channels) return null;
    const prev = r.channels.get(b.name);
    // A machine's seats channel carries seat requests and its host's own posts only (roster.ts seatsChannelContent,
    // every replica), so it is no general restricted channel: seats work on every plan, Free included. Only for an
    // active machine of a current member, with that member in it and every member current (SEATS-FIX-8).
    // Only a MARKED seats channel (PRE4 delta, Codex+Opus): the mark is what makes every replica apply the content rule,
    // so an unmarked `seats-<own node>` channel is an ordinary restricted channel (a free private chat otherwise).
    const seatsNode = seatsChannelNode(b.name);
    const marked = b.seats === true || prev?.seats === true;
    if (seatsNode && marked && b.public !== true && seatsExemptionOk(r, seatsNode, b.members)) return null;
    if (prev?.members) return null; // already restricted: editing it keeps working on any plan
    return limitHit(e, r, "restricted_channels", 0, restrictedChannels(r), people);
  }
  if (kind === "team.integration") {
    // Enabling a connector nobody on the team has enabled adds one integration (F3); the same connector
    // on another machine, and disabling, never do.
    const b = body as BodyOf<"team.integration">;
    const limit = e.entitlements.integrations;
    const used = integrationsUsed(r);
    if (b.enabled && !integrationInUse(r, b.connector) && limit !== null && used + 1 > limit) return limitHit(e, r, "integrations", limit, used, people);
    return null;
  }
  return null;
}

const PeerPlanLimit = z.object({
  resource: z.enum(["people", "machines", "restricted_channels", "integrations", "projects", "boards"]),
  limit: z.number().int().nonnegative().max(1_000_000),
  used: z.number().int().nonnegative().max(1_000_000),
  plan: z.enum(["free", "team", "business"]),
  subscribed: z.boolean().optional(),
});

/**
 * The details of a `plan_limit` refusal relayed from the authority (untrusted peer data): the numbers
 * are validated and the upgrade link is rebuilt locally from OUR view of the chain's license (the
 * portal when it is active, else checkout), so a peer can't plant a URL in our UI.
 */
export function planLimitFromPeer(raw: unknown, r: Roster, now: number, clock = now): PlanLimitDetails | undefined {
  const p = PeerPlanLimit.safeParse(raw);
  if (!p.success) return undefined;
  const d = p.data;
  const seats = d.resource === "people" ? d.used + 1 : Math.max(1, d.used);
  const e = effectiveFor(r, now, clock);
  const { subscribed: _s, ...rest } = d;
  return { ...rest, subscribed: e.status === "active", upgrade_url: upgradeUrl({ ...e, plan: d.plan }, seats, r.license) };
}

/** Throws 402 `plan_limit` if the roster event would exceed the team's plan (authority emit path). */
export function assertPlanAllows(r: Roster, kind: string, body: Record<string, unknown>, now: number, clock = now): void {
  const hit = planLimitFor(r, kind, body, now, clock);
  if (hit) throw new PlanLimitError(hit);
}

/**
 * For the integrations code: throws 402 `plan_limit` unless the plan allows `count` integrations
 * enabled at once (count = how many would be enabled, the new one included). Free allows 1; Team,
 * Business and the trial allow all. Disabling is never limited, so call it only when enabling.
 */
export function assertIntegrationAllowed(core: { readonly roster: Roster; planNow?(): number; readonly clock?: () => number }, count: number, now = core.planNow ? core.planNow() : Date.now()): void {
  const e = effectiveFor(core.roster, now, core.clock ? core.clock() : now);
  const limit = e.entitlements.integrations;
  if (limit === null || count <= limit) return;
  throw new PlanLimitError(limitHit(e, core.roster, "integrations", limit, Math.max(0, count - 1), peopleUsed(core.roster)));
}

/** An active (unrevoked) machine whose member is current, in the channel, with only current members besides. */
function seatsExemptionOk(r: Roster, node: string, members: readonly string[] | null | undefined): boolean {
  const n = activeNodes(r).find((x) => x.node_id === node);
  const host = n ? r.members.get(n.login) : undefined;
  if (!n || !host || host.role === "removed" || !members?.includes(host.handle)) return false;
  const current = new Set([...r.members.values()].filter((m) => m.role !== "removed").map((m) => m.handle));
  return members.every((m) => current.has(m));
}
