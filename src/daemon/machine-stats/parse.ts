// Pure parsers for machine stats (test/unit/machine-stats.test.ts feeds them recorded fixtures).
// macOS: `vm_stat` + `sysctl hw.memsize vm.swapusage kern.memorystatus_vm_pressure_level`, IOHID sensor names.
// Linux: /proc/meminfo, /proc/pressure/memory (PSI), /sys/class/thermal and /sys/class/hwmon readings.
import type { MachineMem, MemPressure } from "../../protocol/machine-stats.ts";
import { TEMP_MAX_C, TEMP_MIN_C } from "../../protocol/machine-stats-format.ts";

/** Pressure from the share of memory in use, when the OS gives no pressure signal. */
export function pressureFromUse(used: number, total: number): MemPressure | null {
  if (!(total > 0)) return null;
  const r = used / total;
  return r >= 0.95 ? "critical" : r >= 0.85 ? "warn" : "normal";
}

// ---- macOS ------------------------------------------------------------------------------------------

export interface VmStat { pageSize: number; pages: Record<string, number> }

/** `vm_stat` output: "Mach Virtual Memory Statistics: (page size of 16384 bytes)" then `Label:   123.` lines. */
export function parseVmStat(text: string): VmStat | null {
  const ps = /page size of (\d+) bytes/.exec(text);
  if (!ps) return null;
  const pages: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^"?([^":]+)"?:\s+(\d+)\.?\s*$/.exec(line.trim());
    if (m) pages[(m[1] as string).trim()] = Number(m[2]);
  }
  return { pageSize: Number(ps[1]), pages };
}

/**
 * Memory in use the way Activity Monitor counts it: app memory (anonymous pages minus purgeable) + wired + the
 * compressor's own pages. File cache and free pages are not "used".
 */
export function darwinUsedBytes(vm: VmStat): number | null {
  const p = vm.pages;
  const wired = p["Pages wired down"];
  const anon = p["Anonymous pages"] ?? p["Pages active"];
  if (wired === undefined || anon === undefined) return null;
  const app = Math.max(0, anon - (p["Pages purgeable"] ?? 0));
  return (app + wired + (p["Pages occupied by compressor"] ?? 0)) * vm.pageSize;
}

export interface DarwinSysctl { memsize: number | null; swapUsed: number | null; swapTotal: number | null; pressure: MemPressure | null }

const UNIT: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `sysctl hw.memsize vm.swapusage kern.memorystatus_vm_pressure_level` (named lines, any order). */
export function parseDarwinSysctl(text: string): DarwinSysctl {
  const out: DarwinSysctl = { memsize: null, swapUsed: null, swapTotal: null, pressure: null };
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    if (key === "hw.memsize" && /^\d+$/.test(val)) out.memsize = Number(val);
    else if (key === "vm.swapusage") {
      const total = /total = ([\d.]+)([BKMGT])/.exec(val);
      if (total) out.swapTotal = Math.round(Number(total[1]) * (UNIT[total[2] as string] ?? 1));
      const m = /used = ([\d.]+)([BKMGT])/.exec(val);
      if (m) out.swapUsed = Math.round(Number(m[1]) * (UNIT[m[2] as string] ?? 1));
    } else if (key === "kern.memorystatus_vm_pressure_level") {
      // xnu: 1 normal, 2 warning, 4 critical (kVMPressureNormal/Warning/Critical).
      out.pressure = val === "1" ? "normal" : val === "2" ? "warn" : val === "4" ? "critical" : null;
    }
  }
  return out;
}

export function darwinMem(vmStatText: string, sysctlText: string): MachineMem | null {
  const vm = parseVmStat(vmStatText);
  const sc = parseDarwinSysctl(sysctlText);
  const used = vm ? darwinUsedBytes(vm) : null;
  if (!sc.memsize || used === null) return null;
  const clamped = Math.min(used, sc.memsize);
  return { total: sc.memsize, used: clamped, swap_used: sc.swapUsed ?? 0,
    ...(sc.swapTotal === null ? {} : { swap_total: sc.swapTotal }),
    pressure: sc.pressure ?? pressureFromUse(clamped, sc.memsize) };
}

