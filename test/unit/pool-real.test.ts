// POOL-REAL-1: team compute on the team's real machines. Accelerator detection with nvidia-smi output captured on
// atlas-wsl (RTX 5070) and hestia-wsl (RTX 5070 Laptop GPU), the WSL driver-mount race, NVIDIA bandwidth, GPU-aware
// suggestions (no slow split when one machine runs a model), where a model is served (serveHosts), and the
// allow-list proxy in front of a served llama-server.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGpuNow, parseNvidiaSmi, readAccel } from "../../src/daemon/machine-stats/accel.ts";
import { ACCEL_RETRY_MS, MachineStatsSampler } from "../../src/daemon/machine-stats/sampler.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { CPU_MEMORY, GPU_RESERVE_BYTES, machineCapacity } from "../../src/pool/capacity.ts";
import { suggestCombined, suggestTeam } from "../helpers/pool-legacy.ts";
import { alternativeLabel } from "../../src/pool/format.ts";
import { serveHosts } from "../../src/pool/run/plan.ts";
import { ALLOWED, MAX_ACTIVE, MAX_BODY, ServeProxy } from "../../src/pool/run/serve-proxy.ts";
import type { MachineAccel, MachineStats, MachineSys } from "../../src/protocol/machine-stats.ts";
import type { PoolShare } from "../../src/protocol/pool.ts";
import type { NodeView } from "../../src/protocol/schemas.ts";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const FIX = join(import.meta.dir, "..", "fixtures", "machine-stats");
const ATLAS_GPU = { name: "NVIDIA GeForce RTX 5070", vram: 12227 * MiB };
const HESTIA_GPU = { name: "NVIDIA GeForce RTX 5070 Laptop GPU", vram: 8151 * MiB };
const accelOf = (gpus: MachineAccel["gpus"], chip = "Intel(R) Core(TM) i7"): MachineAccel => ({ chip, unified: false, gpu_limit: null, gpus });

/** What the machine's daemon reports as its platform: an Apple chip is a Mac (Metal build), anything else here is Linux on x64 (WSL, a CUDA box). */
const platformOf = (s: Partial<MachineStats>): MachineSys => (s.accel?.chip?.startsWith("Apple") ? { os: "darwin", arch: "arm64", cpus: 12, load1: 0 } : { os: "linux", arch: "x64", cpus: 16, load1: 0 });
function node(hostname: string, stats: Partial<MachineStats>, over: Partial<NodeView> = {}): NodeView {
  return {
    node_id: hostname.padEnd(16, "0").slice(0, 16), handle: "alex", hostname, ip: "100.64.0.1", online: true, last_seen: 1,
    rtt_ms: 3, self: false, sync: { behind: 0, last_sync: 1 },
    stats: { at: 1, temp_c: 50, mem: { total: 16 * GiB, used: 4 * GiB, swap_used: 0, pressure: "normal" }, sys: platformOf(stats), ...stats },
    ...over,
  } as NodeView;
}
const share = (p: Partial<PoolShare> = {}): PoolShare => ({ share: true, cap: null, runtime: true, busy: false, serve: true, ...p });
/** atlas-wsl as it reported itself (27 GB RAM, 3 GB used; RTX 5070 with 11656 MiB free). */
const atlas = (over: Partial<NodeView> = {}) => node("atlas-wsl", { mem: { total: 27 * GiB, used: 3 * GiB, swap_used: 0, pressure: "normal" }, accel: accelOf([ATLAS_GPU]), gpu_free: [11656 * MiB] }, over);
/** hestia-wsl (7.6 GB RAM; RTX 5070 Laptop GPU with 7891 MiB free). */
const hestia = (over: Partial<NodeView> = {}) => node("hestia-wsl", { mem: { total: 7.6 * GiB, used: 2.2 * GiB, swap_used: 0, pressure: "normal" }, accel: accelOf([HESTIA_GPU]), gpu_free: [7891 * MiB] }, over);

