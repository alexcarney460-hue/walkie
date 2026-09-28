// Which machines could realistically share one model. Splitting a model across machines (exo, llama.cpp RPC) sends
// data between them for every generated token, so they need to be on the same local network. Walkie already measures
// the round trip from this machine to each peer (the sync `vv` call); a peer that answers within LAN_RTT_MS is on
// this machine's network. Walkie measures nothing between two other machines, so every machine farther away is its
// own group: from its owner's dashboard it may well have neighbours.
import type { PoolShare } from "../protocol/pool.ts";
import { machineCapacity, type CapacityInput, type MachineCapacity } from "./capacity.ts";

/** A peer answering Walkie's sync call within this many ms is on the same local network. */
export const LAN_RTT_MS = 5;

export interface GroupInput extends CapacityInput {
  online: boolean;
  self: boolean;
  rtt_ms: number | null;
  /** WALKIE-POOL-2: whether its owner shares it for split runs (absent: an older Walkie, or not reported yet). */
  pool?: PoolShare;
}

export interface PoolGroup {
  /** "local": this machine and its LAN neighbours; "single": one machine on its own. */
  kind: "local" | "single";
  machines: MachineCapacity[];
  /** Largest measured round trip inside the group (ms); 0 for this machine alone. */
  maxRttMs: number;
  /** Why these machines are grouped (or not), in plain words. */
  why: string;
}

export interface Excluded { hostname: string; handle: string; reason: string }

export interface Grouping { groups: PoolGroup[]; excluded: Excluded[] }

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

export function groupMachines(nodes: readonly GroupInput[], lanRttMs = LAN_RTT_MS): Grouping {
  const excluded: Excluded[] = [];
  const local: { cap: MachineCapacity; rtt: number }[] = [];
  const singles: { cap: MachineCapacity; rtt: number | null }[] = [];
  for (const n of nodes) {
    if (!n.online) { excluded.push({ hostname: n.hostname, handle: n.handle, reason: "offline" }); continue; }
    const cap = machineCapacity(n);
    if (!cap) {
      excluded.push({ hostname: n.hostname, handle: n.handle, reason: "no memory reported (machine stats turned off, or an older Walkie)" });
      continue;
    }
    if (n.self) local.unshift({ cap, rtt: 0 });
    else if (n.rtt_ms !== null && n.rtt_ms <= lanRttMs) local.push({ cap, rtt: n.rtt_ms });
    else singles.push({ cap, rtt: n.rtt_ms });
  }
  const groups: PoolGroup[] = [];
  const hasSelf = nodes.some((n) => n.self && local.some((l) => l.cap.node_id === n.node_id));
  if (local.length > 1) {
    const maxRtt = Math.max(...local.map((l) => l.rtt));
    const others = hasSelf ? local.length - 1 : local.length;
    const who = hasSelf ? `This machine and ${plural(others, "other")} answer` : `${plural(others, "machine")} answer this one`;
    groups.push({
      kind: "local", machines: local.map((l) => l.cap), maxRttMs: maxRtt,
      why: `${who} within ${lanRttMs} ms (slowest ${maxRtt} ms): likely the same local network, close enough to split a model across`,
    });
  } else if (local.length === 1) {
    groups.push({ kind: "local", machines: [local[0]!.cap], maxRttMs: 0, why: hasSelf ? `This machine: no teammate's machine answers within ${lanRttMs} ms` : "On its own" });
  }
  for (const s of singles) {
    groups.push({
      kind: "single", machines: [s.cap], maxRttMs: 0,
      why: s.rtt === null
        ? "Latency not measured yet: on its own"
        : `${s.rtt} ms from this machine: too far to split a model with it. Walkie only measures latency from this machine, so it can't tell which other machines share a network with it`,
    });
  }
  return { groups, excluded };
}
