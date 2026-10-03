// Which machines hold how much of a split run (WALKIE-POOL-2), decided on the head from the team view. Pure.
import { machineCapacity, runtimeBackend, serveBudget } from "../capacity.ts";
import { CATALOG, memoryNeeded, type CatalogModel, type Quant } from "../catalog.ts";
import { canServe, capped, headFirst } from "../combined.ts";
import type { GroupInput } from "../group.ts";
import { candidates, deviceSlot, place, singleSpeed, speedClass, type SpeedClass } from "../suggest.ts";
export { deviceSlot } from "../suggest.ts";

const GiB = 1024 ** 3;

export type { PlannedStage } from "../../protocol/pool.ts";
import type { PlannedStage } from "../../protocol/pool.ts";
export interface Plan { need: number; stages: PlannedStage[] }

export class PlanError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Memory a local GGUF file needs: its size + 10% (KV cache and buffers at a short context) + the runtime overhead. */
export function fileNeed(bytes: number): number {
  return Math.round(bytes * 1.1 + CATALOG.overhead_gib * GiB);
}

export function catalogNeed(m: CatalogModel, q: Quant): number {
  const need = memoryNeeded(m, q);
  if (need === null) throw new PlanError("no_such_format", `${m.name} has no ${q === "q8" ? "8-bit" : "4-bit"} release`);
  return need;
}

/** A machine named on the command line: its hostname, node id, or @handle/hostname. */
export function resolveMachine(nodes: readonly GroupInput[], name: string): GroupInput { return resolve(nodes, name); }

function resolve(nodes: readonly GroupInput[], name: string): GroupInput {
  const n = name.replace(/^@/, "");
  const hit = nodes.filter((x) => x.hostname === n || x.node_id === n || `${x.handle}/${x.hostname}` === n);
  if (hit.length !== 1) throw new PlanError("unknown_machine", hit.length ? `"${name}" names more than one machine; use its node id` : `no machine "${name}" in this team`);
  return hit[0]!;
}

/** The pinned runtime has no usable local accelerator: the head holds no layers in v1. */
export function cpuOnly(n: GroupInput): boolean {
  const c = machineCapacity(n);
  return c ? runtimeBackend(c).kind === "cpu" : false;
}

function usableOf(n: GroupInput): number | null {
  const c = machineCapacity(n);
  if (!c) return null;
  const m = n.self ? c : capped(c, n.pool?.cap ?? null);
  return deviceSlot(m).b.usable;
}

/**
 * Named machines (`--machines a,b`): exactly those plus this machine (the head), each holding a share in proportion
 * to the memory it has free (equal shares where a machine reported none). Unnamed: this machine and every machine
 * that shares, filled largest-first like the suggestion (so a model that fits here stays here).
 */
