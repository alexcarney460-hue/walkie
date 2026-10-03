// TALKIE-OPS-1: the orchestration poll's pure part. How much a machine can take now (the seat slots within its caps, memory and
// CPU headroom, accounts with the 10% reserve: what Capacity check read through the CLI) and which waiting work goes to which
// free slot, as recommendations. No I/O: the daemon gathers the facts (poll.ts) and writes what this decides. The machine a
// recommendation names is where a seat could go when the poll ran; approving it chooses again (seatTarget), so its summary
// names the card and the role, not the machine.
import { freshRoomOf, PERSONAL_RESERVE_PCT } from "../../accounts/select.ts";
import type { AccountView } from "../../protocol/accounts.ts";
import { utcMinute } from "../../protocol/projects/status-report.ts";
import { SEAT_RUNTIMES_V1, type SeatRuntime } from "../../protocol/seats.ts";
import { REC_TTL_MS, recKey, recTitle, type NewRec } from "../../protocol/talkie-recs.ts";

/** A machine with less than this free takes no new seat, and nor does one whose processor is busier than this. */
export const FREE_MEM_MIN_BYTES = 2 * 1024 ** 3;
export const CPU_BUSY_MAX_PCT = 85;
/** Seat recommendations of one kind (build, review) per project per run, so one busy project does not take every seat. */
export const PER_PROJECT_CAP = 3;

const H = 3_600_000;

export interface PollMachine {
  node: string; hostname: string; handle: string; online: boolean;
  /** The seat host's latest word; null when it never said. `active` counts what runs, pauses and queues there. */
  seats: { allows: boolean; max: number | null; active: number } | null;
  /** Headroom readings; one that is missing is not a reason to hold work back. */
  mem?: { pressure: "normal" | "warn" | "critical" | null; free: number | null } | null;
  cpuBusyPct?: number | null;
  /** The runtimes this machine can run on (usableRuntimes), roomiest first. */
  runtimes: readonly SeatRuntime[];
}

export interface WaitingWork {
  card: string; channel: string; project: string; prefixes: readonly string[]; title: string;
  role: "build" | "review";
  /** When the card last changed: how long it has waited can only be under-stated by an edit. */
  since: number;
  audience: "team" | "owners";
  /** The runtime of the agent that built it, when the card says: a reviewer prefers another vendor. */
  builderRuntime?: SeatRuntime | null;
  /** Who may see the card's channel (a restricted channel's members); null: everyone. A seat goes only to such a person's machine. */
  viewers?: readonly string[] | null;
}

export interface Capacity { slots: number; usable: boolean; why: string | null }

export function machineCapacity(m: PollMachine): Capacity {
  const held = (why: string, slots = 0): Capacity => ({ slots, usable: false, why });
  if (!m.online) return held("it is offline");
  if (!m.seats || m.seats.max === null) return held("it has not said how many seats it takes");
  if (!m.seats.allows) return held("its seats are turned off");
  if (m.mem && m.mem.pressure !== null && m.mem.pressure !== "normal") return held("its memory is under pressure");
  if (m.mem && m.mem.free !== null && m.mem.free < FREE_MEM_MIN_BYTES) return held("less than 2 GB of memory is free");
  if (m.cpuBusyPct !== null && m.cpuBusyPct !== undefined && m.cpuBusyPct > CPU_BUSY_MAX_PCT) return held("its processor is busy");
  const free = m.seats.max - m.seats.active;
  if (free <= 0) return held(m.seats.max === 1 ? "its only seat is in use" : `all ${m.seats.max} seats are in use`);
  if (!m.runtimes.length) return held(`no account has room beyond the ${PERSONAL_RESERVE_PCT}% reserve`, free);
  return { slots: free, usable: true, why: null };
}

/**
 * The runtimes a machine can run on: an account that machine reports, online now, whose freshest reading (under an hour old)
 * leaves more than the 10% reserve in its fullest window. The roomiest first, each runtime once. Only the two a plain seat
 * request carries (Claude, Codex): the others need a request of their own kind (a brief, full access) that a person writes.
 */
export function usableRuntimes(accounts: readonly AccountView[], node: string, now: number): SeatRuntime[] {
  const best = new Map<SeatRuntime, number>();
  for (const a of accounts) {
    if (!a.machines.some((m) => m.node_id === node && m.online)) continue;
    const room = freshRoomOf(a.usage, null, now);
    if (room === null || room - PERSONAL_RESERVE_PCT <= 0) continue;
    const runtime = a.provider as SeatRuntime;
    if (!(SEAT_RUNTIMES_V1 as readonly string[]).includes(runtime)) continue;
    best.set(runtime, Math.max(best.get(runtime) ?? 0, room));
  }
  return [...best].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map(([runtime]) => runtime);
}

