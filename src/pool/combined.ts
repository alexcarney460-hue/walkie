// "With all our machines together" (WALKIE-POOL-2): the largest open-weight model the team's online machines could
// run split across all of them, wherever they are, and what can be started from this machine right now (this machine
// plus the machines whose owners share them, each within its cap). Estimates only; `walkie pool run` / the dashboard's
// "Run it split" starts one (src/pool/run/).
//
// The runtime is llama.cpp RPC: the head (the machine that starts the run) runs llama-server and every other machine
// an rpc-server. rpc-servers never talk to each other, so each token pays one round trip from the head to EVERY remote
// stage, whatever order the stages are in: per token = compute of each stage (its share of the bytes read per token
// over its memory bandwidth) + Σ over remote stages (round trip head->stage + HOP_OVERHEAD_MS). The order of stages
// doesn't change that sum; the head does, so the suggestion names the head with the smallest total. Round trips
// between two other machines come from their own published measurements (`stats.peer_rtt`), else the upper bound
// rtt(me,A) + rtt(me,B) (labelled "via this machine"), else UNMEASURED_RTT_MS. docs/PROTOCOL.md §3 "Split runs".
import { gb } from "../protocol/machine-stats-format.ts";
import { CPU_MEMORY, machineCapacity, type Backend, type MachineCapacity } from "./capacity.ts";
import { CATALOG, type Catalog } from "./catalog.ts";
import type { GroupInput } from "./group.ts";
import {
  candidates, ctxText, deviceSlot, EFFICIENCY, fastest, hopMs, place, quantText, roomiest, SPEED_RANK, speedClass,
  type Candidate, type Part, type Pick, type SpeedClass,
} from "./suggest.ts";

/** A pair of machines nobody measured (a mixed team's relay-only peer, say): a cautious internet round trip. */
export const UNMEASURED_RTT_MS = 50;

export type RttHow = "measured" | "via-this-machine" | "unmeasured";
export interface Rtt { ms: number; how: RttHow }

/** Round trip between two machines of the team (see the file comment for the sources, best first). */
export function rttBetween(a: GroupInput, b: GroupInput): Rtt {
  if (a.node_id === b.node_id) return { ms: 0, how: "measured" };
  if (a.self && b.rtt_ms !== null) return { ms: b.rtt_ms, how: "measured" };
  if (b.self && a.rtt_ms !== null) return { ms: a.rtt_ms, how: "measured" };
  const ab = a.stats?.peer_rtt?.[b.node_id];
  const ba = b.stats?.peer_rtt?.[a.node_id];
  if (ab !== undefined || ba !== undefined) {
    const known = [ab, ba].filter((x): x is number => typeof x === "number");
    return { ms: Math.round(known.reduce((s, x) => s + x, 0) / known.length), how: "measured" };
  }
  if (a.rtt_ms !== null && b.rtt_ms !== null) return { ms: a.rtt_ms + b.rtt_ms, how: "via-this-machine" };
  return { ms: UNMEASURED_RTT_MS, how: "unmeasured" };
}

export interface Hop { node_id: string; hostname: string; ms: number; how: RttHow }

export interface CombinedPick extends Pick {
  /** The machine that should start it (runs llama-server): the smallest total round trip to the other stages. */
  head: { node_id: string; hostname: string; self: boolean };
  /** One per remote stage (every placement machine but the head). */
  hops: Hop[];
  /** Per token, ms: the stages' compute, and the network (round trips + per-hop overhead). */
  computeMs: number;
  hopMs: number;
  /** Some round trip wasn't measured between those two machines (see `hops[].how`). */
  estimated: boolean;
  /** When the best head is another machine: the speed if it is started from this one instead. */
  fromHere: { tokensPerSec: number; speed: SpeedClass; hopMs: number } | null;
}

export interface CombinedSuggestion {
  /** Every online machine that reported memory, every member's. */
  machines: MachineCapacity[];
  /** Σ what each contributes (one backend each) free now. */
  usable: number;
  pick: CombinedPick | null;
  /** Machines in `pick` (not this one) whose owners haven't turned sharing on. */
  notSharing: string[];
  /** Machines (not this one) whose owners share them, the runtime installed. */
  sharing: string[];
  /** What this machine can start now: itself + the sharing machines, each within its cap (head = this machine). */
  runnable: CombinedPick | null;
  /** Why `runnable` is missing, or smaller than `pick`. */
  runnableNote: string | null;
}

interface Stage { part: Part; input: GroupInput }

function computeMs(c: Candidate, parts: readonly Part[]): number {
  return parts.reduce((s, p) => s + ((p.share / c.need) * c.bpt) / (EFFICIENCY * p.s.b.bandwidth * 1e9), 0) * 1000;
}

