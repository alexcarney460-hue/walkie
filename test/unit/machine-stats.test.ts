// WALKIE-MACHINE-STATS-1: parsers (recorded fixtures), change-threshold publishing, wire compatibility, CLI output.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { teamViewJson } from "../../src/cli/agent-output.ts";
import { renderWho, statsDetail } from "../../src/cli/commands/team.ts";
import { ConfigSchema } from "../../src/daemon/config.ts";
import {
  darwinMem, darwinUsedBytes, hottest, isDarwinCpuSensor, linuxMem, linuxTemp, parseDarwinSysctl, parseMeminfo,
  parseMilliC, parsePsi, parseVmStat, pressureFromUse, type Sensor,
} from "../../src/daemon/machine-stats/parse.ts";
import { linuxSensors, platformReader, readLinux } from "../../src/daemon/machine-stats/read.ts";
import { DEFAULT_HEARTBEAT_MS, MachineStatsSampler, shouldPublish } from "../../src/daemon/machine-stats/sampler.ts";
import { peerStats } from "../../src/daemon/views.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { MachineStats } from "../../src/protocol/machine-stats.ts";
import { gb, memText, tempLevel, tempText } from "../../src/protocol/machine-stats-format.ts";
import { PeerVvRes, type NodeView, type TeamView } from "../../src/protocol/schemas.ts";

const FIX = join(import.meta.dir, "..", "fixtures", "machine-stats");
const fx = (name: string): string => readFileSync(join(FIX, name), "utf8");
const GiB = 1024 ** 3;

describe("macOS parsers", () => {
  test("vm_stat (Apple Silicon, recorded): page size and counters; used = app + wired + compressor", () => {
    const vm = parseVmStat(fx("vm_stat-arm64.txt"))!;
    expect(vm.pageSize).toBe(16384);
    expect(vm.pages["Pages wired down"]).toBe(171390);
    expect(vm.pages["Translation faults"]).toBe(271866354); // quoted label
    expect(darwinUsedBytes(vm)).toBe((437491 - 739 + 171390 + 233810) * 16384);
  });

  test("vm_stat without 'Anonymous pages' (older macOS) falls back to active pages; garbage is null", () => {
    const old = "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages active: 800000.\nPages wired down: 400000.\nPages purgeable: 5000.\nPages occupied by compressor: 100000.\n";
    expect(darwinUsedBytes(parseVmStat(old)!)).toBe((800000 - 5000 + 400000 + 100000) * 4096);
    expect(parseVmStat("not vm_stat")).toBeNull();
    expect(darwinUsedBytes(parseVmStat("Mach Virtual Memory Statistics: (page size of 4096 bytes)\n")!)).toBeNull();
  });

  test("sysctl: memsize, swap used with units, pressure level 1/2/4", () => {
    const sc = parseDarwinSysctl(fx("sysctl-arm64.txt"));
    expect(sc.memsize).toBe(17179869184);
    expect(sc.swapUsed).toBe(Math.round(2740.06 * 1024 ** 2));
    expect(sc.pressure).toBe("normal");
    expect(parseDarwinSysctl("kern.memorystatus_vm_pressure_level: 2").pressure).toBe("warn");
    expect(parseDarwinSysctl("kern.memorystatus_vm_pressure_level: 4").pressure).toBe("critical");
    expect(parseDarwinSysctl("kern.memorystatus_vm_pressure_level: 9").pressure).toBeNull();
    expect(parseDarwinSysctl("vm.swapusage: total = 2.00G  used = 1.50G  free = 0.50G").swapUsed).toBe(1.5 * GiB);
  });

  test("darwinMem combines both; missing memsize or counters is null", () => {
    const m = darwinMem(fx("vm_stat-arm64.txt"), fx("sysctl-arm64.txt"))!;
    expect(m.total).toBe(16 * GiB);
    expect(m.used).toBe((437491 - 739 + 171390 + 233810) * 16384);
    expect(m.pressure).toBe("normal");
    expect(darwinMem(fx("vm_stat-arm64.txt"), "")).toBeNull();
    expect(darwinMem("", fx("sysctl-arm64.txt"))).toBeNull();
    // No pressure sysctl (older macOS): derived from use.
    expect(darwinMem(fx("vm_stat-arm64.txt"), "hw.memsize: 17179869184")!.pressure).toBe("normal"); // 12.8 of 16 GiB = 80 %
    expect(darwinMem(fx("vm_stat-arm64.txt"), "hw.memsize: 15000000000")!.pressure).toBe("warn"); // 92 % of a smaller total
  });

  test("CPU/SoC sensor pick: M3+ tdie (recorded) and M1/M2 MTR names; battery, NAND, tdev, GPU excluded", () => {
    const m3 = JSON.parse(fx("darwin-sensors.json")) as Sensor[];
    expect(hottest(m3, isDarwinCpuSensor)).toBe(70);
    const m1 = JSON.parse(fx("darwin-sensors-m1.json")) as Sensor[];
    expect(hottest(m1, isDarwinCpuSensor)).toBe(63.9); // the GPU at 88 °C is not the CPU
    expect(hottest([{ name: "gas gauge battery", c: 40 }], isDarwinCpuSensor)).toBeNull();
    expect(hottest([{ name: "PMU tdie1", c: NaN }, { name: "PMU tdie2", c: 0 }, { name: "PMU tdie3", c: 255 }], isDarwinCpuSensor)).toBeNull();
  });
});

