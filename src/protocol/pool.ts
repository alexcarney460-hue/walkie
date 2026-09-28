// Split runs (WALKIE-POOL-2): what a machine tells the team about sharing its compute, and the shapes of the
// local + peer pool API. Carried as an optional `pool` field on the peer `vv` answer and on NodeView; daemons
// before POOL-2 don't send it and strip it when they receive it (zod objects drop unknown keys). PROTOCOL §3
// "Split runs".
import { z } from "zod";

const Bytes = z.number().int().nonnegative().max(2 ** 52);

/** A machine's sharing state, as its daemon publishes it. */
export const PoolShare = z.object({
  /** Its owner turned sharing on (`walkie pool share on` or the dashboard toggle). */
  share: z.boolean(),
  /** The most memory a split run may use there (bytes); null = what is free at the time. */
  cap: Bytes.nullable(),
  /** The pinned llama.cpp runtime is installed there (`walkie pool install`). */
  runtime: z.boolean(),
  /** A stage of someone's run is running there now (one at a time in v1). */
  busy: z.boolean(),
});
export type PoolShare = z.infer<typeof PoolShare>;

/** Run ids: 32 hex characters, minted by the head. */
export const RunId = z.string().regex(/^[0-9a-f]{32}$/);

/** `POST /peer/v1/pool/stage` (head -> worker). */
export const StageReq = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"), run: RunId,
    /** Bytes of the model this stage is planned to hold (weights share + its KV cache + runtime overhead). */
    bytes: Bytes,
    model: z.string().min(1).max(120),
  }).strict(),
  z.object({ action: z.literal("renew"), run: RunId }).strict(),
  z.object({ action: z.literal("stop"), run: RunId }).strict(),
]);
export type StageReq = z.infer<typeof StageReq>;

export const StageRes = z.object({
  ok: z.boolean(),
  /** How long the stage lives without a renew (ms). */
  lease_ms: z.number().int().positive().max(600_000).optional(),
});
export type StageRes = z.infer<typeof StageRes>;

/** The largest peer round-trip table a machine publishes (entries). */
export const MAX_PEER_RTT = 64;

// ---- local API views (GET /v1/pool); plain types so the dashboard can import them ----

export type RunState = "downloading" | "starting" | "loading" | "serving" | "stopping" | "stopped" | "failed";
export type PoolQuant = "q4" | "q8";

export interface PlannedStage { node_id: string; hostname: string; self: boolean; bytes: number }
export interface RunStageView extends PlannedStage { state: "starting" | "ready" | "lost" | "stopped" }

export interface RunView {
  id: string; state: RunState; error: string | null;
  model: { id: string | null; name: string; quant: PoolQuant | null };
  download: { done: number; total: number } | null;
  stages: RunStageView[];
  /** OpenAI-compatible base URL on this machine's loopback, once serving. */
  endpoint: string | null;
  api_key_file: string | null;
  example: string | null;
  tokens_per_s: number | null;
  started_at: number; serving_at: number | null;
  /** llama-server's PID while it runs (this machine's own process; `walkie pool status`, lsof checks). */
  server_pid: number | null;
}

export interface StageView { run: string; head: string; head_hostname: string; model: string; bytes: number; started_at: number; tunnels: number; pid: number; bytes_in: number }

export interface PoolLocalView {
  share: { on: boolean; max_bytes: number | null };
  runtime: { installed: boolean; dir: string; build: string | null };
  run: RunView | null;
  stage: StageView | null;
}
