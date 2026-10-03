// The architecture numbers the KV-cache formula needs, read from a model's config.json (and its active parameters from
// the maker's own name). Pure: no network. A config this cannot read is skipped with a reason, never guessed.
// docs/plans/LOCAL-MODELS-HF-1.md "Candidates" 7.
import type { ModelArch } from "../catalog.ts";

export type ArchSkip = "no_layers" | "no_heads" | "no_head_dim" | "mla_unreadable" | "window_unreadable";
export type ArchRead = { ok: true; arch: ModelArch; moe: boolean } | { ok: false; reason: ArchSkip };

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const posInt = (v: unknown, max = 1_000_000): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= max ? v : null);

type Kind = "full" | "sliding" | "none";

/**
 * What a layer type label means for the KV cache. Linear attention, convolution, state-space and expert blocks cache
 * nothing; sliding-window layers cache their window; everything else (and any label this does not know) caches the
 * whole context, which can only overstate memory.
 */
function kindOf(label: unknown): Kind {
  const s = typeof label === "string" ? label.toLowerCase() : "";
  if (/linear|conv|mamba|ssm|rnn|recurrent|moe|mlp|ffn|gdn|kda|state/.test(s)) return "none";
  if (/slid|local|swa|chunk|window/.test(s)) return "sliding";
  return "full";
}

/** Total layers first: `layer_types` (Hugging Face) or `layers_block_type` (Nemotron-H), cut to the layers when longer. */
function layerKinds(t: Record<string, unknown>, layers: number): Kind[] | null {
  const raw = t.layer_types ?? t.layers_block_type;
  if (!Array.isArray(raw) || raw.length < layers) return null;
  return raw.slice(0, layers).map(kindOf);
}

/**
 * A Mixture of Experts has a count of experts under some key with "expert" in it (`num_experts`, `n_routed_experts`,
 * `num_local_experts`, Step's `moe_num_experts`), in the text config or at the top. A dense model's are null or absent.
 */
function isMoe(t: Record<string, unknown>, root: Record<string, unknown>): boolean {
  for (const src of [t, root]) {
    for (const [key, v] of Object.entries(src)) {
      if (/expert/i.test(key) && typeof v === "number" && v > 1) return true;
    }
  }
  return false;
}

export function readArch(config: unknown): ArchRead {
  const root = obj(config);
  const t = obj(root?.text_config) ?? root;
  const layers = posInt(t?.num_hidden_layers, 512);
  if (!root || !t || layers === null) return { ok: false, reason: "no_layers" };
  const heads = posInt(t.num_attention_heads, 4096);
  if (heads === null) return { ok: false, reason: "no_heads" };

  const kinds = layerKinds(t, layers);
  const interval = posInt(t.full_attention_interval, 512);
  let full = layers;
  let sliding = 0;
  if (kinds) {
    full = kinds.filter((k) => k === "full").length;
    sliding = kinds.filter((k) => k === "sliding").length;
  } else if (interval) {
    full = Math.floor(layers / interval);
  }
  const moe = isMoe(t, root);

  const lora = posInt(t.kv_lora_rank, 65536);
  if (lora !== null) {
    const rope = typeof t.qk_rope_head_dim === "number" && Number.isInteger(t.qk_rope_head_dim) && t.qk_rope_head_dim >= 0 && t.qk_rope_head_dim <= 4096 ? t.qk_rope_head_dim : null;
    if (rope === null) return { ok: false, reason: "mla_unreadable" };
    // Sliding layers next to latent attention are not described by this config: counted as full, an upper bound.
    const cached = full + sliding;
    const arch: ModelArch = { layers, mla: { kv_lora_rank: lora, rope_dim: rope }, ...(cached !== layers ? { hybrid: { full_layers: cached } } : {}) };
    return { ok: true, arch, moe };
  }

  // The Hugging Face default is as many KV heads as attention heads; Step models name them `num_attention_groups`.
  const kvHeads = posInt(t.num_key_value_heads ?? t.num_attention_groups ?? heads, 256);
  if (kvHeads === null) return { ok: false, reason: "no_heads" };
  const hidden = posInt(t.hidden_size, 1_000_000);
  const headDim = posInt(t.head_dim ?? (hidden !== null && hidden % heads === 0 ? hidden / heads : null), 1024);
  if (headDim === null) return { ok: false, reason: "no_head_dim" };

  if (sliding > 0) {
    const window = posInt(t.sliding_window, 1 << 24);
    if (window === null) return { ok: false, reason: "window_unreadable" };
    // Global layers of a sliding-window model may have their own KV heads and head size (Gemma 4).
    const gHeads = posInt(t.num_global_key_value_heads ?? kvHeads, 256);
    if (gHeads === null) return { ok: false, reason: "no_heads" };
    const gDim = posInt(t.global_head_dim ?? headDim, 1024);
    if (gDim === null) return { ok: false, reason: "no_head_dim" };
    return {
      ok: true, moe,
      arch: { layers, kv_heads: gHeads, head_dim: gDim, hybrid: { full_layers: full, sliding: { layers: sliding, window, kv_heads: kvHeads, head_dim: headDim } } },
    };
  }
  return { ok: true, moe, arch: { layers, kv_heads: kvHeads, head_dim: headDim, ...(full !== layers ? { hybrid: { full_layers: full } } : {}) } };
}

/**
 * Active (A) or effective (E, per-layer embeddings) parameters in billions from the maker's own name token:
 * "Qwen3.6-35B-A3B" is 3, "gemma-4-E4B-it" is 4. null when the name has none.
 */
export function activeFromName(name: string): number | null {
  const m = /(?:^|[-_.])[AE](\d+(?:\.\d+)?)B(?=$|[-_.])/.exec(name);
  const v = m ? Number(m[1]) : Number.NaN;
  return Number.isFinite(v) && v > 0 && v < 2000 ? v : null;
}