/** "less than an hour", "1 hour", "5 hours", "2 days". */
export function waited(ms: number): string {
  if (ms < H) return "less than an hour";
  const hours = Math.floor(ms / H);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  return `${Math.floor(hours / 24)} days`;
}

const byName = (a: PollMachine, b: PollMachine): number => (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : a.node < b.node ? -1 : a.node > b.node ? 1 : 0);

/**
 * The machine a seat goes to when a person approves its recommendation: the one the poll named while it can still take a seat
 * on that runtime, else the roomiest that can now (the poll's own order), on the same runtime where it has it. Null: no machine can.
 */
export function seatTarget(machines: readonly PollMachine[], want: { machine: string; runtime: SeatRuntime },
  canSee: (handle: string) => boolean = () => true): { node: string; hostname: string; handle: string; runtime: SeatRuntime } | null {
  const free = machines.map((m) => ({ m, cap: machineCapacity(m) })).filter((x) => x.cap.usable && x.cap.slots > 0 && canSee(x.m.handle));
  const same = free.find((x) => x.m.node === want.machine && x.m.runtimes.includes(want.runtime));
  if (same) return { node: same.m.node, hostname: same.m.hostname, handle: same.m.handle, runtime: want.runtime };
  const pick = free.sort((a, b) => b.cap.slots - a.cap.slots || byName(a.m, b.m))[0];
  if (!pick) return null;
  return { node: pick.m.node, hostname: pick.m.hostname, handle: pick.m.handle, runtime: pick.m.runtimes.includes(want.runtime) ? want.runtime : pick.m.runtimes[0] as SeatRuntime };
}

export interface PollPlan {
  recs: NewRec[];
  /** Machines that cannot take work now, with why. */
  machines: Array<{ node: string; hostname: string; slots: number; why: string }>;
  /** Waiting work no free seat was found for (or that a project's cap left for the next run). */
  unplaced: number;
}

export function planPoll(input: { machines: readonly PollMachine[]; waiting: readonly WaitingWork[]; now: number }): PollPlan {
  const machines = [...input.machines].sort(byName);
  const caps = machines.map((m) => ({ m, cap: machineCapacity(m) }));
  const slots = caps.filter((c) => c.cap.usable && c.cap.slots > 0).map((c) => ({ ...c, left: c.cap.slots }));
  const held = caps.filter((c) => c.cap.why !== null)
    .map((c) => ({ node: c.m.node, hostname: c.m.hostname, slots: c.cap.slots, why: c.cap.why as string }));
  const order = [...input.waiting].sort((a, b) =>
    Number(a.role === "build") - Number(b.role === "build") || a.since - b.since || (a.card < b.card ? -1 : a.card > b.card ? 1 : 0));
  const taken = new Map<string, number>();
  const recs: NewRec[] = [];
  for (const w of order) {
    const key = `${w.channel}|${w.role}`;
    if ((taken.get(key) ?? 0) >= PER_PROJECT_CAP) continue;
    const open = slots.filter((s) => s.left > 0);
    if (!open.length) break;
    // A card of a restricted project goes only to a machine whose person can see it.
    const pick = open.filter((s) => !w.viewers || w.viewers.includes(s.m.handle)).sort((a, b) => b.left - a.left || byName(a.m, b.m))[0];
    if (!pick) continue;
    taken.set(key, (taken.get(key) ?? 0) + 1);
    pick.left -= 1;
    const reviewer = w.role === "review";
    const runtime = (reviewer ? pick.m.runtimes.find((r) => r !== w.builderRuntime) : undefined) ?? (pick.m.runtimes[0] as SeatRuntime);
    const age = waited(input.now - w.since);
    const title = recTitle(w.title, w.prefixes);
    const role = reviewer ? "reviewer" as const : "builder" as const;
    recs.push({
      key: recKey.seat(w.card, role), group: reviewer ? "reviews" : "work", source: "poll", audience: w.audience,
      ...(w.audience === "owners" ? { project: w.channel } : {}),
      action: { kind: "start_seat", machine: pick.m.node, runtime, role, card: w.card },
      summary: `Start a ${role} for “${title}”`,
      reason: reviewer ? `It has waited ${age} for review and a machine has a free seat.` : `A machine has a free seat and the work has waited ${age}.`,
      evidence: [
        `when recommended, ${pick.m.hostname} had ${pick.cap.slots} free seat${pick.cap.slots === 1 ? "" : "s"} of ${pick.m.seats?.max ?? "?"} (the machine is chosen again on approval)`,
        `runtime ${runtime}: an account with room beyond the ${PERSONAL_RESERVE_PCT}% reserve`,
        `in ${w.project} since ${utcMinute(w.since)}`,
      ],
      ttl_ms: REC_TTL_MS,
    });
  }
  return { recs, machines: held, unplaced: input.waiting.length - recs.length };
}