export function planRun(nodes: readonly GroupInput[], need: number, names?: readonly string[]): Plan {
  const self = nodes.find((n) => n.self);
  if (!self) throw new PlanError("no_team", "this machine isn't in a team");
  const overhead = CATALOG.overhead_gib * GiB;
  if (names?.length) {
    const named = [...new Set(names.map((x) => resolve(nodes, x)).filter((n) => !n.self))];
    for (const n of named) {
      if (!n.online) throw new PlanError("offline", `${n.hostname} is offline`);
      if (!n.pool?.share) throw new PlanError("not_sharing", `${n.hostname} isn't shared: its owner runs walkie pool share on`);
      if (!n.pool.runtime) throw new PlanError("no_runtime", `${n.hostname} lacks the llama.cpp runtime: its owner runs walkie pool install`);
      if (n.pool.busy) throw new PlanError("busy", `${n.hostname} is running a stage of another split run`);
    }
    const members = [self, ...named];
    const free = members.map(usableOf);
    const extra = (i: number) => (i === 0 ? 0 : overhead);
    // A head without an accelerator holds no layers (v1: llama-server's layers go to devices only). A worker's weight
    // is what it can hold of the model after its own runtime's overhead (POOL-REAL-1: weighting by raw free memory and
    // adding the overhead on top pushed a capped Mac past its cap).
    const weights = free.map((f, i) => (i === 0 && cpuOnly(self) ? 0 : f === null ? 1 : Math.max(f - extra(i), 1)));
    const total = weights.reduce((s, w) => s + w, 0);
    if (total === 0) throw new PlanError("no_memory", "the pinned runtime cannot place layers on this head; name a sharing worker");
    const stages = members.map((n, i) => {
      const share = Math.round((need * weights[i]!) / total);
      return { node_id: n.node_id, hostname: n.hostname, self: n.self, bytes: share + extra(i), model_bytes: share };
    });
    stages.forEach((st, i) => {
      const f = free[i];
      if (typeof f === "number" && st.bytes > f) throw new PlanError("does_not_fit", `${st.hostname} would need ${(st.bytes / GiB).toFixed(1)} GB and has ${(f / GiB).toFixed(1)} GB free`);
    });
    return { need, stages };
  }
  const pool = [...(cpuOnly(self) ? [] : [self]), ...nodes.filter((n) => !n.self && n.online && canServe(n))];
  const caps = headFirst(pool.flatMap((n) => { const c = machineCapacity(n); return c ? [n.self ? c : capped(c, n.pool?.cap ?? null)] : []; }), self.node_id);
  if (!caps.length) {
    if (cpuOnly(self)) throw new PlanError("no_memory", "the pinned runtime cannot place layers on this head; name a sharing worker");
    throw new PlanError("no_memory", "no machine here reported its memory (machine stats are off); name the machines with --machines");
  }
  const parts = place(need, caps, "usable", overhead, (m) => deviceSlot(m), true);
  if (!parts) {
    // What the stages could hold: each machine's device (GPU / unified memory), as placed above; not its CPU RAM.
    const have = caps.reduce((s, m) => s + deviceSlot(m).b.usable, 0);
    const names = caps.map((m) => m.hostname).join(", ");
    throw new PlanError("does_not_fit", `needs ${(need / GiB).toFixed(1)} GB of GPU memory; ${names} ${caps.length === 1 ? "has" : "have"} ${(have / GiB).toFixed(1)} GB free (a machine counts once its owner shares it and the team has seen that)`);
  }
  const byId = new Map(pool.map((n) => [n.node_id, n] as const));
  const stages = parts.map((p) => ({ node_id: p.s.m.node_id, hostname: p.s.m.hostname, self: byId.get(p.s.m.node_id)?.self === true, bytes: Math.round(p.bytes), model_bytes: Math.round(p.share) }));
  // The head always runs llama-server; list it first even when it holds nothing of the model.
  if (!stages.some((s) => s.self)) stages.unshift({ node_id: self.node_id, hostname: self.hostname, self: true, bytes: 0, model_bytes: 0 });
  return { need, stages: [...stages.filter((s) => s.self), ...stages.filter((s) => !s.self)] };
}

/** A machine that could serve a model whole on its GPU now (POOL-REAL-1). */
export interface ServeHost { node: GroupInput; usable: number; bandwidth: number; memory: string }

/**
 * Where a model needing `need` bytes could run whole on a GPU (or Apple unified memory) now: this machine, and every
 * online machine whose owner shares it (with the runtime, no other pool job), within its share cap. Fastest GPU first
 * (bandwidth), this machine first on a tie. CPU-only machines are not listed: serving puts every layer on a GPU.
 */
export function serveHosts(nodes: readonly GroupInput[], need: number): ServeHost[] {
  const out: ServeHost[] = [];
  for (const n of nodes) {
    if (!n.online && !n.self) continue;
    if (!n.self && !canServe(n)) continue;
    // An older Walkie shares for split runs but has no serve API (p8 review): never picked to serve.
    if (!n.self && n.pool?.serve !== true) continue;
    const c = machineCapacity(n);
    if (!c) continue;
    const m = n.self ? c : capped(c, n.pool?.cap ?? null);
    const gpu = runtimeBackend(m);
    const budget = serveBudget(m);
    if (budget !== null && budget >= need) out.push({ node: n, usable: gpu.usable, bandwidth: gpu.bandwidth, memory: gpu.memory });
  }
  return out.sort((a, b) => b.bandwidth - a.bandwidth || Number(b.node.self) - Number(a.node.self));
}

/** The model to serve whole on one machine's GPU (POOL-REAL-1): what `walkie pool serve` and the dashboard offer. */
export interface ServePick {
  model: CatalogModel; quant: Quant; need: number; host: ServeHost; tokensPerSec: number; speed: SpeedClass;
}

/**
 * The largest catalog model (8-bit before 4-bit) that one machine here or sharing runs whole on its GPU at a speed
 * that isn't slow, on the fastest GPU that holds it; null when none does.
 */
export function bestServe(nodes: readonly GroupInput[]): ServePick | null {
  for (const c of candidates()) {
    const host = serveHosts(nodes, c.need)[0];
    if (!host) continue;
    const tps = singleSpeed(c.bpt, host.bandwidth);
    if (speedClass(tps) === "slow") continue;
    return { model: c.model, quant: c.quant, need: c.need, host, tokensPerSec: tps, speed: speedClass(tps) };
  }
  return null;
}
