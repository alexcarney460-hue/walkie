// LOCAL-MODELS-HF-1 item 7: which Hub models are candidates. Quantization repositories collapse to their base model, a
// maker's own `<name>-GGUF` collapses without a base_model tag, and the base must be a current, original, chat-capable
// release from an established maker. Real list items from test/fixtures/pool-hf/lists.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { collapse, continuesAnother, idFor, isCurrent, isEstablished, isNotPlainChat, isOriginal, licenseOf, nameIsCheckpoint, MIN_FOLLOWERS } from "../../src/pool/hf/candidates.ts";
import { ListItem, parseItems } from "../../src/pool/hf/schemas.ts";
import { HF_FIXTURES } from "../helpers/hf-fixtures.ts";

const items = readdirSync(join(HF_FIXTURES, "lists")).flatMap((f) => parseItems(JSON.parse(readFileSync(join(HF_FIXTURES, "lists", f), "utf8")), ListItem, 1000).items);
const groups = collapse(items);

describe("collapse: quantization repositories become their base model", () => {
  test("every 'quantized' repository counts for its base, with its 30-day downloads summed", () => {
    const g = groups.get("Qwen/Qwen3.6-35B-A3B")!;
    expect(g.repos.length).toBeGreaterThan(1);
    expect(g.repos.every((r) => items.find((i) => i.id === r.id)?.baseModels?.models[0]?.id === "Qwen/Qwen3.6-35B-A3B")).toBe(true);
    const unique = new Map(items.filter((i) => i.baseModels?.models[0]?.id === "Qwen/Qwen3.6-35B-A3B").map((i) => [i.id, i.downloads ?? 0]));
    expect(g.downloads).toBe([...unique.values()].reduce((a, b) => a + b, 0));
  });

  test("a maker's own '<name>-GGUF' with no base_model tag collapses to '<name>' and is kept apart as its own", () => {
    const g = groups.get("ornith-ai/Ornith-1.5-9B")!;
    expect(g.own.map((r) => r.id)).toEqual(["ornith-ai/Ornith-1.5-9B-GGUF"]);
    expect(g.downloads).toBeGreaterThanOrEqual(5_059_834);
  });

  test("a repository labelled a fine-tune, adapter or merge of something is not a quantization of it", () => {
    for (const r of ["5oo6w32cu/Qwen3.8-27B-Uncensored-Q8_0-GGUF", "Jackrong/Qwen3.5-9B-Claude-4.6-Opus-Reasoning-Distilled-v2-GGUF", "emperorofrome/Gmcoder"]) {
      expect(items.some((i) => i.id === r)).toBe(true);
      for (const g of groups.values()) expect([...g.repos, ...g.own].some((x) => x.id === r)).toBe(false);
    }
  });

  test("a repository with neither a base nor a '-GGUF' name is not anyone's quantization", () => {
    expect([...groups.values()].some((g) => [...g.repos, ...g.own].some((x) => x.id === "HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive"))).toBe(false);
  });

  test("the earliest date among a base's GGUF repositories is kept: a model cannot be newer than its own quantizations", () => {
    expect(groups.get("Qwen/Qwen3-8B")!.first).toBe("2025-04-28T12:58:24.000Z"); // the earliest of five quantization repositories
    expect(groups.get("Qwen/Qwen3.8-27B")!.first! >= "2026-08-05").toBe(true);
    const q = (id: string, createdAt?: string) => ({ id, downloads: 1, ...(createdAt ? { createdAt } : {}), baseModels: { relation: "quantized", models: [{ id: "m/X" }] } });
    const g = collapse([q("u/X-GGUF", "2026-03-01T00:00:00.000Z"), q("v/X-GGUF", "2026-02-01T00:00:00.000Z"), q("w/X-GGUF")]).get("m/X")!;
    expect(g.first).toBe("2026-02-01T00:00:00.000Z"); // a repository with no date says nothing
    expect(collapse([q("w/X-GGUF")]).get("m/X")!.first).toBeUndefined();
  });

  test("synthetic: lower-case '-gguf', and an owner/name that would not be a valid repository is dropped", () => {
    const g = collapse([{ id: "datalab-to/surya-ocr-2-gguf", downloads: 5 }, { id: "a/b-GGUF", downloads: 1, baseModels: { relation: "quantized", models: [] } }, { id: "x/GGUF", downloads: 2 }]);
    expect(g.get("datalab-to/surya-ocr-2")!.own[0]!.id).toBe("datalab-to/surya-ocr-2-gguf");
    expect(g.get("a/b")!.own).toHaveLength(1); // a base_model with no models listed: the name rule applies
    expect([...g.keys()]).not.toContain("x/");
  });
});

