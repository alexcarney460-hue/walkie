// WALKIE-POOL-LLM-1 part A: machine-stats audit follow-ups (docs/audits/2026-09-26-*machine-stats*.md).
// CF type check + reference accounting on a fake IOKit, the optional pressure sysctl, schema bounds, the hwmon cap
// and the worker deadline.
import { describe, expect, test } from "bun:test";
import { toBuffer } from "bun:ffi";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DarwinThermal, type ThermalLib } from "../../src/daemon/machine-stats/darwin-thermal.ts";
import { isDarwinCpuSensor } from "../../src/daemon/machine-stats/parse.ts";
import { linuxSensors, readDarwin } from "../../src/daemon/machine-stats/read.ts";
import { MAX_TIMEOUTS, MAX_TOTAL_TIMEOUTS, RETRY_BASE_MS, ThermalClient } from "../../src/daemon/machine-stats/thermal-client.ts";
import { peerStats, STATS_FUTURE_TOLERANCE_MS } from "../../src/daemon/views.ts";
import { MachineStats } from "../../src/protocol/machine-stats.ts";
import { PeerVvRes } from "../../src/protocol/schemas.ts";

const GiB = 1024 ** 3;

// ---- fake CoreFoundation / IOKit ----------------------------------------------------------------------------

interface FakeService { name: string | null /* null: Product is a CFNumber, not a CFString */; c: number }

function fakeLib(services: FakeService[], failAt?: "string" | "dict" | "client" | "typeid") {
  let next = 1000n;
  const live = new Set<bigint>(); // references the reader owns (Create/Copy) and must release
  const props = new Map<bigint, string | null>();
  const events = new Map<bigint, number>();
  const serviceRefs = services.map((_, i) => 50n + BigInt(i));
  const own = (): bigint => { const r = next++; live.add(r); return r; };
  let getCString = 0;
  const cf = {
    CFStringCreateWithCString: () => (failAt === "string" ? 0n : own()),
    CFNumberCreate: () => own(),
    CFDictionaryCreate: () => (failAt === "dict" ? 0n : own()),
    CFArrayGetCount: () => services.length,
    CFArrayGetValueAtIndex: (_arr: bigint, i: number) => serviceRefs[i] ?? 0n,
    CFGetTypeID: (r: bigint) => (props.get(r) === null ? 22n : 7n),
    CFStringGetTypeID: () => (failAt === "typeid" ? 0n : 7n),
    CFStringGetCString: (r: bigint, p: number, len: number) => {
      getCString++;
      const name = props.get(r);
      if (typeof name !== "string") throw new Error("CFStringGetCString called on a non-string");
      const bytes = new TextEncoder().encode(name + "\0");
      toBuffer(p, 0, len).set(bytes.subarray(0, len));
      return true;
    },
    CFRelease: (r: bigint) => {
      if (!live.delete(r)) throw new Error(`released a reference the reader does not own: ${r}`);
    },
  };
  const io = {
    IOHIDEventSystemClientCreate: () => (failAt === "client" ? 0n : own()),
    IOHIDEventSystemClientSetMatching: () => 0,
    IOHIDEventSystemClientCopyServices: () => own(),
    IOHIDServiceClientCopyProperty: (svc: bigint) => {
      const r = own();
      const s = services[serviceRefs.indexOf(svc)];
      props.set(r, s ? s.name : "");
      return r;
    },
    IOHIDServiceClientCopyEvent: (svc: bigint) => {
      const r = own();
      events.set(r, services[serviceRefs.indexOf(svc)]?.c ?? 0);
      return r;
    },
    IOHIDEventGetFloatValue: (ev: bigint) => events.get(ev) ?? 0,
  };
  const dlclosed: bigint[] = [];
  let libsClosed = 0;
  const libc = { dlopen: () => 1n, dlsym: () => 2n, dlclose: (h: bigint) => { dlclosed.push(h); return 0; } };
  const close = (): void => { libsClosed++; };
  return { lib: { libc, cf, io, close } as unknown as ThermalLib, live, getCStringCalls: () => getCString, dlclosed, libsClosed: () => libsClosed };
}

