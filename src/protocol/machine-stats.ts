// Machine stats (memory + temperature) a node reports about itself. Carried as an optional `stats` field on the
// peer `vv` response (PROTOCOL §3 "Machine stats") and on NodeView; never written to the event log. Daemons without
// machine stats (v0.1.3 and earlier) don't send it and drop it when they receive it (zod objects strip unknown keys).
import { z } from "zod";
import { TEMP_MAX_C, TEMP_MIN_C } from "./machine-stats-format.ts";

/** Memory pressure as the OS reports it (macOS kern.memorystatus_vm_pressure_level, Linux PSI), else derived from use. */
export const MemPressure = z.enum(["normal", "warn", "critical"]);
export type MemPressure = z.infer<typeof MemPressure>;

/** Bytes; 4 PiB is far above any machine and keeps the numbers exact in a double. */
const Bytes = z.number().nonnegative().max(2 ** 52);

/** Swap in use beyond this multiple of memory is not a real reading (macOS grows swap files, but not this far). */
export const MAX_SWAP_RATIO = 8;

/**
 * Plausibility caps on self-reported hardware (a teammate's modified daemon could otherwise report petabytes and
 * inflate its group's local-model suggestion): system memory ≤ 16 TiB, memory per GPU ≤ 512 GiB.
 */
export const MAX_MEM_BYTES = 16 * 1024 ** 4;
export const MAX_VRAM_BYTES = 512 * 1024 ** 3;
const Vram = z.number().nonnegative().max(MAX_VRAM_BYTES);

export const MachineMem = z.object({
  total: Bytes.max(MAX_MEM_BYTES),
  used: Bytes,
  swap_used: Bytes,
  pressure: MemPressure.nullable(),
}).refine((m) => m.used <= m.total, { message: "used exceeds total" })
  .refine((m) => m.swap_used <= MAX_SWAP_RATIO * m.total, { message: "swap out of range" });
export type MachineMem = z.infer<typeof MachineMem>;

/**
 * An array whose length is checked BEFORE any element is: zod 3 validates every element even past `.max()`, so a
 * peer's 300k-item array would cost 300k element parses before being dropped (Codex temp-wsl r1).
 */
function cappedArray<T extends z.ZodTypeAny>(el: T, max: number) {
  return z.custom<unknown[]>((v) => Array.isArray(v) && v.length <= max, { message: `array over ${max} items` }).pipe(z.array(el).max(max));
}

/** A printable-ASCII string whose length is checked before the pattern runs. */
function cappedName(max: number) {
  return z.custom<string>((v) => typeof v === "string" && v.length >= 1 && v.length <= max, { message: `string over ${max} characters` })
    .pipe(z.string().regex(/^[\x20-\x7e]+$/));
}

/** A hardware name as the OS reports it ("Apple M5", "NVIDIA GeForce RTX 4090"): printable ASCII, short. */
export const HW_NAME_MAX = 64;
const HwName = cappedName(HW_NAME_MAX);

/** At most this many GPUs per machine are reported. */
export const MAX_GPUS = 8;

/**
 * What the machine could run a local model on (read once at daemon start; src/daemon/machine-stats/accel.ts):
 * the CPU/SoC name, whether memory is unified (Apple Silicon: the GPU uses system RAM), a user-set GPU memory limit
 * (macOS `iogpu.wired_limit_mb`), and NVIDIA GPUs with their memory (`nvidia-smi`). Team-visible (SECURITY.md).
 */
export const MachineAccel = z.object({
  chip: HwName.nullable(),
  unified: z.boolean(),
  /** Bytes; null = the OS default. */
  gpu_limit: Bytes.max(MAX_MEM_BYTES).nullable(),
  gpus: cappedArray(z.object({ name: HwName, vram: Vram }), MAX_GPUS),
  /**
   * Apple Silicon (POOL-REAL-1): the GPU's Metal working-set budget in bytes (MTLDevice recommendedMaxWorkingSetSize),
   * as the installed llama.cpp reports it (`llama-server --list-devices`, MTL0 total); absent without the runtime.
   * Older daemons strip it; a malformed one is dropped alone.
   */
  metal_budget: Bytes.max(MAX_MEM_BYTES).optional().catch(undefined),
});
export type MachineAccel = z.infer<typeof MachineAccel>;

/**
 * The machine's platform, for the dashboard's machine page (WALKIE-UI-POLISH-1): the OS family and CPU architecture
 * as Node names them (bucketed, never a kernel string), the Walkie version (optional), the logical CPU count and the 1-minute
 * load average (null where the OS has none, e.g. Windows). Team-visible (SECURITY.md). Malformed: dropped.
 */
export const MachineSys = z.object({
  os: z.enum(["darwin", "linux", "win32", "other"]),
  arch: z.enum(["arm64", "x64", "other"]),
  /** Semver, pre-release and build metadata allowed; a malformed version drops only this field. */
  version: z.string().max(48).regex(/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.-]{1,20})?(?:\+[0-9A-Za-z.-]{1,20})?$/).optional().catch(undefined),
  cpus: z.number().int().min(1).max(4096),
  load1: z.number().min(0).max(100_000).nullable(),
  /**
   * What this daemon's version can do for teammates (FO-2: `seats_v2` = it runs v2 seat requests). Absent from older
   * daemons; malformed: dropped (the rest kept).
   */
  caps: z.array(z.string().regex(/^[a-z0-9_]{1,32}$/)).max(16).optional().catch(undefined),
});
export type MachineSys = z.infer<typeof MachineSys>;

