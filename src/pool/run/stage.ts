// A worker's side of a split run (WALKIE-POOL-2, hardened in POOL-3): one stage at a time, only when this machine's
// owner shares it.
//
// `POST /peer/v1/pool/stage start` (from an admitted, non-observer machine of a current member, through the peer API
// gate) is admitted only if: sharing is on, no other run holds this machine, the runtime is installed, and the
// planned bytes fit THIS machine's budget = min(the owner's cap, memory free here now - 1 GiB), measured here, never
// taken from the head. It starts `rpc-server -H 127.0.0.1 -p <random>` (no tensor cache on disk) under a supervisor
// (child.ts: it dies with this daemon) with a minimal environment and a private HOME that is deleted at the end.
// Startup can be cancelled (Stop, sharing off) and consent is re-checked before the stage goes live.
//
// Tunnels: only from the head that started it, only while its lease lives (renewed by the head; LEASE_MS without a
// renew stops the stage), at most MAX_TUNNELS at once (a slot is RESERVED when granted, so concurrent opens can't
// overshoot) and MAX_OPENS_PER_MIN new ones a minute. Bytes into rpc-server go through the RPC guard (rpc-guard.ts:
// no custom ops, no node id 0, no transport upgrade) and a byte bucket (burst = budget + 1 GiB, then
// REFILL_BYTES_PER_S). Sharing off, the head's node revoked, its member removed or made an observer, Stop, the lease
// running out, or rpc-server's resident memory passing the budget by 10% + 512 MiB (best effort; NVIDIA VRAM isn't
// resident memory) stop it, killing rpc-server by its PID.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { HttpError } from "../../daemon/http.ts";
import type { Logger } from "../../daemon/logger.ts";
import { StageReq, type PoolShare, type StageRes, type StageView } from "../../protocol/pool.ts";
import { SEATS_POOL_CODE, SEATS_POOL_CONFLICT } from "../../protocol/seats.ts";
import { freeLoopbackPort, minimalEnv, residentBytes, spawnChild, waitForPort, type Child, type ChildRegistry } from "./child.ts";
import { guardSelfTest, RpcGuard } from "./rpc-guard.ts";
import { hasRuntime, INSTALL_HINT, verifyPinnedRpc, type Runtime } from "./runtime.ts";
import { ByteBucket, splice, tcpEnd, type End } from "./tunnel.ts";

export type { StageView } from "../../protocol/pool.ts";

const GiB = 1024 ** 3;
export const LEASE_MS = 45_000;
export const MAX_TUNNELS = 4;
export const MAX_OPENS_PER_MIN = 20;
export const REFILL_BYTES_PER_S = 64 * 1024 * 1024;
/** Kept free on the worker, like the suggestions' RESERVE_BYTES. */
export const STAGE_RESERVE_BYTES = GiB;
/** A granted tunnel that isn't opened within this gives its slot back. */
const GRANT_TTL_MS = 15_000;
const WATCH_MS = 3_000;
const START_WAIT_MS = 20_000;

export interface ShareConfig { on: boolean; maxBytes: number | null }

export interface StageDeps {
  /** Why seats keep the pool off here (service.ts seatsBlock): no stage starts, a running one stops. Default: never. */
  seatsBlock?: () => string | null;
  home: string;
  log: Logger;
  share: () => ShareConfig;
  runtime: () => Runtime;
  /** Whether a node may head a run here: an admitted machine of a current member who isn't an observer. */
  mayHead: (nodeId: string) => boolean;
  hostnameOf: (nodeId: string) => string;
  /** Bytes of memory free on this machine now (total - used), measured here; null when it can't be read. */
  freeMemory: () => Promise<number | null>;
  /** Called when the stage starts or stops (the published `pool.busy` changes). */
  changed: () => void;
  registry?: ChildRegistry;
  /**
   * null when the rpc-server may run, else why not (default: it must be the pinned build, runtime.ts
   * verifyPinnedRpc). Tests with stand-in rpc-servers replace it; nothing a user can configure does.
   */
  verifyRuntime?: (rt: Runtime) => string | null;
  /** Extra rpc-server arguments (tests pin the CPU device). */
  rpcArgs?: readonly string[];
  leaseMs?: number;
}

