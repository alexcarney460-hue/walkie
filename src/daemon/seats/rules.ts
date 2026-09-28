// Which seat requests a host acts on (PROTOCOL §11, SECURITY.md threat 13). Pure: no I/O.
import type { Event } from "../../protocol/schemas.ts";
import {
  parseLauncher, seatOf, seatsChannel, type LauncherEntry, type SeatRun, type SeatRuntime, type SeatStop,
} from "../../protocol/seats.ts";
import { nodeMember, type ChannelRec, type Roster } from "../roster.ts";

/** What a host's config says about seats (config.json `seats`, parsed). */
export interface SeatsPolicy {
  allow: boolean;
  /** Parsed launcher entries; null = the team's owners at the time of each request. */
  launchers: LauncherEntry[] | null;
  runtimes: readonly SeatRuntime[];
}

export type Refusal = { ok: false; reason: string; /** Posting the refusal back is safe (the channel is private). */ answer: boolean };
export type RunDecision = { ok: true; run: SeatRun; launcher: string } | Refusal;
/** `hostPerson`: the host machine's own person, in person (who may stop any seat there; others only their own). */
export type StopDecision = { ok: true; stop: SeatStop; launcher: string; hostPerson: boolean } | Refusal;

function refuse(reason: string, answer = true): Refusal { return { ok: false, reason, answer }; }

/** Handles allowed in the seats channel besides the host's person: the launchers' people. */
export function launcherHandles(r: Roster, policy: SeatsPolicy): string[] {
  const out = new Set<string>();
  if (policy.launchers) {
    for (const e of policy.launchers) {
      const m = [...r.members.values()].find((x) => x.handle === e.handle);
      if (m && m.role !== "removed" && m.role !== "observer") out.add(e.handle);
    }
  } else {
    for (const m of r.members.values()) if (m.role === "owner") out.add(m.handle);
  }
  return [...out].sort();
}

/** The members the host's seats channel should have: its person first, then the launchers' people (max 50). */
export function desiredMembers(r: Roster, me: string, policy: SeatsPolicy): string[] {
  return [me, ...launcherHandles(r, policy).filter((h) => h !== me)].slice(0, 50);
}

/**
 * The channel is fit to carry seats: marked a seats channel, restricted, not archived, holds the host's person, and nobody else but the
 * launchers' people (a teammate added by an owner would read every prompt and all output: the host then does
 * nothing there until it is narrowed again).
 */
export function channelFit(ch: ChannelRec | undefined, me: string, allowed: readonly string[]): string | null {
  if (!ch) return "channel_missing";
  // Marked as a seats channel (`seats: true`, PRE4 delta, Opus 4): only then does every replica apply the seats
  // content rule. An unmarked one (an older authority that dropped the mark) runs no seat: fail closed.
  if (!ch.seats) return "channel_unmarked";
  if (!ch.members) return "channel_not_private";
  if (ch.archived) return "channel_archived";
  if (!ch.members.includes(me)) return "channel_without_host";
  const ok = new Set([me, ...allowed]);
  const extra = ch.members.filter((h) => !ok.has(h));
  return extra.length ? "channel_too_wide" : null;
}

/**
 * The author may launch or stop here: signed by an admitted, non-observer machine of the author's own login, and
 * - a person (no `author.agent`): listed (`@h`, or `@h/<that machine>`), or, with no list, an owner right now;
 * - an agent: only when the host lists exactly `@h/<that machine>/<agent>` (never by default).
 */
export function launcherAllowed(ev: Event, r: Roster, policy: SeatsPolicy): string | null {
  if (ev.author.node !== ev.origin) return "author_node_mismatch";
  const member = nodeMember(r, ev.origin);
  if (!member || member.handle !== ev.author.handle) return "node_not_admitted";
  if (member.role === "observer") return "observer";
  const hostname = r.nodes.get(ev.origin)?.hostname;
  const agent = ev.author.agent;
  if (agent !== undefined) {
    const listed = policy.launchers?.some((e) => e.handle === member.handle && e.machine === hostname && e.agent === agent);
    return listed ? null : "agent_not_allowed";
  }
  if (policy.launchers) {
    const listed = policy.launchers.some((e) => e.agent === undefined && e.handle === member.handle && (e.machine === undefined || e.machine === hostname));
    return listed ? null : "not_a_launcher";
  }
  return member.role === "owner" ? null : "not_a_launcher";
}