describe("accelerators on the team's WSL machines (captured nvidia-smi output)", () => {
  test("atlas-wsl's RTX 5070 and hestia-wsl's laptop GPU parse with their VRAM, free memory and temperature", () => {
    expect(parseNvidiaSmi(readFileSync(join(FIX, "nvidia-smi-wsl-desktop.txt"), "utf8"))).toEqual([ATLAS_GPU]);
    expect(parseNvidiaSmi(readFileSync(join(FIX, "nvidia-smi-wsl.txt"), "utf8"))).toEqual([HESTIA_GPU]);
    expect(parseGpuNow(readFileSync(join(FIX, "nvidia-smi-wsl-desktop-now.txt"), "utf8"), 1)).toEqual({ free: [11656 * MiB], temp: [33] });
  });

  test("readAccel on WSL finds nvidia-smi at /usr/lib/wsl/lib whatever PATH holds (what `walkie pool install` now uses)", async () => {
    const calls: string[][] = [];
    const a = await readAccel({
      platform: "linux", readText: async () => "model name\t: Intel(R) Core(TM) i7-14700K\n",
      exists: async (p) => p === "/usr/lib/wsl/lib/nvidia-smi",
      run: async (cmd) => { calls.push(cmd); return readFileSync(join(FIX, "nvidia-smi-wsl-desktop.txt"), "utf8"); },
    });
    expect(a?.gpus).toEqual([ATLAS_GPU]);
    expect(calls[0]?.[0]).toBe("/usr/lib/wsl/lib/nvidia-smi");
  });

  test("the WSL driver mount appearing after the daemon started: accelerator facts are read again until a GPU shows up", async () => {
    let now = 0;
    let mounted = false;
    let reads = 0;
    const published: MachineStats[] = [];
    const s = new MachineStatsSampler((st) => published.push(st), createLogger({}), {
      platform: "linux", clock: () => now, heartbeatMs: 1,
      read: async () => ({ mem: { total: 27 * GiB, used: 3 * GiB, swap_used: 0, pressure: "normal" }, temp_c: 40 }),
      readAccel: async () => { reads++; return accelOf(mounted ? [ATLAS_GPU] : []); },
      readGpu: async () => ({ free: [11656 * MiB], temp: [33] }),
    });
    await s.tick();
    expect(published.at(-1)?.accel?.gpus).toEqual([]);
    now += 30_000;
    await s.tick();
    expect(reads).toBe(1); // not before ACCEL_RETRY_MS
    mounted = true;
    now += ACCEL_RETRY_MS;
    await s.tick();
    expect(reads).toBe(2);
    expect(published.at(-1)?.accel?.gpus).toEqual([ATLAS_GPU]);
    expect(published.at(-1)?.gpu_free).toEqual([11656 * MiB]);
    now += ACCEL_RETRY_MS * 3;
    await s.tick();
    expect(reads).toBe(2); // a GPU was found: never read again
  });

  test("a Mac whose Metal budget is known, and machines that have a GPU, are not re-read", async () => {
    let reads = 0;
    let now = 0;
    const s = new MachineStatsSampler(() => undefined, createLogger({}), {
      platform: "darwin", clock: () => now,
      read: async () => ({ mem: { total: 16 * GiB, used: 4 * GiB, swap_used: 0, pressure: "normal" }, temp_c: 40 }),
      readAccel: async () => { reads++; return { chip: "Apple M5", unified: true, gpu_limit: null, gpus: [], metal_budget: 12124 * MiB }; },
    });
    await s.tick();
    now += ACCEL_RETRY_MS * 2;
    await s.tick();
    expect(reads).toBe(1);
  });
});

describe("GPU-aware suggestions (POOL-REAL-1)", () => {
  test("NVIDIA bandwidth per model: RTX 5070 672 GB/s, RTX 5070 Laptop GPU 384 GB/s, marked known", () => {
    const a = machineCapacity(atlas())!;
    expect(a.backends[0]).toMatchObject({ kind: "nvidia", bandwidth: 672, bandwidthKnown: true });
    expect(a.backends[0]!.usable).toBe(11656 * MiB - GPU_RESERVE_BYTES);
    expect(machineCapacity(hestia())!.backends[0]).toMatchObject({ bandwidth: 384, bandwidthKnown: true });
    expect(machineCapacity(node("x", { accel: accelOf([{ name: "NVIDIA Some Future GPU", vram: 16 * GiB }]), gpu_free: [16 * GiB] }))!.backends[0]).toMatchObject({ bandwidth: 400, bandwidthKnown: false });
  });

  test("atlas-wsl: a model on its CPU is shown with the largest model its GPU runs fast (what serve runs), never a slow pick first", () => {
    const s = suggestTeam([atlas({ self: true, rtt_ms: null })]).suggestions[0]!;
    expect(s.single!.speed).not.toBe("slow");
    const onGpu = s.single!.placement[0]!.memory === CPU_MEMORY ? s.alternatives.find((x) => alternativeLabel(s, x) === "On the GPU")! : s.single!;
    expect(onGpu.placement[0]!.memory).toBe("GPU memory");
    expect(onGpu.speed).toBe("fast");
    expect(onGpu.need).toBeLessThanOrEqual(11656 * MiB - GPU_RESERVE_BYTES);
    expect(onGpu.model.id).toBe("qwen3-14b"); // 10.7 GiB: fits the 11.4 GiB free (measured: it loads and runs there)
  });

  test("the whole team: no slow split when one machine runs a model at a usable speed (the pre.4 headline was a 3-machine 8-bit 32B at ~1 token/s)", () => {
    const kira = node("kiras-macbook-pro", { mem: { total: 36 * GiB, used: 24 * GiB, swap_used: 0, pressure: "normal" }, accel: { chip: "Apple M4 Max", unified: true, gpu_limit: null, gpus: [] } }, { rtt_ms: 150 });
    const cs = suggestCombined([atlas({ self: true, rtt_ms: null }), hestia({ rtt_ms: 9 }), kira]);
    expect(cs.pick!.speed).not.toBe("slow");
    expect(cs.pick!.pooled).toBe(false);
  });
});

