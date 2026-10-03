// Accelerator facts for local-model suggestions (src/pool/): read once when the daemon starts, published with every
// machine-stats snapshot. macOS: `sysctl -n` for the chip name, Apple Silicon (unified memory) and a user-set GPU
// memory limit. Linux/WSL: the CPU model from /proc/cpuinfo. Any OS: NVIDIA GPUs from one `nvidia-smi` call with a
// timeout, when it is installed at a standard path. Each part fails on its own; nothing here throws.
import { readFile } from "node:fs/promises";
import { HW_NAME_MAX, MAX_GPUS, MAX_VRAM_BYTES, type MachineAccel } from "../../protocol/machine-stats.ts";
import { run as defaultRun, type Runner } from "./read.ts";
import { plausibleC } from "./wsl.ts";

/** Where nvidia-smi lives: the driver's standard path, /usr/local, and WSL's mount of the Windows driver. */
const NVIDIA_SMI = ["/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi", "/usr/lib/wsl/lib/nvidia-smi"];
const MIB = 1024 ** 2;

/** A hardware name kept to printable ASCII, collapsed spaces, at most HW_NAME_MAX characters; null when empty. */
export function hwName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, HW_NAME_MAX).trim();
  return s || null;
}

/** macOS: `sysctl -n machdep.cpu.brand_string`, `hw.optional.arm64` ("1" on Apple Silicon), `iogpu.wired_limit_mb`. */
export function parseDarwinAccel(brand: string | null, arm64: string | null, wiredLimitMb: string | null): Omit<MachineAccel, "gpus"> {
  const mb = Number((wiredLimitMb ?? "").trim());
  return {
    chip: hwName(brand),
    unified: (arm64 ?? "").trim() === "1",
    gpu_limit: Number.isInteger(mb) && mb > 0 && mb < 2 ** 32 ? mb * MIB : null,
  };
}

/** /proc/cpuinfo: x86 "model name", else Arm "Model" / "Hardware" (Raspberry Pi and similar). */
export function parseCpuinfo(text: string | null): string | null {
  if (!text) return null;
  for (const key of ["model name", "Model", "Hardware"]) {
    const m = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m").exec(text);
    if (m) return hwName(m[1]);
  }
  return null;
}

/**
 * NVIDIA integrated GPUs that share the machine's memory with the CPU: nvidia-smi prints `[N/A]` for their memory
 * (captured on a DGX Spark: "NVIDIA GB10, [N/A]"). Only these names count; a discrete card whose memory could not be read
 * is still skipped, so a failed query never invents a GPU.
 */
const INTEGRATED_NVIDIA = /\b(?:GB10|Jetson|Orin|Thor|Tegra)\b/i;

/**
 * `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`: "NVIDIA GeForce RTX 4090, 24564" (MiB).
 * An integrated GPU with `[N/A]` memory is kept as `{vram: 0, unified: true}` (WALK-81).
 */
export function parseNvidiaSmi(text: string | null): MachineAccel["gpus"] {
  if (!text) return [];
  const out: MachineAccel["gpus"] = [];
  for (const line of text.split("\n")) {
    const i = line.lastIndexOf(",");
    if (i < 0) continue;
    const name = hwName(line.slice(0, i));
    const field = line.slice(i + 1).trim();
    const mib = Number(field);
    if (name && /^\[?N\/A\]?$/i.test(field) && INTEGRATED_NVIDIA.test(name)) {
      out.push({ name, vram: 0, unified: true });
    } else if (name && Number.isFinite(mib) && mib > 0 && mib * MIB <= MAX_VRAM_BYTES) {
      out.push({ name, vram: Math.round(mib) * MIB });
    } else continue;
    if (out.length >= MAX_GPUS) break;
  }
  return out;
}

/**
 * `llama-server --list-devices` on Apple Silicon: "  MTL0: Apple M5 (12124 MiB, 12123 MiB free)". The total is Metal's
 * recommendedMaxWorkingSetSize, the most the GPU may wire; bytes, or null when no Metal device is listed.
 */
