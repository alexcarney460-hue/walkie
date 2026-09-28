// The head of a split run (WALKIE-POOL-2): the machine whose person started it. One run at a time.
//
//   plan -> download the GGUF (catalog: pinned revision + sha256) -> ask each worker for a stage -> one 127.0.0.1
//   listener per worker, each connection tunnelled to that worker over Walkie's peer transport -> llama-server
//   --rpc <listeners> bound to 127.0.0.1 with an API key file -> serving (OpenAI-compatible, localhost only).
//
// While it serves: leases renewed every RENEW_MS (two failures in a row = that machine is lost), tokens/s read from
// llama-server's /metrics, new connections to the listeners refused. A stage that dies (its tunnel closes, its renew
// fails, llama-server exits) stops the whole run and says which machine. Stop kills llama-server by its PID, closes
// every tunnel and asks every worker to stop its stage.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Logger } from "../../daemon/logger.ts";
import type { NodeView } from "../../protocol/schemas.ts";
import type { RunStageView, RunView, StageReq, StageRes } from "../../protocol/pool.ts";
import { SEATS_POOL_CODE } from "../../protocol/seats.ts";
import { CATALOG, type Quant } from "../catalog.ts";
import { freeLoopbackPort, minimalEnv, spawnChild, type Child, type ChildRegistry } from "./child.ts";
import { localDevice, parseDevices, rpcDevices, tensorSplit } from "./devices.ts";
import { ensureFiles, filesFor } from "./gguf.ts";
import { catalogNeed, fileNeed, planRun, PlanError, type PlannedStage } from "./plan.ts";
import { hasRuntime, INSTALL_HINT, type Runtime } from "./runtime.ts";
import { splice, tcpEnd, type End } from "./tunnel.ts";

export const RENEW_MS = 10_000;
/** How often a run re-asks the seats gate (like the stage watchdog): seats coming on stop it (Opus r11). */
export const SEATS_WATCH_MS = 3_000;
const METRICS_MS = 5_000;
const LOAD_TIMEOUT_MS = 60 * 60_000;
const MAX_LOCAL_CONNS = 4;

export type { RunState, RunView } from "../../protocol/pool.ts";
export type StageView = RunStageView;

export interface RunRequest { model?: string; quant?: Quant; file?: string; machines?: string[] }

export class RunError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface RunnerDeps {
  /** Why seats keep the pool off here (service.ts seatsBlock): no run is headed from this machine meanwhile. */
  seatsBlock?: () => string | null;
  /** Tests: how often a run re-asks seatsBlock (default SEATS_WATCH_MS). */
  seatsWatchMs?: number;
  home: string;
  log: Logger;
  runtime: () => Runtime;
  stage: (nodeId: string, body: StageReq) => Promise<StageRes>;
  /** Opens one tunnel connection to a worker's stage (Walkie Direct stream or Tailscale WebSocket). */
  tunnel: (nodeId: string, run: string) => Promise<End>;
  changed: () => void;
  registry?: ChildRegistry;
  /** Tests: extra llama-server arguments, the Hugging Face base URL. */
  serverArgs?: readonly string[];
  hfBase?: string;
}

interface Remote {
  plan: PlannedStage; state: StageView["state"]; listener: NetServer | null; port: number;
  conns: Set<Socket>; ends: Set<End>; renewFails: number;
}

interface Active {
  view: RunView; remotes: Remote[]; server: Child | null; abort: AbortController;
  timers: ReturnType<typeof setInterval>[]; locked: boolean; stopping: boolean;
}


export class PoolRunner {
  private cur: Active | null = null;
  constructor(private readonly d: RunnerDeps) {}

  view(): RunView | null { return this.cur ? { ...this.cur.view, stages: this.cur.view.stages.map((s) => ({ ...s })) } : null; }

  private get keyFile(): string { return join(this.d.home, "pool", "api-key"); }

  /** llama-server's environment: minimal (never the daemon's), HOME = <walkie home>/pool. */
  private env(rt: Runtime): Record<string, string> {
    const home = join(this.d.home, "pool");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return minimalEnv(home, rt.dir);
  }

  private apiKey(): string {
    const f = this.keyFile;
    if (existsSync(f)) return readFileSync(f, "utf8").trim();
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    const k = randomBytes(24).toString("hex");
    writeFileSync(f, `${k}\n`, { mode: 0o600 });
    return k;
  }