describe("serveHosts: where a model is served whole", () => {
  test("the fastest GPU it fits on, among this machine and the machines that share (with the runtime, not busy), within caps", () => {
    const need = 9 * GiB;
    const me = hestia({ self: true, rtt_ms: null });
    expect(serveHosts([me, atlas({ pool: share() })], need).map((h) => h.node.hostname)).toEqual(["atlas-wsl"]);
    // Not sharing, no runtime, busy, offline, capped below the need: not a host.
    for (const p of [share({ share: false }), share({ runtime: false }), share({ busy: true }), share({ cap: 8 * GiB })]) {
      expect(serveHosts([me, atlas({ pool: p })], need)).toEqual([]);
    }
    expect(serveHosts([me, atlas({ pool: share(), online: false })], need)).toEqual([]);
    // A small model: both fit; atlas's desktop GPU (672 GB/s) before worker-b's laptop GPU (384 GB/s).
    expect(serveHosts([me, atlas({ pool: share() })], 5 * GiB).map((h) => h.node.hostname)).toEqual(["atlas-wsl", "hestia-wsl"]);
    // A CPU-only machine never serves (every layer goes on a GPU).
    const cpu = node("box", { mem: { total: 128 * GiB, used: 4 * GiB, swap_used: 0, pressure: "normal" }, accel: accelOf([]) }, { pool: share() });
    expect(serveHosts([me, cpu], 5 * GiB).map((h) => h.node.hostname)).toEqual(["hestia-wsl"]);
  });
});