function hopsFrom(head: GroupInput, stages: readonly Stage[]): Hop[] {
  return stages.filter((st) => st.input.node_id !== head.node_id).map((st) => {
    const r = rttBetween(head, st.input);
    return { node_id: st.input.node_id, hostname: st.input.hostname, ms: r.ms, how: r.how };
  });
}

const hopTotal = (hops: readonly Hop[]): number => hops.reduce((s, h) => s + hopMs(h.ms), 0);
const tpsOf = (compute: number, hop: number): number => 1000 / (compute + hop);

function build(c: Candidate, parts: Part[], inputs: ReadonlyMap<string, GroupInput>, heads: readonly GroupInput[], context: number, have: number): CombinedPick | null {
  const stages: Stage[] = parts.map((part) => ({ part, input: inputs.get(part.s.m.node_id)! }));
  const compute = computeMs(c, parts);
  const self = heads.find((h) => h.self) ?? null;
  const scored = heads.map((h) => ({ h, hops: hopsFrom(h, stages) })).map((x) => ({ ...x, total: hopTotal(x.hops) }));
  if (!scored.length) return null;
  // Smallest total; this machine wins a tie (the run starts here without anyone else doing anything).
  scored.sort((a, b) => a.total - b.total || Number(b.h.self) - Number(a.h.self));
  const best = scored[0]!;
  const here = self && best.h.node_id !== self.node_id ? scored.find((x) => x.h.node_id === self.node_id) ?? null : null;
  const tps = tpsOf(compute, best.total);
  const need = parts.reduce((s, p) => s + p.bytes, 0);
  const runtimes = parts.length > 1 ? `, ${parts.length} runtimes` : "";
  const where = parts.map((p) => (p.s.b.memory === CPU_MEMORY ? `${p.s.m.hostname} (CPU)` : p.s.m.hostname)).join(", ");
  return {
    model: c.model, quant: c.quant, need, have, fits: true, pooled: parts.length > 1,
    placement: parts.map((p) => ({ node_id: p.s.m.node_id, hostname: p.s.m.hostname, handle: p.s.m.handle, bytes: p.bytes, memory: p.s.b.memory })),
    tokensPerSec: tps, speed: speedClass(tps),
    why: `Needs ${gb(need)} GB (${quantText(c.quant)}, ${ctxText(context)}${runtimes}); ${gb(have)} GB free now across ${parts.length === 1 ? where : `${parts.length} machines: ${where}`}`,
    head: { node_id: best.h.node_id, hostname: best.h.hostname, self: best.h.self },
    hops: best.hops, computeMs: compute, hopMs: best.total, estimated: best.hops.some((h) => h.how !== "measured"),
    fromHere: here ? { tokensPerSec: tpsOf(compute, here.total), speed: speedClass(tpsOf(compute, here.total)), hopMs: here.total } : null,
  };
}

/** The largest candidate `machines` hold together (8-bit before 4-bit, unless the 8-bit one is slow and 4-bit faster). */
/** The whole model on one machine's fastest backend that holds it (POOL-REAL-1 "serve on the best machine"). */
function onOne(c: Candidate, machines: readonly MachineCapacity[]): Part[] | null {
  const slots = machines.flatMap((m) => m.backends.map((b) => ({ m, b }))).filter((x) => x.b.usable >= c.need);
  const best = slots.sort((a, b) => b.b.bandwidth - a.b.bandwidth)[0];
  return best ? [{ s: best, bytes: c.need, share: c.need }] : null;
}

function largest(cands: readonly Candidate[], machines: readonly MachineCapacity[], inputs: ReadonlyMap<string, GroupInput>, heads: (parts: Part[]) => GroupInput[], context: number, overhead: number, keepOrder = false, single = false, runnable = false): CombinedPick | null {
  const have = machines.reduce((s, m) => s + (runnable ? deviceSlot(m) : roomiest(m, "usable")).b.usable, 0);
  const pickFor = (c: Candidate): CombinedPick | null => {
    // What this machine can start now is placed exactly as `walkie pool run` places it: each machine's first device
    // (POOL-REAL-1 p8-5); the whole-team estimate may also count a machine's system RAM on its CPU.
    const parts = runnable ? place(c.need, machines, "usable", overhead, (m) => deviceSlot(m), keepOrder)
      : place(c.need, machines, "usable", overhead, fastest, keepOrder) ?? place(c.need, machines, "usable", overhead, roomiest, keepOrder);
    const split = parts ? build(c, parts, inputs, heads(parts), context, have) : null;
    // A split only when it is needed: a model one machine holds runs there when that is at least as fast.
    const one = single ? onOne(c, machines) : null;
    const whole = one ? build(c, one, inputs, heads(one), context, have) : null;
    if (whole && (!split || !split.pooled || whole.tokensPerSec >= split.tokensPerSec)) return whole;
    return split;
  };
  // POOL-REAL-1: the largest candidate that isn't slow; only when every one that fits is slow, the largest of those.
  let slow: CombinedPick | null = null;
  for (const c of cands) {
    let p = pickFor(c);
    if (!p) continue;
    if (p.quant !== "q4" && p.speed === "slow") {
      const q4 = cands.find((x) => x.model.id === c.model.id && x.quant === "q4");
      const alt = q4 ? pickFor(q4) : null;
      if (alt && SPEED_RANK[alt.speed] < SPEED_RANK[p.speed]) p = alt;
    }
    if (p.speed !== "slow") return p;
    slow ??= p;
  }
  return slow;
}