describe("darwin-thermal: CF type check and reference accounting", () => {
  test("a Product property that is not a CFString is never read as one; real strings still are", () => {
    const f = fakeLib([{ name: "PMU tdie1", c: 61 }, { name: null, c: 99 }, { name: "PMU tdie2", c: 64.5 }]);
    const r = new DarwinThermal(isDarwinCpuSensor, f.lib);
    const sensors = r.read();
    expect(sensors).toEqual([{ name: "PMU tdie1", c: 61 }, { name: "PMU tdie2", c: 64.5 }]);
    expect(f.getCStringCalls()).toBe(2); // not for the CFNumber
    r.dispose();
    expect(f.live.size).toBe(0);
  });

  test("every reference taken while reading is released; dispose releases the rest; reads after dispose fail", () => {
    const f = fakeLib([{ name: "PMU tdie1", c: 60 }]);
    const r = new DarwinThermal(isDarwinCpuSensor, f.lib);
    for (let i = 0; i < 45; i++) r.read(); // crosses two re-enumerations
    expect(f.live.size).toBe(3); // the client, the Product key, the current services array
    r.dispose();
    r.dispose();
    expect(f.live.size).toBe(0);
    expect(() => r.read()).toThrow("disposed");
  });

  // Audit 2026-09-26 finding 4: the explicit dlopen handle had no matching close, the libraries were never closed.
  test("close(): every CF reference released, the dlopen handle dlclose'd, the libraries closed, once", () => {
    const f = fakeLib([{ name: "PMU tdie1", c: 60 }]);
    const r = new DarwinThermal(isDarwinCpuSensor, f.lib);
    r.read();
    r.close();
    r.dispose();
    expect(f.live.size).toBe(0);
    expect(f.dlclosed).toEqual([1n]);
    expect(f.libsClosed()).toBe(1);
  });

  for (const failAt of ["string", "dict", "client", "typeid"] as const) {
    test(`a failed initialisation (${failAt}) releases everything it created`, () => {
      const f = fakeLib([{ name: "PMU tdie1", c: 60 }], failAt);
      expect(() => new DarwinThermal(isDarwinCpuSensor, f.lib)).toThrow();
      expect(f.live.size).toBe(0);
      expect(f.libsClosed()).toBe(1);
    });
  }
});

// ---- the optional pressure sysctl ------------------------------------------------------------------------------

const VM_STAT = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nAnonymous pages: 400000.\nPages wired down: 100000.\nPages purgeable: 0.\nPages occupied by compressor: 0.\n";
const SYSCTL = "hw.memsize: 17179869184\nvm.swapusage: total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)\n";

describe("macOS memory without the pressure OID", () => {
  const runner = (pressure: string | null) => async (cmd: string[]): Promise<string | null> => {
    if (cmd[0] === "/usr/bin/vm_stat") return VM_STAT;
    if (cmd.includes("kern.memorystatus_vm_pressure_level")) {
      expect(cmd).toEqual(["/usr/sbin/sysctl", "kern.memorystatus_vm_pressure_level"]); // on its own
      return pressure;
    }
    expect(cmd).toEqual(["/usr/sbin/sysctl", "hw.memsize", "vm.swapusage"]);
    return SYSCTL;
  };
  const thermal = async () => ({ sensors: [{ name: "PMU tdie1", c: 55 }], error: null });

  test("the pressure sysctl failing (unknown OID, exit 1) keeps memory; pressure is derived from use", async () => {
    const r = await readDarwin({ run: runner(null), thermal });
    expect(r.mem).toEqual({ total: 16 * GiB, used: 500000 * 16384, swap_used: 512 * 1024 ** 2, pressure: "normal" });
    expect(r.temp_c).toBe(55);
    expect(r.note).toBeUndefined();
  });

  test("with the OID, the kernel's level wins", async () => {
    const r = await readDarwin({ run: runner("kern.memorystatus_vm_pressure_level: 4\n"), thermal });
    expect(r.mem?.pressure).toBe("critical");
  });

  test("a thermal error is a note, memory unaffected", async () => {
    const r = await readDarwin({ run: runner(null), thermal: async () => ({ sensors: null, error: "timed out" }) });
    expect(r.mem?.total).toBe(16 * GiB);
    expect(r.temp_c).toBeNull();
    expect(r.note).toBe("temperature unavailable: timed out");
  });
});

