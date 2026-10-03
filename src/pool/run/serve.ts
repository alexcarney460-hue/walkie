// Serve on the best machine (POOL-REAL-1): a catalog model that fits one machine's GPU runs there whole, at that
// GPU's full speed, and every member machine can use it through Walkie. This is the serving side: one model at a
// time per machine.
//
//   start (this machine's person, or a member machine when the owner shares it) -> download the pinned GGUF
//   (sha256-checked, gguf.ts) -> llama-server with every layer on this machine's GPU, 127.0.0.1 only, its own API key
//   -> the allow-list proxy (serve-proxy.ts, 127.0.0.1) -> serving.
//
// Members connect (`POST /peer/v1/pool/serve` connect): each connecting machine gets its own bearer key, a lease it
// renews (CONN_LEASE_MS without a renew drops it) and tunnels (`/peer/v1/pool/serve-tunnel/<id>`, the split-run
// tunnel transport: a Walkie Direct stream or a Tailscale WebSocket) spliced into the proxy, within
// MAX_TUNNELS_PER_CLIENT at once and OPENS_PER_MIN new ones a minute. Consent is re-checked every WATCH_MS and on
// every roster change: sharing turned off drops every other machine's connection and stops a model another machine
// started; seats on stop everything; a machine that may no longer head runs here loses its connection. No request for
// IDLE_MS stops the model (its GPU memory comes back). Stop kills llama-server by its PID (child.ts supervisor).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { join } from "node:path";
import { HttpError } from "../../daemon/http.ts";
import type { Logger } from "../../daemon/logger.ts";
import type { MachineStats } from "../../protocol/machine-stats.ts";
import { ServeReq, type PoolServing, type ServeRes, type ServeView } from "../../protocol/pool.ts";
import { SEATS_POOL_CODE } from "../../protocol/seats.ts";
import { machineCapacity, serveBudget } from "../capacity.ts";
import { CATALOG, type Quant } from "../catalog.ts";
import { freeLoopbackPort, minimalEnv, spawnChild, type Child, type ChildRegistry } from "./child.ts";
import { ensureFiles, filesFor } from "./gguf.ts";
import { catalogNeed } from "./plan.ts";
import { hasRuntime, INSTALL_HINT, type Runtime } from "./runtime.ts";
import { ServeProxy } from "./serve-proxy.ts";
import type { PoolJobs, Reservation } from "./jobs.ts";
import { PressureWatch, startBlocked, type MemNow } from "./pressure.ts";
import type { ShareConfig, TunnelGrant } from "./stage.ts";
import { splice, tcpEnd, type End } from "./tunnel.ts";

const GiB = 1024 ** 3;
/** A connection whose machine didn't renew it for this long is dropped (its key stops working). */
export const CONN_LEASE_MS = 45_000;
/** No request for this long stops the model. */
export const IDLE_MS = 30 * 60_000;
export const MAX_CLIENTS = 16;
export const MAX_TUNNELS_PER_CLIENT = 8;
export const OPENS_PER_MIN = 60;
const WATCH_MS = 3_000;
const METRICS_MS = 5_000;
const GRANT_TTL_MS = 15_000;
const LOAD_TIMEOUT_MS = 30 * 60_000;

export interface ServeDeps {
  home: string;
  log: Logger;
  runtime: () => Runtime;
  share: () => ShareConfig;
  /** Why seats keep the pool off here (service.ts): nothing is served meanwhile. */
  seatsBlock?: () => string | null;
  /** An admitted machine of a current member who isn't an observer. */
  mayUse: (nodeId: string) => boolean;
  hostnameOf: (nodeId: string) => string;
  /** This machine's machine stats with its GPU memory free read now (not the last sample: a GPU just freed counts). */
  stats: () => Promise<MachineStats | null>;
  /** The machine's single pool-job reservation (jobs.ts): taken before the first await, held through teardown. */
  jobs: PoolJobs;
  /** This machine's memory now (pressure.ts policy). Default: never under pressure. */
  mem?: () => MemNow;
  changed: () => void;
  registry?: ChildRegistry;
  /** Tests: extra llama-server arguments, the Hugging Face base URL, a budget override, the idle timeout. */
  serverArgs?: readonly string[];
  hfBase?: string;
  budget?: () => number | null;
  idleMs?: number;
  leaseMs?: number;
}

