// LOCAL-MODELS-HF-1 item 7: the architecture numbers the KV-cache formula needs, read from real config.json files
// (test/fixtures/pool-hf/configs): layers, KV heads, head size; hybrid and sliding-window layouts; latent attention;
// whether it is a Mixture of Experts; the active parameters from the maker's own name.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activeFromName, readArch } from "../../src/pool/hf/config.ts";
import { kvValuesPerToken, kvValuesTotal } from "../../src/pool/catalog.ts";
import { HF_FIXTURES } from "../helpers/hf-fixtures.ts";

const cfg = (repo: string): unknown => JSON.parse(readFileSync(join(HF_FIXTURES, "configs", `${repo.replace("/", "__")}.json`), "utf8"));
const ok = (repo: string) => {
  const r = readArch(cfg(repo));
  if (!r.ok) throw new Error(`${repo}: ${r.reason}`);
  return r;
};

describe("readArch: dense models", () => {
  test("Qwen3-8B: every layer caches the whole context", () => {
    const r = ok("Qwen/Qwen3-8B");
    expect(r.arch).toEqual({ layers: 36, kv_heads: 8, head_dim: 128 });
    expect(r.moe).toBe(false);
  });

  test("a head size missing from the config is hidden size / attention heads (LFM2.5 1.2B: 2048 / 32), conv layers cache nothing", () => {
    const r = ok("LiquidAI/LFM2.5-1.2B-Instruct");
    expect(r.arch).toEqual({ layers: 16, kv_heads: 8, head_dim: 64, hybrid: { full_layers: 6 } });
  });
});

describe("readArch: hybrid layouts (layer_types, layers_block_type, nested text_config)", () => {
  test("Qwen3.8-27B: the text model is nested in text_config; 16 of 64 layers are full attention, the rest linear", () => {
    const r = ok("Qwen/Qwen3.8-27B");
    expect(r.arch).toEqual({ layers: 64, kv_heads: 4, head_dim: 256, hybrid: { full_layers: 16 } });
    // 2 (K and V) x 16 layers x 4 heads x 256 = 32768 values a token, not 2 x 64 x 4 x 256.
    expect(kvValuesPerToken(r.arch)).toBe(2 * 16 * 4 * 256);
  });

  test("Gemma 4 12B: 8 global layers (1 KV head of 512) and 40 sliding-window layers (8 KV heads of 256, window 1024)", () => {
    const r = ok("google/gemma-4-12B-it");
    expect(r.arch).toEqual({
      layers: 48, kv_heads: 1, head_dim: 512,
      hybrid: { full_layers: 8, sliding: { layers: 40, window: 1024, kv_heads: 8, head_dim: 256 } },
    });
    // At 8K a sliding layer holds 1024 tokens, a global layer all 8192; the naive all-layers formula would be 6.4x more.
    const total = kvValuesTotal(r.arch, 8192);
    expect(total).toBe(8 * 2 * 1 * 512 * 8192 + 40 * 2 * 8 * 256 * 1024);
    expect(total).toBeLessThan((2 * 48 * 8 * 256 * 8192) / 6);
  });

  test("gpt-oss-20b: half the layers slide over 128 tokens; it is a Mixture of Experts", () => {
    const r = ok("openai/gpt-oss-20b");
    expect(r.arch).toEqual({ layers: 24, kv_heads: 8, head_dim: 64, hybrid: { full_layers: 12, sliding: { layers: 12, window: 128, kv_heads: 8, head_dim: 64 } } });
    expect(r.moe).toBe(true);
  });

  test("Nemotron 3.5 Lightning: layers_block_type says 6 attention layers of 52 (the rest are Mamba and expert blocks)", () => {
    const r = ok("nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16");
    expect(r.arch).toEqual({ layers: 52, kv_heads: 2, head_dim: 128, hybrid: { full_layers: 6 } });
    expect(r.moe).toBe(true);
  });

  test("a layer_types list longer than the layers (Step 3.7 Flash lists 3 more, for its prediction heads) is cut to the layers; KV heads come from num_attention_groups", () => {
    const r = ok("stepfun-ai/Step-3.7-Flash");
    expect(r.arch.layers).toBe(45);
    expect(r.arch.kv_heads).toBe(8);
    expect(r.arch.hybrid).toEqual({ full_layers: 12, sliding: { layers: 33, window: 512, kv_heads: 8, head_dim: 128 } });
  });
});

describe("readArch: multi-head latent attention", () => {
  test("GLM-5.3 Flash: 11 sparse-attention layers cache 512 values each (kv_lora_rank 512 + rope 0); 34 linear layers cache nothing", () => {
    const r = ok("zai-org/GLM-5.3-Flash");
    expect(r.arch).toEqual({ layers: 45, mla: { kv_lora_rank: 512, rope_dim: 0 }, hybrid: { full_layers: 11 } });
    expect(kvValuesPerToken(r.arch)).toBe(11 * 512);
  });

  test("GLM-4.7 Flash: every layer is latent attention with rope 64", () => {
    expect(ok("zai-org/GLM-4.7-Flash").arch).toEqual({ layers: 47, mla: { kv_lora_rank: 512, rope_dim: 64 } });
  });
});

