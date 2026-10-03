// "What your team could run locally": per machine and per group of machines, the BEST open-weight model that fits one
// machine (quality first, see catalog.ts compareModels: Hugging Face benchmark ratings, then date and size; not the
// largest one), then what the group could run split across machines (pipeline-parallel, e.g. exo or llama.cpp RPC),
// with a rough speed class. Everything here is an estimate from memory figures; nothing is downloaded or run.
// docs/PROTOCOL.md §3 "Local model suggestions" has the formulas.
import { gb } from "../protocol/machine-stats-format.ts";
import { bytesPerToken, CATALOG, compareModels, memoryNeeded, QUANT_LABEL, QUANTS, rankModels, type Catalog, type CatalogModel, type Quant } from "./catalog.ts";
import { CPU_MEMORY, runtimeBackend, type Backend, type MachineCapacity } from "./capacity.ts";
import { groupMachines, LAN_RTT_MS, type GroupInput, type Grouping, type PoolGroup } from "./group.ts";

/** Share of theoretical memory bandwidth token generation achieves (llama.cpp Apple Silicon results: 0.45–0.84). */
export const EFFICIENCY = 0.6;
/** Per hop between machines on top of the measured round trips: moving activations, synchronisation. */
export const HOP_OVERHEAD_MS = 2;
/**
 * Round trips llama.cpp RPC makes to a remote stage per generated token (POOL-REAL-1, measured on hestia-wsl with a
 * counting proxy between llama-server and rpc-server, Llama 3.1 8B split 1:1: 16 for 16 tokens, 162 for 128), plus
 * about 100 while loading and a dozen on a first request (alloc-size queries it then caches).
 */
export const RPC_ROUND_TRIPS_PER_TOKEN = 1.3;

/** Milliseconds a token spends on one remote stage's network hop. */
export const hopMs = (rttMs: number): number => RPC_ROUND_TRIPS_PER_TOKEN * Math.max(1, rttMs) + HOP_OVERHEAD_MS;
/** tokens/s: at or above FAST reads faster than a person; below USABLE is painful for chat. */
export const SPEED_FAST = 20;
export const SPEED_USABLE = 5;

export type SpeedClass = "fast" | "usable" | "slow";
export const SPEED_RANK: Record<SpeedClass, number> = { fast: 0, usable: 1, slow: 2 };

export interface Placement {
  node_id: string; hostname: string; handle: string; bytes: number;
  /** Which memory it runs from there: "GPU memory", "unified memory", "system memory (CPU)". */
  memory: string;
  /**
   * The speed of this part is the machine's GPU speed (a hardware estimate), but Walkie's own runtime is counted as CPU
   * only there (a DGX Spark, an NVIDIA card on Linux arm64, a machine that did not report its platform): the same speed
   * needs a GPU build of llama.cpp that Walkie does not install. Absent: the part's speed is what Walkie's runtime gets.
   */
  gpuSpeedOnly?: true;
}

export interface Pick {
  model: CatalogModel;
  quant: Quant;
  /** Bytes the model needs (weights + KV cache + overhead). */
  need: number;
  /** Bytes available where it was measured against (one machine, or the group). */
  have: number;
  fits: boolean;
  pooled: boolean;
  placement: Placement[];
  tokensPerSec: number;
  speed: SpeedClass;
  why: string;
}

export interface GroupSuggestion {
  group: PoolGroup;
  /** Bytes free for a model now / if otherwise idle: what each machine contributes to a split, one backend each. */
  usable: number;
  usableIdle: number;
  /** Largest model that fits on one machine of the group. */
  single: Pick | null;
  /** Larger model the group could run split across machines (only when bigger than `single`). */
  pooled: Pick | null;
  /**
   * A faster, smaller pick (at least 1.5x the speed, or a better speed class, in less memory), best rated first; on a
   * CPU pick, the GPU one. null when the best pick is already the smallest and fastest.
   */
  faster: Pick | null;
  /** A faster smaller pick and the next model up that doesn't fit. */
  alternatives: Pick[];
  /**
   * A bigger model if the machines were otherwise idle (only the OS and a few GB of apps; see capacity.ts), when
   * that changes the answer. Not "if the agents stopped": Walkie doesn't attribute memory to agents.
   */
  ifIdle: Pick | null;
}