interface Client {
  node: string; key: string; since: number; requests: number;
  lease: ReturnType<typeof setTimeout>;
  tunnels: Set<End>; reserved: number; opens: number[];
}

interface Serving {
  view: ServeView;
  key: string; localKey: string; port: number;
  server: Child | null; proxy: ServeProxy | null;
  clients: Map<string, Client>;
  abort: AbortController; timers: ReturnType<typeof setInterval>[]; stopping: boolean;
  job: Reservation; pressure: PressureWatch;
  /** The teardown in progress (every stop awaits the same one). */
  down: Promise<void> | null;
}

const LIVE = new Set(["downloading", "loading", "serving"]);

export class PoolServer {
  private cur: Serving | null = null;
  constructor(private readonly d: ServeDeps) {}

  private get dir(): string { return join(this.d.home, "pool"); }
  private get keyFile(): string { return join(this.dir, "serve.key"); }
  /** llama-server's own key file, one per run (a later run never shares or loses it to an earlier teardown). */
  private upstreamKeyFile(id: string): string { return join(this.dir, `serve-upstream-${id}.key`); }
  private leaseMs(): number { return this.d.leaseMs ?? CONN_LEASE_MS; }

  /** A model is being served, loaded or stopped here (it still holds GPU memory until its teardown ends). */
  active(): boolean { return !!this.cur && (LIVE.has(this.cur.view.state) || this.cur.view.state === "stopping"); }

  view(): ServeView | null {
    const c = this.cur;
    if (!c) return null;
    return {
      ...c.view,
      clients: [...c.clients.values()].map((x) => ({ node_id: x.node, hostname: this.d.hostnameOf(x.node), since: x.since, requests: x.requests, tunnels: x.tunnels.size })),
      idle_stop_at: c.view.state === "serving" ? (c.view.last_request_at ?? c.view.serving_at ?? Date.now()) + this.idleMs() : null,
    };
  }

  /** What the team sees (PoolShare.serving). */
  published(): PoolServing | null {
    const c = this.cur;
    if (!c || c.stopping || !LIVE.has(c.view.state)) return null;
    const st = c.view.state as PoolServing["state"];
    return {
      id: c.view.id, model: c.view.model.name, model_id: c.view.model.id, quant: c.view.model.quant, state: st,
      open: this.d.share().on && !this.d.seatsBlock?.(), tokens_per_s: c.view.tokens_per_s,
    };
  }

  private idleMs(): number { return this.d.idleMs ?? IDLE_MS; }

  /**
   * GPU (or Apple unified) memory a model may use here now: the accelerator backend's free figure (capacity.ts: free
   * VRAM less 1 GiB per GPU, or unified memory within the GPU's share), capped by the owner's share cap for another
   * machine's start. null = this machine has no GPU llama.cpp can put every layer on.
   */
  private async gpuBudget(forOther: boolean): Promise<number | null> {
    if (this.d.budget) return this.d.budget();
    const cap = machineCapacity({ node_id: "self", hostname: "self", handle: "self", stats: (await this.d.stats()) ?? undefined });
    const budget = cap ? serveBudget(cap) : null;
    if (budget === null) return null;
    const share = this.d.share();
    return forOther && share.maxBytes !== null ? Math.min(budget, share.maxBytes) : budget;
  }