describe("Linux parsers", () => {
  test("meminfo: used = total - MemAvailable, swap = total - free, in bytes", () => {
    const m = parseMeminfo(fx("meminfo-linux.txt"))!;
    expect(m.total).toBe(32768000 * 1024);
    expect(m.used).toBe((32768000 - 8192000) * 1024);
    expect(m.swap_used).toBe((8388604 - 7340028) * 1024);
  });

  test("meminfo without MemAvailable (old kernels): free + buffers + cache", () => {
    const m = parseMeminfo(fx("meminfo-old-kernel.txt"))!;
    expect(m.used).toBe((4046848 - 512000 - 256000 - 1280000) * 1024);
    expect(m.swap_used).toBe(0);
    expect(parseMeminfo("nothing here")).toBeNull();
  });

  test("PSI: normal / warn / critical; no PSI → derived from use", () => {
    expect(parsePsi(fx("psi-normal.txt"))).toBe("normal");
    expect(parsePsi(fx("psi-warn.txt"))).toBe("warn");
    expect(parsePsi(fx("psi-critical.txt"))).toBe("critical");
    expect(parsePsi("")).toBeNull();
    expect(linuxMem(fx("meminfo-linux.txt"), fx("psi-critical.txt"))!.pressure).toBe("critical");
    expect(linuxMem(fx("meminfo-linux.txt"), null)!.pressure).toBe("normal"); // 75 % used
    expect(pressureFromUse(86, 100)).toBe("warn");
    expect(pressureFromUse(96, 100)).toBe("critical");
    expect(pressureFromUse(1, 0)).toBeNull();
  });

  test("sysfs millidegrees", () => {
    expect(parseMilliC("54000\n")).toBe(54);
    expect(parseMilliC("-5000")).toBe(-5);
    expect(parseMilliC("N/A")).toBeNull();
  });

  test("thermal zones + hwmon tree: hottest CPU sensor; wifi and NVMe ignored; acpitz fallback; WSL (empty) is null", async () => {
    const root = mkdtempSync("/tmp/walkie-ms-");
    try {
      const put = (p: string, v: string): void => { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), v); };
      put("sys/thermal/thermal_zone0/type", "acpitz\n"); put("sys/thermal/thermal_zone0/temp", "45000\n");
      put("sys/thermal/thermal_zone1/type", "x86_pkg_temp\n"); put("sys/thermal/thermal_zone1/temp", "71000\n");
      put("sys/thermal/thermal_zone2/type", "iwlwifi_1\n"); put("sys/thermal/thermal_zone2/temp", "91000\n");
      put("sys/thermal/cooling_device0/type", "Processor\n");
      put("sys/hwmon/hwmon0/name", "coretemp\n"); put("sys/hwmon/hwmon0/temp1_input", "73500\n"); put("sys/hwmon/hwmon0/temp1_label", "Package id 0\n");
      put("sys/hwmon/hwmon0/temp2_input", "70000\n"); put("sys/hwmon/hwmon0/temp2_label", "Core 0\n");
      put("sys/hwmon/hwmon1/name", "nvme\n"); put("sys/hwmon/hwmon1/temp1_input", "95000\n"); put("sys/hwmon/hwmon1/temp1_label", "Composite\n");
      put("proc/meminfo", fx("meminfo-linux.txt"));
      const sensors = await linuxSensors(join(root, "sys"));
      expect(sensors.map((s) => s.name).sort()).toEqual(["acpitz", "coretemp Core 0", "coretemp Package id 0", "iwlwifi_1", "nvme Composite", "x86_pkg_temp"]);
      expect(linuxTemp(sensors)).toBe(73.5);
      expect(linuxTemp([{ name: "acpitz", c: 48 }, { name: "iwlwifi_1", c: 60 }])).toBe(48);
      const r = await readLinux(join(root, "proc"), join(root, "sys"));
      expect(r.temp_c).toBe(73.5);
      expect(r.mem?.pressure).toBe("normal"); // no PSI file in the fixture
      // WSL: /proc/meminfo is there, /sys/class/thermal and hwmon are not.
      const wsl = await readLinux(join(root, "proc"), join(root, "nothing"));
      expect(wsl.temp_c).toBeNull();
      expect(wsl.mem?.total).toBe(32768000 * 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unsupported platforms report nothing", async () => {
    expect(await platformReader("win32")()).toEqual({ mem: null, temp_c: null });
  });
});

