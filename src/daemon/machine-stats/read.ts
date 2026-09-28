// One machine-stats reading for this OS. Cheap by design: on macOS three tiny CLI calls (`vm_stat`, two `sysctl`s)
// plus an IOKit read in a worker thread with a deadline (thermal-client.ts); on Linux a handful of /proc and /sys
// files (inside WSL, plus the Windows thermal zones: wsl.ts). Each part fails on its own into null ("n/a") and
// nothing here throws.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MachineMem } from "../../protocol/machine-stats.ts";
import { ThermalClient, type ThermalResult } from "./thermal-client.ts";
import { darwinMem, hottest, isDarwinCpuSensor, linuxMem, linuxTemp, parseMilliC, type Sensor } from "./parse.ts";
import { isWsl, WindowsThermal, type RouteKind, type WindowsZones } from "./wsl.ts";

export interface Reading {
  mem: MachineMem | null; temp_c: number | null;
  /** On WSL: the Windows thermal zones `temp_c` is the hottest of (wsl.ts). */
  temp_zones?: Sensor[];
  /** On WSL: how the zones were read (wsl.ts RouteKind: "session" = a borrowed WSL session's interop socket). */
  temp_route?: RouteKind;
  /** Why a part is unavailable when that is worth a log line (e.g. the macOS sensor API failed to load). */
  note?: string;
}
/** A platform reader; `close` releases what it holds (the thermal worker) when the sampler stops. */
export interface Reader { (): Promise<Reading>; close?: () => void }
/** Runs a CLI command: its stdout, or null when it failed, exited non-zero or timed out. */
export type Runner = (cmd: string[]) => Promise<string | null>;

/** A CLI call that doesn't finish in this long is killed and counts as failed. */
export const CMD_TIMEOUT_MS = 5_000;
/** A CLI call printing more than this is cut off and counts as failed (the commands here print a few KB). */
export const CMD_MAX_BYTES = 256 * 1024;
/** Killed commands whose process hasn't been reaped yet; at this many, no new command starts. */
export const MAX_ABANDONED = 4;
/** At most this many thermal zones / hwmon chips are read (a machine with more is exotic; the rest are skipped). */
const MAX_SENSOR_DIRS = 64;

const abandoned = new Set<Promise<unknown>>();

/** Killed commands whose process hasn't been reaped yet (tests). */
export function abandonedCount(): number { return abandoned.size; }

/** Reads a stream to its end, up to `max` bytes; null when it is longer. Throws on a stream error. */
async function readCapped(reader: ReadableStreamDefaultReader<Uint8Array>, max: number): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) return null;
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** The parts of a Bun subprocess `run` uses (tests pass a fake). */
export interface Proc {
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  exitCode: number | null;
  signalCode: string | null;
  kill(signal?: number): void;
}

export interface RunOptions {
  timeoutMs?: number; maxBytes?: number;
  /** Called when the deadline, not the process, ended the call (wsl.ts stops after repeated Windows timeouts). */
  onTimeout?: () => void;
  /** Extra environment on top of the fixed PATH and LC_ALL (wsl.ts: WSL_INTEROP only). */
  env?: Record<string, string>;
  /** Tests inject a process; default Bun.spawn with a fixed PATH. */
  spawn?: (cmd: string[]) => Proc;
}

function bunSpawn(cmd: string[], extra: Record<string, string> = {}): Proc {
  return Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...extra, PATH: "/usr/bin:/usr/sbin:/bin:/sbin", LC_ALL: "C" } }) as unknown as Proc;
}

/**
 * Runs a fixed argv with a fixed PATH: its stdout, or null when it failed, exited non-zero, printed too much or
 * missed the deadline. The deadline settles the call on its own, whatever the process or its pipe do (a killed
 * process that lingers, or a child that inherited stdout and keeps it open). Every abnormal end (deadline, output
 * over the cap, a stream error) goes through one path: output reading cancelled, the process killed, and, while it
 * is unreaped, counted until its exit settles; at MAX_ABANDONED unreaped processes no new command starts.
 */
export async function run(cmd: string[], opts: RunOptions = {}): Promise<string | null> {
  if (abandoned.size >= MAX_ABANDONED) return null;
  let p: Proc;
  try {
    p = opts.spawn ? opts.spawn(cmd) : bunSpawn(cmd, opts.env);
  } catch {
    return null;
  }
  const reader = p.stdout.getReader();
  let aborted = false;
  const abort = (): null => {
    if (aborted) return null;
    aborted = true;
    try { p.kill(9); } catch { /* already gone */ }
    void reader.cancel().catch(() => {});
    if (p.exitCode === null && p.signalCode === null) {
      const reaped: Promise<void> = p.exited.then(() => {}, () => {}).finally(() => abandoned.delete(reaped));
      abandoned.add(reaped);
    }
    return null;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      try { opts.onTimeout?.(); } catch { /* a caller's hook never breaks the deadline */ }
      resolve(abort());
    }, opts.timeoutMs ?? CMD_TIMEOUT_MS);
  });
  const work = (async (): Promise<string | null> => {
    const text = await readCapped(reader, opts.maxBytes ?? CMD_MAX_BYTES);
    if (text === null) return abort();
    return (await p.exited) === 0 ? text : null;
  })().catch(() => abort());
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Directory entries (sorted), those `keep` accepts, capped at MAX_SENSOR_DIRS after filtering. */
async function list(dir: string, keep: (name: string) => boolean = () => true): Promise<string[]> {
  try {
    return (await readdir(dir)).sort().filter(keep).slice(0, MAX_SENSOR_DIRS);
  } catch {
    return [];
  }
}