/** A temperature in °C within the plausible range (machine-stats-format.ts). */
const Temp = z.number().min(TEMP_MIN_C).max(TEMP_MAX_C);
/** At most this many Windows thermal zones are reported. */
export const MAX_TEMP_ZONES = 16;
const ZoneName = cappedName(32);

export const MachineStats = z.object({
  /** When these values were sampled: the reporting node's clock (unix ms); on NodeView, converted to this node's clock. */
  at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** null = not available on that platform. */
  mem: MachineMem.nullable(),
  /**
   * The machine's temperature in °C: the hottest CPU/SoC/board sensor (on WSL, the hottest Windows ACPI thermal zone),
   * else the hottest NVIDIA GPU (`temp_src: "gpu"`); null = no readable sensor (VMs, Intel Macs without HID sensors).
   */
  temp_c: Temp.nullable(),
  /**
   * WALKIE-TEMP-WSL: where `temp_c` came from, "cpu" (CPU/SoC/board sensor or thermal zone) or "gpu" (no such sensor:
   * the GPU fallback). Absent from older daemons (their `temp_c` is always "cpu"). Malformed: dropped.
   */
  temp_src: z.enum(["cpu", "gpu"]).optional().catch(undefined),
  /**
   * WALKIE-TEMP-WSL: each Windows thermal zone behind `temp_c` on WSL (`\_TZ.` prefix removed), at most 16.
   * Absent elsewhere and from older daemons. Malformed: dropped.
   */
  temp_zones: cappedArray(z.object({ name: ZoneName, c: Temp }), MAX_TEMP_ZONES).optional().catch(undefined),
  /**
   * WALKIE-TEMP-WSL: how the Windows zones were reached: "own" (the daemon's WSL_INTEROP), "plain" (interop through
   * its parent session), "session" (another WSL session of the same user, borrowed: a systemd service has none).
   * Absent with no zones and from older daemons. Malformed: dropped.
   */
  temp_route: z.enum(["own", "plain", "session"]).optional().catch(undefined),
  /**
   * WALKIE-TEMP-WSL: each NVIDIA GPU's temperature in °C (`nvidia-smi --query-gpu=temperature.gpu`), in `accel.gpus`
   * order, null where the GPU reports none. Absent: not measured. Malformed: dropped.
   */
  gpu_temp: cappedArray(Temp.nullable(), MAX_GPUS).optional().catch(undefined),
  /** Accelerator facts; absent from daemons before local-model suggestions. Malformed: dropped, the rest kept. */
  accel: MachineAccel.optional().catch(undefined),
  /**
   * Free memory per NVIDIA GPU in bytes (`nvidia-smi --query-gpu=memory.free`), in `accel.gpus` order, sampled with
   * memory. Absent: not measured (no NVIDIA GPU, the query failed, or an older daemon). Malformed: dropped.
   */
  gpu_free: cappedArray(Vram, MAX_GPUS).optional().catch(undefined),
  /**
   * Agent discovery on that machine could not report every running session in its last scan (over the per-runtime
   * cap, or out of its time budget): `unreported` sessions keep their last status. Absent = complete.
   */
  discovery: z.object({ incomplete: z.boolean(), unreported: z.number().int().nonnegative().max(1_000_000) }).optional().catch(undefined),
  /**
   * WALKIE-POOL-2: this machine's measured round trip (ms, its sync `vv` call) to each peer it reached within its
   * liveness window, by node id, at most 64. Lets a viewer estimate the latency between two OTHER machines for a
   * split run. Absent from older daemons (the viewer then uses rtt(me,A) + rtt(me,B)). Malformed: dropped.
   */
  peer_rtt: z.record(z.string().regex(/^[0-9a-f]{16}$/), z.number().int().nonnegative().max(60_000))
    .refine((r) => Object.keys(r).length <= 64, { message: "too many peers" }).optional().catch(undefined),
  /** Platform, Walkie version and CPU load (MachineSys); absent from older daemons. Malformed: dropped, the rest kept. */
  sys: MachineSys.optional().catch(undefined),
  /**
   * AGENT-SEE-1: local model servers running on the machine (ollama, llama-server, rpc-server, vllm, mlx-lm), by name
   * and count: machine load, not agents. Absent: none seen, or an older daemon (which drops it). Malformed: dropped.
   */
  model_servers: cappedArray(z.object({ name: cappedName(24).pipe(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,23}$/)), count: z.number().int().min(1).max(1_000) }), 8).optional().catch(undefined),
});
export type MachineStats = z.infer<typeof MachineStats>;

/** Whether a machine's announced facts say it runs v2 seat requests (FO-2); an older daemon (no caps) does not. */
export function hasCap(stats: { sys?: MachineSys } | null | undefined, cap: string): boolean {
  return stats?.sys?.caps?.includes(cap) === true;
}