export function parseMetalBudget(text: string | null): number | null {
  const m = /^\s*MTL0:[^(\n]*\((\d+) MiB/m.exec(text ?? "");
  const mib = m ? Number(m[1]) : NaN;
  return Number.isInteger(mib) && mib > 0 && mib * MIB <= 2 ** 42 ? mib * MIB : null;
}

export interface AccelDeps {
  /** Apple Silicon: Metal's working-set budget in bytes, when it can be read (main.ts: the installed llama-server). */
  metalBudget?: () => Promise<number | null>;
  platform?: NodeJS.Platform;
  run?: Runner;
  readText?: (path: string) => Promise<string | null>;
  exists?: (path: string) => Promise<boolean>;
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function nvidiaSmi(exists: (p: string) => Promise<boolean>): Promise<string | null> {
  for (const bin of NVIDIA_SMI) if (await exists(bin)) return bin;
  return null;
}

async function nvidiaGpus(run: Runner, exists: (p: string) => Promise<boolean>): Promise<MachineAccel["gpus"]> {
  const bin = await nvidiaSmi(exists);
  return bin ? parseNvidiaSmi(await run([bin, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])) : [];
}

/** `nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits`: one MiB figure per line; null unless all parse. */
export function parseGpuFree(text: string | null, gpus: number): number[] | null {
  if (!text) return null;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length !== gpus) return null;
  const out: number[] = [];
  for (const l of lines) {
    const mib = Number(l);
    if (!Number.isFinite(mib) || mib < 0 || mib * MIB > MAX_VRAM_BYTES) return null;
    out.push(Math.round(mib) * MIB);
  }
  return out;
}

/** Free VRAM per NVIDIA GPU now, in the order `readAccel` listed them; null when it can't be measured. */
export async function readGpuFree(gpus: number, deps: Pick<AccelDeps, "run" | "exists"> = {}): Promise<number[] | null> {
  if (gpus <= 0) return null;
  const bin = await nvidiaSmi(deps.exists ?? ((p: string) => Bun.file(p).exists()));
  return bin ? parseGpuFree(await (deps.run ?? defaultRun)([bin, "--query-gpu=memory.free", "--format=csv,noheader,nounits"]), gpus) : null;
}

/** Free VRAM and temperature per NVIDIA GPU, from one nvidia-smi call per sample. */
export interface GpuNow { free: number[] | null; temp: (number | null)[] | null }

/**
 * `nvidia-smi --query-gpu=memory.free,temperature.gpu --format=csv,noheader,nounits`: "7891, 61" per GPU. Free VRAM
 * as parseGpuFree (null unless every line parses); a temperature that is "[N/A]" or outside 5-120 °C is null, and the
 * list is null when no GPU has one.
 */
export function parseGpuNow(text: string | null, gpus: number): GpuNow {
  if (!text) return { free: null, temp: null };
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length !== gpus) return { free: null, temp: null };
  const cols = lines.map((l) => l.split(",").map((c) => c.trim()));
  const free = parseGpuFree(cols.map((c) => c[0] ?? "").join("\n"), gpus);
  const temp = cols.map((c) => {
    const v = c[1] !== undefined && /^\d+(\.\d+)?$/.test(c[1]) ? Number(c[1]) : Number.NaN;
    return plausibleC(v) ? v : null;
  });
  return { free, temp: temp.some((t) => t !== null) ? temp : null };
}

/** Free VRAM and temperature per NVIDIA GPU now, in the order `readAccel` listed them. */
export async function readGpuNow(gpus: number, deps: Pick<AccelDeps, "run" | "exists"> = {}): Promise<GpuNow> {
  if (gpus <= 0) return { free: null, temp: null };
  const bin = await nvidiaSmi(deps.exists ?? ((p: string) => Bun.file(p).exists()));
  if (!bin) return { free: null, temp: null };
  return parseGpuNow(await (deps.run ?? defaultRun)([bin, "--query-gpu=memory.free,temperature.gpu", "--format=csv,noheader,nounits"]), gpus);
}

/** This machine's accelerator facts, or null on a platform Walkie doesn't read (Windows outside WSL). */
export async function readAccel(deps: AccelDeps = {}): Promise<MachineAccel | null> {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? defaultRun;
  const exists = deps.exists ?? ((p: string) => Bun.file(p).exists());
  if (platform === "darwin") {
    const sysctl = (oid: string) => run(["/usr/sbin/sysctl", "-n", oid]); // one OID per call: a missing one fails alone
    const [brand, arm64, wired, gpus] = await Promise.all([
      sysctl("machdep.cpu.brand_string"), sysctl("hw.optional.arm64"), sysctl("iogpu.wired_limit_mb"), nvidiaGpus(run, exists),
    ]);
    const base = { ...parseDarwinAccel(brand, arm64, wired), gpus };
    const metal = base.unified && deps.metalBudget ? await deps.metalBudget().catch(() => null) : null;
    return metal ? { ...base, metal_budget: metal } : base;
  }
  if (platform === "linux") {
    const [cpuinfo, gpus] = await Promise.all([(deps.readText ?? readTextFile)("/proc/cpuinfo"), nvidiaGpus(run, exists)]);
    return { chip: parseCpuinfo(cpuinfo), unified: false, gpu_limit: null, gpus };
  }
  return null;
}
