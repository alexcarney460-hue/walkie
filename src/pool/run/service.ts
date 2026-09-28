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
  readonly children: ChildRegistry;
  constructor(private readonly d: PoolServiceDeps, private readonly opts: PoolOptions = {}) {
    const max = d.config.pool_share_max_gb;
    this.shareCfg = { on: d.config.pool_share, maxBytes: typeof max === "number" ? Math.round(max * GiB) : null };
    this.children = new ChildRegistry(join(d.home, "pool", "children.json"));
    // A daemon that died (SIGKILL, a crash) may have left children behind if even their supervisors were killed.
    const reaped = this.children.reap();
    if (reaped.length) d.log.warn("pool_children_reaped", { children: reaped.map((r) => `${r.role}:${r.pid}`).join(",") });
    const seatsBlock = d.seatsBlock ?? (() => null);
    this.stages = new PoolStages({
      seatsBlock, home: d.home, log: d.log, share: () => this.shareCfg, runtime: () => this.runtime(), mayHead: d.mayHead,
      hostnameOf: d.hostnameOf, changed: d.changed, registry: this.children,
      freeMemory: opts.freeMemory ?? (() => measureFreeMemory(d.stats)),
      ...(opts.verifyRuntime ? { verifyRuntime: opts.verifyRuntime } : {}),
      ...(opts.rpcArgs ? { rpcArgs: opts.rpcArgs } : {}), ...(opts.leaseMs ? { leaseMs: opts.leaseMs } : {}),
    });
    this.runner = new PoolRunner({
      seatsBlock, home: d.home, log: d.log, runtime: () => this.runtime(), stage: d.stage, tunnel: d.tunnel, changed: d.changed, registry: this.children,
      ...(opts.serverArgs ? { serverArgs: opts.serverArgs } : {}), ...(opts.hfBase ? { hfBase: opts.hfBase } : {}),
    });
  }

  runtime(): Runtime { return locateRuntime(this.d.home, this.opts.llamaDir ?? this.d.config.pool_llama_dir); }

  /** Published to the team (vv answer, NodeView). */
  published(): PoolShare { return this.stages.share(); }

  view(): PoolLocalView {
    const rt = this.runtime();
    return {
      share: { on: this.shareCfg.on, max_bytes: this.shareCfg.maxBytes },
      runtime: { installed: hasRuntime(rt), dir: rt.dir, build: installedBuild(rt.dir) },
      run: this.runner.view(), stage: this.stages.view(),
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
    this.d.changed();
  }

  /** The roster changed: a stage whose head is no longer admitted stops. */
  rosterChanged(): void { this.stages.recheck(); }

  async stop(): Promise<void> {
    await this.runner.stop();
    await this.stages.stop("daemon_stopping");
  }
}