describe("rules", () => {
  test("established maker: an organisation with at least 1,000 followers", () => {
    expect(MIN_FOLLOWERS).toBe(1000);
    expect(isEstablished({ name: "ornith-ai", numFollowers: 3658 })).toBe(true);
    expect(isEstablished({ name: "poolside", numFollowers: 1610 })).toBe(true);
    expect(isEstablished({ name: "XingChen-AGI", numFollowers: 300 })).toBe(false);
    expect(isEstablished({ name: "x", numFollowers: 999 })).toBe(false);
    expect(isEstablished(null)).toBe(false); // a person's account answers 404
  });

  test("original release: no base, or a base by the same author (Qwen3-8B of Qwen3-8B-Base); not a fine-tune of someone else's weights", () => {
    expect(isOriginal(undefined, "Qwen")).toBe(true);
    expect(isOriginal({ relation: "finetune", models: [{ id: "Qwen/Qwen3-8B-Base" }] }, "Qwen")).toBe(true);
    expect(isOriginal({ relation: "finetune", models: [{ id: "google/gemma-4-12B" }] }, "google")).toBe(true);
    expect(isOriginal({ relation: "finetune", models: [{ id: "Qwen/Qwen3.8-27B" }] }, "orcarouter")).toBe(false);
    expect(isOriginal({ relation: "merge", models: [{ id: "Qwen/Qwen3.6-27B" }, { id: "Qwen/Qwen3.8-27B" }] }, "JetBrains")).toBe(false);
    expect(isOriginal({ relation: "finetune", models: [{ id: "QWEN/Qwen3-8B-Base" }] }, "Qwen")).toBe(true); // the Hub's owner names are case-insensitive
    expect(isOriginal({ relation: "finetune", models: [] }, "x")).toBe(true);
  });

  test("a model whose name continues another maker's model name is that model's fine-tune, with or without base_model metadata", () => {
    const all = [...groups.keys()];
    expect(all).toContain("ReadyArt/gemma-4-31B-it-scotoma-2"); // a real Hub entry: no base_model, 31B, 250 thousand downloads
    expect(all).toContain("google/gemma-4-31B-it");
    expect(continuesAnother("ReadyArt/gemma-4-31B-it-scotoma-2", all)).toBe(true);
    expect(continuesAnother("google/gemma-4-31B-it", all)).toBe(false);
    expect(continuesAnother("unsloth/gemma-4-12b-it", ["google/gemma-4-12B-it"])).toBe(false); // the same name: that is the base_model rule's case
    expect(continuesAnother("google/gemma-4-12B-it-qat", ["google/gemma-4-12B-it"])).toBe(false); // the same maker's own variant
    expect(continuesAnother("x/ab-1", ["y/ab"])).toBe(false); // a very short name is no evidence
    expect(continuesAnother("someone/QWEN3.8-27B-Uncensored-X", ["Qwen/Qwen3.8-27B"])).toBe(true); // case-insensitive
  });

  test("checkpoints and quantised copies by name; BF16 in a name is fine", () => {
    for (const n of ["Qwen3.5-2B-Base", "Qwen3-0.6B-Base", "gemma-4-12B-it-qat-q4_0-unquantized", "Llama-3.1-8B-pt", "gemma-3-1b-pt", "Qwen3.8-27B-NVFP4", "Foo-7B-AWQ", "Foo-7B-GPTQ-Int4", "Foo-7B-FP8", "Foo-GGUF", "model-4bit"]) expect(nameIsCheckpoint(n)).toBe(true);
    for (const n of ["NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16", "gpt-oss-20b", "Qwen3.8-27B", "gemma-4-E4B-it", "Llama-3.1-8B-Instruct", "Ornith-1.5-9B", "Kimi-K2-Instruct", "baseline-7B", "Pythia-7B"]) expect(nameIsCheckpoint(n)).toBe(false);
  });

  test("a speculative-decoding drafter or a text-diffusion model is not a chat model people run, by its name (Liquid AI's real DSpark drafters, Google's DiffusionGemma)", () => {
    for (const n of ["LFM2.5-2.6B-DSpark", "LFM2.5-8B-A1B-DSpark", "Qwen3.6-27B-DFlash", "Foo-7B-Draft", "Foo-7B-drafter", "Foo-70B-speculator", "diffusiongemma-26B-A4B-it", "LLaDA-Diffusion-8B"]) expect(nameIsCheckpoint(n)).toBe(true);
    for (const n of ["LFM2.5-2.6B", "LFM2.5-8B-A1B", "Eagle-7B", "Drafty-7B", "Qwen3-Next-80B-A3B-Thinking", "Sparkle-7B", "Mellum2-12B-A2.5B-Instruct"]) expect(nameIsCheckpoint(n)).toBe(false); // Eagle-7B is a real RWKV chat model
  });

  test("by the Hub's own tags: a drafter says 'draft-model' / 'speculative-decoding', a text-diffusion model has a diffusion architecture tag", () => {
    expect(isNotPlainChat(["sglang", "safetensors", "qwen3", "speculative-decoding", "dspark", "lfm2", "draft-model", "text-generation"])).toBe(true); // LiquidAI/LFM2.5-2.6B-DSpark
    expect(isNotPlainChat(["transformers", "safetensors", "diffusion_gemma", "image-text-to-text", "conversational"])).toBe(true); // google/diffusiongemma-26B-A4B-it
    expect(isNotPlainChat(["transformers", "safetensors", "qwen3_5", "image-text-to-text", "conversational", "license:apache-2.0"])).toBe(false);
    expect(isNotPlainChat(["diffusers"])).toBe(false); // image diffusion libraries are not text diffusion, and have no chat pipeline anyway
    expect(isNotPlainChat(undefined)).toBe(false);
    expect(isNotPlainChat([])).toBe(false);
  });

  test("current: created within 16 months", () => {
    const now = new Date("2026-10-01T23:00:00Z");
    expect(isCurrent("2026-08-05T08:22:59.000Z", now)).toBe(true);
    expect(isCurrent("2025-08-04T00:00:00.000Z", now)).toBe(true); // gpt-oss, 14 months
    expect(isCurrent("2025-06-02T00:00:00.000Z", now)).toBe(true);
    expect(isCurrent("2025-05-31T00:00:00.000Z", now)).toBe(false);
    expect(isCurrent("2025-04-27T05:00:00.000Z", now)).toBe(false); // Qwen3-8B
    expect(isCurrent("2099-01-01T00:00:00.000Z", now)).toBe(true);
    expect(isCurrent("garbage", now)).toBe(false);
  });

  test("a catalog id from the repository name: lower case, [a-z0-9.-], at most 48", () => {
    expect(idFor("Qwen3.8-27B")).toBe("qwen3.8-27b");
    expect(idFor("NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16")).toBe("nvidia-nemotron-3.5-lightning-30b-a3b-bf16");
    expect(idFor("gemma-4-E4B-it")).toBe("gemma-4-e4b-it");
    expect(idFor("a__b  c")).toBe("a-b-c");
    expect(idFor("x".repeat(80))).toHaveLength(48);
    expect(idFor("---")).toBeNull();
    expect(idFor("é")).toBeNull();
  });

  test("licence from the tags; a stranger's text is cut down to plain characters", () => {
    expect(licenseOf(["transformers", "license:apache-2.0", "region:us"])).toBe("apache-2.0");
    expect(licenseOf(["license:other", "license:llama3.3"])).toBe("other");
    expect(licenseOf(["transformers"])).toBe("see the model card");
    expect(licenseOf(["license:<b>x</b>"])).toBe("b x b");
    expect(licenseOf(undefined)).toBe("see the model card");
  });
});
