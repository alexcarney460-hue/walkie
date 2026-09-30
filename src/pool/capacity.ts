// What one machine could give a local model: usable memory now (what's free after everything already running:
// agents, apps, anything) and if it were otherwise idle (only the OS and a few GB of apps), per way of running it
// (GPU memory, unified memory, system RAM on the CPU), plus a memory-bandwidth figure for the speed estimate. Pure:
// works on NodeView (dashboard + CLI).
// Numbers and their sources: docs/PROTOCOL.md §3 "Local model suggestions".
import { gb } from "../protocol/machine-stats-format.ts";
import { machineBusy, type MachineAccel, type MachineMem, type MachineStats } from "../protocol/machine-stats.ts";

const GiB = 1024 ** 3;

/** Kept free on every machine so running a model doesn't push it into swap. */
export const RESERVE_BYTES = 1 * GiB;
/** What an idle machine's OS and apps still hold (the "if idle" figure). */
export const IDLE_OS_BYTES = 4 * GiB;
/**
 * Per NVIDIA GPU, on top of what it reports free: the CUDA context. POOL-REAL-1 measured it: Llama 3.1 8B Q4 with an
 * 8K cache used 5692 MiB of VRAM in all (weights 4.58 GiB + cache 1.0 GiB + context and compute buffers), under the
 * catalog's figure (6.58 GiB, which carries 1 GiB of runtime overhead already), so 1 GiB more here double-counted.
 */
export const GPU_RESERVE_BYTES = 0.5 * GiB;
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
/**
 * Memory bandwidth (GB/s) of common NVIDIA GPUs (NVIDIA's spec sheets: bus width x memory data rate), most specific
 * name first: a "Laptop GPU" and a "Ti"/"SUPER" differ from the plain desktop card. POOL-REAL-1: the team's RTX 5070
 * (672) and RTX 5070 Laptop GPU (384) were measured against these.
 */
const NVIDIA_BW: ReadonlyArray<[RegExp, number]> = [
  [/RTX 5090 Laptop/i, 896], [/RTX 5080 Laptop/i, 896], [/RTX 5070 Ti Laptop/i, 672], [/RTX 5070 Laptop/i, 384], [/RTX 5060 Laptop/i, 384],
  [/RTX 4090 Laptop/i, 576], [/RTX 4080 Laptop/i, 432], [/RTX 4070 Laptop/i, 256], [/RTX 4060 Laptop/i, 256],
  [/RTX 5090/i, 1792], [/RTX 5080/i, 960], [/RTX 5070 Ti/i, 896], [/RTX 5070/i, 672], [/RTX 5060 Ti/i, 448], [/RTX 5060/i, 448],
  [/RTX 4090/i, 1008], [/RTX 4080 SUPER/i, 736], [/RTX 4080/i, 717], [/RTX 4070 Ti SUPER/i, 672], [/RTX 4070 Ti/i, 504],
  [/RTX 4070/i, 504], [/RTX 4060 Ti/i, 288], [/RTX 4060/i, 272],
  [/RTX 3090/i, 936], [/RTX 3080 Ti/i, 912], [/RTX 3080/i, 760], [/RTX 3070/i, 448], [/RTX 3060 Ti/i, 448], [/RTX 3060/i, 360],
  [/H100/i, 2000], [/A100/i, 1555], [/L40S/i, 864], [/RTX 6000 Ada/i, 960], [/RTX A6000/i, 768],
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
  /**
   * NVIDIA with several GPUs: the FIRST GPU's own figures. A split-run stage (rpc-server) and a split head's own part
   * use one device, the first, so they plan against it; serving (-ngl all) spreads over every GPU (POOL-REAL-1 p8-3).
   */
  device?: { usable: number; usableIdle: number };
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
  // Several GPUs: layers are split over them and each token still passes every one, so the slowest one's figure.
  const known = accel.gpus.map((g) => NVIDIA_BW.find(([re]) => re.test(g.name))?.[1] ?? null);
  const bwKnown = known.every((b) => b !== null);
  const g0 = accel.gpus[0]!;
  const device = {
    usable: measured ? Math.max(0, Math.min(gpuFree![0]!, g0.vram) - GPU_RESERVE_BYTES) : 0,
    usableIdle: Math.max(0, g0.vram - GPU_RESERVE_BYTES),
  };
  const gpu: Backend = {
    kind: "nvidia", memory: "GPU memory", usable: now, usableIdle: idle, measured, device,
    bandwidth: bwKnown ? Math.min(...(known as number[])) : laptop ? DEFAULT_BW.nvidiaLaptop : DEFAULT_BW.nvidia, bandwidthKnown: bwKnown,
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
  const actual = (capacity: MachineCapacity): MachineCapacity => machineBusy(n.stats)
    ? { ...capacity, usableIdle: capacity.usable,
      backends: capacity.backends.map((b) => ({ ...b, usableIdle: b.usable,
        ...(b.device ? { device: { ...b.device, usableIdle: b.device.usable } } : {}) })),
      notes: [...capacity.notes, "Machine busy: idle capacity is unavailable"] }
    : capacity;
  if (accel && accel.gpus.length > 0) return actual(nvidia(accel, mem, n.stats?.gpu_free, base));
  if (accel?.unified) {
    // A user-set limit, else Metal's own budget (POOL-REAL-1, read from llama.cpp), else the community fraction.
    const cap = accel.gpu_limit ?? accel.metal_budget ?? mem.total * appleGpuShare(mem.total);
    const free = Math.max(0, mem.total - mem.used - RESERVE_BYTES);
    const { bw, known } = appleBandwidth(accel.chip);
    const unified: Backend = {
      kind: "apple", memory: "unified memory", usable: Math.floor(Math.min(cap, free)),
      usableIdle: Math.floor(Math.max(0, Math.min(cap, mem.total - IDLE_OS_BYTES))), measured: true, bandwidth: bw, bandwidthKnown: known,
    };
    // The GPU (Metal) may wire only part of unified memory; the CPU can use all of it, slower (llama.cpp CPU build).
    return actual(assemble(base, `${accel.chip ?? "Apple Silicon"} · ${gbText(mem.total)} unified`, [unified, cpuBackend(mem)],
      accel.gpu_limit ? [`GPU memory limit set to ${gbText(accel.gpu_limit)} (iogpu.wired_limit_mb)`] : []));
  }
  return actual(assemble(base, `${accel?.chip ? `${accel.chip} · ` : ""}CPU only · ${gbText(mem.total)}`, [cpuBackend(mem)],
    accel ? ["No GPU found: the model would run on the CPU (slow)"] : ["Hardware not reported (an older Walkie): counted as CPU only"]));
}
