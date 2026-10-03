// Validates the model catalog (models.json) with zod: tests and `walkie pool` check the file the dashboard trusts.
import { z } from "zod";

const Gib = z.number().positive().max(4096).nullable();
const HttpsUrl = z.string().url().startsWith("https://");
/**
 * Text that reaches a terminal, an agent and the dashboard: printable ASCII only, so a list read from the Hub or from a
 * file can't carry an escape sequence, a line break or a look-alike control character.
 */
const Printable = /^[\x20-\x7e]*$/;
/** Model pages and configs are on Hugging Face and nowhere else: a link built from the list can't lead off site. */
const ModelPage = z.string().regex(/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+$/);
const ModelConfig = z.string().regex(/^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/blob\/main\/config\.json$/);

/** Benchmark standing (src/pool/hf/quality.ts): rated models carry a score, every one the values behind it by label. */
export const ModelQualitySchema = z.object({
  basis: z.enum(["rated", "unrated"]),
  score: z.number().finite().min(-20).max(20).optional(),
  scores: z.record(z.string().regex(/^[A-Za-z0-9 .-]{1,30}$/), z.number().min(0).max(100)).refine((r) => Object.keys(r).length <= 12, { message: "too many benchmarks" }).optional(),
  rules: z.number().int().min(1).max(1000).optional(),
}).strict().refine((q) => (q.basis === "rated") === (q.score !== undefined), { message: "a rated model has a score and an unrated one has none" });

export const CatalogModelSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,48}$/),
  name: z.string().min(2).max(60).regex(Printable),
  maker: z.string().min(2).max(40).regex(Printable),
  params_b: z.number().positive().max(5000),
  active_b: z.number().positive().nullable(),
  arch: z.object({
    layers: z.number().int().positive().max(512),
    kv_heads: z.number().int().positive().max(256).optional(),
    head_dim: z.number().int().positive().max(1024).optional(),
    mla: z.object({ kv_lora_rank: z.number().int().positive(), rope_dim: z.number().int().nonnegative() }).strict().optional(),
    hybrid: z.object({
      full_layers: z.number().int().nonnegative().max(512),
      sliding: z.object({
        layers: z.number().int().positive().max(512), window: z.number().int().positive().max(1 << 24),
        kv_heads: z.number().int().positive().max(256), head_dim: z.number().int().positive().max(1024),
      }).strict().optional(),
    }).strict().optional(),
  }).strict()
    .refine((a) => !!a.mla !== (a.kv_heads !== undefined && a.head_dim !== undefined), { message: "either kv_heads + head_dim or mla" })
    .refine((a) => !a.hybrid || a.hybrid.full_layers + (a.hybrid.sliding?.layers ?? 0) <= a.layers, { message: "hybrid layers exceed the layers" }),
  weights_gib: z.object({ q4: Gib.optional(), q8: Gib.optional() }).strict().optional(),
  mem_gib: z.object({ q4: Gib, q8: Gib }).strict(),
  license: z.string().min(2).max(80).regex(Printable),
  released: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  quality: ModelQualitySchema.optional(),
  downloads: z.number().int().nonnegative().max(1e12).optional(),
  gguf_repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(200).optional(),
  source: ModelPage,
  config_source: ModelConfig,
  verified: z.boolean(),
  note: z.string().max(600).regex(Printable).optional(),
}).strict().refine((m) => m.active_b === null || m.active_b < m.params_b, { message: "active parameters exceed total" })
  .refine((m) => m.mem_gib.q4 !== null, { message: "every model needs a 4-bit figure" });

export const CatalogSchema = z.object({
  version: z.number().int().positive(),
  updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  origin: z.object({ kind: z.enum(["huggingface", "built-in"]), at: z.string().regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/) }).strict().optional(),
  context_tokens: z.number().int().min(512).max(1 << 20),
  bits_per_weight: z.object({ q4: z.number().min(4).max(5.5), q8: z.number().min(8).max(9) }).strict(),
  bits_source: HttpsUrl,
  kv_bytes_per_value: z.number().positive().max(4),
  overhead_gib: z.number().nonnegative().max(8),
  formula: z.string().min(10),
  models: z.array(CatalogModelSchema).min(5).max(100)
    .refine((ms) => new Set(ms.map((m) => m.id)).size === ms.length, { message: "duplicate model id" }),
}).strict();