describe("readArch: Mixture of Experts and what cannot be read", () => {
  test("experts under any of the three names mark a Mixture of Experts", () => {
    expect(ok("Qwen/Qwen3.6-35B-A3B").moe).toBe(true); // num_experts, nested
    expect(ok("zai-org/GLM-5.3-Flash").moe).toBe(true); // n_routed_experts
    expect(ok("openai/gpt-oss-120b").moe).toBe(true); // num_local_experts
    expect(ok("google/gemma-4-31B-it").moe).toBe(false);
    expect(ok("stepfun-ai/Step-3.7-Flash").moe).toBe(true); // moe_num_experts
    expect(ok("Qwen/Qwen3.8-27B").moe).toBe(false);
  });

  test("no layer count, an absurd one, a latent-attention config without its rope size, or not an object: skipped with a reason", () => {
    expect(readArch({ hidden_size: 4096, num_attention_heads: 32 })).toEqual({ ok: false, reason: "no_layers" });
    expect(readArch({ num_hidden_layers: 100000, num_attention_heads: 32, hidden_size: 4096 })).toEqual({ ok: false, reason: "no_layers" });
    expect(readArch({ num_hidden_layers: 10, num_attention_heads: 8, hidden_size: 512, kv_lora_rank: 64 })).toEqual({ ok: false, reason: "mla_unreadable" });
    expect(readArch({ num_hidden_layers: 10, hidden_size: 512 })).toEqual({ ok: false, reason: "no_heads" });
    expect(readArch({ num_hidden_layers: 10, num_attention_heads: 7, hidden_size: 512 })).toEqual({ ok: false, reason: "no_head_dim" });
    expect(readArch("config")).toEqual({ ok: false, reason: "no_layers" });
    expect(readArch(null)).toEqual({ ok: false, reason: "no_layers" });
  });
});

describe("activeFromName: the maker's own token for active (A) or effective (E) parameters", () => {
  test("real model names", () => {
    expect(activeFromName("Qwen3.6-35B-A3B")).toBe(3);
    expect(activeFromName("Qwen3-235B-A22B")).toBe(22);
    expect(activeFromName("NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16")).toBe(3);
    expect(activeFromName("LFM2.5-8B-A1B")).toBe(1);
    expect(activeFromName("gemma-4-E4B-it")).toBe(4);
    expect(activeFromName("gemma-4-26B-A4B-it")).toBe(4);
    expect(activeFromName("Mellum2-12B-A2.5B-Instruct")).toBe(2.5);
  });
  test("names without a token say nothing", () => {
    for (const n of ["gpt-oss-120b", "Qwen3.8-27B", "GLM-5.3-Flash", "Llama-3.1-8B-Instruct", "Qwen3.8-Flash-Next", "DeepSeek-V4-Flash", "granite-4.2-8b", "MiniMax-M2.7", "Phi-4", "AREX-2"]) expect(activeFromName(n)).toBeNull();
  });
});

describe("readArch: catalog architecture bounds", () => {
  const base = { num_hidden_layers: 16, num_attention_heads: 32, num_key_value_heads: 8, head_dim: 128 };
  test("KV heads include the upper bound; explicit invalid values cannot fall back", () => {
    expect(readArch({ ...base, num_key_value_heads: 256 }).ok).toBe(true);
    for (const n of [0, -1, 1.5, 257, 4097, NaN, Infinity]) {
      expect(readArch({ ...base, num_key_value_heads: n })).toEqual({ ok: false, reason: "no_heads" });
      expect(readArch({ ...base, num_key_value_heads: undefined, num_attention_groups: n })).toEqual({ ok: false, reason: "no_heads" });
      expect(readArch({ ...base, num_key_value_heads: undefined, num_attention_heads: n }).ok).toBe(false);
    }
  });
  test("head dimensions include the upper bound, including derived dimensions", () => {
    expect(readArch({ ...base, head_dim: 1024 }).ok).toBe(true);
    expect(readArch({ ...base, head_dim: undefined, hidden_size: 32768 }).ok).toBe(true);
    for (const n of [0, -1, 1.5, 1025, 4097, NaN, Infinity]) {
      expect(readArch({ ...base, head_dim: n, hidden_size: 4096 })).toEqual({ ok: false, reason: "no_head_dim" });
    }
    expect(readArch({ ...base, head_dim: undefined, hidden_size: 65536 })).toEqual({ ok: false, reason: "no_head_dim" });
  });
  test("sliding and global heads and dimensions follow the same bounds", () => {
    const sliding = { ...base, layer_types: Array(16).fill("sliding_attention"), sliding_window: 1024 };
    expect(readArch({ ...sliding, num_global_key_value_heads: 256, global_head_dim: 1024 }).ok).toBe(true);
    expect(readArch({ ...sliding, num_global_key_value_heads: 257 })).toEqual({ ok: false, reason: "no_heads" });
    expect(readArch({ ...sliding, global_head_dim: 1025 })).toEqual({ ok: false, reason: "no_head_dim" });
    expect(readArch({ ...sliding, num_key_value_heads: 257 }).ok).toBe(false);
    expect(readArch({ ...sliding, head_dim: 1025 }).ok).toBe(false);
  });
});
