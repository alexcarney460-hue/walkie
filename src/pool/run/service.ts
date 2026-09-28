// Split runs on this daemon (WALKIE-POOL-2): the owner's sharing setting, the worker side (a stage of someone's
// run) and the head side (a run this machine's person started). Attached to Core as `core.pool`; the peer API and
// the local API reach it there. docs/PROTOCOL.md §3 "Split runs".
import { saveConfigField, type Config } from "../../daemon/config.ts";
import type { Logger } from "../../daemon/logger.ts";
import type { PoolShare } from "../../protocol/pool.ts";
import { SEATS_POOL_CODE, SEATS_POOL_CONFLICT } from "../../protocol/seats.ts";
import { HttpError } from "../../daemon/http.ts";
import { join } from "node:path";
import { readDarwin, readLinux } from "../../daemon/machine-stats/read.ts";
import type { MachineStats } from "../../protocol/machine-stats.ts";
import { ChildRegistry } from "./child.ts";
import { PoolRunner, type RunnerDeps } from "./runner.ts";
import { hasRuntime, installedBuild, locateRuntime, type Runtime } from "./runtime.ts";
import { PoolStages, type ShareConfig } from "./stage.ts";
import { PoolServer } from "./serve.ts";
import { PoolJobs } from "./jobs.ts";
import { PoolConnections } from "./connect.ts";
import type { InstallView, PrepareView, ServeReq, ServeRes } from "../../protocol/pool.ts";
import { installRuntime, LLAMA_BUILD, targetFor, type RuntimeTarget } from "./runtime.ts";
import { readAccel, readGpuNow } from "../../daemon/machine-stats/accel.ts";
import { CATALOG, type Quant } from "../catalog.ts";
import { machineCapacity } from "../capacity.ts";
import { ensureFiles, filesFor, PINS } from "./gguf.ts";
import { prepareWeights, preparedDir } from "./weights.ts";
import type { End } from "./tunnel.ts";

const GiB = 1024 ** 3;

export interface PoolOptions {
  /** Where llama-server and the rpc server are (default: config `pool_llama_dir`, WALKIE_LLAMA_DIR, <home>/pool/llama). */
  llamaDir?: string;
  /** Tests: extra rpc-server / llama-server arguments, the stage lease, the Hugging Face base URL. */
  rpcArgs?: readonly string[];
  serverArgs?: readonly string[];
  leaseMs?: number;
  hfBase?: string;
  /** Tests: this machine's free memory in bytes (default: measured, see freeMemory()). */
  freeMemory?: () => Promise<number | null>;
  /** Tests only: accept stand-in rpc-servers (default: only the pinned llama.cpp build runs). */
  verifyRuntime?: (rt: Runtime) => string | null;
  /** Tests: the runtime installer (default runtime.ts installRuntime: downloads the pinned build). */
  installRuntime?: (t: RuntimeTarget, dir: string, onProgress: (file: string, done: number, total: number) => void) => Promise<Runtime>;
  /** Tests: served models' GPU budget (bytes) and idle timeout, instead of measured / 30 minutes. */
  serveBudget?: () => number | null;
  serveIdleMs?: number;
}

/** Machine stats this fresh are used as is; otherwise memory is read now. */
const STATS_FRESH_MS = 60_000;

/**
 * Memory free on this machine now (total - used; the same "used" as machine stats), from the sampler's last
 * reading when fresh, else read now (vm_stat / sysctl on macOS without temperature, /proc/meminfo on Linux).
 */
export async function measureFreeMemory(stats: () => MachineStats | null): Promise<number | null> {
  const s = stats();
  if (s?.mem && Date.now() - s.at < STATS_FRESH_MS) return Math.max(0, s.mem.total - s.mem.used);
  try {
    const r = process.platform === "darwin" ? await readDarwin({ thermal: async () => ({ sensors: null, error: "not read" }) })
      : process.platform === "linux" ? await readLinux() : null;
    return r?.mem ? Math.max(0, r.mem.total - r.mem.used) : null;
  } catch {
    return null;
  }
}

/**
 * Machine stats with free VRAM read NOW (POOL-REAL-1): the sampler's figure is up to 30 s old, and a GPU a model or a
 * stage just gave back was refused ("3.7 GB free" right after a stop). Other machines keep the published figure.
 */
export async function freshGpuStats(stats: () => MachineStats | null): Promise<MachineStats | null> {
  const s = stats();
  const n = s?.accel?.gpus.length ?? 0;
  if (!s || n === 0) return s;
  const now = await readGpuNow(n).catch(() => null);
  return now?.free ? { ...s, gpu_free: now.free } : s;
}