/** A grant to tunnel into the stage: accept() owns one connection's bytes; release() gives the slot back unused. */
export interface TunnelGrant { accept(end: End): Promise<void>; release(): void }

interface Current {
  run: string; head: string; model: string; bytes: number; budget: number; port: number; child: Child; home: string;
  lease: ReturnType<typeof setTimeout>; watch: ReturnType<typeof setInterval>;
  tunnels: Set<End>; reserved: number; opens: number[]; bucket: ByteBucket; startedAt: number; stopping: boolean;
  /** Bytes the head sent into the rpc-server through the tunnels (weights, activations). */
  bytesIn: number;
}

interface Pending { run: string; head: string; cancelled: string | null; child: Child | null }

export class PoolStages {
  private cur: Current | null = null;
  private pending: Pending | null = null;
  constructor(private readonly d: StageDeps) {}

  busy(): boolean { return !!this.cur || !!this.pending; }

  view(): StageView | null {
    const c = this.cur;
    return c ? { run: c.run, head: c.head, head_hostname: this.d.hostnameOf(c.head), model: c.model, bytes: c.bytes, started_at: c.startedAt, tunnels: c.tunnels.size, pid: c.child.pid, bytes_in: c.bytesIn } : null;
  }

  /** The published sharing state (vv answer, NodeView). */
  share(): PoolShare {
    const s = this.d.share();
    const on = s.on && !this.d.seatsBlock?.(); // a seats host serves no stages, so it doesn't offer to
    return { share: on, cap: on ? s.maxBytes : null, runtime: hasRuntime(this.d.runtime()), busy: this.busy() };
  }