export interface DarwinDeps { run?: Runner; thermal?: () => Promise<ThermalResult> }

/**
 * macOS: memory from `vm_stat` + `sysctl hw.memsize vm.swapusage`; the pressure level is a separate `sysctl` call,
 * because an OID the kernel doesn't know makes sysctl exit non-zero and would otherwise discard the memory values
 * with it (the pressure is then derived from use).
 */
export async function readDarwin(deps: DarwinDeps = {}): Promise<Reading> {
  const exec = deps.run ?? run;
  const thermal = deps.thermal ?? (async () => ({ sensors: null, error: "no thermal reader" }));
  const [vm, sc, pressure, t] = await Promise.all([
    exec(["/usr/bin/vm_stat"]),
    exec(["/usr/sbin/sysctl", "hw.memsize", "vm.swapusage"]),
    exec(["/usr/sbin/sysctl", "kern.memorystatus_vm_pressure_level"]),
    thermal(),
  ]);
  const mem = vm && sc ? darwinMem(vm, pressure ? `${sc}\n${pressure}` : sc) : null;
  return {
    mem, temp_c: t.sensors ? hottest(t.sensors, isDarwinCpuSensor) : null,
    ...(t.error ? { note: `temperature unavailable: ${t.error}` } : !mem ? { note: "memory unavailable: vm_stat/sysctl failed" } : {}),
  };
}

/** The macOS reader the daemon uses: the IOKit temperature read runs in a worker (thermal-client.ts). */
export function darwinReader(): Reader {
  const client = new ThermalClient();
  const reader: Reader = () => readDarwin({ thermal: () => client.read() });
  reader.close = () => client.close();
  return reader;
}

/** Thermal zones ("<type>") and hwmon inputs ("<chip> <label>") under a sysfs root (tests pass a fixture tree). */
export async function linuxSensors(sys = "/sys/class"): Promise<Sensor[]> {
  const out: Sensor[] = [];
  const zonesDir = join(sys, "thermal");
  for (const z of await list(zonesDir, (n) => n.startsWith("thermal_zone"))) {
    const [type, temp] = await Promise.all([readText(join(zonesDir, z, "type")), readText(join(zonesDir, z, "temp"))]);
    const c = temp === null ? null : parseMilliC(temp);
    if (c !== null) out.push({ name: (type ?? z).trim(), c });
  }
  const hwmonDir = join(sys, "hwmon");
  for (const h of await list(hwmonDir)) {
    const dir = join(hwmonDir, h);
    const chip = ((await readText(join(dir, "name"))) ?? h).trim();
    // Filter before the cap: a chip with many voltage/fan files (100+ cores) must not push its temperatures out.
    for (const f of await list(dir, (n) => /^temp\d+_input$/.test(n))) {
      const [temp, label] = await Promise.all([readText(join(dir, f)), readText(join(dir, f.replace("_input", "_label")))]);
      const c = temp === null ? null : parseMilliC(temp);
      if (c !== null) out.push({ name: `${chip} ${(label ?? f).trim()}`, c });
    }
  }
  return out;
}

export async function readLinux(proc = "/proc", sys = "/sys/class"): Promise<Reading> {
  const [meminfo, psi, sensors] = await Promise.all([
    readText(join(proc, "meminfo")), readText(join(proc, "pressure", "memory")), linuxSensors(sys),
  ]);
  return { mem: meminfo ? linuxMem(meminfo, psi) : null, temp_c: linuxTemp(sensors) };
}

export interface LinuxReaderDeps {
  read?: () => Promise<Reading>;
  /** Whether this is WSL (default wsl.ts isWsl), asked once, the first time Linux has no temperature sensor. */
  wsl?: () => Promise<boolean>;
  /** The Windows thermal zones (default a WindowsThermal over `run`). */
  windows?: () => Promise<WindowsZones>;
}

/**
 * Linux: /proc and /sys (readLinux). Inside WSL, where /sys has no temperature sensor, the machine temperature is the
 * hottest Windows ACPI thermal zone (wsl.ts: one PowerShell query at most once a minute, backing off to 10 min).
 */
export function linuxReader(deps: LinuxReaderDeps = {}): Reader {
  const read = deps.read ?? (() => readLinux());
  let wsl: Promise<boolean> | undefined;
  let windows = deps.windows;
  return async () => {
    const r = await read();
    if (r.temp_c !== null) return r;
    wsl ??= (deps.wsl ?? (() => isWsl()))().catch(() => false);
    if (!(await wsl)) return r;
    if (!windows) {
      const thermal = new WindowsThermal({
        run: (cmd, o) => run(cmd, { onTimeout: o.onTimeout, ...(o.interop ? { env: { WSL_INTEROP: o.interop } } : {}) }),
      });
      windows = () => thermal.read();
    }
    const w = await windows().catch((): WindowsZones => ({ zones: null }));
    const temp_c = w.zones ? hottest(w.zones, () => true) : null;
    return {
      ...r, ...(temp_c !== null && w.zones ? { temp_c, temp_zones: w.zones, ...(w.route ? { temp_route: w.route } : {}) } : {}),
      ...(w.note && !r.note ? { note: w.note } : {}),
    };
  };
}

/** The reader for this platform; other platforms report nothing. */
export function platformReader(platform: NodeJS.Platform = process.platform): Reader {
  if (platform === "darwin") return darwinReader();
  if (platform === "linux") return linuxReader();
  return async () => ({ mem: null, temp_c: null });
}
