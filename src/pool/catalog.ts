// The open-weight model catalog (models.json) and the memory estimate behind every suggestion. No zod here: the
// dashboard bundle imports it (catalog-schema.ts validates the file). docs/PROTOCOL.md §3 "Local model suggestions".
import catalogJson from "./models.json" with { type: "json" };

export type Quant = "q4" | "q8";
export const QUANTS: readonly Quant[] = ["q8", "q4"];
/** How a quantisation is named for people ("4-bit"), with the llama.cpp format it stands for. */
export const QUANT_LABEL: Record<Quant, string> = { q4: "4-bit (Q4_K_M)", q8: "8-bit (Q8_0)" };

export interface ModelArch {
  /** All decoder layers. */
  layers: number;
  /** Grouped-query attention: KV heads and head size (of a layer that caches the whole context). */
  kv_heads?: number;
  head_dim?: number;
  /** Multi-head latent attention (DeepSeek): values cached per layer and token = kv_lora_rank + rope_dim. */
  mla?: { kv_lora_rank: number; rope_dim: number };
  /**
   * Hybrid attention, read from the config's `layer_types`: only `full_layers` of the layers cache every token (with the
   * numbers above); `sliding` layers cache at most `window` tokens (with their own KV heads and head size); the rest
   * (linear attention, convolution, state-space, expert blocks) cache nothing. Absent: every layer is full attention.
   */
  hybrid?: { full_layers: number; sliding?: { layers: number; window: number; kv_heads: number; head_dim: number } };
}

/** What Hugging Face says about a model's quality (src/pool/hf/quality.ts); docs/PROTOCOL.md section 3. */
export interface ModelQuality {
  /** "rated": at least three admitted benchmark results on Hugging Face (quality.ts); "unrated": fewer (ranked after every rated model). */
  basis: "rated" | "unrated";
  /** Rated only: the combined ability of the benchmark results (cautious estimate, 0 = the average rated model). */
  score?: number;
  /** The benchmark values (0-100) behind it by label, e.g. {"GPQA": 89.2, "HLE": 30.8}; unrated: the one or none it has. */
  scores?: Record<string, number>;
  /** The admission rules this was produced under (quality.ts RATING_RULES): absent on older stored lists. */
  rules?: number;
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
  /** Release date, YYYY-MM-DD (Hugging Face `createdAt`); absent in a hand-made catalog. */
  released?: string;
  /** Benchmark standing; absent in a hand-made catalog (then the model is unrated). */
  quality?: ModelQuality;
  /** Hugging Face downloads in the last 30 days: adoption, a tie-break only, never quality. */
  downloads?: number;
  /** The GGUF repository whose file sizes gave the memory figures (live snapshots). */
  gguf_repo?: string;
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
  /** Where the list came from and when it was read; absent in a hand-made catalog. */
  origin?: { kind: "huggingface" | "built-in"; at: string };
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

/** Values cached per token across the layers that cache the whole context (K and V). */
export function kvValuesPerToken(a: ModelArch): number {
  const full = a.hybrid ? a.hybrid.full_layers : a.layers;
  if (a.mla) return full * (a.mla.kv_lora_rank + a.mla.rope_dim);
  return 2 * full * (a.kv_heads ?? 0) * (a.head_dim ?? 0);
}

/** Values cached for `context` tokens: every token in full-attention layers, at most the window in sliding ones. */
export function kvValuesTotal(a: ModelArch, context: number): number {
  const s = a.hybrid?.sliding;
  return kvValuesPerToken(a) * context + (s ? 2 * s.layers * s.kv_heads * s.head_dim * Math.min(s.window, context) : 0);
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
  const kv = kvValuesTotal(m.arch, context) * cat.kv_bytes_per_value;
  return w + kv + cat.overhead_gib * GiB;
}

/** Bytes read per generated token: the active share of the weights (all of them for a dense model). */
export function bytesPerToken(m: CatalogModel, q: Quant, cat: Catalog = CATALOG): number | null {
  const w = weightBytes(m, q, cat);
  if (w === null) return null;
  return m.active_b ? (w * m.active_b) / m.params_b : w;
}

// ---- ranking (docs/PROTOCOL.md section 3 "Local model suggestions"): quality first, size is not quality ----

/** Parameters that count as the model's size when it is a Mixture of Experts: the geometric mean of total and active. */
export function effectiveB(m: CatalogModel): number {
  return m.active_b ? Math.sqrt(m.params_b * m.active_b) : m.params_b;
}

/**
 * Negative when `a` is the better pick. Rated models (three or more admitted Hugging Face benchmark results) come first, by score.
 * Models without ratings come after every rated one: newest month first, then larger effective size, then adoption.
 */
export function compareModels(a: CatalogModel, b: CatalogModel): number {
  const ra = a.quality?.basis === "rated";
  const rb = b.quality?.basis === "rated";
  if (ra !== rb) return ra ? -1 : 1;
  if (ra && rb) {
    const d = (b.quality?.score ?? 0) - (a.quality?.score ?? 0);
    if (d !== 0) return d;
  }
  return (b.released ?? "").slice(0, 7).localeCompare((a.released ?? "").slice(0, 7))
    || effectiveB(b) - effectiveB(a)
    || (b.downloads ?? 0) - (a.downloads ?? 0)
    || a.id.localeCompare(b.id);
}

/** Models best first. */
export function rankModels(models: readonly CatalogModel[]): CatalogModel[] {
  return [...models].sort(compareModels);
}

/** "#4 of 58": the place of a rated model among the rated ones of a catalog; null for an unrated model. */
export function ratedPlace(cat: Catalog, m: CatalogModel): { place: number; of: number } | null {
  if (m.quality?.basis !== "rated") return null;
  const rated = rankModels(cat.models.filter((x) => x.quality?.basis === "rated"));
  const i = rated.findIndex((x) => x.id === m.id);
  return i < 0 ? null : { place: i + 1, of: rated.length };
}