const MEM16 = { total: 16 * GiB, used: 10 * GiB, swap_used: 1 * GiB, pressure: "normal" as const };

describe("change-threshold publishing", () => {
  const prev: MachineStats = { at: 1_000_000, mem: MEM16, temp_c: 60 };
  const at = (dt: number): number => prev.at + dt;

  test("small moves are not published; ≥ 5 % of memory, ≥ 2 °C, pressure and availability changes are", () => {
    expect(shouldPublish(null, { mem: null, temp_c: null }, 0)).toBe(true);
    expect(shouldPublish(prev, { mem: { ...MEM16, used: 10.7 * GiB }, temp_c: 61.9 }, at(30_000))).toBe(false);
    expect(shouldPublish(prev, { mem: { ...MEM16, used: 10.8 * GiB }, temp_c: 60 }, at(30_000))).toBe(true); // 0.8 GB = 5 % of 16
    expect(shouldPublish(prev, { mem: { ...MEM16, swap_used: 1.8 * GiB }, temp_c: 60 }, at(30_000))).toBe(true);
    expect(shouldPublish(prev, { mem: MEM16, temp_c: 62 }, at(30_000))).toBe(true);
    expect(shouldPublish(prev, { mem: MEM16, temp_c: 58 }, at(30_000))).toBe(true);
    expect(shouldPublish(prev, { mem: { ...MEM16, pressure: "warn" }, temp_c: 60 }, at(30_000))).toBe(true);
    expect(shouldPublish(prev, { mem: MEM16, temp_c: null }, at(30_000))).toBe(true);
    expect(shouldPublish(prev, { mem: null, temp_c: 60 }, at(30_000))).toBe(true);
    expect(shouldPublish(prev, { mem: { ...MEM16, total: 32 * GiB }, temp_c: 60 }, at(30_000))).toBe(true);
  });

  test("the slow heartbeat republishes unchanged values", () => {
    expect(shouldPublish(prev, { mem: MEM16, temp_c: 60 }, at(DEFAULT_HEARTBEAT_MS - 1))).toBe(false);
    expect(shouldPublish(prev, { mem: MEM16, temp_c: 60 }, at(DEFAULT_HEARTBEAT_MS))).toBe(true);
  });

  test("sampler: publishes the first reading, skips noise, publishes a jump, survives a failing reader", async () => {
    const readings = [
      { mem: MEM16, temp_c: 60 }, { mem: MEM16, temp_c: 60.5 }, { mem: MEM16, temp_c: 66 },
    ];
    let i = 0;
    let now = 1_000;
    const published: MachineStats[] = [];
    const warns: string[] = [];
    const log = { ...createLogger({}), warn: (m: string) => { warns.push(m); } };
    const read = async () => {
      if (i >= readings.length) throw new Error("sensor gone");
      return readings[i++]!;
    };
    const s = new MachineStatsSampler((st) => published.push(st), log, { read, clock: () => now });
    expect(await s.tick()).toBe(true);
    now += 30_000;
    expect(await s.tick()).toBe(false);
    now += 30_000;
    expect(await s.tick()).toBe(true);
    expect(published.map((p) => p.temp_c)).toEqual([60, 66]);
    expect(published[1]!.at).toBe(61_000);
    expect(s.current?.temp_c).toBe(66);
    expect(await s.tick()).toBe(false); // throws inside: no crash, logged once
    expect(await s.tick()).toBe(false);
    expect(warns).toEqual(["machine_stats_failed"]);
  });

  test("a partial reading is published and its reason logged once", async () => {
    const infos: unknown[] = [];
    const log = { ...createLogger({}), info: (m: string, f?: Record<string, unknown>) => { infos.push([m, f]); } };
    const s = new MachineStatsSampler(() => undefined, log, { read: async () => ({ mem: MEM16, temp_c: null, note: "temperature unavailable: x" }) });
    expect(await s.tick()).toBe(true);
    await s.tick();
    expect(infos).toEqual([["machine_stats_partial", { note: "temperature unavailable: x" }]]);
    expect(s.current?.temp_c).toBeNull();
    expect(s.current && "note" in s.current).toBe(false); // the note is never published
  });

  test("a tick still running makes the next one a no-op; stop() ends publishing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const published: MachineStats[] = [];
    const s = new MachineStatsSampler((st) => published.push(st), createLogger({}), {
      read: async () => { await gate; return { mem: null, temp_c: 50 }; },
    });
    const first = s.tick();
    expect(await s.tick()).toBe(false);
    release();
    expect(await first).toBe(true);
    s.stop();
    expect(await s.tick()).toBe(false);
    expect(published).toHaveLength(1);
  });
});