/** The host machine's own person, in person (no agent), signed by one of their admitted machines. */
function hostPerson(ev: Event, ctx: DecideCtx): boolean {
  const member = nodeMember(ctx.roster, ev.origin);
  return ev.author.agent === undefined && ev.author.node === ev.origin && member?.handle === ctx.me && ev.author.handle === ctx.me && member.role !== "observer";
}

/** How far ahead of the host's clock a request may be dated (clock skew between machines). */
export const MAX_FUTURE_SKEW_MS = 2 * 60_000;

export interface DecideCtx {
  roster: Roster;
  /** This host: node id and its person's handle. */
  node: string;
  me: string;
  policy: SeatsPolicy;
  now: number;
  maxAgeMs: number;
  /**
   * Re-judging a launch that was fresh when it arrived and then waited in the busy queue: everything is checked
   * again (the launcher may have lost the right meanwhile) except its age.
   */
  queued?: boolean;
}

/** Common checks for a seat request post in this host's channel; null when the post is not a request for it. */
function common(ev: Event, ctx: DecideCtx): Refusal | "run" | "stop" | null {
  if (ev.kind !== "msg.post" || ev.channel !== seatsChannel(ctx.node)) return null;
  const seat = seatOf(ev.body);
  if (!seat || (seat.op !== "run" && seat.op !== "stop")) return null;
  if (ev.origin === ctx.node && ev.author.agent === "seats") return null; // our own answers
  // The host itself must be an admitted, non-observer member right now (Codex r2 HIGH 1): a demoted host runs
  // nothing, and answers nothing (an observer's posts would be refused anyway).
  const host = nodeMember(ctx.roster, ctx.node);
  if (!host || host.role === "observer" || host.handle !== ctx.me) return refuse("host_not_admitted", false);
  const unfit = channelFit(ctx.roster.channels.get(ev.channel), ctx.me, launcherHandles(ctx.roster, ctx.policy));
  if (unfit) return refuse(unfit, false);
  if (!ctx.policy.allow) return refuse("seats_not_allowed");
  // The machine's own person may always stop what runs on it (from any of their machines, in person).
  const who = seat.op === "stop" && hostPerson(ev, ctx) ? null : launcherAllowed(ev, ctx.roster, ctx.policy);
  if (who) return refuse(who);
  if (!ctx.queued && ctx.now - ev.ts > ctx.maxAgeMs) return refuse("stale");
  // A request dated ahead would stay "fresh" past its real age limit (Opus LOW 5).
  if (!ctx.queued && ev.ts - ctx.now > MAX_FUTURE_SKEW_MS) return refuse("future");
  return seat.op;
}

export function decideRun(ev: Event, ctx: DecideCtx): RunDecision | null {
  const c = common(ev, ctx);
  if (c === null || c === "stop") return null;
  if (c !== "run") return c;
  const run = seatOf(ev.body) as SeatRun;
  if (!ctx.policy.runtimes.includes(run.runtime)) return refuse("runtime_not_allowed");
  return { ok: true, run, launcher: ev.author.handle };
}

export function decideStop(ev: Event, ctx: DecideCtx): StopDecision | null {
  const c = common(ev, ctx);
  if (c === null || c === "run") return null;
  if (c !== "stop") return c;
  return { ok: true, stop: seatOf(ev.body) as SeatStop, launcher: ev.author.handle, hostPerson: hostPerson(ev, ctx) };
}

/** Parses config launcher strings; invalid entries are dropped (the route validates them before saving). */
export function parseLaunchers(list: readonly string[] | undefined): LauncherEntry[] | null {
  if (!list) return null;
  return list.map(parseLauncher).filter((e): e is LauncherEntry => e !== null);
}
