// Mock split runs (WALKIE-POOL-2) for the dashboard: this machine's sharing and a run that walks through
// downloading -> starting -> loading -> serving. WALKIE_MOCK_POOL_RUN=serving seeds a run that is already serving.
import { suggestCombined } from "../../src/pool/combined.ts";
import type { ConnectionView, InstallView, PoolLocalView, RunView, ServeView } from "../../src/protocol/pool.ts";
import { bestServe } from "../../src/pool/run/plan.ts";
import { CATALOG } from "../../src/pool/catalog.ts";
import type { NodeView } from "../../src/protocol/schemas.ts";

const GiB = 1024 ** 3;
const KEY = "~/.walkie/pool/api-key";

export class MockPool {
  share = { on: false, max_bytes: null as number | null };
  run: RunView | null = null;
  /** POOL-REAL-1: what this machine serves, its connections, the runtime install. WALKIE_MOCK_POOL_RUNTIME=missing starts without it. */
  serve: ServeView | null = null;
  connections: ConnectionView[] = [];
  installed = process.env.WALKIE_MOCK_POOL_RUNTIME !== "missing";
  install: InstallView | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly nodes: () => NodeView[]) {
    if (process.env.WALKIE_MOCK_POOL_RUN === "serving") this.start(true);
  }

  view(): PoolLocalView {
    return {
      share: { ...this.share }, runtime: { installed: this.installed, dir: "~/.walkie/pool/llama", build: this.installed ? "b11205 darwin-arm64" : null },
      run: this.run, stage: null, serve: this.serve, connections: this.connections, install: this.install, prepare: null, prepared: [],
    };
  }

  startInstall(): InstallView {
    const total = 11755672;
    this.install = { target: "macOS (Apple Silicon, Metal)", build: "b11205", state: "downloading", file: "llama-b11205-bin-macos-arm64.tar.gz", done: 0, total, error: null, by: null };
    const t = setInterval(() => {
      if (!this.install) return;
      const done = Math.min(total, this.install.done + total / 5);
      this.install = { ...this.install, done, ...(done >= total ? { state: "done" as const } : {}) };
      if (done >= total) { this.installed = true; clearInterval(t); }
    }, 600);
    return this.install;
  }

  /** Serve here (self) or connect to another machine (it "serves" at once in the mock). */
  startServe(modelId: string, quant: "q4" | "q8", on: NodeView | null): { on: { node_id: string; hostname: string; self: boolean }; serve?: ServeView; connection?: ConnectionView } | null {
    const m = CATALOG.models.find((x) => x.id === modelId);
    if (!m) return null;
    const self = this.nodes().find((n) => n.self)!;
    const target = on ?? self;
    if (!target.self) {
      const c = this.connect(target, modelId);
      return { on: { node_id: target.node_id, hostname: target.hostname, self: false }, connection: c };
    }
    const pick = bestServe(this.nodes());
    const ep = "http://127.0.0.1:61901/v1";
    const keyFile = "~/.walkie/pool/serve.key";
    this.serve = {
      id: "5e".repeat(16), state: "serving", error: null, model: { id: m.id, name: m.name, quant }, download: null,
      need: pick?.need ?? 10 * GiB, gpu_free: pick?.host.usable ?? null, started_by: null, endpoint: ep, api_key_file: keyFile,
      example: `curl ${ep}/chat/completions -H "Authorization: Bearer $(cat ${keyFile})" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"Hello"}]}'`,
      clients: [], requests: 0, tokens_per_s: 23.4, started_at: Date.now(), serving_at: Date.now(), last_request_at: null, idle_stop_at: Date.now() + 30 * 60_000, server_pid: 50112,
    };
    return { on: { node_id: self.node_id, hostname: self.hostname, self: true }, serve: this.serve };
  }

  connect(n: NodeView, modelId?: string): ConnectionView {
    const m = CATALOG.models.find((x) => x.id === (modelId ?? n.pool?.serving?.model_id));
    const ep = "http://127.0.0.1:61977/v1";
    const keyFile = `~/.walkie/pool/connect/${n.node_id}.key`;
    const c: ConnectionView = {
      node_id: n.node_id, hostname: n.hostname, id: n.pool?.serving?.id ?? "7a".repeat(16),
      model: { id: m?.id ?? null, name: m?.name ?? n.pool?.serving?.model ?? "model", quant: n.pool?.serving?.quant ?? "q4" },
      state: "connected", error: null, endpoint: ep, api_key_file: keyFile,
      example: `curl ${ep}/chat/completions -H "Authorization: Bearer $(cat ${keyFile})" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"Hello"}]}'`,
      since: Date.now(), requests: 0,
    };
    this.connections = [...this.connections.filter((x) => x.node_id !== n.node_id), c];
    return c;
  }

  disconnect(nodeId: string): ConnectionView | null {
    const c = this.connections.find((x) => x.node_id === nodeId) ?? null;
    this.connections = this.connections.filter((x) => x.node_id !== nodeId);
    return c;
  }

  stopServe(): ServeView | null {
    if (this.serve) this.serve = { ...this.serve, state: "stopped", endpoint: null, example: null, server_pid: null, idle_stop_at: null };
    return this.serve;
  }

  setShare(on: boolean, maxGb: number | null | undefined): void {
    this.share = { on, max_bytes: maxGb === undefined ? this.share.max_bytes : maxGb === null ? null : Math.round(maxGb * GiB) };
  }

  start(serving = false): RunView | null {
    const pick = suggestCombined(this.nodes()).runnable;
    if (!pick) return null;
    const total = pick.need - 1.2 * GiB;
    this.run = {
      id: "0f".repeat(16), state: serving ? "serving" : "downloading", error: null,
      model: { id: pick.model.id, name: pick.model.name, quant: pick.quant },
      download: { done: serving ? total : 0, total },
      stages: pick.placement.map((p) => ({ node_id: p.node_id, hostname: p.hostname, self: p.node_id === pick.head.node_id, bytes: p.bytes, model_bytes: p.bytes, state: "ready" as const })),
      endpoint: serving ? "http://127.0.0.1:61842/v1" : null, api_key_file: serving ? KEY : null,
      example: serving ? `curl http://127.0.0.1:61842/v1/chat/completions -H "Authorization: Bearer $(cat ${KEY})" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"Hello"}]}'` : null,
      tokens_per_s: serving ? 5.8 : null, started_at: Date.now() - (serving ? 9 * 60_000 : 0), serving_at: serving ? Date.now() - 6 * 60_000 : null, server_pid: serving ? 48213 : null,
    };
    if (!serving) this.advance();
    return this.run;
  }

  private advance(): void {
    if (this.timer) clearInterval(this.timer);
    let tick = 0;
    this.timer = setInterval(() => {
      const r = this.run;
      if (!r) return;
      tick++;
      if (r.state === "downloading" && r.download) {
        const done = Math.min(r.download.total, r.download.done + r.download.total / 8);
        this.run = { ...r, download: { ...r.download, done }, ...(done >= r.download.total ? { state: "starting" as const } : {}) };
      } else if (r.state === "starting") this.run = { ...r, state: "loading" };
      else if (r.state === "loading" && tick > 12) {
        this.run = { ...r, state: "serving", endpoint: "http://127.0.0.1:61842/v1", api_key_file: KEY, serving_at: Date.now(), server_pid: 48213, tokens_per_s: 5.8,
          example: `curl http://127.0.0.1:61842/v1/chat/completions -H "Authorization: Bearer $(cat ${KEY})" -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"Hello"}]}'` };
        if (this.timer) clearInterval(this.timer);
      }
    }, 700);
  }

  stop(): RunView | null {
    if (this.timer) clearInterval(this.timer);
    if (this.run) this.run = { ...this.run, state: "stopped", endpoint: null, example: null, server_pid: null, stages: this.run.stages.map((s) => ({ ...s, state: "stopped" })) };
    return this.run;
  }
}
