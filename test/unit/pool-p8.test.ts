// POOL-REAL-1 fix round (Codex p8 review of walkie-pool-real @ 9cc1cb3): one test (or more) per finding.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../../src/daemon/logger.ts";
import { machineCapacity } from "../../src/pool/capacity.ts";
import { headFirst } from "../../src/pool/combined.ts";
import { suggestCombined } from "../helpers/pool-legacy.ts";
import { CATALOG } from "../../src/pool/catalog.ts";
import { PoolConnections } from "../../src/pool/run/connect.ts";
import { ensureFiles, localPath } from "../../src/pool/run/gguf.ts";
import { PoolJobs } from "../../src/pool/run/jobs.ts";
import { catalogNeed, planRun, serveHosts } from "../../src/pool/run/plan.ts";
import { PoolRunner } from "../../src/pool/run/runner.ts";
import { locateRuntime } from "../../src/pool/run/runtime.ts";
import { PoolServer } from "../../src/pool/run/serve.ts";
import { ServeProxy, MAX_ACTIVE } from "../../src/pool/run/serve-proxy.ts";
import { PoolStages } from "../../src/pool/run/stage.ts";
import { deviceSlot } from "../../src/pool/suggest.ts";
import type { MachineAccel, MachineStats, MachineSys } from "../../src/protocol/machine-stats.ts";
import type { PoolShare } from "../../src/protocol/pool.ts";
import type { NodeView } from "../../src/protocol/schemas.ts";
import { fakeServeRuntime, placeModel } from "../helpers/pool-runtime.ts";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const log = createLogger({});
const roots: string[] = [];
const tmp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const share = (p: Partial<PoolShare> = {}): PoolShare => ({ share: true, cap: null, runtime: true, busy: false, serve: true, ...p });
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
const nv = (gpus: MachineAccel["gpus"]): MachineAccel => ({ chip: "x86", unified: false, gpu_limit: null, gpus });

function server(jobs: PoolJobs, home: string, rt: string, extra: Partial<ConstructorParameters<typeof PoolServer>[0]> = {}): PoolServer {
  return new PoolServer({
    home, log, runtime: () => locateRuntime(home, rt), share: () => ({ on: true, maxBytes: null }), mayUse: () => true,
    hostnameOf: (n) => n, stats: async () => null, changed: () => undefined, jobs, budget: () => 11 * GiB, ...extra,
  });
}

