// Which machines hold how much of a split run (WALKIE-POOL-2), decided on the head from the team view. Pure.
import { machineCapacity } from "../capacity.ts";
import { CATALOG, memoryNeeded, type CatalogModel, type Quant } from "../catalog.ts";
import { canServe, capped, headFirst } from "../combined.ts";
import type { GroupInput } from "../group.ts";
import { fastest, place, roomiest } from "../suggest.ts";

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
function resolve(nodes: readonly GroupInput[], name: string): GroupInput {
  const n = name.replace(/^@/, "");
  const hit = nodes.filter((x) => x.hostname === n || x.node_id === n || `${x.handle}/${x.hostname}` === n);
  if (hit.length !== 1) throw new PlanError("unknown_machine", hit.length ? `"${name}" names more than one machine; use its node id` : `no machine "${name}" in this team`);
  return hit[0]!;
}

/** The head reported no GPU at all (CPU only): llama-server can't put layers on it in v1. */
export function cpuOnly(n: GroupInput): boolean {
  return machineCapacity(n)?.kind === "cpu";
}

function usableOf(n: GroupInput): number | null {
  const c = machineCapacity(n);
  if (!c) return null;
  const m = n.self ? c : capped(c, n.pool?.cap ?? null);
  return Math.max(...m.backends.map((b) => b.usable));
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
    // A head without an accelerator holds no layers (v1: llama-server's layers go to devices only).
    const weights = free.map((f, i) => (i === 0 && cpuOnly(self) ? 0 : f === null ? 1 : Math.max(f, 1)));
    const total = weights.reduce((s, w) => s + w, 0);
    const extra = (i: number) => (i === 0 ? 0 : overhead);
    const stages = members.map((n, i) => ({ node_id: n.node_id, hostname: n.hostname, self: n.self, bytes: Math.round((need * weights[i]!) / total) + extra(i) }));
    stages.forEach((st, i) => {
      const f = free[i];
      if (typeof f === "number" && st.bytes > f) throw new PlanError("does_not_fit", `${st.hostname} would need ${(st.bytes / GiB).toFixed(1)} GB and has ${(f / GiB).toFixed(1)} GB free`);
    });
    return { need, stages };
  }
  const pool = [...(cpuOnly(self) ? [] : [self]), ...nodes.filter((n) => !n.self && n.online && canServe(n))];
  const caps = headFirst(pool.flatMap((n) => { const c = machineCapacity(n); return c ? [n.self ? c : capped(c, n.pool?.cap ?? null)] : []; }), self.node_id);
  if (!caps.length) throw new PlanError("no_memory", "no machine here reported its memory (machine stats are off); name the machines with --machines");
  const parts = place(need, caps, "usable", overhead, fastest, true) ?? place(need, caps, "usable", overhead, roomiest, true);
  if (!parts) {
    const have = caps.reduce((s, m) => s + Math.max(...m.backends.map((b) => b.usable)), 0);
    throw new PlanError("does_not_fit", `needs ${(need / GiB).toFixed(1)} GB; this machine and the sharing machines have ${(have / GiB).toFixed(1)} GB free`);
  }
  const byId = new Map(pool.map((n) => [n.node_id, n] as const));
  const stages = parts.map((p) => ({ node_id: p.s.m.node_id, hostname: p.s.m.hostname, self: byId.get(p.s.m.node_id)?.self === true, bytes: Math.round(p.bytes) }));
  // The head always runs llama-server; list it first even when it holds nothing of the model.
  if (!stages.some((s) => s.self)) stages.unshift({ node_id: self.node_id, hostname: self.hostname, self: true, bytes: 0 });
  return { need, stages: [...stages.filter((s) => s.self), ...stages.filter((s) => !s.self)] };
}