// ---- schema bounds ------------------------------------------------------------------------------------------

describe("MachineStats bounds", () => {
  const ok = { at: 5, mem: { total: 16 * GiB, used: 8 * GiB, swap_used: GiB, pressure: "normal" }, temp_c: 50 };

  test("contradictory or implausible values are refused", () => {
    expect(MachineStats.safeParse(ok).success).toBe(true);
    const bad = [
      { ...ok, mem: { ...ok.mem, used: 17 * GiB } }, // used > total
      { ...ok, mem: { ...ok.mem, swap_used: 16 * 8 * GiB + 1 } }, // swap beyond 8x memory
      { ...ok, temp_c: 0.5 }, // below the sampler's floor
      { ...ok, temp_c: -40 },
      { ...ok, temp_c: 151 },
      { ...ok, at: 1e300 },
    ];
    for (const b of bad) expect(MachineStats.safeParse(b).success).toBe(false);
    expect(MachineStats.safeParse({ ...ok, temp_c: 1 }).success).toBe(true);
    expect(MachineStats.safeParse({ ...ok, mem: { ...ok.mem, used: 16 * GiB } }).success).toBe(true);
  });

  test("on the wire a refused value drops the stats, never the sync answer", () => {
    const r = PeerVvRes.safeParse({ node: "n", vv: { a: 1 }, ts: 1, stats: { ...ok, mem: { ...ok.mem, used: 17 * GiB } } });
    expect(r.success).toBe(true);
    expect(r.success && r.data.stats).toBeUndefined();
  });

  test("a far-future sample time is dropped, not shown as 'just now'; small jitter is clamped", () => {
    const s = MachineStats.parse(ok);
    const now = 1_000_000_000;
    expect(peerStats({ ...s, at: now + 30_000 }, 0, now)?.at).toBe(now);
    expect(peerStats({ ...s, at: now + STATS_FUTURE_TOLERANCE_MS + 1 }, 0, now)).toBeUndefined();
    expect(peerStats({ ...s, at: Number.MAX_SAFE_INTEGER }, 0, now)).toBeUndefined();
    // A peer whose clock runs 1 h ahead, measured as skew: its fresh sample is fine.
    expect(peerStats({ ...s, at: now + 3_600_000 - 2_000 }, 3_600_000, now)?.at).toBe(now - 2_000);
  });
});

// ---- hwmon cap ----------------------------------------------------------------------------------------------