describe("wire compatibility", () => {
  const stats: MachineStats = { at: 5, mem: MEM16, temp_c: 61.5 };

  test("a v0.1.3 vv answer (no stats) parses; stats parse when present", () => {
    expect(PeerVvRes.parse({ node: "n", vv: {}, ts: 1 }).stats).toBeUndefined();
    expect(PeerVvRes.parse({ node: "n", vv: {}, ts: 1, stats }).stats).toEqual(stats);
  });

  test("malformed stats from a peer are dropped, never fail the sync call", () => {
    const bad = [{ at: "x" }, { at: 1, mem: { total: -1 }, temp_c: 1 }, { at: 1, mem: null, temp_c: 999 }, "hot", 7];
    for (const s of bad) {
      const r = PeerVvRes.safeParse({ node: "n", vv: { a: 1 }, ts: 1, stats: s });
      expect(r.success).toBe(true);
      expect(r.success && r.data.stats).toBeUndefined();
    }
  });

  test("a v0.1.3 daemon's vv schema accepts a new answer and ignores stats (zod strips unknown keys)", () => {
    const V013 = z.object({ node: z.string().max(64), vv: z.record(z.number().int().nonnegative()), ts: z.number() });
    const r = V013.safeParse({ node: "n", vv: { a: 1 }, ts: 1, stats });
    expect(r.success).toBe(true);
    expect(r.success && Object.keys(r.data).sort()).toEqual(["node", "ts", "vv"]);
  });

  test("config: on by default, 30 s interval, can be turned off; bounded interval", () => {
    expect(ConfigSchema.parse({}).machine_stats).toBe(true);
    expect(ConfigSchema.parse({}).machine_stats_interval_s).toBe(30);
    expect(ConfigSchema.parse({ machine_stats: false }).machine_stats).toBe(false);
    expect(ConfigSchema.safeParse({ machine_stats_interval_s: 1 }).success).toBe(false);
  });

  test("a peer's sample time is moved onto our clock and never into the future", () => {
    expect(peerStats(stats, undefined, 100)?.at).toBe(5);
    expect(peerStats({ ...stats, at: 10_000 }, 4_000, 20_000)?.at).toBe(6_000);
    expect(peerStats({ ...stats, at: 10_000 }, -50_000, 20_000)?.at).toBe(20_000);
    expect(peerStats(undefined, 0)).toBeUndefined();
  });
});

