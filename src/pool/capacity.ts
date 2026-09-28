// What one machine could give a local model: usable memory now (what's free after everything already running:
// agents, apps, anything) and if it were otherwise idle (only the OS and a few GB of apps), per way of running it
// (GPU memory, unified memory, system RAM on the CPU), plus a memory-bandwidth figure for the speed estimate. Pure:
// works on NodeView (dashboard + CLI).
// Numbers and their sources: docs/PROTOCOL.md §3 "Local model suggestions".
import { gb } from "../protocol/machine-stats-format.ts";
import type { MachineAccel, MachineMem, MachineStats } from "../protocol/machine-stats.ts";

const GiB = 1024 ** 3;

/** Kept free on every machine so running a model doesn't push it into swap. */
export const RESERVE_BYTES = 1 * GiB;
/** What an idle machine's OS and apps still hold (the "if idle" figure). */
export const IDLE_OS_BYTES = 4 * GiB;
/** Per NVIDIA GPU: the CUDA context and display. */
export const GPU_RESERVE_BYTES = 1 * GiB;
/**
 * macOS lets the GPU wire about 2/3 of unified memory up to 32 GiB and 3/4 above (Metal's
 * recommendedMaxWorkingSetSize; measured by the llama.cpp community, not documented by Apple: [UNCLEAR]).
 */
export function appleGpuShare(total: number): number {
  return total > 32 * GiB ? 0.75 : 2 / 3;
}

/**
 * Theoretical memory bandwidth (GB/s) by Apple chip (Wikipedia "Apple M1".."Apple M5", citing Apple). Where a chip
 * comes in two binnings the name can't tell apart (M3 Max, M4 Max, M5 Max) the lower one is used.
 */
const APPLE_BW: ReadonlyArray<[RegExp, number]> = [
  [/M1 Ultra/, 800], [/M1 Max/, 400], [/M1 Pro/, 200], [/M1\b/, 68],
  [/M2 Ultra/, 800], [/M2 Max/, 400], [/M2 Pro/, 200], [/M2\b/, 100],
  [/M3 Ultra/, 819], [/M3 Max/, 300], [/M3 Pro/, 150], [/M3\b/, 100],
  [/M4 Max/, 410], [/M4 Pro/, 273], [/M4\b/, 120],
  [/M5 Max/, 460], [/M5 Pro/, 307], [/M5\b/, 153],
];
/** Unknown Apple chip, NVIDIA GPU, laptop NVIDIA GPU, CPU-only: rough class figures, labelled estimates. */
export const DEFAULT_BW = { apple: 100, nvidia: 400, nvidiaLaptop: 250, cpu: 60 } as const;

export type AccelKind = "apple" | "nvidia" | "cpu";

/** The `memory` of the system-RAM-on-the-CPU backend. */
export const CPU_MEMORY = "system memory (CPU)";

/** One way the machine could run a model: its GPU memory, Apple unified memory, or system RAM on the CPU. */
export interface Backend {
  kind: AccelKind;
  /** "GPU memory", "unified memory", "system memory (CPU)". */
  memory: string;
  /** Bytes a model could use now, leaving the memory in use alone; 0 when "now" isn't measured (see `measured`). */
  usable: number;
  /** Bytes a model could use if the machine were otherwise idle (only the OS and a few GB of apps). */
  usableIdle: number;
  /** false = the free figure isn't measured (e.g. free VRAM unknown): only the "if idle" figure counts it. */
  measured: boolean;
  /** GB/s for the speed estimate. */
  bandwidth: number;
  /** false = a class default, not this chip's figure. */
  bandwidthKnown: boolean;
}

export interface MachineCapacity {
  node_id: string;
  hostname: string;
  handle: string;
  /** The primary backend's kind (the accelerator when there is one). */
  kind: AccelKind;
  /** "Apple M5 · 16 GB unified", "NVIDIA GeForce RTX 4090 · 24 GB VRAM + 64 GB RAM", "CPU only · 64 GB". */
  label: string;
  /**
   * The ways it could run a model, fastest first, considered independently. A machine with an NVIDIA GPU has its VRAM
   * and its system RAM on the CPU (a big-RAM box with a small GPU can run a bigger model slowly on the CPU); an Apple
   * Silicon machine has Metal (the GPU's share of unified memory) and the CPU (all of it, slower).
   */
  backends: Backend[];
  /** Largest `usable` / `usableIdle` over the backends: what this machine adds to a split (one backend per machine). */
  usable: number;
  usableIdle: number;
  /** The primary backend's bandwidth (GB/s) and whether it is this chip's figure. */
  bandwidth: number;
  bandwidthKnown: boolean;
  /** Plain-language caveats ("free VRAM not measured"). */
  notes: string[];
}

export interface CapacityInput {
  node_id: string; hostname: string; handle: string; stats?: MachineStats;
}

const gbText = (b: number): string => `${Math.round(b / GiB)} GB`;

function appleBandwidth(chip: string | null): { bw: number; known: boolean } {
  for (const [re, bw] of APPLE_BW) if (chip && re.test(chip)) return { bw, known: true };
  return { bw: DEFAULT_BW.apple, known: false };
}