  /** Starts a catalog model here. `by` = the member machine that asked; null = this machine's person. */
  async start(modelId: string, quant: Quant, by: string | null): Promise<ServeView> {
    const block = this.d.seatsBlock?.() ?? null;
    if (block) throw new HttpError(409, SEATS_POOL_CODE, by ? `this machine runs seats, so it serves no models: ${block}` : block);
    if (by !== null) {
      if (!this.d.share().on) throw new HttpError(403, "not_sharing", "this machine's owner hasn't turned sharing on (walkie pool share on)");
      if (!this.d.mayUse(by)) throw new HttpError(403, "forbidden", "this machine may not start models here");
    }
    const m = CATALOG.models.find((x) => x.id === modelId);
    if (!m) throw new HttpError(400, "unknown_model", `no model "${modelId}" in the catalog (walkie pool lists them)`);
    const files = filesFor(m.id, quant);
    if (!files) throw new HttpError(400, "no_such_format", `${m.name} has no ${quant === "q8" ? "8-bit" : "4-bit"} GGUF in Walkie's list`);
    const c = this.cur;
    if (c && LIVE.has(c.view.state) && !c.stopping) {
      if (c.view.model.id === m.id && c.view.model.quant === quant) return this.view()!; // already serving it: join it
      throw new HttpError(409, "serve_active", `this machine already serves ${c.view.model.name}; stop it first (walkie pool stop)`);
    }
    const need = catalogNeed(m, quant);
    const id = randomBytes(16).toString("hex");
    // The machine's one pool job, taken before the first await (a stage, a split head, an install or a model still
    // stopping holds it: 409 busy). Released only when this run's teardown has finished.
    const job = this.d.jobs.reserve("serve", id);
    let budget: number | null;
    let rt: Runtime;
    try {
      rt = this.d.runtime();
      if (!hasRuntime(rt)) throw new HttpError(409, "no_runtime", `the llama.cpp runtime isn't installed on this machine (${INSTALL_HINT})`);
      const pressed = startBlocked(this.d.mem?.());
      if (pressed) throw new HttpError(503, "memory_pressure", pressed);
      budget = await this.gpuBudget(by !== null);
      if (budget === null) throw new HttpError(409, "no_gpu", "the pinned runtime has no usable GPU with measured free memory on this machine; serving puts every layer on a GPU (split it instead: walkie pool run)");
      if (need > budget) {
        throw new HttpError(507, "insufficient_memory", `${m.name} (${quant === "q8" ? "8-bit" : "4-bit"}) needs ${(need / GiB).toFixed(1)} GB of GPU memory; this machine has ${(budget / GiB).toFixed(1)} GB free${by !== null && this.d.share().maxBytes !== null ? " within its owner's cap" : ""} (split it instead: walkie pool run)`);
      }
    } catch (err) {
      job.release();
      throw err;
    }
    const now = Date.now();
    const view: ServeView = {
      id, state: "downloading", error: null, model: { id: m.id, name: m.name, quant }, download: { done: 0, total: files.bytes },
      need, gpu_free: budget, started_by: by ? { node_id: by, hostname: this.d.hostnameOf(by) } : null,
      endpoint: null, api_key_file: null, example: null, clients: [], requests: 0, tokens_per_s: null,
      started_at: now, serving_at: null, last_request_at: null, idle_stop_at: null, server_pid: null,
    };
    const run: Serving = {
      view, key: randomBytes(24).toString("hex"), localKey: this.localKey(), port: 0, server: null, proxy: null,
      clients: new Map(), abort: new AbortController(), timers: [], stopping: false,
      job, pressure: new PressureWatch(() => this.d.mem?.()), down: null,
    };
    this.cur = run;
    const watch = setInterval(() => this.watch(run), WATCH_MS);
    (watch as { unref?: () => void }).unref?.();
    run.timers.push(watch);
    this.d.log.info("pool_serve_started", { id, model: m.id, quant, by: by ?? "self", need, budget });
    void this.proceed(run, rt).catch((err: unknown) => this.fail(run, (err as Error).message));
    this.d.changed();
    return this.view()!;
  }