  /** Validates and plans synchronously (errors reach the caller); the run itself proceeds in the background. */
  start(req: RunRequest, nodes: readonly NodeView[]): RunView {
    const block = this.d.seatsBlock?.() ?? null;
    if (block) throw new RunError(409, SEATS_POOL_CODE, block);
    if (this.cur && !["stopped", "failed"].includes(this.cur.view.state)) throw new RunError(409, "run_active", "a split run is already running here; stop it first (walkie pool stop)");
    const rt = this.d.runtime();
    if (!hasRuntime(rt)) throw new RunError(409, "no_runtime", `the llama.cpp runtime isn't installed on this machine: ${INSTALL_HINT}`);
    let model: RunView["model"];
    let need: number;
    let file: string | null = null;
    if (req.file) {
      if (!/\.gguf$/i.test(req.file) || !existsSync(req.file)) throw new RunError(400, "invalid", "file must be an existing .gguf file on this machine");
      file = req.file;
      need = fileNeed(statSync(file).size);
      model = { id: null, name: file.split("/").pop()!.replace(/\.gguf$/i, ""), quant: null };
    } else {
      const m = CATALOG.models.find((x) => x.id === req.model);
      if (!m) throw new RunError(400, "unknown_model", `no model "${req.model ?? ""}" in the catalog (walkie pool lists them)`);
      const quant = req.quant ?? "q4";
      if (!filesFor(m.id, quant)) throw new RunError(400, "no_such_format", `${m.name} has no ${quant === "q8" ? "8-bit" : "4-bit"} GGUF in Walkie's list`);
      try { need = catalogNeed(m, quant); } catch (err) { throw new RunError(400, (err as PlanError).code, (err as Error).message); }
      model = { id: m.id, name: m.name, quant };
    }
    let stages: PlannedStage[];
    try {
      stages = planRun(nodes, need, req.machines).stages;
    } catch (err) {
      if (err instanceof PlanError) throw new RunError(409, err.code, err.message);
      throw err;
    }
    const id = randomBytes(16).toString("hex");
    const view: RunView = {
      id, state: file ? "starting" : "downloading", error: null, model, download: null,
      stages: stages.map((s) => ({ ...s, state: s.self ? "ready" : "starting" })),
      endpoint: null, api_key_file: null, example: null, tokens_per_s: null, started_at: Date.now(), serving_at: null, server_pid: null,
    };
    const remotes: Remote[] = stages.filter((s) => !s.self).map((plan) => ({ plan, state: "starting", listener: null, port: 0, conns: new Set(), ends: new Set(), renewFails: 0 }));
    const run: Active = { view, remotes, server: null, abort: new AbortController(), timers: [], locked: false, stopping: false };
    this.cur = run;
    // Seats coming on (or found on disk after a restart) stop the run, whatever phase it is in (Opus seats r11 MEDIUM).
    if (this.d.seatsBlock) {
      const t = setInterval(() => {
        const why = this.d.seatsBlock?.();
        if (why && this.live(run)) this.fail(run, why);
      }, this.d.seatsWatchMs ?? SEATS_WATCH_MS);
      (t as { unref?: () => void }).unref?.();
      run.timers.push(t);
    }
    this.d.log.info("pool_run_started", { run: id, model: model.id ?? "file", quant: model.quant, stages: stages.map((s) => s.hostname).join(",") });
    void this.proceed(run, rt, req, file).catch((err: unknown) => this.fail(run, (err as Error).message));
    this.d.changed();
    return this.view()!;
  }

  private set(run: Active, patch: Partial<RunView>): void {
    run.view = { ...run.view, ...patch };
    this.d.changed();
  }

  private stageState(run: Active, nodeId: string, state: StageView["state"]): void {
    run.view = { ...run.view, stages: run.view.stages.map((s) => (s.node_id === nodeId ? { ...s, state } : s)) };
    this.d.changed();
  }

  private live(run: Active): boolean { return this.cur === run && !run.stopping; }