describe("the allow-list proxy in front of a served llama-server", () => {
  const KEY = "a".repeat(48);
  const UP_KEY = "upstream-secret";
  let upstream: ReturnType<typeof Bun.serve>;
  let seen: { path: string; auth: string | null }[] = [];
  const holds: (() => void)[] = [];
  let proxy: ServeProxy;
  let base: string;
  const labels: string[] = [];
  beforeAll(() => {
    upstream = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const u = new URL(req.url);
        seen.push({ path: u.pathname, auth: req.headers.get("authorization") });
        if (u.pathname === "/v1/completions") await new Promise<void>((r) => { holds.push(r); });
        if (u.pathname === "/v1/chat/completions") {
          const enc = new TextEncoder();
          return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode("data: a\n\n")); c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } }), { headers: { "Content-Type": "text/event-stream", "X-Internal": "1" } });
        }
        return Response.json({ ok: true, path: u.pathname });
      },
    });
    proxy = new ServeProxy({ upstream: () => ({ port: upstream.port!, key: UP_KEY }), authorize: (k) => (k === KEY ? "client-1" : null), onRequest: (l) => labels.push(l) });
    base = `http://127.0.0.1:${proxy.start()}`;
  });
  afterAll(() => { proxy.stop(); upstream.stop(true); });
  const auth = { Authorization: `Bearer ${KEY}` };

  test("only the OpenAI calls pass; the client's key is swapped for llama-server's; streams pass through, internal headers don't", async () => {
    expect(ALLOWED.map(([m, p]) => `${m} ${p}`)).toEqual(["GET /health", "GET /v1/models", "POST /v1/chat/completions", "POST /v1/completions"]);
    seen = [];
    for (const p of ["/slots", "/props", "/metrics", "/lora-adapters", "/tokenize", "/v1/embeddings", "/", "/completion"]) {
      expect((await fetch(`${base}${p}`, { headers: auth })).status).toBe(404);
      expect((await fetch(`${base}${p}`, { method: "POST", headers: auth, body: "{}" })).status).toBe(404);
    }
    expect(seen).toEqual([]); // nothing reached llama-server
    const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: auth, body: JSON.stringify({ messages: [], stream: true }) });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    expect(r.headers.get("x-internal")).toBeNull();
    expect(await r.text()).toBe("data: a\n\ndata: [DONE]\n\n");
    expect(seen).toEqual([{ path: "/v1/chat/completions", auth: `Bearer ${UP_KEY}` }]);
    expect(labels).toContain("client-1");
  });

  test("no key, a wrong key, a key of the wrong shape: 401 and nothing forwarded", async () => {
    seen = [];
    expect((await fetch(`${base}/v1/models`)).status).toBe(401);
    expect((await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${"b".repeat(48)}` } })).status).toBe(401);
    expect((await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${UP_KEY}` } })).status).toBe(401);
    expect(seen).toEqual([]);
  });

  test("bodies over MAX_BODY are refused; at most MAX_ACTIVE requests in flight per key", async () => {
    const inflight = Array.from({ length: MAX_ACTIVE }, () => fetch(`${base}/v1/completions`, { method: "POST", headers: auth, body: "{}" }));
    for (let i = 0; i < 100 && holds.length < MAX_ACTIVE; i++) await Bun.sleep(20);
    expect(holds.length).toBe(MAX_ACTIVE);
    expect((await fetch(`${base}/v1/models`, { headers: auth })).status).toBe(429);
    for (const h of holds.splice(0)) h();
    const done = await Promise.all(inflight);
    expect(done.every((r) => r.status === 200)).toBe(true);
    await Promise.all(done.map((r) => r.text()));
    expect((await fetch(`${base}/v1/models`, { headers: auth })).status).toBe(200); // slots given back
    // Last: the server answers before reading a too-large body, which ends that connection.
    const big = "x".repeat(MAX_BODY + 1);
    const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { ...auth, Connection: "close" }, body: big }).catch(() => null);
    if (r) expect(r.status).toBe(413);
    seen = [];
    const small = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { ...auth, "Content-Length": String(MAX_BODY + 5), Connection: "close" }, body: "x".repeat(MAX_BODY + 5) }).catch(() => null);
    if (small) expect(small.status).toBe(413);
    expect(seen).toEqual([]);
  });
});

