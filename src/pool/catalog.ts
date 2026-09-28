// The open-weight model catalog (models.json) and the memory estimate behind every suggestion. No zod here: the
// dashboard bundle imports it (catalog-schema.ts validates the file). docs/PROTOCOL.md §3 "Local model suggestions".
import catalogJson from "./models.json" with { type: "json" };

export type Quant = "q4" | "q8";
export const QUANTS: readonly Quant[] = ["q8", "q4"];
/** How a quantisation is named for people ("4-bit"), with the llama.cpp format it stands for. */
export const QUANT_LABEL: Record<Quant, string> = { q4: "4-bit (Q4_K_M)", q8: "8-bit (Q8_0)" };

export interface ModelArch {
  layers: number;
  /** Grouped-query attention: KV heads and head size. */
  kv_heads?: number;
  head_dim?: number;
  /** Multi-head latent attention (DeepSeek): values cached per layer and token = kv_lora_rank + rope_dim. */
  mla?: { kv_lora_rank: number; rope_dim: number };
}

export interface CatalogModel {
  id: string;
  name: string;
  maker: string;
  /** Total parameters, billions. */
  params_b: number;
  /** Parameters used per token for a mixture of experts (billions); null = dense (all of them). */
  active_b: number | null;
  arch: ModelArch;
  /** Published checkpoint size in GiB where it replaces the formula's weights (a native 4-bit release); null = no such format. */
  weights_gib?: Partial<Record<Quant, number | null>>;
  /** Memory needed at the catalog's context length, GiB; null = the format doesn't exist for this model. */
  mem_gib: Record<Quant, number | null>;
  license: string;
  /** The model card. */
  source: string;
  /** Where the architecture numbers come from. */
  config_source: string;
  /** false = a number here could not be checked against the model card or config ([UNCLEAR] in docs). */
  verified: boolean;
  note?: string;
}

export interface Catalog {
  version: number;
  updated: string;
  context_tokens: number;
  bits_per_weight: Record<Quant, number>;
  bits_source: string;
  kv_bytes_per_value: number;
  overhead_gib: number;
  formula: string;
  models: CatalogModel[];
}

export const CATALOG: Catalog = catalogJson as Catalog;

const GiB = 1024 ** 3;

/** Values cached per token across all layers (K and V). */
export function kvValuesPerToken(a: ModelArch): number {
  if (a.mla) return a.layers * (a.mla.kv_lora_rank + a.mla.rope_dim);
  return 2 * a.layers * (a.kv_heads ?? 0) * (a.head_dim ?? 0);
}

/** Bytes of weights in a format, or null when the format doesn't exist. */
export function weightBytes(m: CatalogModel, q: Quant, cat: Catalog = CATALOG): number | null {
  const fixed = m.weights_gib?.[q];
  if (fixed === null) return null;
  if (typeof fixed === "number") return fixed * GiB;
  return (m.params_b * 1e9 * cat.bits_per_weight[q]) / 8;
}

/** Memory to run the model: weights + KV cache for `context` tokens + runtime overhead (bytes). */
export function memoryNeeded(m: CatalogModel, q: Quant, context = CATALOG.context_tokens, cat: Catalog = CATALOG): number | null {
  const w = weightBytes(m, q, cat);
  if (w === null) return null;
  const kv = kvValuesPerToken(m.arch) * context * cat.kv_bytes_per_value;
  return w + kv + cat.overhead_gib * GiB;
}

/** Bytes read per generated token: the active share of the weights (all of them for a dense model). */
export function bytesPerToken(m: CatalogModel, q: Quant, cat: Catalog = CATALOG): number | null {
  const w = weightBytes(m, q, cat);
  if (w === null) return null;
  return m.active_b ? (w * m.active_b) / m.params_b : w;
}