type Base = Pick<MachineCapacity, "node_id" | "hostname" | "handle">;

/** "Free now" never exceeds "if idle": a machine using less than the idle allowance keeps its free figure. */
function withIdleFloor(b: Backend): Backend {
  return b.usableIdle >= b.usable ? b : { ...b, usableIdle: b.usable };
}

function assemble(base: Base, label: string, raw: Backend[], notes: string[]): MachineCapacity {
  const backends = raw.map(withIdleFloor);
  const primary = backends[0]!;
  return {
    ...base, kind: primary.kind, label, backends,
    usable: Math.max(...backends.map((b) => b.usable)), usableIdle: Math.max(...backends.map((b) => b.usableIdle)),
    bandwidth: primary.bandwidth, bandwidthKnown: primary.bandwidthKnown, notes,
  };
}

function cpuBackend(mem: MachineMem): Backend {
  return {
    kind: "cpu", memory: CPU_MEMORY, usable: Math.max(0, mem.total - mem.used - RESERVE_BYTES),
    usableIdle: Math.max(0, mem.total - IDLE_OS_BYTES), measured: true, bandwidth: DEFAULT_BW.cpu, bandwidthKnown: false,
  };
}

/**
 * NVIDIA: "now" = the free VRAM each GPU reported (nvidia-smi memory.free) less 1 GiB per GPU; "if idle" = total VRAM
 * less 1 GiB per GPU. Without a free-VRAM reading the GPU counts only in the "if idle" figure. System RAM on the CPU
 * is a second, independent backend.
 */
function nvidia(accel: MachineAccel, mem: MachineMem, gpuFree: readonly number[] | undefined, base: Base): MachineCapacity {
  const idle = accel.gpus.reduce((s, g) => s + Math.max(0, g.vram - GPU_RESERVE_BYTES), 0);
  const measured = !!gpuFree && gpuFree.length === accel.gpus.length;
  const now = measured ? accel.gpus.reduce((s, g, i) => s + Math.max(0, Math.min(gpuFree![i]!, g.vram) - GPU_RESERVE_BYTES), 0) : 0;
  const laptop = accel.gpus.some((g) => /laptop|mobile|max-q/i.test(g.name));
  const name = accel.gpus.length === 1 ? accel.gpus[0]!.name : `${accel.gpus.length}x ${accel.gpus[0]!.name}`;
  const vram = accel.gpus.reduce((s, g) => s + g.vram, 0);
  const gpu: Backend = {
    kind: "nvidia", memory: "GPU memory", usable: now, usableIdle: idle, measured,
    bandwidth: laptop ? DEFAULT_BW.nvidiaLaptop : DEFAULT_BW.nvidia, bandwidthKnown: false,
  };
  const freeVram = measured ? accel.gpus.reduce((s, g, i) => s + Math.min(gpuFree![i]!, g.vram), 0) : 0;
  const note = measured
    ? `GPU: ${gb(freeVram)} of ${gb(vram)} GB VRAM free now`
    : "Free GPU memory not measured: the GPU counts only in the \"if idle\" figure";
  return assemble(base, `${name} · ${gbText(vram)} VRAM + ${gbText(mem.total)} RAM`, [gpu, cpuBackend(mem)], [note]);
}

/** The machine's capacity, or null when it reported no memory (stats off, an older Walkie, or no reading). */
export function machineCapacity(n: CapacityInput): MachineCapacity | null {
  const mem = n.stats?.mem;
  if (!mem || !(mem.total > 0)) return null;
  const accel = n.stats?.accel;
  const base: Base = { node_id: n.node_id, hostname: n.hostname, handle: n.handle };
  if (accel && accel.gpus.length > 0) return nvidia(accel, mem, n.stats?.gpu_free, base);
  if (accel?.unified) {
    const cap = accel.gpu_limit ?? mem.total * appleGpuShare(mem.total);
    const free = Math.max(0, mem.total - mem.used - RESERVE_BYTES);
    const { bw, known } = appleBandwidth(accel.chip);
    const unified: Backend = {
      kind: "apple", memory: "unified memory", usable: Math.floor(Math.min(cap, free)),
      usableIdle: Math.floor(Math.max(0, Math.min(cap, mem.total - IDLE_OS_BYTES))), measured: true, bandwidth: bw, bandwidthKnown: known,
    };
    // The GPU (Metal) may wire only part of unified memory; the CPU can use all of it, slower (llama.cpp CPU build).
    return assemble(base, `${accel.chip ?? "Apple Silicon"} · ${gbText(mem.total)} unified`, [unified, cpuBackend(mem)],
      accel.gpu_limit ? [`GPU memory limit set to ${gbText(accel.gpu_limit)} (iogpu.wired_limit_mb)`] : []);
  }
  return assemble(base, `${accel?.chip ? `${accel.chip} · ` : ""}CPU only · ${gbText(mem.total)}`, [cpuBackend(mem)],
    accel ? ["No GPU found: the model would run on the CPU (slow)"] : ["Hardware not reported (an older Walkie): counted as CPU only"]);
}