  /** The key this machine's own person uses (a file, 0600), kept across runs. */
  private localKey(): string {
    const f = this.keyFile;
    if (existsSync(f)) {
      const k = readFileSync(f, "utf8").trim();
      if (/^[0-9a-f]{48}$/.test(k)) return k;
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const k = randomBytes(24).toString("hex");
    writeFileSync(f, `${k}\n`, { mode: 0o600 });
    return k;
  }

  private live(run: Serving): boolean { return this.cur === run && !run.stopping; }

  private set(run: Serving, patch: Partial<ServeView>): void {
    run.view = { ...run.view, ...patch };
    this.d.changed();
  }

  private async proceed(run: Serving, rt: Runtime): Promise<void> {
    const mf = filesFor(run.view.model.id!, run.view.model.quant!)!;
    const path = await ensureFiles(this.d.home, mf, run.abort.signal, (p) => {
      if (this.live(run)) run.view = { ...run.view, download: { done: p.done, total: p.total } };
    }, this.d.hfBase);
    if (!this.live(run)) return;
    this.set(run, { state: "loading", download: { done: mf.bytes, total: mf.bytes } });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.upstreamKeyFile(run.view.id), `${run.key}\n`, { mode: 0o600 });
    run.port = await freeLoopbackPort();
    const cmd = [
      rt.server!, "-m", path, "--host", "127.0.0.1", "--port", String(run.port), "--api-key-file", this.upstreamKeyFile(run.view.id),
      "--metrics", "--no-webui", "--no-slots", "-c", String(CATALOG.context_tokens), "-np", "1", "-ngl", "all",
      "--alias", run.view.model.name, ...(this.d.serverArgs ?? []),
    ];
    const server = await spawnChild(cmd, minimalEnv(this.dir, rt.dir), { registry: this.d.registry, role: "llama-server" });
    if (!this.live(run)) { await server.stop(); return; }
    run.server = server;
    this.set(run, { server_pid: server.pid });
    void server.exited.then((code) => {
      if (!this.live(run)) return;
      const lines = server.tail().split("\n").map((l) => l.trim()).filter(Boolean);
      const why = [...lines].reverse().find((l) => /error|fail|out of memory|unable|abort/i.test(l)) ?? lines[lines.length - 1] ?? "";
      this.fail(run, `llama-server exited (${code ?? "signal"}): ${why.slice(0, 240)}`);
    });
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    for (;;) {
      if (!this.live(run) || !server.alive()) return;
      if (Date.now() > deadline) throw new Error("the model didn't finish loading within 30 minutes");
      try {
        const r = await fetch(`http://127.0.0.1:${run.port}/health`, { signal: AbortSignal.timeout(2_000) });
        if (r.ok) break;
      } catch { /* loading */ }
      await Bun.sleep(300);
    }
    server.confirm();
    const proxy = new ServeProxy({
      upstream: () => (this.live(run) && run.view.state === "serving" ? { port: run.port, key: run.key } : null),
      authorize: (k) => this.authorize(run, k),
      onRequest: (label) => this.request(run, label),
    });
    const port = proxy.start();
    if (!this.live(run)) { proxy.stop(); return; }
    run.proxy = proxy;
    const endpoint = `http://127.0.0.1:${port}/v1`;
    const now = Date.now();
    this.set(run, {
      state: "serving", serving_at: now, endpoint, api_key_file: this.keyFile,
      example: `curl ${endpoint}/chat/completions -H "Authorization: Bearer $(cat ${this.keyFile})" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"Hello"}]}'`,
    });
    this.d.log.info("pool_serve_serving", { id: run.view.id, port, upstream: run.port, pid: server.pid });
    const t = setInterval(() => void this.metrics(run), METRICS_MS);
    (t as { unref?: () => void }).unref?.();
    run.timers.push(t);
  }

  private authorize(run: Serving, key: string): string | null {
    if (key === run.localKey) return "self";
    for (const c of run.clients.values()) if (c.key === key) return c.node;
    return null;
  }

  private request(run: Serving, label: string): void {
    const now = Date.now();
    run.view = { ...run.view, requests: run.view.requests + 1, last_request_at: now };
    const c = run.clients.get(label);
    if (c) c.requests++;
  }

  private async metrics(run: Serving): Promise<void> {
    if (!this.live(run) || run.view.state !== "serving") return;
    try {
      const res = await fetch(`http://127.0.0.1:${run.port}/metrics`, { headers: { Authorization: `Bearer ${run.key}` }, signal: AbortSignal.timeout(2_000) });
      if (!res.ok) return;
      const m = /^llamacpp:predicted_tokens_seconds\s+([0-9.eE+-]+)/m.exec(await res.text());
      const tps = m ? Number(m[1]) : NaN;
      if (Number.isFinite(tps) && tps > 0 && this.live(run)) {
        const r = Math.round(tps * 10) / 10;
        if (r !== run.view.tokens_per_s) this.set(run, { tokens_per_s: r });
      }
    } catch { /* next time */ }
  }