export interface Sensor { name: string; c: number }

/** CPU/SoC die sensors: Apple Silicon "PMU tdie*" (M3+), "pACC/eACC/SOC MTR Temp Sensor*" (M1/M2). */
const DARWIN_CPU = /tdie|MTR Temp Sensor|ACC|SOC|CPU/i;
const DARWIN_NOT_CPU = /battery|gas gauge|NAND|tdev|tcal|GPU/i;

export function isDarwinCpuSensor(name: string): boolean {
  return DARWIN_CPU.test(name) && !DARWIN_NOT_CPU.test(name);
}

/** The hottest CPU/SoC sensor, or null when none reads plausibly. */
export function hottest(sensors: readonly Sensor[], pick: (name: string) => boolean): number | null {
  let max: number | null = null;
  for (const s of sensors) {
    if (!pick(s.name) || !Number.isFinite(s.c) || s.c < TEMP_MIN_C || s.c > TEMP_MAX_C) continue;
    if (max === null || s.c > max) max = s.c;
  }
  return max === null ? null : Math.round(max * 10) / 10;
}

// ---- Linux ------------------------------------------------------------------------------------------

/** /proc/meminfo (kB). Used = total - available (MemAvailable, else free + buffers + cache on old kernels). */
export function parseMeminfo(text: string): Omit<MachineMem, "pressure"> | null {
  const kb: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line);
    if (m) kb[m[1] as string] = Number(m[2]);
  }
  const total = kb.MemTotal;
  if (!total) return null;
  const available = kb.MemAvailable ?? (kb.MemFree ?? 0) + (kb.Buffers ?? 0) + (kb.Cached ?? 0);
  const swap = Math.max(0, (kb.SwapTotal ?? 0) - (kb.SwapFree ?? 0));
  return { total: total * 1024, used: Math.max(0, Math.min(total, total - available)) * 1024, swap_used: swap * 1024,
    ...(kb.SwapTotal === undefined ? {} : { swap_total: kb.SwapTotal * 1024 }) };
}

/**
 * /proc/pressure/memory: `some avg10=… ` / `full avg10=…` (share of the last 10 s that tasks stalled on memory).
 * critical: all non-idle tasks stalled ≥ 10 %; warn: some stalled ≥ 10 % or all ≥ 2 %.
 */
export function parsePsi(text: string): MemPressure | null {
  const avg = (kind: string): number | null => {
    const m = new RegExp(`^${kind} avg10=([\\d.]+)`, "m").exec(text);
    return m ? Number(m[1]) : null;
  };
  const some = avg("some");
  const full = avg("full");
  if (some === null && full === null) return null;
  if ((full ?? 0) >= 10) return "critical";
  if ((some ?? 0) >= 10 || (full ?? 0) >= 2) return "warn";
  return "normal";
}

export function linuxMem(meminfo: string, psi: string | null): MachineMem | null {
  const m = parseMeminfo(meminfo);
  if (!m) return null;
  return { ...m, pressure: (psi ? parsePsi(psi) : null) ?? pressureFromUse(m.used, m.total) };
}

/** Thermal zone types and hwmon chip names/labels that are the CPU package, its cores or the SoC. */
const LINUX_CPU = /x86_pkg_temp|cpu|soc|package|core|tctl|tdie|k10temp|coretemp|zenpower/i;

export function isLinuxCpuSensor(name: string): boolean {
  return LINUX_CPU.test(name);
}

/** A sysfs temperature file: millidegrees Celsius as an integer ("54000\n"); null if unreadable. */
export function parseMilliC(text: string): number | null {
  const t = text.trim();
  if (!/^-?\d+$/.test(t)) return null;
  return Number(t) / 1000;
}

/**
 * The hottest CPU/SoC reading on Linux. Sensor names are "<thermal zone type>" or "<hwmon chip> <label>".
 * Without any CPU-named sensor, ACPI zones (acpitz, usually the package on laptops) are the fallback.
 */
export function linuxTemp(sensors: readonly Sensor[]): number | null {
  return hottest(sensors, isLinuxCpuSensor) ?? hottest(sensors, (n) => /^acpitz/i.test(n));
}