/** One machine on its own: the best model it runs alone and a faster smaller alternative. */
export interface MachineSuggestion {
  machine: MachineCapacity;
  /** Index of its group in `suggestions`. */
  group: number;
  best: Pick | null;
  faster: Pick | null;
}

export interface TeamSuggestion extends Grouping {
  suggestions: GroupSuggestion[];
  /** Every counted machine on its own (the group's order). */
  machines: MachineSuggestion[];
  /** The group that could run the best model (the Mission Control card shows it). */
  headline: GroupSuggestion | null;
  context: number;
}

export interface Candidate { model: CatalogModel; quant: Quant; need: number; bpt: number }

/** Every (model, format) with a memory figure, best model first (compareModels), 8-bit before 4-bit. */
export function candidates(cat: Catalog = CATALOG, context = cat.context_tokens): Candidate[] {
  const out: Candidate[] = [];
  for (const model of rankModels(cat.models)) {
    for (const quant of QUANTS) {
      const need = memoryNeeded(model, quant, context, cat);
      const bpt = bytesPerToken(model, quant, cat);
      if (need !== null && bpt !== null) out.push({ model, quant, need, bpt });
    }
  }
  return out;
}

export function speedClass(tps: number): SpeedClass {
  return tps >= SPEED_FAST ? "fast" : tps >= SPEED_USABLE ? "usable" : "slow";
}

/** Tokens/s on one machine: generation reads the active weights once per token, so bandwidth bounds it. */
export function singleSpeed(bpt: number, bandwidthGBs: number): number {
  return (EFFICIENCY * bandwidthGBs * 1e9) / bpt;
}

/**
 * Tokens/s split across machines (pipeline): each token passes every stage in turn, so the stages' times add up,
 * plus one network hop between consecutive machines.
 */
export function pooledSpeed(bpt: number, parts: readonly { share: number; bandwidth: number }[], rttMs: number): number {
  const compute = parts.reduce((s, p) => s + (p.share * bpt) / (EFFICIENCY * p.bandwidth * 1e9), 0);
  const hops = Math.max(0, parts.length - 1) * hopMs(rttMs) / 1000;
  return 1 / (compute + hops);
}

export const ctxText = (context: number): string => `${Math.round(context / 1024)}K context`;
export const quantText = (q: Quant): string => QUANT_LABEL[q].split(" ")[0]!;

export type Field = "usable" | "usableIdle";
/** One machine and one way it could run a model. */
export interface Slot { m: MachineCapacity; b: Backend }

/** One machine's part of a pick, flagged when its speed is a GPU's that Walkie's own runtime does not use there. */
export function placementOf(s: Slot, bytes: number): Placement {
  return {
    node_id: s.m.node_id, hostname: s.m.hostname, handle: s.m.handle, bytes, memory: s.b.memory,
    ...(s.b.kind !== "cpu" && runtimeBackend(s.m).kind === "cpu" ? { gpuSpeedOnly: true as const } : {}),
  };
}

export const freeText = (field: Field): string => (field === "usable" ? "free now" : "free if otherwise idle");

function singlePick(c: Candidate, s: Slot, field: Field, context: number): Pick {
  const have = s.b[field];
  const tps = singleSpeed(c.bpt, s.b.bandwidth);
  return {
    model: c.model, quant: c.quant, need: c.need, have, fits: c.need <= have, pooled: false,
    placement: [placementOf(s, c.need)],
    tokensPerSec: tps, speed: speedClass(tps),
    why: `Needs ${gb(c.need)} GB (${quantText(c.quant)}, ${ctxText(context)}); ${s.m.hostname} has ${gb(have)} GB of ${s.b.memory} ${freeText(field)}`,
  };
}