  /** Consent, authority and the idle timeout, as they are now. */
  private watch(run: Serving): void {
    if (!this.live(run)) return;
    const seats = this.d.seatsBlock?.();
    if (seats) { this.fail(run, `seats came on here: ${seats}`); return; }
    const pressed = run.pressure.check();
    if (pressed) { this.fail(run, `stopped: ${pressed.replaceAll("_", " ")} on this machine`); return; }
    const sharing = this.d.share().on;
    if (!sharing && run.view.started_by) { void this.teardown(run, "stopped", "its owner turned sharing off"); return; }
    // A model a member asked for is not brought up once that member may no longer use this machine (WALK-74: removed,
    // made an observer, their machine revoked) while it was still downloading or loading. One already serving keeps
    // serving for the teammates still allowed; every connection is judged below.
    const by = run.view.started_by;
    if (by && run.view.state !== "serving" && !this.d.mayUse(by.node_id)) {
      void this.teardown(run, "stopped", `not started: ${by.hostname} may no longer use this machine (its person was removed or made an observer, or the machine was revoked)`);
      return;
    }
    for (const c of [...run.clients.values()]) {
      if (!sharing) this.drop(run, c, "sharing_off");
      else if (!this.d.mayUse(c.node)) this.drop(run, c, "not_allowed");
    }
    const last = run.view.last_request_at ?? run.view.serving_at;
    if (run.view.state === "serving" && last !== null && Date.now() - last >= this.idleMs()) {
      this.d.log.info("pool_serve_idle", { id: run.view.id });
      void this.teardown(run, "stopped", `stopped after ${Math.round(this.idleMs() / 60_000)} minutes without a request`);
    }
  }

  /** The roster or the share setting changed: judged now. */
  recheck(): void { if (this.cur) this.watch(this.cur); }

  private drop(run: Serving, c: Client, why: string): void {
    if (run.clients.get(c.node) !== c) return;
    run.clients.delete(c.node);
    clearTimeout(c.lease);
    for (const e of c.tunnels) e.close();
    this.d.log.info("pool_serve_client_dropped", { id: run.view.id, node: c.node, why });
    this.d.changed();
  }