describe("model downloads resume after a broken connection (atlas-wsl's link broke a 9 GB download mid-way)", () => {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const { mkdtempSync, existsSync, readFileSync: read, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { ensureFiles, localPath } = require("../../src/pool/run/gguf.ts") as typeof import("../../src/pool/run/gguf.ts");
  const data = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 7) % 251);
  const sha = createHash("sha256").update(data).digest("hex");
  const mf = { repo: "acme/tiny-GGUF", revision: "a".repeat(40), files: [{ path: "tiny.gguf", size: data.byteLength, sha256: sha }], bytes: data.byteLength };

  /** A raw HTTP server that can cut a response mid-body (a Content-Length it never finishes, then a closed socket). */
  function server(mode: "cut-then-range" | "no-range" | "corrupt"): { base: string; ranges: (string | null)[]; stop: () => void; ready: Promise<void> } {
    const ranges: (string | null)[] = [];
    let n = 0;
    const net = require("node:net") as typeof import("node:net");
    const srv = net.createServer((sock) => {
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        const range = /\r\nrange: *bytes=(\d+)-/i.exec(buf);
        ranges.push(range ? `bytes=${range[1]}-` : null);
        n++;
        const send = (status: string, body: Uint8Array, cutAt?: number) => {
          sock.write(`HTTP/1.1 ${status}\r\nContent-Length: ${body.byteLength}\r\nConnection: close\r\n\r\n`);
          if (cutAt !== undefined) { sock.write(body.subarray(0, cutAt), () => sock.destroy()); return; }
          sock.end(body);
        };
        if (mode === "corrupt") return send("200 OK", data.map((b) => b ^ 1));
        if (mode === "no-range") return n === 1 ? send("200 OK", data, 1_000_000) : send("200 OK", data);
        const from = range ? Number(range[1]) : 0;
        if (n === 1) return send(range ? "206 Partial Content" : "200 OK", data.subarray(from), Math.min(500_000, data.byteLength - from));
        return send("206 Partial Content", data.subarray(from));
      });
    });
    const ready = new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    return { get base() { const a = srv.address(); return `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`; }, ranges, stop: () => srv.close(), ready };
  }

  test("a cut download resumes with a Range request; the whole file's sha256 is checked", async () => {
    const home = mkdtempSync(join(tmpdir(), "wk-dl-"));
    const p = localPath(home, mf, mf.files[0]!);
    require("node:fs").mkdirSync(require("node:path").dirname(p), { recursive: true });
    // Start from a known prefix so even a reset before the response body arrives must use Range.
    writeFileSync(`${p}.part`, data.subarray(0, 1_000_000));
    const s = server("cut-then-range");
    await s.ready;
    let last = 0;
    await ensureFiles(home, mf, new AbortController().signal, (p) => { last = p.done; }, s.base, 5);
    s.stop();
    expect(createHash("sha256").update(read(p)).digest("hex")).toBe(sha);
    expect(read(`${p}.ok`, "utf8").trim()).toBe(sha);
    expect(s.ranges[0]).toBe("bytes=1000000-");
    expect(s.ranges.length).toBeGreaterThanOrEqual(2);
    expect(s.ranges.slice(1).every((r) => r !== null && /^bytes=[1-9]\d*-$/.test(r))).toBe(true);
    expect(last).toBe(data.byteLength);
  });

  test("a part left by an earlier daemon is continued, not downloaded again", async () => {
    const home = mkdtempSync(join(tmpdir(), "wk-dl-"));
    const p = localPath(home, mf, mf.files[0]!);
    require("node:fs").mkdirSync(require("node:path").dirname(p), { recursive: true });
    writeFileSync(`${p}.part`, data.subarray(0, 2_000_000));
    const s = server("cut-then-range");
    await s.ready;
    await ensureFiles(home, mf, new AbortController().signal, () => undefined, s.base, 5);
    s.stop();
    // The first request already asks for the rest (the server cuts it; the retry asks again from further on).
    expect(s.ranges[0]).toBe("bytes=2000000-");
    expect(createHash("sha256").update(read(p)).digest("hex")).toBe(sha);
  });

  test("a server without Range support: started over; a wrong file: refused and its part removed", async () => {
    const home = mkdtempSync(join(tmpdir(), "wk-dl-"));
    const s = server("no-range");
    await s.ready;
    await ensureFiles(home, mf, new AbortController().signal, () => undefined, s.base, 5);
    s.stop();
    expect(existsSync(`${localPath(home, mf, mf.files[0]!)}.ok`)).toBe(true);
    const home2 = mkdtempSync(join(tmpdir(), "wk-dl-"));
    const bad = server("corrupt");
    await bad.ready;
    await expect(ensureFiles(home2, mf, new AbortController().signal, () => undefined, bad.base, 5)).rejects.toThrow(/sha256 or size mismatch/);
    bad.stop();
    expect(existsSync(`${localPath(home2, mf, mf.files[0]!)}.part`)).toBe(false);
  });
});