/** Every (machine, backend): a machine with a GPU and system RAM offers both, each considered on its own. */
const slots = (machines: readonly MachineCapacity[]): Slot[] => machines.flatMap((m) => m.backends.map((b) => ({ m, b })));

/**
 * Best candidate that fits on one machine's backend (by `field`), the fastest backend on a tie; with `preferUsable`
 * (POOL-REAL-1) the best one that isn't slow, when any fits: a 32B model on a CPU at 2 tokens/s is not what a
 * machine with a 12 GB GPU should suggest first (the slow better one is listed as an alternative).
 */
function bestSingle(cands: readonly Candidate[], machines: readonly MachineCapacity[], field: Field, context: number, preferUsable: boolean | "gpu" = false): Pick | null {
  const all = slots(machines);
  const onGpu = all.filter((s) => s.b.kind !== "cpu");
  const find = (from: readonly Slot[], usable: boolean): Pick | null => {
    for (const c of cands) {
      const fitting = from.filter((s) => c.need <= s.b[field]).sort((a, b) => b.b.bandwidth - a.b.bandwidth);
      if (!fitting.length) continue;
      const p = singlePick(c, fitting[0]!, field, context);
      if (!usable || p.speed !== "slow") return p;
    }
    return null;
  };
  if (preferUsable === "gpu") return find(onGpu, true);
  return preferUsable ? find(all, true) ?? find(all, false) : find(all, false);
}

/**
 * The backend a split-run part runs on there: llama.cpp puts a stage (rpc-server) or the head's own part on the
 * machine's FIRST device: its GPU (the first one, when it has several) or Apple unified memory; the CPU only when there
 * is no accelerator supported by the pinned runtime. Planning, admission and runnable suggestions use this rule (POOL-REAL-1 p8-3/5).
 */
export function deviceSlot(m: MachineCapacity): Slot {
  const b = runtimeBackend(m);
  return { m, b: b.device ? { ...b, usable: Math.min(b.usable, b.device.usable), usableIdle: Math.min(b.usableIdle, b.device.usableIdle) } : b };
}

/** The backend with the most memory (by `field`), the faster one on a tie: what a machine adds to a split at most. */
export function roomiest(m: MachineCapacity, field: Field): Slot {
  const b = [...m.backends].sort((x, y) => y[field] - x[field] || y.bandwidth - x.bandwidth)[0]!;
  return { m, b };
}

/** The fastest backend with any memory free (backends are listed fastest first), else the roomiest. */
export function fastest(m: MachineCapacity, field: Field): Slot {
  const b = m.backends.find((x) => x[field] > 0);
  return b ? { m, b } : roomiest(m, field);
}

/** Sum of what each machine contributes to a split (one backend per machine, so memory isn't counted twice). */
export function groupFree(machines: readonly MachineCapacity[], field: Field): number {
  return machines.reduce((s, m) => s + roomiest(m, field).b[field], 0);
}

export interface Part { s: Slot; bytes: number; share: number }

/**
 * Fill machines largest-first, one backend each (`choose`), until the model fits; null when the group can't hold it.
 * Every machine after the first runs its own runtime, so it holds `overhead` bytes on top of its share of the model.
 */
export function place(need: number, machines: readonly MachineCapacity[], field: Field, overhead: number, choose: (m: MachineCapacity, f: Field) => Slot, keepOrder = false): Part[] | null {
  const out: Part[] = [];
  let left = need;
  const slots = machines.map((m) => choose(m, field));
  for (const s of keepOrder ? slots : slots.sort((a, b) => b.b[field] - a.b[field])) {
    if (left <= 0) break;
    const extra = out.length ? overhead : 0;
    const share = Math.min(s.b[field] - extra, left);
    if (share <= 0) continue;
    out.push({ s, bytes: share + extra, share });
    left -= share;
  }
  return left <= 0 ? out : null;
}

