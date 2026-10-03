// Split runs (WALKIE-POOL-2): what a machine tells the team about sharing its compute, and the shapes of the
// local + peer pool API. Carried as an optional `pool` field on the peer `vv` answer and on NodeView; daemons
// before POOL-2 don't send it and strip it when they receive it (zod objects drop unknown keys). PROTOCOL §3
// "Split runs".
import { z } from "zod";
import type { Catalog } from "../pool/catalog.ts";

const Bytes = z.number().int().nonnegative().max(2 ** 52);

/** Run ids: 32 hex characters, minted by the head. */
export const RunId = z.string().regex(/^[0-9a-f]{32}$/);

/** Catalog model ids ("qwen3-14b"). */
export const ModelId = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,48}$/);

/**
 * A model a machine serves whole on its own GPU (POOL-REAL-1 "serve on the best machine"), as its daemon publishes
 * it: members connect to it through Walkie (`walkie pool connect <machine>`). `open` = its owner shares the machine,
 * so other members may connect; without it only the machine's own person uses it.
 */
export const PoolServing = z.object({
  id: RunId,
  model: z.string().min(1).max(120),
  model_id: ModelId.nullable(),
  quant: z.enum(["q4", "q8"]).nullable(),
  state: z.enum(["downloading", "loading", "serving"]),
  open: z.boolean(),
  /** Generation speed llama-server measured (its /metrics), once it served a request. */
  tokens_per_s: z.number().nonnegative().max(100_000).nullable(),
});
export type PoolServing = z.infer<typeof PoolServing>;

/** A machine's sharing state, as its daemon publishes it. */
export const PoolShare = z.object({
  /** Its owner turned sharing on (`walkie pool share on` or the dashboard toggle). */
  share: z.boolean(),
  /** The most memory a split run may use there (bytes); null = what is free at the time. */
  cap: Bytes.nullable(),
  /** The pinned llama.cpp runtime is installed there (`walkie pool install`). */
  runtime: z.boolean(),
  /** A stage of someone's run, or a served model, is running there now (one pool job at a time). */
  busy: z.boolean(),
  /**
   * POOL-REAL-1: this daemon serves models whole (`POST /peer/v1/pool/serve`). Older daemons don't send it: they are
   * never picked to serve.
   */
  serve: z.boolean().optional().catch(undefined),
  /**
   * Catalog models ("<model id>:<quant>") whose weights this machine has prepared from its own checked copy
   * (`walkie pool prepare`, POOL-REAL-1): a stage of one loads its share from disk instead of over the network.
   */
  prepared: z.array(z.string().regex(/^[a-z0-9][a-z0-9.-]{1,48}:q[48]$/)).max(32).optional().catch(undefined),
  /** The model it serves whole, if any (POOL-REAL-1; older daemons don't send it). A malformed one is dropped alone. */
  serving: PoolServing.nullable().optional().catch(undefined),
});
export type PoolShare = z.infer<typeof PoolShare>;

/** `POST /peer/v1/pool/stage` (head -> worker). */
export const StageReq = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"), run: RunId,
    /** Bytes of the model this stage is planned to hold (weights share + its KV cache + runtime overhead). */
    bytes: Bytes,
    model: z.string().min(1).max(120),
    /** POOL-REAL-1: the catalog model, sent only to a worker that published it as prepared (loads its share locally). */
    weights: z.object({ model: ModelId, quant: z.enum(["q4", "q8"]) }).strict().optional(),
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

/**
 * `POST /peer/v1/pool/serve` (a member machine -> the machine that serves, POOL-REAL-1): start a catalog model there
 * (only when its owner shares it), connect (a per-client key for its endpoint), renew the connection's lease,
 * disconnect, stop (only the machine that started it). Connect without `id` means whatever it serves now.
 */
export const ServeReq = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), model: ModelId, quant: z.enum(["q4", "q8"]) }).strict(),
  z.object({ action: z.literal("connect"), id: RunId.optional() }).strict(),
  z.object({ action: z.literal("renew"), id: RunId }).strict(),
  z.object({ action: z.literal("disconnect"), id: RunId }).strict(),
  z.object({ action: z.literal("stop"), id: RunId }).strict(),
]);
export type ServeReq = z.infer<typeof ServeReq>;

export const ServeRes = z.object({
  ok: z.boolean(),
  id: RunId.optional(),
  state: z.enum(["downloading", "loading", "serving"]).optional(),
  model: z.object({ name: z.string().min(1).max(120), id: ModelId.nullable(), quant: z.enum(["q4", "q8"]).nullable() }).optional(),
  /** connect: the bearer key this client presents to the served endpoint (48 hex characters). */
  key: z.string().regex(/^[0-9a-f]{48}$/).optional(),
  lease_ms: z.number().int().positive().max(600_000).optional(),
});
export type ServeRes = z.infer<typeof ServeRes>;