  private async proceed(run: Active, rt: Runtime, req: RunRequest, file: string | null): Promise<void> {
    let path = file;
    if (!path) {
      const mf = filesFor(req.model!, run.view.model.quant!)!;
      this.set(run, { download: { done: 0, total: mf.bytes } });
      path = await ensureFiles(this.d.home, mf, run.abort.signal, (p) => {
        if (this.live(run)) run.view = { ...run.view, download: { done: p.done, total: p.total } };
      }, this.d.hfBase);
      if (!this.live(run)) return;
      this.set(run, { state: "starting", download: { done: mf.bytes, total: mf.bytes } });
    }
    // Stages first (each worker checks sharing, its cap and its runtime), then a listener per worker.
    await Promise.all(run.remotes.map(async (r) => {
      try {
        await this.d.stage(r.plan.node_id, { action: "start", run: run.view.id, bytes: r.plan.bytes, model: run.view.model.name.slice(0, 120) });
      } catch (err) {
        throw new Error(`${r.plan.hostname}: ${(err as Error).message}`);
      }
      r.state = "ready";
      this.stageState(run, r.plan.node_id, "ready");
    }));
    if (!this.live(run)) return;
    for (const r of run.remotes) {
      await this.listen(run, r);
      // Stopped meanwhile (Opus r11 LOW): teardown closed the listeners it saw; this one came after.
      if (!this.live(run)) { r.listener?.close(); return; }
    }
    run.timers.push(setInterval(() => void this.renew(run), RENEW_MS));
    const endpoints = run.remotes.map((r) => `127.0.0.1:${r.port}`);
    const args = await this.deviceArgs(run, rt, endpoints);
    const port = await freeLoopbackPort();
    const key = this.apiKey();
    const cmd = [
      rt.server!, "-m", path, "--host", "127.0.0.1", "--port", String(port), "--api-key-file", this.keyFile,
      "--metrics", "--no-webui", "-c", String(CATALOG.context_tokens), "--alias", run.view.model.name,
      ...(endpoints.length ? ["--rpc", endpoints.join(",")] : []), ...args, ...(this.d.serverArgs ?? []),
    ];
    if (!this.live(run)) return;
    this.set(run, { state: "loading" });
    const server = await spawnChild(cmd, this.env(rt), { registry: this.d.registry, role: "llama-server" });
    // Stopped while it was starting (Opus/Codex seats r10 MEDIUM): teardown saw no server, so it is stopped here.
    if (!this.live(run)) { await server.stop(); return; }
    run.server = server;
    this.set(run, { server_pid: server.pid });
    this.d.log.info("pool_run_server", { run: run.view.id, pid: server.pid, port });
    void server.exited.then((code) => { if (this.live(run)) this.fail(run, this.exitReason(run, code, server)); });
    await this.waitHealthy(run, port, server);
    if (!this.live(run)) return;
    server.confirm(); // it answers: it is llama-server now, not the shell that started it
    run.locked = true;
    const endpoint = `http://127.0.0.1:${port}/v1`;
    this.set(run, {
      state: "serving", serving_at: Date.now(), endpoint, api_key_file: this.keyFile,
      example: `curl ${endpoint}/chat/completions -H "Authorization: Bearer $(cat ${this.keyFile})" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"Hello"}]}'`,
    });
    this.d.log.info("pool_run_serving", { run: run.view.id, port });
    run.timers.push(setInterval(() => void this.metrics(run, port, key), METRICS_MS));
  }

  /** --device and --tensor-split: the head's accelerator (when it holds a part) and each worker's first device. */
  private async deviceArgs(run: Active, rt: Runtime, endpoints: string[]): Promise<string[]> {
    // Asynchronous: the listing connects through this daemon's own tunnels, which a blocking spawn would starve.
    // --rpc must come first: --list-devices prints and exits as soon as it is parsed.
    const lister = await spawnChild([rt.server!, ...(endpoints.length ? ["--rpc", endpoints.join(",")] : []), "--list-devices"], this.env(rt), { registry: this.d.registry, role: "llama-server" });
    const done = await Promise.race([lister.exited.then(() => true), Bun.sleep(120_000).then(() => false)]);
    if (!done) await lister.stop();
    const devs = parseDevices(lister.tail());
    const rpc = rpcDevices(devs, endpoints);
    const missing = run.remotes.filter((_, i) => rpc[i] === null).map((r) => r.plan.hostname);
    if (missing.length) {
      const why = lister.tail().split("\n").map((l) => l.trim()).filter((l) => /error|fail|RPC|refused|version/i.test(l)).slice(-2).join(" · ");
      throw new Error(`couldn't reach the stage on ${missing.join(", ")} through its tunnel${why ? ` (${why.slice(0, 300)})` : ""}`);
    }
    const head = run.view.stages.find((s) => s.self);
    const local = head && head.bytes > 0 ? localDevice(devs) : null;
    // The planned parts must be what runs: without a device here, the head's part would silently land on the workers
    // (-ngl all over the RPC devices) and push them past what they agreed to hold.
    if (head && head.bytes > 0 && !local) throw new Error("this machine has no GPU llama.cpp can use, so it can't hold its planned part; name machines that hold the whole model with --machines");
    const names = [...(local ? [local] : []), ...(rpc as string[])];
    const bytes = [...(local ? [head!.bytes] : []), ...run.remotes.map((r) => r.plan.bytes)];
    if (!names.length) return [];
    return ["--device", names.join(","), "-ngl", "all", ...(names.length > 1 ? ["--tensor-split", tensorSplit(bytes)] : [])];
  }

