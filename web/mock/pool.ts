// Mock split runs (WALKIE-POOL-2) for the dashboard: this machine's sharing and a run that walks through
// downloading -> starting -> loading -> serving. WALKIE_MOCK_POOL_RUN=serving seeds a run that is already serving.
import { suggestCombined } from "../../src/pool/combined.ts";
import type { PoolLocalView, RunView } from "../../src/protocol/pool.ts";
import type { NodeView } from "../../src/protocol/schemas.ts";

const GiB = 1024 ** 3;
const KEY = "~/.walkie/pool/api-key";

export class MockPool {
  share = { on: false, max_bytes: null as number | null };
  run: RunView | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly nodes: () => NodeView[]) {
    if (process.env.WALKIE_MOCK_POOL_RUN === "serving") this.start(true);
  }

  view(): PoolLocalView {
    return { share: { ...this.share }, runtime: { installed: true, dir: "~/.walkie/pool/llama", build: "b11205 darwin-arm64" }, run: this.run, stage: null };
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
      stages: pick.placement.map((p) => ({ node_id: p.node_id, hostname: p.hostname, self: p.node_id === pick.head.node_id, bytes: p.bytes, state: "ready" as const })),
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
