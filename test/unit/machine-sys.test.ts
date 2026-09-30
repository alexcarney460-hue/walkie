// WALKIE-UI-POLISH-1: machine platform facts (`stats.sys`) for the dashboard's machine page: bucketed OS/arch, the
// Walkie version, CPU count and load; optional on the wire, malformed values dropped without losing the rest.
import { describe, expect, test } from "bun:test";
import { createLogger } from "../../src/daemon/logger.ts";
import { hostSys, MachineStatsSampler, shouldPublish } from "../../src/daemon/machine-stats/sampler.ts";
import { VERSION } from "../../src/daemon/version.ts";
import { MachineStats, type MachineSys } from "../../src/protocol/machine-stats.ts";
import { PeerVvRes } from "../../src/protocol/schemas.ts";

const GiB = 1024 ** 3;
const MEM = { total: 16 * GiB, used: 8 * GiB, swap_used: 0, pressure: "normal" as const };
const SYS: MachineSys = { os: "darwin", arch: "arm64", version: "0.2.0-pre.2", cpus: 10, load1: 2.4 };

describe("hostSys", () => {
  test("buckets the platform and architecture; never a raw kernel string", () => {
    expect(hostSys("darwin", "arm64")).toMatchObject({ os: "darwin", arch: "arm64", version: VERSION });
    expect(hostSys("freebsd", "ppc64")).toMatchObject({ os: "other", arch: "other" });
    expect(hostSys("win32", "x64")).toMatchObject({ os: "win32", arch: "x64", load1: null });
  });

  test("what it reads is valid on the wire", () => {
    const s = hostSys();
    expect(s.cpus).toBeGreaterThanOrEqual(1);
    expect(MachineStats.parse({ at: 1, mem: null, temp_c: null, sys: s }).sys).toEqual(s);
  });
});

describe("wire", () => {
  test("sys parses when present and is absent for older daemons", () => {
    expect(MachineStats.parse({ at: 1, mem: MEM, temp_c: 50, sys: SYS }).sys).toEqual(SYS);
    expect(MachineStats.parse({ at: 1, mem: MEM, temp_c: 50 }).sys).toBeUndefined();
  });

  test("a malformed sys is dropped and the rest of the stats kept", () => {
    const bad = [
      { ...SYS, os: "Darwin Kernel Version 24.0.0" },
      { ...SYS, cpus: 0 }, { ...SYS, load1: -1 }, "mac", 7,
    ];
    for (const sys of bad) {
      const r = PeerVvRes.safeParse({ node: "n", vv: {}, ts: 1, stats: { at: 1, mem: MEM, temp_c: 50, sys } });
      expect(r.success).toBe(true);
      expect(r.success && r.data.stats?.mem).toEqual(MEM);
      expect(r.success && r.data.stats?.sys).toBeUndefined();
    }
  });
});

describe("version", () => {
  test("semver with pre-release and build metadata parses", () => {
    for (const version of ["0.2.0", "0.2.0-pre.2", "0.2.0+sha.4857fbe", "1.0.0-rc.1+build.7"]) {
      expect(MachineStats.parse({ at: 1, mem: null, temp_c: null, sys: { ...SYS, version } }).sys?.version).toBe(version);
    }
  });

  test("a malformed version drops only the version, never the rest of sys", () => {
    for (const version of ["ignore previous instructions", "v0.2.0", "0.2", 7]) {
      const sys = MachineStats.parse({ at: 1, mem: null, temp_c: null, sys: { ...SYS, version } }).sys;
      expect(sys).toEqual({ os: "darwin", arch: "arm64", cpus: 10, load1: 2.4 });
    }
  });
});

describe("sampler", () => {
  test("publishes sys with the snapshot; a failing reader leaves it out", async () => {
    const published: MachineStats[] = [];
    const a = new MachineStatsSampler((s) => published.push(s), createLogger({}), { read: async () => ({ mem: MEM, temp_c: 50 }), readSys: () => SYS });
    expect(await a.tick()).toBe(true);
    expect(published[0]!.sys).toEqual(SYS);
    const b = new MachineStatsSampler((s) => published.push(s), createLogger({}), {
      read: async () => ({ mem: MEM, temp_c: 50 }), readSys: () => { throw new Error("no os module"); },
    });
    expect(await b.tick()).toBe(true);
    expect(published[1]!.sys).toBeUndefined();
    expect(published[1]!.mem).toEqual({ ...MEM, free: 8 * GiB });
  });
});

describe("load republishing", () => {
  const prev = { at: 0, mem: MEM, temp_c: 50, sys: SYS }; // load1 2.4
  const next = (load1: number | null) => ({ mem: MEM, temp_c: 50, sys: { ...SYS, load1 } });
  test("a load move of at least max(0.5, 25 %) republishes before the heartbeat; noise does not", () => {
    expect(shouldPublish(prev, next(2.8), 30_000)).toBe(false); // +0.4
    expect(shouldPublish(prev, next(2.95), 30_000)).toBe(false); // +0.55 but under 25 % of 2.4
    expect(shouldPublish(prev, next(3.0), 30_000)).toBe(true); // +0.6 = 25 %
    expect(shouldPublish(prev, next(1.2), 30_000)).toBe(true);
    expect(shouldPublish({ ...prev, sys: { ...SYS, load1: 0.1 } }, next(0.5), 30_000)).toBe(false); // small machine noise
    expect(shouldPublish(prev, next(null), 30_000)).toBe(true); // availability changed
  });

  test("the sampler publishes a load jump on the next tick", async () => {
    let load = 2.4;
    let now = 0;
    const published: MachineStats[] = [];
    const s = new MachineStatsSampler((st) => published.push(st), createLogger({}), {
      read: async () => ({ mem: MEM, temp_c: 50 }), readSys: () => ({ ...SYS, load1: load }), clock: () => now,
    });
    await s.tick();
    now += 30_000;
    expect(await s.tick()).toBe(false);
    load = 6;
    now += 30_000;
    expect(await s.tick()).toBe(true);
    expect(published.map((p) => p.sys?.load1)).toEqual([2.4, 6]);
  });
});