test("hwmon: temperature inputs are picked before the 64-entry cap (a chip with many other files)", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hwmon-"));
  try {
    const dir = join(root, "hwmon", "hwmon0");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "name"), "coretemp\n");
    for (let i = 0; i < 80; i++) writeFileSync(join(dir, `in${i}_input`), "1000\n"); // sort before "temp…"
    writeFileSync(join(dir, "temp1_input"), "68000\n");
    writeFileSync(join(dir, "temp1_label"), "Package id 0\n");
    const zones = join(root, "thermal");
    for (let i = 0; i < 70; i++) mkdirSync(join(zones, `cooling_device${String(i).padStart(2, "0")}`), { recursive: true });
    mkdirSync(join(zones, "thermal_zone0"), { recursive: true });
    writeFileSync(join(zones, "thermal_zone0", "type"), "x86_pkg_temp\n");
    writeFileSync(join(zones, "thermal_zone0", "temp"), "66000\n");
    const sensors = await linuxSensors(root);
    expect(sensors).toContainEqual({ name: "coretemp Package id 0", c: 68 });
    expect(sensors).toContainEqual({ name: "x86_pkg_temp", c: 66 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- worker deadline ----------------------------------------------------------------------------------------

const workerFrom = (code: string) => (): Worker => new Worker(URL.createObjectURL(new Blob([code], { type: "application/javascript" })));
const CLOSES = `if (e.data && e.data.type === "close") { postMessage({ closed: true }); process.exit(0); }`;
const ANSWERS = `self.onmessage = (e) => { ${CLOSES} postMessage({ id: e.data.id, sensors: [{ name: "PMU tdie1", c: 57 }], error: null }); };`;
/** A read that spins 300 ms (past a 150 ms deadline); it handles "close" once the spin is over. */
const HANGS = `self.onmessage = (e) => { ${CLOSES} const end = Date.now() + 300; while (Date.now() < end) {} };`;
/** Answers its first read, then a read runs 150 ms (past a short deadline) and it closes cooperatively afterwards. */
const SLOW_THEN_CLOSES = `let n = 0; self.onmessage = (e) => { ${CLOSES} if (n++ === 0) { postMessage({ id: e.data.id, sensors: [], error: null }); return; } const end = Date.now() + 150; while (Date.now() < end) {} };`;
const BROKEN = `throw new Error("cannot load");`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ThermalClient: the IOKit read runs in a worker with a deadline", () => {
  test("answers come back from the worker", async () => {
    let spawned = 0;
    const c = new ThermalClient({ spawn: () => { spawned++; return workerFrom(ANSWERS)(); }, deadlineMs: 2_000 });
    expect(await c.read()).toEqual({ sensors: [{ name: "PMU tdie1", c: 57 }], error: null });
    expect(await c.read()).toEqual({ sensors: [{ name: "PMU tdie1", c: 57 }], error: null });
    expect(spawned).toBe(1); // one worker, reused
    c.close();
  });

  test("a stuck read misses the deadline without blocking this thread; a new worker next time; off after 3", async () => {
    let spawned = 0;
    const c = new ThermalClient({ spawn: () => { spawned++; return workerFrom(HANGS)(); }, deadlineMs: 150, retireGraceMs: 2_000 });
    let ticks = 0;
    const iv = setInterval(() => ticks++, 10);
    const t0 = performance.now();
    const r = await c.read();
    const took = performance.now() - t0;
    clearInterval(iv);
    expect(r.sensors).toBeNull();
    expect(r.error).toContain("longer than 150 ms");
    expect(took).toBeLessThan(1_000);
    expect(ticks).toBeGreaterThan(5); // the event loop kept running while the worker spun
    for (let i = 1; i < MAX_TIMEOUTS; i++) { await sleep(300); await c.read(); }
    expect(spawned).toBe(MAX_TIMEOUTS);
    await sleep(300);
    const off = await c.read();
    expect(off.error).toContain("turned off until restart");
    expect(spawned).toBe(MAX_TIMEOUTS); // no more workers
  });

  // Audit 2026-09-26 finding 2: a failed worker used to switch reads to native calls on the daemon thread.
  test("a worker that cannot load: temperature unavailable, never read on this thread, retried with a growing delay", async () => {
    let now = 1_000_000;
    let spawned = 0;
    const c = new ThermalClient({ spawn: () => { spawned++; return workerFrom(BROKEN)(); }, deadlineMs: 2_000, retireGraceMs: 2_000, clock: () => now });
    const first = await c.read();
    expect(first.sensors).toBeNull();
    expect(first.error).toContain("temperature worker failed");
    await sleep(80);
    expect((await c.read()).error).toContain("retrying in 60 s");
    expect(spawned).toBe(1); // no retry before the delay, and no in-thread read
    now += RETRY_BASE_MS;
    expect((await c.read()).error).toContain("temperature worker failed");
    expect(spawned).toBe(2);
    await sleep(80);
    now += RETRY_BASE_MS; // the second failure doubled the delay
    expect((await c.read()).error).toContain("retrying in 60 s");
    expect(spawned).toBe(2);
    c.close();
  });

  test("a worker that cannot be constructed: unavailable and retried later, no native fallback", async () => {
    let now = 0;
    let spawned = 0;
    const c = new ThermalClient({ spawn: () => { spawned++; throw new Error("no workers here"); }, clock: () => now });
    expect(await c.read()).toEqual({ sensors: null, error: "temperature worker could not start: no workers here" });
    expect((await c.read()).error).toContain("retrying in");
    now += RETRY_BASE_MS;
    await c.read();
    expect(spawned).toBe(2);
  });

  test("the client has no in-thread native path at all", () => {
    const src = readFileSync(new URL("../../src/daemon/machine-stats/thermal-client.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from "\.\/darwin-thermal\.ts"/);
    expect(src).not.toContain("inThread");
  });

  // Audit 2026-09-26 finding 4: a timed-out worker used to be terminated without releasing its native resources.
  test("a timed-out worker is retired cooperatively: asked to close, not terminated, and no new worker meanwhile", async () => {
    let spawned = 0;
    let terminated = 0;
    const closed: number[] = [];
    const c = new ThermalClient({
      deadlineMs: 100, retireGraceMs: 5_000,
      spawn: () => {
        const w = workerFrom(SLOW_THEN_CLOSES)();
        const n = ++spawned;
        w.addEventListener("message", (e: MessageEvent<{ closed?: boolean }>) => { if (e.data?.closed) closed.push(n); });
        const terminate = w.terminate.bind(w);
        w.terminate = () => { terminated++; terminate(); };
        return w;
      },
    });
    expect((await c.read()).error).toBeNull();
    expect((await c.read()).error).toContain("longer than 100 ms");
    expect((await c.read()).error).toContain("still finishing"); // the retiring worker is still in its slow read
    expect(spawned).toBe(1);
    await sleep(400); // the read returns, the worker handles "close", releases and exits
    expect(closed).toEqual([1]);
    expect(terminated).toBe(0);
    expect((await c.read()).error).toBeNull();
    expect(spawned).toBe(2);
    c.close();
  });

  // Round-2 audit (Codex 1, Opus 1): a forced terminate used to count as "gone" and let a new worker start.
  test("a worker whose termination never completes stays tracked and worker creation turns off until restart", async () => {
    let spawned = 0;
    let terminated = 0;
    const stuck = (): Worker => {
      const t = new EventTarget() as EventTarget & { postMessage: (m: unknown) => void; terminate: () => void; unref: () => void };
      t.postMessage = () => { /* a native read that never returns: no reply, "close" never handled */ };
      t.terminate = () => { terminated++; /* termination requested, never completes: no "close" event */ };
      t.unref = () => {};
      return t as unknown as Worker;
    };
    const c = new ThermalClient({ deadlineMs: 50, retireGraceMs: 100, spawn: () => { spawned++; return stuck(); } });
    expect((await c.read()).error).toContain("longer than 50 ms");
    expect((await c.read()).error).toContain("still finishing");
    await sleep(200);
    expect(terminated).toBe(1);
    const off = await c.read();
    expect(off.error).toBe("the temperature worker did not stop within 100 ms; turned off until restart");
    await sleep(50);
    await c.read();
    expect(spawned).toBe(1); // never replaced
  });

  test("intermittent successes don't reset the count forever: off after MAX_TOTAL_TIMEOUTS since start", async () => {
    let spawned = 0;
    const c = new ThermalClient({ deadlineMs: 60, retireGraceMs: 2_000, spawn: () => { spawned++; return workerFrom(SLOW_THEN_CLOSES)(); } });
    let last: string | null = null;
    for (let i = 0; i < MAX_TOTAL_TIMEOUTS * 2 + 2 && !last?.includes("since start"); i++) {
      last = (await c.read()).error;
      if (last) await sleep(200); // let the retiring worker finish its slow read and close
    }
    expect(last).toContain(`${MAX_TOTAL_TIMEOUTS} times since start; turned off until restart`);
    expect(spawned).toBe(MAX_TOTAL_TIMEOUTS);
  });

  test.if(process.platform === "darwin")("this Mac: the real worker reads the IOKit sensors", async () => {
    const c = new ThermalClient();
    try {
      const r = await c.read();
      expect(r.error).toBeNull();
      expect(Array.isArray(r.sensors)).toBe(true);
    } finally {
      c.close();
    }
  });
});
