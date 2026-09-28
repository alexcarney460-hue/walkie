// Display rules for machine stats shared by the CLI and the dashboard. No zod here: the dashboard bundle imports it.
import type { MachineMem, MemPressure } from "./machine-stats.ts";

/**
 * Plausible temperatures: readings outside this range are sensor noise (unplugged probes report -127 or 255 °C, some
 * macOS tdev sensors -21 °C). The sampler drops them and the wire schema refuses them.
 */
export const TEMP_MIN_C = 1;
export const TEMP_MAX_C = 150;

/** Temperature bands: normal below 70 °C, warn 70–85 °C, critical above 85 °C. */
export const TEMP_WARN_C = 70;
export const TEMP_CRITICAL_C = 85;

export function tempLevel(c: number | null): MemPressure | null {
  if (c === null) return null;
  return c > TEMP_CRITICAL_C ? "critical" : c >= TEMP_WARN_C ? "warn" : "normal";
}

/** Bytes as GB with one decimal below 100 ("11.7", "128"). */
export function gb(bytes: number): string {
  const v = bytes / 1024 ** 3;
  return v >= 100 ? String(Math.round(v)) : v.toFixed(1);
}

/** "11.7/16.0 GB" or "n/a". */
export function memText(mem: MachineMem | null | undefined): string {
  return mem ? `${gb(mem.used)}/${gb(mem.total)} GB` : "n/a";
}

/** "67 °C" or "n/a". */
export function tempText(c: number | null | undefined): string {
  return c === null || c === undefined ? "n/a" : `${Math.round(c)} °C`;
}
