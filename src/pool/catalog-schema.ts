// Validates the model catalog (models.json) with zod: tests and `walkie pool` check the file the dashboard trusts.
import { z } from "zod";

const Gib = z.number().positive().max(4096).nullable();
const HttpsUrl = z.string().url().startsWith("https://");

export const CatalogModelSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,48}$/),
  name: z.string().min(2).max(60),
  maker: z.string().min(2).max(40),
  params_b: z.number().positive().max(5000),
  active_b: z.number().positive().nullable(),
  arch: z.object({
    layers: z.number().int().positive().max(512),
    kv_heads: z.number().int().positive().max(256).optional(),
    head_dim: z.number().int().positive().max(1024).optional(),
    mla: z.object({ kv_lora_rank: z.number().int().positive(), rope_dim: z.number().int().positive() }).strict().optional(),
  }).strict().refine((a) => !!a.mla !== (a.kv_heads !== undefined && a.head_dim !== undefined), { message: "either kv_heads + head_dim or mla" }),
  weights_gib: z.object({ q4: Gib.optional(), q8: Gib.optional() }).strict().optional(),
  mem_gib: z.object({ q4: Gib, q8: Gib }).strict(),
  license: z.string().min(2).max(80),
  source: HttpsUrl,
  config_source: HttpsUrl,
  verified: z.boolean(),
  note: z.string().max(600).optional(),
}).strict().refine((m) => m.active_b === null || m.active_b < m.params_b, { message: "active parameters exceed total" })
  .refine((m) => m.mem_gib.q4 !== null, { message: "every model needs a 4-bit figure" });

export const CatalogSchema = z.object({
  version: z.number().int().positive(),
  updated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  context_tokens: z.number().int().min(512).max(1 << 20),
  bits_per_weight: z.object({ q4: z.number().min(4).max(5.5), q8: z.number().min(8).max(9) }).strict(),
  bits_source: HttpsUrl,
  kv_bytes_per_value: z.number().positive().max(4),
  overhead_gib: z.number().nonnegative().max(8),
  formula: z.string().min(10),
  models: z.array(CatalogModelSchema).min(5).max(100)
    .refine((ms) => new Set(ms.map((m) => m.id)).size === ms.length, { message: "duplicate model id" }),
}).strict();