/** A split: first each machine's fastest backend; if that can't hold it, each machine's roomiest one. */
function pooledPick(c: Candidate, g: PoolGroup, field: Field, context: number, overhead: number): Pick | null {
  const parts = place(c.need, g.machines, field, overhead, fastest) ?? place(c.need, g.machines, field, overhead, roomiest);
  if (!parts) return null;
  const have = groupFree(g.machines, field);
  const need = parts.reduce((s, p) => s + p.bytes, 0);
  const tps = pooledSpeed(c.bpt, parts.map((p) => ({ share: p.share / c.need, bandwidth: p.s.b.bandwidth })), g.maxRttMs);
  const runtimes = parts.length > 1 ? `, ${parts.length} runtimes` : "";
  return {
    model: c.model, quant: c.quant, need, have, fits: true, pooled: parts.length > 1,
    placement: parts.map((p) => placementOf(p.s, p.bytes)),
    tokensPerSec: tps, speed: speedClass(tps),
    why: `Needs ${gb(need)} GB (${quantText(c.quant)}, ${ctxText(context)}${runtimes}); the group has ${gb(have)} GB ${freeText(field)}, split across ${parts.map((p) => (p.s.b.memory === CPU_MEMORY ? `${p.s.m.hostname} (CPU)` : p.s.m.hostname)).join(", ")}`,
  };
}

/**
 * Best candidate the whole group holds, only when it's better rated than what one machine runs. When the 8-bit split
 * would be slow and the 4-bit one of the same model is faster, the 4-bit one is suggested. POOL-REAL-1: a split is
 * suggested only when needed: a slow split is not offered over a model one machine runs at a usable speed.
 */
function bestPooled(cands: readonly Candidate[], g: PoolGroup, field: Field, beat: Pick | null, context: number, overhead: number): Pick | null {
  if (g.machines.length < 2) return null;
  for (const c of cands) {
    if (beat && compareModels(c.model, beat.model) >= 0) return null;
    const p = pooledPick(c, g, field, context, overhead);
    if (!p?.pooled) continue;
    let pick = p;
    if (p.quant !== "q4" && p.speed === "slow") {
      const q4 = cands.find((x) => x.model.id === c.model.id && x.quant === "q4");
      const alt = q4 ? pooledPick(q4, g, field, context, overhead) : null;
      if (alt && SPEED_RANK[alt.speed] < SPEED_RANK[p.speed]) pick = alt;
    }
    if (pick.speed === "slow" && beat && beat.speed !== "slow") continue;
    return pick;
  }
  return null;
}

function tooBig(c: Candidate, have: number, where: string, context: number): Pick {
  return {
    model: c.model, quant: c.quant, need: c.need, have, fits: false, pooled: false, placement: [],
    tokensPerSec: 0, speed: "slow",
    why: `Needs ${gb(c.need)} GB (${quantText(c.quant)}, ${ctxText(context)}); ${where} has ${gb(have)} GB free now, ${gb(c.need - have)} GB short`,
  };
}