export interface PoolServiceDeps {
  home: string; configPath: string; config: Config; log: Logger;
  /** An admitted machine of a current member who isn't an observer (may head a run on this machine). */
  mayHead: (nodeId: string) => boolean;
  hostnameOf: (nodeId: string) => string;
  /** This machine's latest published machine stats (for its free memory). */
  stats: () => MachineStats | null;
  changed: () => void;
  stage: RunnerDeps["stage"];
  tunnel: RunnerDeps["tunnel"];
  /** POOL-REAL-1: a serving machine's `POST /peer/v1/pool/serve`, and a tunnel to any tunnel path of a peer. */
  serve: (nodeId: string, body: ServeReq) => Promise<ServeRes>;
  tunnelTo: (nodeId: string, path: string) => Promise<End>;
  /**
   * Why seats keep the pool off here now (allowed, or anything of a seat still there: a seat, a queued launch, a deny
   * still stopping them, a seat user not verified removed), or null. While it answers, nothing of the pool runs: no
   * sharing, no stage, no run head (Opus seats r9 HIGH, Codex r10 HIGH; docs/SECURITY.md threat 16). Default: never.
   */
  seatsBlock?: () => string | null;
}

export type { PoolLocalView } from "../../protocol/pool.ts";
import type { PoolLocalView } from "../../protocol/pool.ts";

export class PoolService {
  private shareCfg: ShareConfig;
  readonly stages: PoolStages;
  readonly runner: PoolRunner;
  readonly server: PoolServer;
  readonly connections: PoolConnections;
  readonly children: ChildRegistry;
  /** The machine's single pool-job reservation (jobs.ts): serve, split head, stage or install, one at a time. */
  readonly jobs: PoolJobs;
  private prep: { view: PrepareView; abort: AbortController } | null = null;
  private inst: InstallView | null = null;
  private preparedMemo: string[] | null = null;
  constructor(private readonly d: PoolServiceDeps, private readonly opts: PoolOptions = {}) {
    const max = d.config.pool_share_max_gb;
    this.shareCfg = { on: d.config.pool_share, maxBytes: typeof max === "number" ? Math.round(max * GiB) : null };
    this.children = new ChildRegistry(join(d.home, "pool", "children.json"));
    // A daemon that died (SIGKILL, a crash) may have left children behind if even their supervisors were killed.
    const reaped = this.children.reap();
    if (reaped.length) d.log.warn("pool_children_reaped", { children: reaped.map((r) => `${r.role}:${r.pid}`).join(",") });
    const seatsBlock = d.seatsBlock ?? (() => null);
    this.jobs = new PoolJobs(d.changed);
    const mem = () => d.stats()?.mem;
    this.stages = new PoolStages({
      jobs: this.jobs, mem,
      seatsBlock, home: d.home, log: d.log, share: () => this.shareCfg, runtime: () => this.runtime(), mayHead: d.mayHead,
      hostnameOf: d.hostnameOf, changed: d.changed, registry: this.children,
      freeMemory: opts.freeMemory ?? (() => measureFreeMemory(d.stats)),
      gpuFree: async () => {
        const cap = machineCapacity({ node_id: "self", hostname: "self", handle: "self", stats: (await freshGpuStats(d.stats)) ?? undefined });
        const gpu = cap?.backends.find((b) => b.kind === "nvidia" && b.measured);
        // rpc-server holds the stage on the first GPU (POOL-REAL-1 p8-3): its budget is that GPU's.
        return gpu ? gpu.device?.usable ?? gpu.usable : null;
      },
      ...(opts.verifyRuntime ? { verifyRuntime: opts.verifyRuntime } : {}),
      ...(opts.rpcArgs ? { rpcArgs: opts.rpcArgs } : {}), ...(opts.leaseMs ? { leaseMs: opts.leaseMs } : {}),
    });
    this.server = new PoolServer({
      seatsBlock, home: d.home, log: d.log, runtime: () => this.runtime(), share: () => this.shareCfg, mayUse: d.mayHead,
      hostnameOf: d.hostnameOf, stats: () => freshGpuStats(d.stats), changed: d.changed, registry: this.children,
      jobs: this.jobs, mem,
      ...(opts.serverArgs ? { serverArgs: opts.serverArgs } : {}), ...(opts.hfBase ? { hfBase: opts.hfBase } : {}),
      ...(opts.serveBudget ? { budget: opts.serveBudget } : {}), ...(opts.serveIdleMs ? { idleMs: opts.serveIdleMs } : {}),
    });
    this.connections = new PoolConnections({ home: d.home, log: d.log, changed: d.changed, hostnameOf: d.hostnameOf, serve: d.serve, tunnel: d.tunnelTo });
    this.runner = new PoolRunner({
      jobs: this.jobs, mem,
      seatsBlock, home: d.home, log: d.log, runtime: () => this.runtime(), stage: d.stage, tunnel: d.tunnel, changed: d.changed, registry: this.children,
      ...(opts.serverArgs ? { serverArgs: opts.serverArgs } : {}), ...(opts.hfBase ? { hfBase: opts.hfBase } : {}),
    });
  }