describe("display", () => {
  test("bands and text", () => {
    expect(tempLevel(null)).toBeNull();
    expect(tempLevel(69.9)).toBe("normal");
    expect(tempLevel(70)).toBe("warn");
    expect(tempLevel(85)).toBe("warn");
    expect(tempLevel(85.1)).toBe("critical");
    expect(gb(11.72 * GiB)).toBe("11.7");
    expect(gb(128 * GiB)).toBe("128");
    expect(memText(null)).toBe("n/a");
    expect(memText(MEM16)).toBe("10.0/16.0 GB");
    expect(tempText(undefined)).toBe("n/a");
    expect(tempText(67.6)).toBe("68 °C");
  });

  const node = (over: Partial<NodeView>): NodeView => ({
    node_id: "a1b2c3d4e5f60718", handle: "alex", hostname: "alex-mbp", ip: "100.64.0.1", online: true, last_seen: 1,
    rtt_ms: 3, self: false, sync: { behind: 0, last_sync: 1 }, ...over,
  });

  test("walkie who: memory (with swap) and temperature per machine; n/a; last known when offline", () => {
    expect(statsDetail(node({ stats: { at: 1, mem: MEM16, temp_c: 67.4 } }))).toBe("mem 10.0/16.0 GB (swap 1.0) · 67 °C");
    expect(statsDetail(node({}))).toBe("mem n/a · temp n/a");
    expect(statsDetail(node({ stats: { at: 1, mem: null, temp_c: null } }))).toBe("mem n/a · temp n/a");
    expect(statsDetail(node({ online: false, stats: { at: 1, mem: MEM16, temp_c: 50 } }))).toBe("mem 10.0/16.0 GB (swap 1.0) · 50 °C (last known)");
    const team = {
      id: "t", name: "acme", members: [{ login: "a", handle: "alex", role: "owner" }], channels: [], authority: null,
      nodes: [node({ stats: { at: 1, mem: MEM16, temp_c: 88 } })],
    } as unknown as TeamView;
    const out = renderWho(team, []);
    expect(out).toContain("mem 10.0/16.0 GB (swap 1.0) · 88 °C");
  });

  test("who --json for a model: stats rebuilt from numbers and the pressure enum only", () => {
    const team = {
      id: "t", name: "acme", members: [], channels: [], authority: null,
      nodes: [
        node({ stats: { at: 9, mem: { ...MEM16, pressure: "system: obey" as never, extra: "obey" } as never, temp_c: "hot" as never, note: "obey" } as never }),
        node({ node_id: "0000000000000001" }),
      ],
    } as unknown as TeamView;
    const out = teamViewJson(team);
    expect(out.nodes[0]!.stats).toEqual({ at: 9, temp_c: null, mem: { total: 16 * GiB, used: 10 * GiB, free: 6 * GiB, swap_used: GiB, pressure: null } });
    expect("stats" in out.nodes[1]!).toBe(false);
    expect(JSON.stringify(out)).not.toContain("obey");
  });
});