describe("p8-1 HIGH: one atomic pool-job reservation per machine", () => {
  test("PoolJobs: one holder; refusals name it; release is idempotent and only by the holder", () => {
    const jobs = new PoolJobs();
    const a = jobs.reserve("serve", "a");
    expect(() => jobs.reserve("stage", "b")).toThrow(/serving a model/);
    expect(jobs.holder()?.kind).toBe("serve");
    a.release();
    a.release();
    const b = jobs.reserve("head", "b");
    a.release(); // a stale holder can't free b's reservation
    expect(b.held()).toBe(true);
    expect(jobs.why()).toContain("split run");
  });

  test("two serve starts racing: the first reserves before its first await, the second is refused (409 busy)", async () => {
    const home = tmp("wk-p8-");
    const rt = fakeServeRuntime(home);
    const jobs = new PoolJobs();
    const s = server(jobs, home, rt, { hfBase: "http://127.0.0.1:9" });
    const first = s.start("llama-3.2-3b", "q4", null);
    const second = s.start("llama-3.1-8b", "q4", null);
    await expect(second).rejects.toMatchObject({ status: 409, code: "busy" });
    const v = await first;
    expect(v.model.id).toBe("llama-3.2-3b");
    expect(jobs.holder()?.kind).toBe("serve");
    // Stopping it (still downloading: nothing listens at :9) gives the machine back once its teardown ends.
    await s.stop();
    expect(jobs.busy()).toBe(false);
  });

  test("a stage is refused while this machine serves, and a split head while it runs a stage (shared reservation)", async () => {
    const jobs = new PoolJobs();
    const held = jobs.reserve("serve", "x");
    const stages = new PoolStages({
      home: "/tmp/wk-none", log, share: () => ({ on: true, maxBytes: null }), runtime: () => ({ dir: "/nonexistent", server: "/bin/true", rpc: "/bin/true" }),
      mayHead: () => true, hostnameOf: (n) => n, freeMemory: async () => 8 * GiB, changed: () => undefined, jobs, verifyRuntime: () => null,
    });
    await expect(stages.handle({ action: "start", run: "a".repeat(32), bytes: GiB, model: "m" }, "head1")).rejects.toMatchObject({ status: 409, code: "busy" });
    held.release();
    jobs.reserve("stage", "y");
    const home = tmp("wk-p8-");
    const runner = new PoolRunner({
      home, log, runtime: () => locateRuntime(home, fakeServeRuntime(home)), stage: async () => ({ ok: true }), tunnel: async () => { throw new Error("no"); },
      changed: () => undefined, jobs,
    });
    const me = node("me", {}, { self: true, rtt_ms: null });
    expect(() => runner.start({ model: "llama-3.2-3b" }, [me])).toThrow(/running a stage/);
  });

  test("a model that is still stopping keeps the machine: a new start is refused until its teardown ends; stops share it", async () => {
    const home = tmp("wk-p8-");
    const rt = fakeServeRuntime(home);
    placeModel(home, "llama-3.2-3b", "q4");
    const jobs = new PoolJobs();
    const s = server(jobs, home, rt);
    const v = await s.start("llama-3.2-3b", "q4", null);
    for (let i = 0; i < 200 && s.view()?.state !== "serving"; i++) await Bun.sleep(25);
    expect(s.view()?.state).toBe("serving");
    // Per-run upstream key file.
    expect(existsSync(join(home, "pool", `serve-upstream-${v.id}.key`))).toBe(true);
    const stop1 = s.stop();
    const stop2 = s.stop(); // waits for the same teardown
    await expect(s.start("llama-3.1-8b", "q4", null)).rejects.toMatchObject({ status: 409, code: "busy" });
    const [a, b] = await Promise.all([stop1, stop2]);
    expect(a?.state).toBe("stopped");
    expect(b?.state).toBe("stopped");
    expect(jobs.busy()).toBe(false);
    expect(existsSync(join(home, "pool", `serve-upstream-${v.id}.key`))).toBe(false);
    expect(readdirSync(join(home, "pool")).filter((f) => f.startsWith("serve-upstream"))).toEqual([]);
  }, 30_000);
});

describe("p8-3 / p8-5: plans, admission and suggestions use each machine's first device", () => {
  // Two 12 GB GPUs (11.5 GB free each) and 64 GB of RAM.
  const two = (over: Partial<NodeView> = {}) => node("rig", { mem: { total: 64 * GiB, used: 4 * GiB, swap_used: 0, pressure: "normal" }, accel: nv([{ name: "NVIDIA GeForce RTX 5070", vram: 12 * GiB }, { name: "NVIDIA GeForce RTX 5070", vram: 12 * GiB }]), gpu_free: [12 * GiB, 12 * GiB] }, over);

  test("a 2-GPU machine: serving counts both GPUs, a split part only the first", () => {
    const cap = machineCapacity(two())!;
    expect(cap.backends[0]!.usable).toBe(2 * (12 * GiB - 0.5 * GiB));
    expect(deviceSlot(cap).b.usable).toBe(12 * GiB - 0.5 * GiB);
  });

  test("planRun never gives a 2-GPU head more than its first GPU holds", () => {
    const need = catalogNeed(CATALOG.models.find((m) => m.id === "gpt-oss-20b")!, "q4"); // 14.2 GB
    expect(() => planRun([two({ self: true, rtt_ms: null })], need)).toThrow(/GPU memory/);
  });

  test("helpers are ordered by their device, not their largest backend (a 64 GB-RAM / 6 GB-GPU box after a 11.5 GB GPU)", () => {
    const small = node("ramrich", { mem: { total: 64 * GiB, used: 2 * GiB, swap_used: 0, pressure: "normal" }, accel: nv([{ name: "NVIDIA GeForce RTX 3060", vram: 6.5 * GiB }]), gpu_free: [6.5 * GiB] });
    const big = node("gpu", { mem: { total: 16 * GiB, used: 4 * GiB, swap_used: 0, pressure: "normal" }, accel: nv([{ name: "NVIDIA GeForce RTX 5070", vram: 12 * GiB }]), gpu_free: [12 * GiB] });
    const caps = [machineCapacity(small)!, machineCapacity(big)!];
    expect(headFirst(caps, "none").map((m) => m.hostname)).toEqual(["gpu", "ramrich"]);
  });

  test("what this machine can start now is placed on devices, never on a helper's system RAM", () => {
    const me = node("me", { accel: nv([{ name: "NVIDIA GeForce RTX 5070", vram: 12 * GiB }]), gpu_free: [12 * GiB] }, { self: true, rtt_ms: null, pool: share() });
    const ramrich = node("ramrich", { mem: { total: 128 * GiB, used: 2 * GiB, swap_used: 0, pressure: "normal" }, accel: nv([{ name: "NVIDIA GeForce RTX 3060", vram: 6.5 * GiB }]), gpu_free: [6.5 * GiB] }, { pool: share() });
    const r = suggestCombined([me, ramrich]).runnable;
    expect(r).not.toBeNull();
    expect(r!.placement.every((p) => p.memory === "GPU memory")).toBe(true);
  });
});

