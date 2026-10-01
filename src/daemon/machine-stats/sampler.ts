// Samples this machine's memory and temperature on an interval (accelerator facts once: accel.ts; free VRAM and GPU
// temperature every tick on a machine with an NVIDIA GPU, the GPU standing in for the machine temperature when there
// is no CPU/board sensor) and publishes a new snapshot only when it moved meaningfully (≥ 5 % of
// memory, ≥ 1 GiB of free VRAM, ≥ 2 °C, a pressure or availability change) or the
// heartbeat is due. The published snapshot is what peers read on `vv` and what the dashboard shows; nothing is
// written to the event log.
import { cpus, loadavg } from "node:os";
import { machineBusy, type MachineAccel, type MachineStats, type MachineSys } from "../../protocol/machine-stats.ts";
import type { Logger } from "../logger.ts";
import { VERSION } from "../version.ts";
import { SEATS_V2_CAP } from "../../protocol/seats.ts";
import { readAccel, readGpuNow, type GpuNow } from "./accel.ts";
import { platformReader, type Reader, type Reading } from "./read.ts";

export const DEFAULT_INTERVAL_MS = 30_000;
/** Republish unchanged values this often, so "updated" stays recent on a steady machine. */
export const DEFAULT_HEARTBEAT_MS = 5 * 60_000;
/** Memory (used, or swap used) moving by this share of total memory publishes. */
export const MEM_STEP = 0.05;
/** Temperature moving by this many °C publishes. */
export const TEMP_STEP_C = 2;

/** Linux without a GPU found yet: accelerator facts are read again this often (WSL driver mount race). */
export const ACCEL_RETRY_MS = 5 * 60_000;

export interface SamplerOptions {
  intervalMs?: number; heartbeatMs?: number;
  /** Tests inject readings; default the platform reader (read.ts). */
  read?: Reader;
  /** Accelerator facts, read on the first tick and again every ACCEL_RETRY_MS on Linux while no GPU was found (default accel.ts). */
  readAccel?: () => Promise<MachineAccel | null>;
  /** Tests: the platform (default process.platform). */
  platform?: NodeJS.Platform;
  /** Free VRAM and temperature per NVIDIA GPU, read every tick when there is one (default accel.ts readGpuNow). */
  readGpu?: (gpus: number) => Promise<GpuNow>;
  /** Free VRAM only (tests written before GPU temperatures); used when `readGpu` is not given. */
  readGpuFree?: (gpus: number) => Promise<number[] | null>;
  clock?: () => number;
  /** Platform, version and CPU load, read every tick (default hostSys). */
  readSys?: () => MachineSys | null;
}

/** Busy share of CPU time since the previous sample, across all logical CPUs. */
export class CpuBusyTracker {
  private before: { total: number; idle: number } | null = null;
  constructor(private readonly read: () => ReadonlyArray<Pick<ReturnType<typeof cpus>[number], "times">> = cpus) {}
  sample(): number | null {
    const rows = this.read();
    if (!rows.length) return null;
    const next = rows.reduce((acc, cpu) => ({
      total: acc.total + Object.values(cpu.times).reduce((sum, n) => sum + n, 0),
      idle: acc.idle + cpu.times.idle,
    }), { total: 0, idle: 0 });
    const prev = this.before;
    this.before = next;
    if (!prev || next.total <= prev.total || next.idle < prev.idle) return null;
    return Math.round(Math.max(0, Math.min(100, 100 * (1 - (next.idle - prev.idle) / (next.total - prev.total)))));
  }
}

/** This machine's platform facts and 1-minute load average; Windows reports no load average (null). */
export function hostSys(platform: string = process.platform, arch: string = process.arch, busy: number | null = null): MachineSys {
  const os: MachineSys["os"] = platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "other";
  const loads = os === "win32" ? [null, null, null] : loadavg();
  const rounded = (v: number | null | undefined): number | null => v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(Math.max(0, v) * 100) / 100;
  return {
    os,
    arch: arch === "arm64" || arch === "x64" ? arch : "other",
    version: VERSION,
    cpus: Math.max(1, Math.min(4096, cpus().length || 1)),
    load1: rounded(loads[0]), load5: rounded(loads[1]), load15: rounded(loads[2]), cpu_busy_pct: busy,
    caps: [SEATS_V2_CAP],
  };
}

