// WALKIE-POOL-2 split runs, pure parts: which machines hold what, llama-server device arguments, the pinned runtime and
// model files, the tunnel ends' backpressure and the byte bucket.
import { describe, expect, test } from "bun:test";
import { createServer, connect, type Socket } from "node:net";
import { parseDevices, localDevice, rpcDevices, tensorSplit } from "../../src/pool/run/devices.ts";
import { filesFor, PINS } from "../../src/pool/run/gguf.ts";
import { fileNeed, planRun, PlanError } from "../../src/pool/run/plan.ts";
import { LLAMA_BUILD, manualInstall, targetFor, TARGETS } from "../../src/pool/run/runtime.ts";
import { ByteBucket, HIGH_WATER, splice, tcpEnd, WsEnd, type WsLike } from "../../src/pool/run/tunnel.ts";
import { CATALOG } from "../../src/pool/catalog.ts";
import type { GroupInput } from "../../src/pool/group.ts";
import type { MachineStats } from "../../src/protocol/machine-stats.ts";

const GiB = 1024 ** 3;
const SHARE = { share: true, cap: null, runtime: true, busy: false };
function node(id: string, totalGb: number, usedGb: number, over: Partial<GroupInput> = {}): GroupInput {
  return {
    node_id: id, hostname: id, handle: id, online: true, self: false, rtt_ms: 20,
    stats: { at: 1, temp_c: 40, sys: { os: "darwin", arch: "arm64", cpus: 8, load1: 0 }, mem: { total: totalGb * GiB, used: usedGb * GiB, swap_used: 0, pressure: "normal" }, accel: { chip: "Apple M4", unified: true, gpu_limit: null, gpus: [] } } as MachineStats,
    ...over,
  };
}

describe("planning a run", () => {
  test("unnamed: this machine + the sharing machines, largest first; a model that fits here stays here", () => {
    const nodes = [node("me", 16, 4, { self: true }), node("kira", 36, 10, { pool: SHARE }), node("nope", 64, 4)];
    const small = planRun(nodes, 3 * GiB);
    expect(small.stages.map((s) => s.hostname)).toEqual(["me"]);
    const big = planRun(nodes, 20 * GiB);
    expect(big.stages[0]!.self).toBe(true); // the head is listed first
    expect(big.stages.map((s) => s.hostname).sort()).toEqual(["kira", "me"]);
    expect(big.stages.some((s) => s.hostname === "nope")).toBe(false); // not sharing
    expect(() => planRun(nodes, 200 * GiB)).toThrow(PlanError);
  });

  test("a sharing machine's cap bounds its part", () => {
    const nodes = [node("me", 16, 4, { self: true }), node("kira", 36, 10, { pool: { ...SHARE, cap: 5 * GiB } })];
    const p = planRun(nodes, 12 * GiB);
    expect(p.stages.find((s) => s.hostname === "kira")!.bytes).toBeLessThanOrEqual(5 * GiB);
  });

  test("named machines: exactly those + this machine, shares in proportion to free memory; refusals are specific", () => {
    const nodes = [node("me", 16, 4, { self: true }), node("kira", 36, 12, { pool: SHARE }), node("ari", 24, 12, { pool: SHARE }), node("off", 24, 2), node("gone", 24, 2, { online: false, pool: SHARE }), node("busy", 24, 2, { pool: { ...SHARE, busy: true } }), node("bare", 24, 2, { pool: { ...SHARE, runtime: false } })];
    const p = planRun(nodes, 4 * GiB, ["kira"]);
    expect(p.stages.map((s) => s.hostname)).toEqual(["me", "kira"]);
    expect(p.stages[1]!.bytes).toBeGreaterThan(p.stages[0]!.bytes); // kira has more free memory (+ its runtime's overhead)
    const code = (names: string[]) => { try { planRun(nodes, 4 * GiB, names); return "ok"; } catch (e) { return (e as PlanError).code; } };
    expect(code(["off"])).toBe("not_sharing");
    expect(code(["gone"])).toBe("offline");
    expect(code(["busy"])).toBe("busy");
    expect(code(["bare"])).toBe("no_runtime");
    expect(code(["who"])).toBe("unknown_machine");
    expect(code(["kira", "ari"])).toBe("ok");
    // Machines that report no memory get equal shares.
    const blind = planRun([node("me", 16, 4, { self: true, stats: undefined }), node("kira", 36, 12, { pool: SHARE, stats: undefined })], 2 * GiB, ["kira"]);
    expect(blind.stages[0]!.bytes).toBe(1 * GiB);
  });

  test("a local file needs its size + 10% + the runtime overhead", () => {
    expect(fileNeed(10 * GiB)).toBe(Math.round(11 * GiB + CATALOG.overhead_gib * GiB));
  });
});

describe("llama-server devices", () => {
  const out = `0.00 I srv init\nAvailable devices:\n  MTL0: Apple M5 (12124 MiB, 12123 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)\n  RPC0: 127.0.0.1:50611 (16384 MiB, 16384 MiB free)\n  RPC1: 127.0.0.1:50612 (16384 MiB, 16384 MiB free)\n`;
  test("parses the list; the first device per rpc endpoint; the head's accelerator; integer split", () => {
    const d = parseDevices(out);
    expect(d.map((x) => x.name)).toEqual(["MTL0", "RPC0", "RPC1"]); // BLAS is not a device llama-server offloads layers to
    expect(rpcDevices(d, ["127.0.0.1:50612", "127.0.0.1:50611", "127.0.0.1:1"])).toEqual(["RPC1", "RPC0", null]);
    expect(localDevice(d)).toBe("MTL0");
    expect(localDevice(parseDevices("  BLAS: x\n  RPC0: 127.0.0.1:1 (1 MiB)"))).toBeNull();
    expect(tensorSplit([3 * GiB, 1 * GiB])).toBe("750,250");
  });
});