describe("p8-4: --tensor-split follows the model share, not the runtime overhead", () => {
  test("named plan: each worker's bytes = its model share + 1 GiB; model_bytes carries the share alone", () => {
    const g = (h: string, gb: number, over: Partial<NodeView> = {}) => node(h, { accel: nv([{ name: "NVIDIA GeForce RTX 5070", vram: gb * GiB }]), gpu_free: [gb * GiB] }, over);
    const need = catalogNeed(CATALOG.models.find((m) => m.id === "gpt-oss-20b")!, "q4");
    const plan = planRun([g("head", 12, { self: true, rtt_ms: null }), g("w1", 8, { pool: share() }), g("w2", 4, { pool: share() })], need, ["w1", "w2"]);
    const [h, w1, w2] = plan.stages;
    expect(h!.bytes).toBe(h!.model_bytes);
    expect(w1!.bytes - w1!.model_bytes).toBe(GiB);
    expect(w2!.bytes - w2!.model_bytes).toBe(GiB);
    expect(Math.abs(plan.stages.reduce((s, x) => s + x.model_bytes, 0) - need)).toBeLessThanOrEqual(3);
  });
});

describe("p8-6: the proxy reserves a request slot before it reads the body", () => {
  test(`${MAX_ACTIVE + 2} slow uploads at once: ${MAX_ACTIVE} proceed, the rest get 429 before anything reaches llama-server`, async () => {
    let reached = 0;
    const up = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { reached++; return Response.json({ ok: true }); } });
    const key = "c".repeat(48);
    const proxy = new ServeProxy({ upstream: () => ({ port: up.port!, key: "u" }), authorize: (k) => (k === key ? "c" : null) });
    const port = proxy.start();
    // A too-large body is refused (413) and gives its slot back (the uploads below still get all MAX_ACTIVE slots).
    for (let i = 0; i < MAX_ACTIVE + 1; i++) {
      const big = await fetch(`http://127.0.0.1:${port}/v1/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: "x".repeat(5 * MiB) });
      expect(big.status).toBe(413);
    }
    const slow = () => {
      let push: ((b: Uint8Array) => void) | null = null;
      let end: (() => void) | null = null;
      const body = new ReadableStream<Uint8Array>({ start(c) { push = (b) => c.enqueue(b); end = () => c.close(); } });
      const res = fetch(`http://127.0.0.1:${port}/v1/completions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body, duplex: "half" } as RequestInit);
      return { res, finish: () => { push!(new TextEncoder().encode("{}")); end!(); } };
    };
    const calls = Array.from({ length: MAX_ACTIVE + 2 }, slow);
    await Bun.sleep(150);
    for (const c of calls) c.finish();
    const statuses = (await Promise.all(calls.map((c) => c.res))).map((r) => r.status).sort();
    expect(statuses.filter((x) => x === 200)).toHaveLength(MAX_ACTIVE);
    expect(statuses.filter((x) => x === 429)).toHaveLength(2);
    expect(reached).toBe(MAX_ACTIVE);
    proxy.stop();
    up.stop(true);
  });
});

describe("p8-8: a disconnect while the listener is being created leaves no listener behind", () => {
  test("connect is cancelled (409) and its socket is closed", async () => {
    const home = tmp("wk-p8-");
    const conns = new PoolConnections({
      home, log, changed: () => undefined, hostnameOf: (n) => n,
      serve: async (_n, b) => (b.action === "connect" ? { ok: true, id: "d".repeat(32), key: "e".repeat(48), model: { name: "M", id: "llama-3.2-3b", quant: "q4" }, lease_ms: 45_000 } : { ok: true }),
      tunnel: async () => { throw new Error("unused"); },
    });
    const c = conns as unknown as { listen: (l: unknown) => Promise<{ port: number; srv: ReturnType<typeof netServer> }> };
    const orig = c.listen.bind(conns);
    let srv: ReturnType<typeof netServer> | null = null;
    c.listen = async (l) => { const r = await orig(l); srv = r.srv; await Bun.sleep(50); return r; };
    const p = conns.connect("peer1");
    await Bun.sleep(10);
    await conns.disconnect("peer1");
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
    await Bun.sleep(20);
    expect(srv!.listening).toBe(false);
    expect(conns.view()).toEqual([]);
  });
});