/** A machine as a split run could use it: every backend's "free now" capped at what its owner shares. */
export function capped(m: MachineCapacity, cap: number | null): MachineCapacity {
  if (cap === null) return m;
  const backends: Backend[] = m.backends.map((b) => ({ ...b, usable: Math.min(b.usable, cap) }));
  return { ...m, backends, usable: Math.max(...backends.map((b) => b.usable)) };
}

/**
 * The head first (its part costs no network hop), then the others largest-first: a model that fits on the head stays
 * there, and a bigger one uses as few other machines as it can.
 */
export function headFirst(caps: readonly MachineCapacity[], headId: string): MachineCapacity[] {
  // Ordered by what each machine's device holds (the rule the run uses), not its largest backend (system RAM).
  const free = (m: MachineCapacity) => deviceSlot(m).b.usable;
  return [...caps.filter((m) => m.node_id === headId), ...caps.filter((m) => m.node_id !== headId).sort((a, b) => free(b) - free(a))];
}

/** Sharing, with the runtime, and not busy with another run: a machine this one may ask for a stage. */
export function canServe(n: GroupInput): boolean {
  return !!n.pool && n.pool.share && n.pool.runtime && !n.pool.busy;
}

export function suggestCombined(nodes: readonly GroupInput[], opts: { cat?: Catalog; context?: number } = {}): CombinedSuggestion {
  const cat = opts.cat ?? CATALOG;
  const context = opts.context ?? cat.context_tokens;
  const overhead = cat.overhead_gib * 1024 ** 3;
  const cands = candidates(cat, context);
  const online = nodes.filter((n) => n.online);
  const inputs = new Map(online.map((n) => [n.node_id, n] as const));
  const caps = online.flatMap((n) => { const c = machineCapacity(n); return c ? [c] : []; });
  const self = online.find((n) => n.self) ?? null;
  const usable = caps.reduce((s, m) => s + roomiest(m, "usable").b.usable, 0);

  // Anyone in the placement (or this machine) may be the head of the whole-team answer.
  const anyHead = (parts: Part[]): GroupInput[] => {
    const ids = new Set(parts.map((p) => p.s.m.node_id));
    if (self) ids.add(self.node_id);
    return [...ids].map((id) => inputs.get(id)!).filter(Boolean);
  };
  const pick = caps.length ? largest(cands, caps, inputs, anyHead, context, overhead, false, true) : null;
  const sharing = online.filter((n) => !n.self && canServe(n)).map((n) => n.hostname);
  const notSharing = pick ? pick.placement.filter((p) => { const n = inputs.get(p.node_id); return !!n && !n.self && !canServe(n); }).map((p) => p.hostname) : [];

  let runnable: CombinedPick | null = null;
  let runnableNote: string | null = null;
  const selfCap = self ? caps.find((m) => m.node_id === self.node_id) ?? null : null;
  if (!self) runnableNote = "This machine isn't in the team yet";
  else if (!self.pool?.runtime) runnableNote = "Install the runtime on this machine first: walkie pool install";
  else {
    const helpers = online.filter((n) => !n.self && canServe(n))
      .flatMap((n) => { const c = caps.find((m) => m.node_id === n.node_id); return c ? [capped(c, n.pool?.cap ?? null)] : []; });
    // This machine first (no hop for its part), then the helpers largest-first: what `walkie pool run` places.
    // A head without an accelerator holds no layers in a run (v1), so the estimate doesn't count it either.
    const machines = headFirst([...(selfCap && selfCap.kind !== "cpu" ? [selfCap] : []), ...helpers], self.node_id);
    runnable = machines.length ? largest(cands, machines, inputs, () => [self], context, overhead, true, false, true) : null;
    if (!runnable) runnableNote = "Nothing in the catalog fits in the memory this machine and the sharing machines have free";
    else if (pick && (runnable.model.params_b < pick.model.params_b) && notSharing.length) {
      runnableNote = `The bigger pick needs ${notSharing.join(", ")} to share (its owner runs: walkie pool share on)`;
    }
  }
  return { machines: caps, usable, pick, notSharing, sharing, runnable, runnableNote };
}