/** The largest peer round-trip table a machine publishes (entries). */
export const MAX_PEER_RTT = 64;

// ---- local API views (GET /v1/pool); plain types so the dashboard can import them ----

export type RunState = "downloading" | "starting" | "loading" | "serving" | "stopping" | "stopped" | "failed";
export type PoolQuant = "q4" | "q8";

export interface PlannedStage {
  node_id: string; hostname: string; self: boolean;
  /** Memory the machine is planned to give: its share of the model plus, on a worker, its own runtime's overhead. */
  bytes: number;
  /** Its share of the model alone (POOL-REAL-1 p8-4): what --tensor-split is proportional to. */
  model_bytes: number;
}
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

export interface StageView { run: string; head: string; head_hostname: string; model: string; bytes: number; started_at: number; tunnels: number; pid: number; bytes_in: number; bytes_out?: number }

export type ServeState = "downloading" | "loading" | "serving" | "stopping" | "stopped" | "failed";

/** A model this machine serves whole (POOL-REAL-1), for its own person and the members connected to it. */
export interface ServeView {
  id: string; state: ServeState; error: string | null;
  model: { id: string | null; name: string; quant: PoolQuant | null };
  download: { done: number; total: number } | null;
  /** Bytes the model needs (weights + 8K cache + overhead) and the GPU memory it had free when it started. */
  need: number; gpu_free: number | null;
  /** null = this machine's person started it; else the machine that asked. */
  started_by: { node_id: string; hostname: string } | null;
  /** OpenAI-compatible base URL on this machine's loopback (the allow-list proxy), and its key file. */
  endpoint: string | null; api_key_file: string | null; example: string | null;
  clients: { node_id: string; hostname: string; since: number; requests: number; tunnels: number }[];
  requests: number; tokens_per_s: number | null;
  started_at: number; serving_at: number | null; last_request_at: number | null;
  /** When it stops for want of requests (idle timeout), while serving. */
  idle_stop_at: number | null;
  server_pid: number | null;
}

/** This machine's connection to a model another machine serves (POOL-REAL-1). */
export interface ConnectionView {
  node_id: string; hostname: string; id: string;
  model: { id: string | null; name: string; quant: PoolQuant | null };
  state: "connected" | "lost" | "closed";
  error: string | null;
  /** OpenAI-compatible base URL on THIS machine's loopback, tunnelled to the serving machine, and its key file. */
  endpoint: string; api_key_file: string; example: string;
  since: number; requests: number;
}

/** `walkie pool prepare`: this machine's copy of a model for split-run stages (POOL-REAL-1). */
export interface PrepareView {
  model: string; quant: PoolQuant; name: string;
  state: "downloading" | "preparing" | "done" | "failed";
  done: number; total: number; error: string | null;
}

/** `walkie pool install` through the daemon (POOL-REAL-1: a person or a NAMED agent may run it). */
export interface InstallView {
  target: string; build: string;
  state: "downloading" | "done" | "failed";
  file: string | null; done: number; total: number; error: string | null;
  /** Who asked: null = a person (CLI or dashboard), else the agent's name. */
  by: string | null;
}

export interface PoolLocalView {
  share: { on: boolean; max_bytes: number | null };
  runtime: { installed: boolean; dir: string; build: string | null };
  run: RunView | null;
  stage: StageView | null;
  /** POOL-REAL-1: what this machine serves, and the served models it is connected to. Older daemons omit them. */
  serve?: ServeView | null;
  connections?: ConnectionView[];
  prepare?: PrepareView | null;
  prepared?: string[];
  install?: InstallView | null;
}

/**
 * `GET /v1/pool/models` (LOCAL-MODELS-HF-1): the model list the suggestions use and where it came from. The daemon reads
 * Hugging Face when a person opens the suggestions and the list is missing or over a day old; until then (or when it
 * cannot) this is the built-in list or the previous one, with `note` saying why. `catalog` is left out with `?brief=1`.
 */
export interface PoolModelsView {
  source: "huggingface" | "built-in";
  state: "fresh" | "stale" | "built-in";
  /** When the Hugging Face list was read (ms epoch); null for the built-in list. */
  checked_at: number | null;
  note: string | null;
  /** A read of Hugging Face is running now: ask again in a few seconds. */
  refreshing: boolean;
  catalog?: Catalog;
}