  /** POOL-REAL-1: asks another machine to start / stop a model it serves (the local API's `serve --on`). */
  peerServe(nodeId: string, body: ServeReq): Promise<ServeRes> { return this.d.serve(nodeId, body); }

  runtime(): Runtime { return locateRuntime(this.d.home, this.opts.llamaDir ?? this.d.config.pool_llama_dir); }

  /** Published to the team (vv answer, NodeView). */
  published(): PoolShare {
    const s = this.stages.share();
    const serving = this.server.published();
    const prepared = s.share ? this.prepared() : [];
    return { ...s, busy: s.busy || this.jobs.busy(), serve: true, ...(serving ? { serving } : {}), ...(prepared.length ? { prepared } : {}) };
  }

  /** Catalog models ("<id>:<quant>") whose weights this machine prepared (weights.ts), newest check cached. */
  prepared(): string[] {
    if (this.preparedMemo) return this.preparedMemo;
    const out: string[] = [];
    for (const id of Object.keys(PINS.models)) {
      for (const q of ["q4", "q8"] as const) {
        const mf = filesFor(id, q);
        if (mf && preparedDir(this.d.home, mf)) out.push(`${id}:${q}`);
      }
    }
    this.preparedMemo = out.slice(0, 32);
    return this.preparedMemo;
  }

  /**
   * `walkie pool install` through the daemon (POOL-REAL-1): the pinned, sha256-checked llama.cpp build for this
   * machine (CUDA when an NVIDIA GPU is found) into its runtime directory. A chore, not a trust decision: a person or a
   * NAMED agent may start it (routes.ts). Refused while anything of the pool runs here (it replaces the binaries).
   */
  async install(by: string | null): Promise<InstallView> {
    if (this.inst?.state === "downloading") return this.inst;
    if (this.children.busy()) throw new HttpError(409, "pool_busy", "a model server this machine started is still stopping; try again in a moment");
    // The machine's one pool job, taken before the first await: no run, stage or served model starts while the
    // runtime directory is being replaced, and a second install is refused (jobs.ts).
    let job;
    try { job = this.jobs.reserve("install", "runtime"); } catch (err) { throw new HttpError(409, "pool_busy", (err as Error).message); }
    let t;
    try {
      const nvidia = ((this.d.stats()?.accel ?? await readAccel().catch(() => null))?.gpus.length ?? 0) > 0;
      t = targetFor({ nvidia });
      if (!t) throw new HttpError(409, "no_target", `no pinned llama.cpp ${LLAMA_BUILD} build for ${process.platform}/${process.arch}`);
    } catch (err) {
      job.release();
      throw err;
    }
    const total = t.assets.reduce((a, x) => a + x.bytes, 0);
    const view: InstallView = { target: t.label, build: LLAMA_BUILD, state: "downloading", file: null, done: 0, total, error: null, by };
    this.inst = view;
    const dir = this.runtime().dir;
    const doneBefore = new Map<string, number>();
    this.d.log.info("pool_install_started", { target: t.id, by: by ?? "person", dir });
    void (this.opts.installRuntime ?? installRuntime)(t, dir, (file, done) => {
      doneBefore.set(file, done);
      if (this.inst) this.inst = { ...this.inst, file, done: [...doneBefore.values()].reduce((a, b) => a + b, 0) };
    }).then(() => {
      this.inst = { ...this.inst!, state: "done", done: total, error: null };
      this.d.log.info("pool_install_done", { target: t.id });
    }, (err: unknown) => {
      this.inst = { ...this.inst!, state: "failed", error: (err as Error).message.slice(0, 300) };
      this.d.log.warn("pool_install_failed", { target: t.id, err: (err as Error).message.slice(0, 300) });
    }).finally(() => {
      this.preparedMemo = null;
      job.release();
      this.d.changed();
    });
    this.d.changed();
    return view;
  }