describe("pinned runtime and model files", () => {
  test("one pinned build per platform, sha256 per tarball; CUDA only with an NVIDIA GPU", () => {
    expect(LLAMA_BUILD).toMatch(/^b\d+$/);
    for (const t of Object.values(TARGETS)) for (const a of t.assets) {
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.file).toContain(LLAMA_BUILD);
    }
    expect(targetFor({ platform: "darwin", arch: "arm64" })?.id).toBe("darwin-arm64");
    expect(targetFor({ platform: "linux", arch: "x64" })?.id).toBe("linux-x64");
    expect(targetFor({ platform: "linux", arch: "x64", nvidia: true })?.id).toBe("linux-x64-cuda");
    expect(targetFor({ platform: "win32", arch: "x64" })).toBeNull();
    expect(manualInstall(TARGETS["linux-x64-cuda"]!)).toContain("cudart-llama");
  });

  test("every catalog model has pinned GGUF files (repo@revision, sha256, sizes) for each format it has", () => {
    for (const m of CATALOG.models) {
      for (const q of ["q4", "q8"] as const) {
        const f = filesFor(m.id, q);
        if (m.mem_gib[q] === null) { expect(f).toBeNull(); continue; }
        expect(f).not.toBeNull();
        expect(f!.revision).toMatch(/^[0-9a-f]{40}$/);
        // The files are close to the catalog's weight estimate (the memory figure minus KV cache and overhead).
        expect(f!.bytes / GiB).toBeLessThan(m.mem_gib[q]!);
      }
    }
    expect(Object.keys(PINS.models).sort()).toEqual(CATALOG.models.map((m) => m.id).sort());
    expect(filesFor("llama-3.3-70b", "q8")!.files.length).toBe(2); // split GGUF: llama-server loads the rest from part 1
  });
});

/** Two WsEnds wired to each other in memory, with a controllable "network" buffer. */
function wsPair(): { a: WsEnd; b: WsEnd } {
  let a!: WsEnd, b!: WsEnd;
  const link = (to: () => WsEnd, side: "a" | "b"): WsLike => ({
    sendBytes: (x) => queueMicrotask(() => to().message(x.slice())),
    sendText: (t) => queueMicrotask(() => to().message(t)),
    close: () => queueMicrotask(() => to().closed()),
  });
  a = new WsEnd(link(() => b, "a"));
  b = new WsEnd(link(() => a, "b"));
  return { a, b };
}

describe("tunnel ends", () => {
  test("WebSocket frames are cut to 256 KiB, whatever size the socket handed over", async () => {
    const sizes: number[] = [];
    const end = new WsEnd({ sendBytes: (x) => sizes.push(x.byteLength), sendText: () => undefined, close: () => undefined });
    await end.write(new Uint8Array(3 * 1024 * 1024 + 5));
    expect(Math.max(...sizes)).toBe(256 * 1024);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(3 * 1024 * 1024 + 5);
  });

  test("TCP: splice carries bytes both ways and closes the other side when one ends", async () => {
    const echo = createServer((s) => s.on("data", (d) => s.write(d))).listen(0, "127.0.0.1");
    await new Promise((r) => echo.once("listening", r));
    const port = (echo.address() as { port: number }).port;
    const { a, b } = wsPair();
    const toEcho = tcpEnd(connect({ host: "127.0.0.1", port }));
    const spliced = splice(b, toEcho);
    const payload = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
    await a.write(payload);
    let back = 0;
    while (back < payload.byteLength) back += (await a.read())!.byteLength;
    expect(back).toBe(payload.byteLength);
    a.close();
    const r = await spliced;
    expect(r.up).toBe(payload.byteLength);
    echo.close();
  });

  test("TCP backpressure: a slow reader pauses the socket instead of buffering without bound", async () => {
    let server!: Socket;
    const srv = createServer((s) => { server = s; }).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const client = connect({ host: "127.0.0.1", port: (srv.address() as { port: number }).port });
    await new Promise((r) => client.once("connect", r));
    await Bun.sleep(20);
    const end = tcpEnd(server);
    const big = Buffer.alloc(64 * 1024 * 1024);
    let drained = false;
    client.write(big, () => { drained = true; });
    await Bun.sleep(300);
    expect(drained).toBe(false); // nobody reads the End: the socket is paused, the sender's write can't complete
    let got = 0;
    while (got < big.byteLength) got += (await end.read())!.byteLength;
    await Bun.sleep(20);
    expect(drained).toBe(true);
    end.close();
    client.destroy();
    srv.close();
  });

  test("byte bucket: a burst passes at once, then the refill rate holds", async () => {
    const b = new ByteBucket(1000, 10_000);
    const t0 = performance.now();
    await b.take(1000);
    expect(performance.now() - t0).toBeLessThan(20);
    await b.take(1000); // 1000 bytes at 10 kB/s = 100 ms
    expect(performance.now() - t0).toBeGreaterThanOrEqual(90);
  });
});