describe("prepared weights: a stage loads its share from its own disk (rpc-server tensor cache)", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { fnv1a64, hashHex, readGgufTensors, prepareWeights, preparedDir, HASH_THRESHOLD } = require("../../src/pool/run/weights.ts") as typeof import("../../src/pool/run/weights.ts");
  const { localPath } = require("../../src/pool/run/gguf.ts") as typeof import("../../src/pool/run/gguf.ts");
  const { RpcGuard, CMD, RPC_TENSOR_SIZE } = require("../../src/pool/run/rpc-guard.ts") as typeof import("../../src/pool/run/rpc-guard.ts");

  function refFnv(buf: Uint8Array): string {
    let h = 0xcbf29ce484222325n;
    for (const b of buf) h = ((h ^ BigInt(b)) * 0x100000001b3n) & ((1n << 64n) - 1n);
    return h.toString(16).padStart(16, "0");
  }

  /** A GGUF v3 file: one KV (general.alignment = 32, plus a string array like a vocab), a big F32 and a small Q8_0 tensor. */
  function gguf(big: Float32Array, small: Uint8Array): Uint8Array {
    const parts: number[] = [];
    const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(...b); };
    const u64 = (v: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); parts.push(...b); };
    const str = (s: string) => { u64(Buffer.byteLength(s)); parts.push(...Buffer.from(s)); };
    parts.push(...Buffer.from("GGUF")); u32(3); u64(2); u64(2);
    str("general.alignment"); u32(4); u32(32);
    str("tokenizer.ggml.tokens"); u32(9); u32(8); u64(3); str("a"); str("bb"); str("ccc");
    str("blk.0.big"); u32(2); u64(1024); u64(big.length / 1024); u32(0); u64(0);
    const bigBytes = big.length * 4;
    const smallOff = Math.ceil(bigBytes / 32) * 32;
    str("blk.0.small"); u32(1); u64(32 * (small.length / 34)); u32(8); u64(smallOff);
    while (parts.length % 32) parts.push(0);
    const head = parts.length;
    const out = new Uint8Array(head + smallOff + small.length);
    out.set(Uint8Array.from(parts), 0);
    out.set(new Uint8Array(big.buffer), head);
    out.set(small, head + smallOff);
    return out;
  }

  test("FNV-1a 64 matches the definition, continued over chunks", () => {
    const b = new Uint8Array(100_003).map((_, i) => (i * 131 + 7) & 255);
    expect(hashHex(fnv1a64(b))).toBe(refFnv(b));
    expect(hashHex(fnv1a64(b.subarray(50_000), fnv1a64(b.subarray(0, 50_000))))).toBe(refFnv(b));
  });

  test("GGUF tensors are found with their absolute offsets and sizes; the big ones are copied into <dir>/rpc/<hash>", async () => {
    const home = fs.mkdtempSync(join(tmpdir(), "wk-w-"));
    const big = new Float32Array(3 * 1024 * 1024).map((_, i) => (i % 977) / 7);
    const small = new Uint8Array(34 * 4).fill(3);
    const file = gguf(big, small);
    const mf = { repo: "acme/w-GGUF", revision: "b".repeat(40), files: [{ path: "w.gguf", size: file.byteLength, sha256: "c".repeat(64) }], bytes: file.byteLength };
    const p = localPath(home, mf, mf.files[0]!);
    fs.mkdirSync(require("node:path").dirname(p), { recursive: true });
    fs.writeFileSync(p, file);
    const ts = await readGgufTensors(p);
    expect(ts.map((t) => [t.name, t.type, t.bytes])).toEqual([["blk.0.big", 0, big.length * 4], ["blk.0.small", 8, small.length]]);
    expect(Buffer.from(file.subarray(ts[0]!.offset, ts[0]!.offset + 8)).equals(Buffer.from(big.buffer, 0, 8))).toBe(true);
    expect(Array.from(file.subarray(ts[1]!.offset, ts[1]!.offset + 4))).toEqual([3, 3, 3, 3]);
    expect(preparedDir(home, mf)).toBeNull();
    const r = await prepareWeights(home, mf, new AbortController().signal, () => undefined);
    expect(r.tensors).toBe(1); // only tensors over HASH_THRESHOLD go by hash
    expect(big.length * 4).toBeGreaterThan(HASH_THRESHOLD);
    const names = fs.readdirSync(join(r.dir, "rpc"));
    expect(names).toEqual([refFnv(new Uint8Array(big.buffer))]);
    expect(fs.statSync(join(r.dir, "rpc", names[0]!)).size).toBe(big.length * 4);
    expect(preparedDir(home, mf)).toBe(r.dir);
  });

  test("the RPC guard clears SET_TENSOR's cache flag: a head can't make the worker write its tensor cache", () => {
    const g = new RpcGuard({ maxMessage: 1 << 30 });
    const hello = new Uint8Array(9 + 24); hello[0] = CMD.HELLO; new DataView(hello.buffer).setBigUint64(1, 24n, true);
    g.feed(hello);
    const dataLen = 16;
    const payload = new Uint8Array(RPC_TENSOR_SIZE + 1 + 8 + dataLen);
    const dv = new DataView(payload.buffer);
    dv.setBigUint64(0, 1n, true); // id
    dv.setUint32(8, 0, true); // F32
    dv.setUint32(52, 0, true); // op NONE
    payload[RPC_TENSOR_SIZE] = 1; // cache_flag
    const msg = new Uint8Array(9 + payload.byteLength);
    msg[0] = CMD.SET_TENSOR; new DataView(msg.buffer).setBigUint64(1, BigInt(payload.byteLength), true); msg.set(payload, 9);
    const joined = Buffer.concat(g.feed(msg).map((b) => Buffer.from(b)));
    expect(joined.byteLength).toBe(msg.byteLength); // forwarded whole
    expect(joined[9 + RPC_TENSOR_SIZE]).toBe(0); // the cache flag, cleared
    joined[9 + RPC_TENSOR_SIZE] = 1;
    expect(joined.equals(Buffer.from(msg))).toBe(true); // nothing else changed
  });
});