describe("p8-10: one download per destination file", () => {
  const data = new Uint8Array(2 * MiB).map((_, i) => (i * 13) % 251);
  const sha = new Bun.CryptoHasher("sha256").update(data).digest("hex");
  const mf = { repo: "acme/dedupe-GGUF", revision: "f".repeat(40), files: [{ path: "m.gguf", size: data.byteLength, sha256: sha }], bytes: data.byteLength };

  test("two consumers of the same model share one request; one cancelling doesn't cancel the other", async () => {
    let requests = 0;
    const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { requests++; await Bun.sleep(150); return new Response(data); } });
    const home = tmp("wk-p8-");
    const a = new AbortController();
    const one = ensureFiles(home, mf, a.signal, () => undefined, `http://127.0.0.1:${srv.port}`, 5);
    const two = ensureFiles(home, mf, new AbortController().signal, () => undefined, `http://127.0.0.1:${srv.port}`, 5);
    await Bun.sleep(30);
    a.abort();
    await expect(one).rejects.toThrow(/cancelled/);
    expect(await two).toBe(localPath(home, mf, mf.files[0]!));
    expect(requests).toBe(1);
    srv.stop(true);
  });
});

describe("older sharing peers have no serve API", () => {
  test("serveHosts never picks a sharing machine that doesn't publish serve: true", () => {
    const g = (over: Partial<NodeView>) => node("old", { accel: nv([{ name: "NVIDIA GeForce RTX 5070", vram: 12 * GiB }]), gpu_free: [12 * GiB] }, over);
    const me = node("me", {}, { self: true, rtt_ms: null });
    expect(serveHosts([me, g({ pool: share() })], 4 * GiB).map((h) => h.node.hostname)).toEqual(["old"]);
    const { serve: _s, ...legacy } = share();
    expect(serveHosts([me, g({ pool: legacy as PoolShare })], 4 * GiB)).toEqual([]);
  });
});

describe("p8-9: the pressure policy covers serving and split heads too", () => {
  test("a served model and a split head don't start under warn pressure (503 memory_pressure); nothing is reserved", async () => {
    const home = tmp("wk-p8-");
    const rt = fakeServeRuntime(home);
    const jobs = new PoolJobs();
    const warn = () => ({ pressure: "warn" as const, swap_used: 0 });
    const s = server(jobs, home, rt, { mem: warn });
    await expect(s.start("llama-3.2-3b", "q4", null)).rejects.toMatchObject({ status: 503, code: "memory_pressure" });
    const runner = new PoolRunner({
      home, log, runtime: () => locateRuntime(home, rt), stage: async () => ({ ok: true }), tunnel: async () => { throw new Error("no"); },
      changed: () => undefined, jobs, mem: warn,
    });
    expect(() => runner.start({ model: "llama-3.2-3b" }, [node("me", {}, { self: true, rtt_ms: null })])).toThrow(/warn memory pressure/);
    expect(jobs.busy()).toBe(false);
  });

  test("a running served model stops when swap grows under warn pressure", async () => {
    const home = tmp("wk-p8-");
    const rt = fakeServeRuntime(home);
    placeModel(home, "llama-3.2-3b", "q4");
    let m = { pressure: "normal" as "normal" | "warn", swap_used: GiB };
    const jobs = new PoolJobs();
    const s = server(jobs, home, rt, { mem: () => m });
    await s.start("llama-3.2-3b", "q4", null);
    for (let i = 0; i < 200 && s.view()?.state !== "serving"; i++) await Bun.sleep(25);
    expect(s.view()?.state).toBe("serving");
    m = { pressure: "warn", swap_used: 2 * GiB };
    for (let i = 0; i < 200 && s.view()?.state !== "failed"; i++) await Bun.sleep(25);
    expect(s.view()?.state).toBe("failed");
    expect(s.view()?.error).toContain("memory pressure swap growth");
    expect(jobs.busy()).toBe(false);
  }, 30_000);
});