  /**
   * `walkie pool prepare <model>` (a person, POOL-REAL-1): downloads the pinned GGUF here if missing (checked), then
   * copies its weights into the rpc-server tensor cache, so stages of split runs of this model load this machine's
   * share from disk. One at a time; progress in the local view.
   */
  prepare(modelId: string, quant: Quant): PrepareView {
    const m = CATALOG.models.find((x) => x.id === modelId);
    const mf = m ? filesFor(m.id, quant) : null;
    if (!m || !mf) throw new HttpError(400, "unknown_model", `no ${quant === "q8" ? "8-bit" : "4-bit"} GGUF of "${modelId}" in Walkie's list`);
    if (this.prep && ["downloading", "preparing"].includes(this.prep.view.state)) throw new HttpError(409, "prepare_active", `already preparing ${this.prep.view.name}`);
    const view: PrepareView = { model: m.id, quant, name: m.name, state: "downloading", done: 0, total: mf.bytes, error: null };
    const job = { view, abort: new AbortController() };
    this.prep = job;
    const set = (patch: Partial<PrepareView>): void => { job.view = { ...job.view, ...patch }; this.d.changed(); };
    void (async () => {
      await ensureFiles(this.d.home, mf, job.abort.signal, (p) => { job.view = { ...job.view, done: p.done, total: p.total }; }, this.opts.hfBase);
      set({ state: "preparing", done: 0 });
      const r = await prepareWeights(this.d.home, mf, job.abort.signal, (p) => { job.view = { ...job.view, done: p.done, total: p.total }; });
      this.preparedMemo = null;
      this.d.log.info("pool_prepared", { model: m.id, quant, tensors: r.tensors, bytes: r.bytes });
      set({ state: "done", done: r.bytes, total: r.bytes });
    })().catch((err: unknown) => {
      this.d.log.warn("pool_prepare_failed", { model: m.id, err: (err as Error).message.slice(0, 300) });
      set({ state: "failed", error: (err as Error).message.slice(0, 300) });
    });
    this.d.changed();
    return job.view;
  }

  view(): PoolLocalView {
    const rt = this.runtime();
    return {
      share: { on: this.shareCfg.on, max_bytes: this.shareCfg.maxBytes },
      runtime: { installed: hasRuntime(rt), dir: rt.dir, build: installedBuild(rt.dir) },
      run: this.runner.view(), stage: this.stages.view(), serve: this.server.view(), connections: this.connections.view(),
      prepare: this.prep?.view ?? null, prepared: this.prepared(), install: this.inst,
    };
  }

  /**
   * Why seats can't be allowed here now (sharing is on, a stage or a run is running, or any model server this daemon
   * started, or is starting, still runs: Opus/Codex seats r10 MEDIUM), with what to turn off; null when nothing of the
   * pool is on. Asked synchronously right before seats are allowed and before each seat launch.
   */
  seatsConflict(): string | null {
    const on: string[] = [];
    const fix: string[] = [];
    if (this.server.active()) { on.push("this machine is serving a model"); fix.push("walkie pool stop"); }
    else if (this.jobs.holder()?.kind === "install") { on.push("the llama.cpp runtime is being installed"); fix.push("wait for it"); }
    if (this.shareCfg.on || this.stages.busy()) {
      on.push(this.stages.busy() ? "this machine is serving a stage of a split run" : "compute sharing is on here");
      fix.push("walkie pool share off");
    }
    const run = this.runner.view();
    if (run && !["stopped", "failed"].includes(run.state)) { on.push("a split run is running from here"); fix.push("walkie pool stop"); }
    else if (!on.length && this.children.busy()) { on.push("a model server this machine started is still stopping"); fix.push("wait for it, or walkie pool stop"); }
    const what = on.join(" and ");
    return on.length ? `${SEATS_POOL_CONFLICT}. ${what.charAt(0).toUpperCase()}${what.slice(1)}: turn ${on.length > 1 ? "them" : "it"} off first (${fix.join(", then ")})` : null;
  }

  /** Turns sharing on or off (persisted in config.json); off stops a running stage at once. Never on while seats are. */
  async setShare(on: boolean, maxGb: number | null | undefined): Promise<void> {
    const block = on ? this.d.seatsBlock?.() ?? null : null;
    if (block) throw new HttpError(409, SEATS_POOL_CODE, block);
    const maxBytes = maxGb === undefined ? this.shareCfg.maxBytes : maxGb === null ? null : Math.round(maxGb * GiB);
    saveConfigField(this.d.configPath, "pool_share", on);
    saveConfigField(this.d.configPath, "pool_share_max_gb", maxBytes === null ? null : Math.round((maxBytes / GiB) * 10) / 10);
    this.shareCfg = { on, maxBytes };
    this.d.log.info("pool_share_changed", { on, max_bytes: maxBytes });
    if (!on) await this.stages.stop("sharing_off");
    this.server.recheck();
    this.d.changed();
  }

  /** The roster changed: a stage whose head is no longer admitted stops. */
  rosterChanged(): void { this.stages.recheck(); this.server.recheck(); }

  async stop(): Promise<void> {
    this.prep?.abort.abort();
    await this.runner.stop();
    await this.stages.stop("daemon_stopping");
    await this.server.stop();
    await this.connections.stopAll();
  }
}