/** The 1-minute load average moving by at least this much (and at least LOAD_STEP_RATIO of the last one) publishes. */
export const LOAD_STEP = 0.5;
export const LOAD_STEP_RATIO = 0.25;
/** Prevent a fluctuating busy threshold from publishing more often than this. */
export const BUSY_TRANSITION_MIN_MS = 10_000;

/** Free VRAM moving by this much (bytes, summed over the GPUs) publishes. */
export const GPU_FREE_STEP = 1024 ** 3;

/** Whether `next` (sampled at `now`) differs enough from the published `prev` to publish it. */
export function shouldPublish(
  prev: MachineStats | null,
  next: Reading & { gpu_free?: number[] | null; sys?: MachineSys | null; temp_src?: "cpu" | "gpu"; gpu_temp?: (number | null)[] | null },
  now: number, heartbeatMs = DEFAULT_HEARTBEAT_MS,
): boolean {
  if (!prev) return true;
  if (now - prev.at >= heartbeatMs) return true;
  if (now - prev.at >= BUSY_TRANSITION_MIN_MS
    && machineBusy(prev) !== machineBusy({ at: now, mem: next.mem, temp_c: next.temp_c, ...(next.sys ? { sys: next.sys } : {}) })) return true;
  if ((prev.temp_src ?? null) !== (next.temp_src ?? null)) return true;
  const t0 = maxTemp(prev.gpu_temp), t1 = maxTemp(next.gpu_temp);
  if ((t0 === null) !== (t1 === null)) return true;
  if (t0 !== null && t1 !== null && Math.abs(t1 - t0) >= TEMP_STEP_C) return true;
  const l0 = prev.sys?.load1 ?? null, l1 = next.sys?.load1 ?? null;
  if ((l0 === null) !== (l1 === null)) return true;
  if (l0 !== null && l1 !== null && Math.abs(l1 - l0) >= Math.max(LOAD_STEP, LOAD_STEP_RATIO * l0)) return true;
  const b0 = prev.sys?.cpu_busy_pct ?? null, b1 = next.sys?.cpu_busy_pct ?? null;
  if ((b0 === null) !== (b1 === null)) return true;
  if (b0 !== null && b1 !== null && (Math.abs(b1 - b0) >= 20 || (b0 >= 70) !== (b1 >= 70))) return true;
  const gf = (v: number[] | null | undefined): number | null => (v ? v.reduce((s, x) => s + x, 0) : null);
  const g0 = gf(prev.gpu_free), g1 = gf(next.gpu_free);
  if ((g0 === null) !== (g1 === null)) return true;
  if (g0 !== null && g1 !== null && Math.abs(g1 - g0) >= GPU_FREE_STEP) return true;
  if ((prev.temp_c === null) !== (next.temp_c === null)) return true;
  if (prev.temp_c !== null && next.temp_c !== null && Math.abs(next.temp_c - prev.temp_c) >= TEMP_STEP_C) return true;
  const a = prev.mem, b = next.mem;
  if ((a === null) !== (b === null)) return true;
  if (a && b) {
    if (a.total !== b.total || a.pressure !== b.pressure || a.swap_total !== b.swap_total) return true;
    if (b.swap_total && (a.swap_used / b.swap_total > 0.8) !== (b.swap_used / b.swap_total > 0.8)) return true;
    const step = MEM_STEP * b.total;
    if (Math.abs(b.used - a.used) >= step || Math.abs(b.swap_used - a.swap_used) >= step) return true;
  }
  return false;
}

/** The hottest of a list of temperatures, or null when there is none. */
function maxTemp(v: readonly (number | null)[] | null | undefined): number | null {
  let max: number | null = null;
  for (const t of v ?? []) if (t !== null && (max === null || t > max)) max = t;
  return max;
}

/**
 * The machine temperature and its source: the CPU/SoC/board reading when there is one, else the hottest NVIDIA GPU
 * (WALKIE-TEMP-WSL: a desktop under WSL has no ACPI zones but its GPU reports one).
 */
export function machineTemp(cpu: number | null, gpuTemps: readonly (number | null)[] | null): { temp_c: number | null; temp_src?: "cpu" | "gpu" } {
  if (cpu !== null) return { temp_c: cpu, temp_src: "cpu" };
  const gpu = maxTemp(gpuTemps);
  return gpu === null ? { temp_c: null } : { temp_c: gpu, temp_src: "gpu" };
}