  private async waitHealthy(run: Active, port: number, server: Child): Promise<void> {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (this.live(run) && server.alive() && Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
        if (r.ok) return;
      } catch { /* not up yet */ }
      await Bun.sleep(300);
    }
    if (this.live(run) && server.alive()) throw new Error("the model didn't finish loading within an hour");
  }

  /** One listener per worker on 127.0.0.1; each connection llama-server makes is tunnelled to that worker. */
  private listen(run: Active, r: Remote): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = createServer((sock) => {
        if (!this.live(run) || run.locked || r.conns.size >= MAX_LOCAL_CONNS) { sock.destroy(); return; }
        r.conns.add(sock);
        // The End takes the socket's data at once (queued, with its own backpressure) while the tunnel opens:
        // pausing a fresh socket and resuming it later loses its first bytes under Bun.
        void this.bridge(run, r, sock, tcpEnd(sock)).finally(() => r.conns.delete(sock));
      });
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const a = srv.address();
        r.port = typeof a === "object" && a ? a.port : 0;
        r.listener = srv;
        resolve();
      });
    });
  }

  private async bridge(run: Active, r: Remote, sock: Socket, local: End): Promise<void> {
    let remote: End;
    try {
      remote = await this.d.tunnel(r.plan.node_id, run.view.id);
    } catch (err) {
      sock.destroy();
      this.d.log.warn("pool_tunnel_failed", { run: run.view.id, node: r.plan.node_id, err: (err as Error).message });
      return;
    }
    r.ends.add(remote);
    const res = await splice(local, remote);
    r.ends.delete(remote);
    // While serving, a tunnel that ends without a Stop means the stage is gone.
    if (this.live(run) && run.view.state === "serving") this.lost(run, r, res.error ?? "its connection closed");
  }

  private lost(run: Active, r: Remote, why: string): void {
    if (r.state === "lost") return;
    r.state = "lost";
    this.stageState(run, r.plan.node_id, "lost");
    this.fail(run, `lost the stage on ${r.plan.hostname} (${why}); the run was stopped`);
  }

  private async renew(run: Active): Promise<void> {
    for (const r of run.remotes) {
      if (!this.live(run) || r.state !== "ready") continue;
      try {
        await this.d.stage(r.plan.node_id, { action: "renew", run: run.view.id });
        r.renewFails = 0;
      } catch (err) {
        r.renewFails++;
        if (r.renewFails >= 2) this.lost(run, r, (err as Error).message);
      }
    }
  }

  private async metrics(run: Active, port: number, key: string): Promise<void> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(2_000) });
      if (!res.ok) return;
      const m = /^llamacpp:predicted_tokens_seconds\s+([0-9.eE+-]+)/m.exec(await res.text());
      const tps = m ? Number(m[1]) : NaN;
      if (Number.isFinite(tps) && tps > 0 && this.live(run)) this.set(run, { tokens_per_s: Math.round(tps * 10) / 10 });
    } catch { /* next time */ }
  }

  private exitReason(run: Active, code: number | null, server: Child): string {
    const gone = run.remotes.find((r) => r.state === "lost");
    if (gone) return `lost the stage on ${gone.plan.hostname}; the run was stopped`;
    const lines = server.tail().split("\n").map((l) => l.trim()).filter((l) => l && !/^WARNING: GGML_BACKTRACE/.test(l));
    const why = [...lines].reverse().find((l) => /RPC|error|failed|crash|abort|out of memory|unable/i.test(l)) ?? lines[lines.length - 1] ?? "";
    const rpc = /Remote RPC server crashed|RPC/i.test(why) ? " (a stage's rpc-server went away)" : "";
    return `llama-server exited (${code ?? "signal"})${rpc}: ${why.slice(0, 240)}`;
  }

  private fail(run: Active, message: string): void {
    if (this.cur !== run || run.stopping) return;
    this.d.log.warn("pool_run_failed", { run: run.view.id, err: message.slice(0, 300) });
    void this.teardown(run, "failed", message);
  }

  async stop(): Promise<RunView | null> {
    const run = this.cur;
    if (!run || run.stopping) return this.view();
    await this.teardown(run, "stopped", null);
    return this.view();
  }

  private async teardown(run: Active, end: "stopped" | "failed", error: string | null): Promise<void> {
    run.stopping = true;
    this.set(run, { state: "stopping", ...(error ? { error } : {}) });
    run.abort.abort();
    for (const t of run.timers) clearInterval(t);
    await run.server?.stop();
    for (const r of run.remotes) {
      r.listener?.close();
      for (const s of r.conns) s.destroy();
      for (const e of r.ends) e.close();
    }
    // Every worker, even one whose start answer never came: a stop for a stage it doesn't have is a harmless 404.
    await Promise.allSettled(run.remotes.map((r) => this.d.stage(r.plan.node_id, { action: "stop", run: run.view.id })));
    run.view = {
      ...run.view, state: end, endpoint: null, example: null, server_pid: null,
      stages: run.view.stages.map((s) => ({ ...s, state: s.state === "lost" ? "lost" : "stopped" })),
    };
    this.d.log.info("pool_run_stopped", { run: run.view.id, state: end });
    this.d.changed();
  }
}