  async handle(raw: unknown, caller: string): Promise<StageRes> {
    const parsed = StageReq.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, "invalid", "bad stage request");
    const req = parsed.data;
    if (req.action === "stop") {
      const p = this.pending;
      if (p && p.run === req.run && p.head === caller) { await this.cancelPending("head_stopped"); return { ok: true }; }
      const c = this.cur;
      if (!c || c.run !== req.run || c.head !== caller) throw new HttpError(404, "no_run", "no such stage on this machine");
      await this.stop("head_stopped");
      return { ok: true };
    }
    if (req.action === "renew") {
      const c = this.cur;
      if (!c || c.run !== req.run || c.head !== caller) throw new HttpError(404, "no_run", "no such stage on this machine");
      if (!this.d.mayHead(caller)) { await this.stop("head_not_allowed"); throw new HttpError(403, "forbidden", "this machine may no longer head a run here"); }
      clearTimeout(c.lease);
      c.lease = this.leaseTimer();
      return { ok: true, lease_ms: this.leaseMs() };
    }
    return this.start(req.run, req.bytes, req.model, caller);
  }

  private leaseMs(): number { return this.d.leaseMs ?? LEASE_MS; }
  private leaseTimer(): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => void this.stop("lease_expired"), this.leaseMs());
    (t as { unref?: () => void }).unref?.();
    return t;
  }

  /** The most this stage may use here: the owner's cap, and never more than what is free now minus the reserve. */
  private async budget(share: ShareConfig): Promise<number> {
    const free = await this.d.freeMemory();
    if (free === null) {
      if (share.maxBytes === null) throw new HttpError(503, "memory_unknown", "this machine can't read its free memory; its owner can set a cap: walkie pool share on --max-gb N");
      return share.maxBytes;
    }
    const room = Math.max(0, free - STAGE_RESERVE_BYTES);
    return share.maxBytes === null ? room : Math.min(share.maxBytes, room);
  }

  /** Consent and authority, as they are NOW (asked again before a stage goes live and on every watchdog tick). */
  private consentGone(head: string): string | null {
    if (!this.d.share().on) return "sharing_off";
    if (this.d.seatsBlock?.()) return "seats_on";
    if (!this.d.mayHead(head)) return "head_not_allowed";
    return null;
  }

  private async start(run: string, bytes: number, model: string, caller: string): Promise<StageRes> {
    const share = this.d.share();
    if (!share.on) throw new HttpError(403, "not_sharing", "this machine's owner hasn't turned sharing on (walkie pool share on)");
    const block = this.d.seatsBlock?.();
    if (block) throw new HttpError(409, SEATS_POOL_CODE, `this machine runs seats, so it serves no stages: ${block}`);
    if (this.cur?.run === run && this.cur.head === caller) return { ok: true, lease_ms: this.leaseMs() }; // idempotent
    if (this.busy()) throw new HttpError(409, "busy", "this machine is already running a stage of another split run");
    if (!this.d.mayHead(caller)) throw new HttpError(403, "forbidden", "this machine may not head a split run here");
    const rt = this.d.runtime();
    if (!hasRuntime(rt) || !rt.rpc) throw new HttpError(409, "no_runtime", `the llama.cpp runtime isn't installed on this machine (its owner runs: ${INSTALL_HINT})`);
    // POOL-4: only the pinned build (the guard speaks its wire format), and only with a guard that judges right.
    const wrongBuild = (this.d.verifyRuntime ?? verifyPinnedRpc)(rt);
    if (wrongBuild) throw new HttpError(409, "wrong_runtime", wrongBuild);
    const selfTest = guardSelfTest();
    if (selfTest) {
      this.d.log.error("pool_guard_selftest_failed", { reason: selfTest });
      throw new HttpError(500, "guard_selftest_failed", `this machine's RPC guard failed its self-test (${selfTest}); split runs are off here`);
    }
    if (share.maxBytes !== null && bytes > share.maxBytes) {
      throw new HttpError(413, "over_cap", `this stage needs ${(bytes / GiB).toFixed(1)} GB; the owner shares at most ${(share.maxBytes / GiB).toFixed(1)} GB`);
    }
    const p: Pending = { run, head: caller, cancelled: null, child: null };
    this.pending = p;
    this.d.changed();
    let home: string | null = null;
    try {
      const budget = await this.budget(share);
      if (bytes > budget) throw new HttpError(507, "insufficient_memory", `this stage needs ${(bytes / GiB).toFixed(1)} GB; this machine can give ${(budget / GiB).toFixed(1)} GB now`);
      if (p.cancelled) throw new HttpError(409, "cancelled", `the stage was cancelled while starting (${p.cancelled})`);
      const port = await freeLoopbackPort();
      mkdirSync(join(this.d.home, "pool"), { recursive: true, mode: 0o700 });
      home = mkdtempSync(join(this.d.home, "pool", "stage-"));
      p.child = await spawnChild([rt.rpc, "-H", "127.0.0.1", "-p", String(port), ...(this.d.rpcArgs ?? [])], minimalEnv(home, rt.dir), { registry: this.d.registry, role: "rpc-server" });
      const up = await waitForPort(port, START_WAIT_MS, p.child.exited, () => !!p.cancelled);
      const gone = p.cancelled ?? this.consentGone(caller);
      if (!up || gone) {
        await p.child.stop();
        if (gone) throw new HttpError(409, "cancelled", `the stage was cancelled while starting (${gone})`);
        throw new HttpError(500, "rpc_start_failed", `rpc-server did not start: ${p.child.tail().split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 300)}`);
      }
      const child = p.child;
      child.confirm(); // it listens: it is rpc-server now, not the shell that started it
      const cur: Current = {
        run, head: caller, model, bytes, budget, port, child, home, lease: this.leaseTimer(), watch: setInterval(() => this.watch(), WATCH_MS),
        tunnels: new Set(), reserved: 0, opens: [], bucket: new ByteBucket(budget + GiB, REFILL_BYTES_PER_S), startedAt: Date.now(), stopping: false, bytesIn: 0,
      };
      (cur.watch as { unref?: () => void }).unref?.();
      this.cur = cur;
      home = null; // owned by the stage now
      void child.exited.then((code) => { if (this.cur === cur && !cur.stopping) void this.stop(`rpc_server_exited (${code})`); });
      this.d.log.info("pool_stage_started", { run, head: caller, model, bytes, budget, pid: child.pid, port });
      return { ok: true, lease_ms: this.leaseMs() };
    } finally {
      if (home) rmSync(home, { recursive: true, force: true });
      if (this.pending === p) this.pending = null;
      this.d.changed();
    }
  }

  private async cancelPending(reason: string): Promise<void> {
    const p = this.pending;
    if (!p) return;
    p.cancelled = reason;
    await p.child?.stop();
    this.d.log.info("pool_stage_cancelled", { run: p.run, head: p.head, reason });
  }

  private watch(): void {
    const c = this.cur;
    if (!c) return;
    const gone = this.consentGone(c.head);
    if (gone) { void this.stop(gone); return; }
    const limit = c.budget * 1.1 + 512 * 1024 * 1024;
    const rss = residentBytes(c.child.pid);
    if (rss !== null && rss > limit) {
      this.d.log.warn("pool_stage_over_memory", { run: c.run, rss, limit: Math.round(limit) });
      void this.stop("over_memory_cap");
    }
  }

  /** The roster or the share setting changed: judged at once, not at the next watchdog tick. */
  recheck(): void {
    const p = this.pending;
    if (p) { const gone = this.consentGone(p.head); if (gone) void this.cancelPending(gone); }
    this.watch();
  }

  /**
   * A tunnel into the running stage: only the head that started it, only while it runs, within the tunnel caps. The
   * slot is taken now; accept() re-checks the stage and uses it, release() (or GRANT_TTL_MS) gives it back.
   * The caller already passed the peer gate (an admitted machine of a current member).
   */
  tunnel(run: string, caller: string): TunnelGrant {
    const c = this.cur;
    if (!c || c.run !== run || c.stopping) throw new HttpError(404, "no_run", "no such stage on this machine");
    if (c.head !== caller) throw new HttpError(403, "forbidden", "only the machine that started this run may connect to it");
    if (this.consentGone(caller)) throw new HttpError(403, "not_sharing", "sharing is off on this machine, or the head may no longer run here");
    if (c.tunnels.size + c.reserved >= MAX_TUNNELS) throw new HttpError(429, "too_many_tunnels", "too many connections to this stage");
    const now = Date.now();
    c.opens = c.opens.filter((t) => now - t < 60_000);
    if (c.opens.length >= MAX_OPENS_PER_MIN) throw new HttpError(429, "rate_limited", "too many new connections to this stage");
    c.opens.push(now);
    c.reserved++;
    let held = true;
    const release = (): void => { if (held) { held = false; c.reserved--; } };
    const ttl = setTimeout(release, GRANT_TTL_MS);
    (ttl as { unref?: () => void }).unref?.();
    const id = randomUUID().slice(0, 8);
    return {
      release: () => { clearTimeout(ttl); release(); },
      accept: async (remote) => {
        clearTimeout(ttl);
        const ok = held && this.cur === c && !c.stopping && !this.consentGone(caller);
        release();
        if (!ok) { remote.close(); return; }
        const sock = connect({ host: "127.0.0.1", port: c.port });
        const local = tcpEnd(sock);
        c.tunnels.add(remote);
        this.d.log.info("pool_tunnel_open", { run, tunnel: id, head: caller });
        const guard = new RpcGuard({ maxMessage: c.budget + GiB });
        const r = await splice(remote, local, (n) => { c.bytesIn += n; return c.bucket.take(n); }, (b) => guard.feed(b));
        c.tunnels.delete(remote);
        this.d.log.info("pool_tunnel_closed", { run, tunnel: id, in_bytes: r.up, out_bytes: r.down, ...(r.error ? { err: r.error } : {}) });
      },
    };
  }

  async stop(reason: string): Promise<void> {
    if (this.pending && !this.cur) { await this.cancelPending(reason); return; }
    const c = this.cur;
    if (!c || c.stopping) return;
    c.stopping = true;
    clearTimeout(c.lease);
    clearInterval(c.watch);
    for (const t of c.tunnels) t.close();
    await c.child.stop();
    rmSync(c.home, { recursive: true, force: true });
    if (this.cur === c) this.cur = null;
    this.d.log.info("pool_stage_stopped", { run: c.run, head: c.head, reason, pid: c.child.pid });
    this.d.changed();
  }
}