export class MachineStatsSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;
  private lastError: string | null = null;
  private published: MachineStats | null = null;
  readonly intervalMs: number;
  private readonly heartbeatMs: number;
  private readonly read: Reader;
  private readonly readAccel: () => Promise<MachineAccel | null>;
  private readonly readGpu: (gpus: number) => Promise<GpuNow>;
  /** undefined = not read yet; null = none on this platform or the read failed. */
  private accel: MachineAccel | null | undefined = undefined;
  /** When accelerator facts were last read (they are read again while no GPU was found: ACCEL_RETRY_MS). */
  private accelAt = 0;
  private readonly clock: () => number;
  private readonly readSys: () => MachineSys | null;
  private readonly cpuBusy = new CpuBusyTracker();
  private readonly platform: NodeJS.Platform;

  constructor(private readonly publish: (s: MachineStats) => void, private readonly log: Logger, opts: SamplerOptions = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.read = opts.read ?? platformReader();
    this.readAccel = opts.readAccel ?? (() => readAccel());
    const readFree = opts.readGpuFree;
    this.readGpu = opts.readGpu ?? (readFree ? async (n) => ({ free: await readFree(n), temp: null }) : (n) => readGpuNow(n));
    this.clock = opts.clock ?? Date.now;
    this.readSys = opts.readSys ?? (() => hostSys(process.platform, process.arch, this.cpuBusy.sample()));
    this.platform = opts.platform ?? process.platform;
  }

  get current(): MachineStats | null { return this.published; }

  /**
   * Re-read accelerator facts while no GPU was found (POOL-REAL-1): on WSL the Windows driver's mount
   * (/usr/lib/wsl/lib) can appear after the service started, and a GPU missed at start was never seen again.
   * Only Linux, where that race exists; a machine that has a GPU keeps its facts.
   */
  private accelStale(): boolean {
    if (this.accel === undefined || (this.accel?.gpus.length ?? 0) > 0) return false;
    const due = this.clock() - this.accelAt >= ACCEL_RETRY_MS;
    // Apple Silicon: the Metal budget appears once the llama.cpp runtime is installed (walkie pool install).
    if (this.accel !== null && this.accel.unified) return this.platform === "darwin" && this.accel.metal_budget === undefined && due;
    return this.platform === "linux" && due;
  }

  start(): void {
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.read.close?.();
  }

  /** One sample; true when it was published. Never throws; a tick still running skips the next. */
  async tick(): Promise<boolean> {
    if (this.running || this.stopped) return false;
    this.running = true;
    try {
      if (this.accel === undefined || this.accelStale()) {
        const before = this.accel?.gpus.length ?? 0;
        this.accelAt = this.clock();
        this.accel = await this.readAccel().catch(() => null);
        const after = this.accel?.gpus.length ?? 0;
        if (after > before && before === 0 && this.accel) this.log.info("machine_accel_found", { gpus: after });
      }
      const gpus = this.accel?.gpus.length ?? 0;
      const none: GpuNow = { free: null, temp: null };
      const [r, gpu] = await Promise.all([this.read(), gpus ? this.readGpu(gpus).catch(() => none) : Promise.resolve(none)]);
      const gpuFree = gpu.free;
      const temp = machineTemp(r.temp_c, gpu.temp);
      if (this.stopped) return false;
      if (r.note && r.note !== this.lastError) this.log.info("machine_stats_partial", { note: r.note });
      this.lastError = r.note ?? null;
      const now = this.clock();
      let sys: MachineSys | null = null;
      try { sys = this.readSys(); } catch { sys = null; }
      const next = { ...r, ...temp, gpu_free: gpuFree, gpu_temp: gpu.temp, sys };
      if (!shouldPublish(this.published, next, now, this.heartbeatMs)) return false;
      this.published = {
        at: now, mem: r.mem ? { ...r.mem, free: Math.max(0, r.mem.total - r.mem.used) } : null,
        temp_c: temp.temp_c, ...(temp.temp_src ? { temp_src: temp.temp_src } : {}),
        ...(r.temp_zones?.length && temp.temp_src === "cpu" ? { temp_zones: r.temp_zones, ...(r.temp_route ? { temp_route: r.temp_route } : {}) } : {}),
        ...(this.accel ? { accel: this.accel } : {}), ...(gpuFree ? { gpu_free: gpuFree } : {}),
        ...(gpu.temp ? { gpu_temp: gpu.temp } : {}), ...(sys ? { sys } : {}),
      };
      this.publish(this.published);
      return true;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== this.lastError) this.log.warn("machine_stats_failed", { err: msg });
      this.lastError = msg;
      return false;
    } finally {
      this.running = false;
    }
  }
}