describe("Apple Silicon (alex-mac, M5 16 GB) in the pool", () => {
  const { parseMetalBudget } = require("../../src/daemon/machine-stats/accel.ts") as typeof import("../../src/daemon/machine-stats/accel.ts");
  const { targetFor, TARGETS, PINNED_RPC } = require("../../src/pool/run/runtime.ts") as typeof import("../../src/pool/run/runtime.ts");

  test("walkie pool install on darwin-arm64: the pinned macOS arm64 build (Metal + rpc-server), sha256-checked", () => {
    const t = targetFor({ platform: "darwin", arch: "arm64" })!;
    expect(t.id).toBe("darwin-arm64");
    expect(t.assets).toEqual([{ file: "llama-b11205-bin-macos-arm64.tar.gz", sha256: "97b06f59ad15e2b4b6044ba7338c4e3f40354c6dc2b9c5cda234e2bd6b9fd65e", bytes: 11755672 }]);
    expect(TARGETS["darwin-arm64"]).toBe(t);
    expect(PINNED_RPC["darwin-arm64"]!.server).toMatch(/^[0-9a-f]{64}$/); // the stage's pinned rpc-server
    // Never the CUDA build on a Mac, whatever nvidia-smi says.
    expect(targetFor({ platform: "darwin", arch: "arm64", nvidia: true })!.id).toBe("darwin-arm64");
  });

  test("Metal's working-set budget from the pinned llama-server (captured on this M5): 12124 MiB", () => {
    expect(parseMetalBudget(readFileSync(join(FIX, "llama-list-devices-m5.txt"), "utf8"))).toBe(12124 * MiB);
    expect(parseMetalBudget("Available devices:\n  CUDA0: NVIDIA GeForce RTX 5070 (12227 MiB, 11656 MiB free)")).toBeNull();
    expect(parseMetalBudget(null)).toBeNull();
  });

  test("capacity: the Metal budget when known (else 2/3 of RAM), M5 bandwidth 153 GB/s", () => {
    const mac = (budget?: number) => node("alexs-macbook-air", { mem: { total: 16 * GiB, used: 4 * GiB, swap_used: 0, pressure: "normal" }, accel: { chip: "Apple M5", unified: true, gpu_limit: null, gpus: [], ...(budget ? { metal_budget: budget } : {}) } });
    const known = machineCapacity(mac(12124 * MiB))!.backends[0]!;
    expect(known).toMatchObject({ kind: "apple", bandwidth: 153, bandwidthKnown: true, usableIdle: 12124 * MiB });
    expect(known.usable).toBe(11 * GiB); // 16 - 4 used - 1 reserve, under the Metal budget
    expect(machineCapacity(mac())!.backends[0]!.usableIdle).toBe(Math.floor((16 * GiB * 2) / 3));
  });

  test("the sampler re-reads accelerator facts on a Mac until the Metal budget appears (runtime installed later)", async () => {
    let now = 0;
    let budget: number | undefined;
    let reads = 0;
    const published: MachineStats[] = [];
    const s = new MachineStatsSampler((st) => published.push(st), createLogger({}), {
      platform: "darwin", clock: () => now, heartbeatMs: 1,
      read: async () => ({ mem: { total: 16 * GiB, used: 4 * GiB, swap_used: 0, pressure: "normal" }, temp_c: 40 }),
      readAccel: async () => { reads++; return { chip: "Apple M5", unified: true, gpu_limit: null, gpus: [], ...(budget ? { metal_budget: budget } : {}) }; },
    });
    await s.tick();
    budget = 12124 * MiB;
    now += ACCEL_RETRY_MS;
    await s.tick();
    expect(reads).toBe(2);
    expect(published.at(-1)?.accel?.metal_budget).toBe(12124 * MiB);
    now += ACCEL_RETRY_MS * 3;
    await s.tick();
    expect(reads).toBe(2);
  });
});