  private leaseTimer(run: Serving, node: string): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => { const c = run.clients.get(node); if (c) this.drop(run, c, "lease_expired"); }, this.leaseMs());
    (t as { unref?: () => void }).unref?.();
    return t;
  }

  /** `POST /peer/v1/pool/serve` from an admitted machine of a current member (the peer gate ran). */
  async handle(raw: unknown, caller: string): Promise<ServeRes> {
    const parsed = ServeReq.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, "invalid", "bad serve request");
    const req = parsed.data;
    if (req.action === "start") {
      const v = await this.start(req.model, req.quant, caller);
      return { ok: true, id: v.id, state: v.state as ServeRes["state"], model: v.model };
    }
    const run = this.cur;
    const live = run && this.live(run) && LIVE.has(run.view.state) ? run : null;
    if (req.action === "connect") {
      if (!live || (req.id && req.id !== live.view.id)) throw new HttpError(404, "not_serving", "this machine serves no such model now");
      if (!this.d.share().on) throw new HttpError(403, "not_sharing", "this machine's owner hasn't turned sharing on (walkie pool share on)");
      const seats = this.d.seatsBlock?.();
      if (seats) throw new HttpError(409, SEATS_POOL_CODE, `this machine runs seats, so it serves no models: ${seats}`);
      if (!this.d.mayUse(caller)) throw new HttpError(403, "forbidden", "this machine may not use models served here");
      let c = live.clients.get(caller);
      if (c) {
        clearTimeout(c.lease);
        c.lease = this.leaseTimer(live, caller);
      } else {
        if (live.clients.size >= MAX_CLIENTS) throw new HttpError(429, "too_many_clients", `at most ${MAX_CLIENTS} machines may connect at once`);
        c = { node: caller, key: randomBytes(24).toString("hex"), since: Date.now(), requests: 0, lease: this.leaseTimer(live, caller), tunnels: new Set(), reserved: 0, opens: [] };
        live.clients.set(caller, c);
        this.d.log.info("pool_serve_client", { id: live.view.id, node: caller });
        this.d.changed();
      }
      return { ok: true, id: live.view.id, state: live.view.state as ServeRes["state"], model: live.view.model, key: c.key, lease_ms: this.leaseMs() };
    }
    if (!live || req.id !== live.view.id) throw new HttpError(404, "not_serving", "this machine serves no such model now");
    if (req.action === "renew") {
      const c = live.clients.get(caller);
      if (!c) throw new HttpError(404, "not_connected", "this machine is not connected to that model");
      if (!this.d.share().on || !this.d.mayUse(caller)) { this.drop(live, c, "not_allowed"); throw new HttpError(403, "forbidden", "no longer allowed to use this machine's model"); }
      clearTimeout(c.lease);
      c.lease = this.leaseTimer(live, caller);
      return { ok: true, id: live.view.id, state: live.view.state as ServeRes["state"], lease_ms: this.leaseMs() };
    }
    if (req.action === "disconnect") {
      const c = live.clients.get(caller);
      if (c) this.drop(live, c, "disconnected");
      return { ok: true };
    }
    // stop: only the machine that started it (this machine's person stops it locally).
    if (live.view.started_by?.node_id !== caller) throw new HttpError(403, "forbidden", "only the machine that started this model, or this machine's person, may stop it");
    await this.teardown(live, "stopped", null);
    return { ok: true };
  }

  /** A tunnel into the proxy for a connected machine, within its caps (the peer gate ran). */
  tunnel(id: string, caller: string): TunnelGrant {
    const run = this.cur;
    if (!run || !this.live(run) || run.view.id !== id) throw new HttpError(404, "not_serving", "this machine serves no such model now");
    if (run.view.state !== "serving" || !run.proxy) throw new HttpError(503, "not_ready", `the model is ${run.view.state}`);
    const c = run.clients.get(caller);
    if (!c) throw new HttpError(403, "not_connected", "connect first (walkie pool connect)");
    if (!this.d.share().on || !this.d.mayUse(caller)) throw new HttpError(403, "not_sharing", "sharing is off on this machine, or this machine may no longer use it");
    if (c.tunnels.size + c.reserved >= MAX_TUNNELS_PER_CLIENT) throw new HttpError(429, "too_many_tunnels", "too many connections to this model from one machine");
    const now = Date.now();
    c.opens = c.opens.filter((t) => now - t < 60_000);
    if (c.opens.length >= OPENS_PER_MIN) throw new HttpError(429, "rate_limited", "too many new connections to this model");
    c.opens.push(now);
    c.reserved++;
    let held = true;
    const release = (): void => { if (held) { held = false; c.reserved--; } };
    const ttl = setTimeout(release, GRANT_TTL_MS);
    (ttl as { unref?: () => void }).unref?.();
    return {
      release: () => { clearTimeout(ttl); release(); },
      accept: async (remote) => {
        clearTimeout(ttl);
        const ok = held && this.live(run) && run.clients.get(caller) === c && !!run.proxy;
        release();
        if (!ok) { remote.close(); return; }
        const local = tcpEnd(tcpConnect({ host: "127.0.0.1", port: run.proxy!.port }));
        c.tunnels.add(remote);
        const r = await splice(remote, local);
        c.tunnels.delete(remote);
        this.d.log.debug("pool_serve_tunnel_closed", { id, node: caller, in_bytes: r.up, out_bytes: r.down, ...(r.error ? { err: r.error } : {}) });
      },
    };
  }

  private fail(run: Serving, message: string): void {
    if (this.cur !== run || run.stopping) return;
    this.d.log.warn("pool_serve_failed", { id: run.view.id, err: message.slice(0, 300) });
    void this.teardown(run, "failed", message);
  }

  /** This machine's person stops what it serves. */
  async stop(): Promise<ServeView | null> {
    const run = this.cur;
    // A stop while another is under way waits for that same teardown (the model is gone when this returns).
    if (run && (run.stopping || LIVE.has(run.view.state))) await this.teardown(run, "stopped", null);
    return this.view();
  }

  private teardown(run: Serving, end: "stopped" | "failed", error: string | null): Promise<void> {
    if (!run.down) run.down = this.doTeardown(run, end, error);
    return run.down;
  }

  private async doTeardown(run: Serving, end: "stopped" | "failed", error: string | null): Promise<void> {
    run.stopping = true;
    this.set(run, { state: "stopping", ...(error ? { error } : {}) });
    run.abort.abort();
    for (const t of run.timers) clearInterval(t);
    run.proxy?.stop();
    for (const c of [...run.clients.values()]) { clearTimeout(c.lease); for (const e of c.tunnels) e.close(); }
    run.clients.clear();
    try {
      await run.server?.stop();
    } finally {
      rmSync(this.upstreamKeyFile(run.view.id), { force: true });
      run.view = { ...run.view, state: end, endpoint: null, example: null, server_pid: null, ...(error ? { error } : {}) };
      run.job.release(); // llama-server is gone: its GPU memory is back
      this.d.log.info("pool_serve_stopped", { id: run.view.id, state: end, ...(error ? { why: error.slice(0, 200) } : {}) });
      this.d.changed();
    }
  }
}