export function suggestForGroup(g: PoolGroup, cat: Catalog = CATALOG, context = cat.context_tokens): GroupSuggestion {
  const cands = candidates(cat, context);
  const usable = groupFree(g.machines, "usable");
  const usableIdle = groupFree(g.machines, "usableIdle");
  const single = bestSingle(cands, g.machines, "usable", context, true);
  const overhead = cat.overhead_gib * 1024 ** 3;
  const pooled = bestPooled(cands, g, "usable", single, context, overhead);
  const top = pooled ?? single;

  const alternatives: Pick[] = [];
  // POOL-REAL-1: when the pick runs on a CPU, the best model a GPU runs at a usable speed (what `walkie pool serve` runs).
  const gpu = single && single.placement[0]?.memory === CPU_MEMORY ? bestSingle(cands, g.machines, "usable", context, "gpu") : null;
  if (gpu) alternatives.push(gpu);
  // A better rated model that fits one machine only on its CPU or only slowly (a GPU machine's system RAM, say).
  const biggest = bestSingle(cands, g.machines, "usable", context);
  if (biggest && single && (!top || compareModels(biggest.model, top.model) < 0)) alternatives.push(biggest);
  const quicker = single && !gpu ? fasterThan(single, cands, g.machines, context) : null;
  if (quicker) alternatives.push(quicker);
  // The next better rated model that does not fit; when nothing fits at all, the model that needs the least memory
  // ("Smallest": the list is in quality order now, so its last entry is no longer the smallest model).
  const tooBigQ4 = cands.filter((c) => c.quant === "q4" && c.need > usable);
  const next = top
    ? [...tooBigQ4].reverse().find((c) => compareModels(c.model, top.model) < 0)
    : tooBigQ4.reduce<Candidate | undefined>((least, c) => (!least || c.need < least.need ? c : least), undefined);
  if (next) alternatives.push(tooBig(next, usable, g.machines.length === 1 ? g.machines[0]!.hostname : "the group", context));

  const idleSingle = bestSingle(cands, g.machines, "usableIdle", context, true);
  const idleTop = bestPooled(cands, g, "usableIdle", idleSingle, context, overhead) ?? idleSingle;
  const ifIdle = idleTop && (!top || compareModels(idleTop.model, top.model) < 0) ? idleTop : null;
  return { group: g, usable, usableIdle, single, pooled, faster: gpu ?? quicker, alternatives, ifIdle };
}

/**
 * The best rated model that needs less memory than `pick` and reaches a faster speed class (fast, when the pick is
 * only usable); failing that, the best rated one that is at least 1.5 times as fast. On one of the machines; null when
 * there is none (the pick is already the smallest and fastest).
 */
function fasterThan(pick: Pick, cands: readonly Candidate[], machines: readonly MachineCapacity[], context: number): Pick | null {
  // Another model: the same model at 4-bit is smaller and quicker, but it is not an alternative.
  const smaller = cands
    .filter((c) => c.need < pick.need && c.model.id !== pick.model.id)
    .map((c) => bestSingle([c], machines, "usable", context))
    .filter((p): p is Pick => !!p);
  return smaller.find((p) => SPEED_RANK[p.speed] < SPEED_RANK[pick.speed]) ?? smaller.find((p) => p.tokensPerSec >= 1.5 * pick.tokensPerSec) ?? null;
}

export function suggestTeam(nodes: readonly GroupInput[], opts: { cat?: Catalog; context?: number; lanRttMs?: number } = {}): TeamSuggestion {
  const cat = opts.cat ?? CATALOG;
  const context = opts.context ?? cat.context_tokens;
  const grouping = groupMachines(nodes, opts.lanRttMs ?? LAN_RTT_MS);
  const suggestions = grouping.groups.map((g) => suggestForGroup(g, cat, context));
  // The group whose best pick (split or single) is the best rated; the first on a tie, and the first when nothing fits.
  const headline = suggestions.reduce<GroupSuggestion | null>((best, s) => {
    if (!best) return s;
    const m = (s.pooled ?? s.single)?.model;
    if (!m) return best;
    const b = (best.pooled ?? best.single)?.model;
    return !b || compareModels(m, b) < 0 ? s : best;
  }, null);
  // Every machine on its own; a group of one already is that.
  const machines = grouping.groups.flatMap((g, group) => g.machines.map((machine): MachineSuggestion => {
    const solo = g.machines.length === 1 ? suggestions[group]! : suggestForGroup({ kind: "single", machines: [machine], maxRttMs: 0, why: "On its own" }, cat, context);
    return { machine, group, best: solo.single, faster: solo.faster };
  }));
  return { ...grouping, suggestions, machines, headline, context };
}