describe("p8-9: one memory-pressure policy for every pool job (pressure.ts)", () => {
  const { PoolStages } = require("../../src/pool/run/stage.ts") as typeof import("../../src/pool/run/stage.ts");
  const { PressureWatch, startBlocked, SWAP_GROWTH_BYTES } = require("../../src/pool/run/pressure.ts") as typeof import("../../src/pool/run/pressure.ts");
  const mem = (pressure: "normal" | "warn" | "critical", swap: number) => ({ pressure, swap_used: swap });

  test("no job starts at warn or critical; a running one stops at critical, or at warn once swap grew by more than 512 MiB", () => {
    expect(startBlocked(mem("normal", 0))).toBeNull();
    expect(startBlocked(mem("warn", 0))).toContain("warn");
    expect(startBlocked(mem("critical", 0))).toContain("critical");
    expect(startBlocked(null)).toBeNull();
    let now = mem("normal", 2 * GiB);
    const w = new PressureWatch(() => now);
    expect(w.check()).toBeNull();
    now = mem("warn", 2 * GiB + SWAP_GROWTH_BYTES); // warn, swap grew exactly the allowance: keep going
    expect(w.check()).toBeNull();
    now = mem("warn", 2 * GiB + SWAP_GROWTH_BYTES + 1);
    expect(w.check()).toBe("memory_pressure_swap_growth");
    now = mem("normal", 5 * GiB); // swap alone is not pressure
    expect(w.check()).toBeNull();
    now = mem("critical", 2 * GiB);
    expect(w.check()).toBe("memory_pressure_critical");
  });

  test("a stage start is refused (503 memory_pressure) under warn pressure; normal passes the gate", async () => {
    let now = mem("warn", 0);
    const stages = new PoolStages({
      home: "/tmp/wk-none", log: createLogger({}), share: () => ({ on: true, maxBytes: null }),
      runtime: () => ({ dir: "/nonexistent", server: null, rpc: null }), mayHead: () => true, hostnameOf: (n) => n,
      freeMemory: async () => 8 * GiB, changed: () => undefined, mem: () => now,
    });
    const start = { action: "start", run: "a".repeat(32), bytes: GiB, model: "m" };
    await expect(stages.handle(start, "head1")).rejects.toMatchObject({ status: 503, code: "memory_pressure" });
    now = mem("normal", 0);
    // Past the pressure check, it fails on the missing runtime instead: the pressure gate was the only refusal.
    await expect(stages.handle(start, "head1")).rejects.toMatchObject({ code: "no_runtime" });
  });
});

describe("a machine joins a split only when it helps (atlas-wsl + hestia-wsl + alex-mac)", () => {
  const { planRun } = require("../../src/pool/run/plan.ts") as typeof import("../../src/pool/run/plan.ts");
  const { catalogNeed } = require("../../src/pool/run/plan.ts") as typeof import("../../src/pool/run/plan.ts");
  const { CATALOG: CAT } = require("../../src/pool/catalog.ts") as typeof import("../../src/pool/catalog.ts");
  const mac = node("alexs-macbook-air", { mem: { total: 16 * GiB, used: 6 * GiB, swap_used: 0, pressure: "normal" }, accel: { chip: "Apple M5", unified: true, gpu_limit: null, gpus: [], metal_budget: 12124 * MiB } }, { pool: share({ cap: 3 * GiB }), rtt_ms: 12 });
  const need = catalogNeed(CAT.models.find((m) => m.id === "gpt-oss-20b")!, "q4");

  test("gpt-oss-20b from atlas-wsl: atlas + hestia hold it, so the Mac (slower link, 3 GB cap) is not added", () => {
    const plan = planRun([atlas({ self: true, rtt_ms: null }), hestia({ pool: share(), rtt_ms: 7 }), mac], need);
    expect(plan.stages.map((s) => s.hostname)).toEqual(["atlas-wsl", "hestia-wsl"]);
  });

  test("named, the Mac joins with a share within its cap", () => {
    const plan = planRun([atlas({ self: true, rtt_ms: null }), hestia({ pool: share(), rtt_ms: 7 }), mac], need, ["hestia-wsl", "alexs-macbook-air"]);
    expect(plan.stages.map((s) => s.hostname)).toEqual(["atlas-wsl", "hestia-wsl", "alexs-macbook-air"]);
    expect(plan.stages[2]!.bytes).toBeLessThanOrEqual(3 * GiB);
  });

  test("the whole-team estimate for gpt-oss-20b uses the two NVIDIA machines, not the Mac", () => {
    const cs = suggestCombined([atlas({ self: true, rtt_ms: null, pool: share({ share: false }) }), hestia({ pool: share(), rtt_ms: 7 }), mac]);
    const p = cs.runnable!;
    console.log("[evidence] runnable:", p.model.id, p.quant, p.placement.map((x) => `${x.hostname}:${(x.bytes / GiB).toFixed(1)}`).join(" "));
    expect(p.placement.some((x) => x.hostname === "alexs-macbook-air")).toBe(false);
  });
});
