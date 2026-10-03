// LOCAL-MODELS-HF-1 item 7: the whole pipeline, from the Hub's answers to a catalog, against the trimmed real responses
// in test/fixtures/pool-hf (a fake Hub; nothing touches the network). Fetch, validate, collapse, filter, size from the
// GGUF files, read the architecture, rate by benchmarks, and say what was left out and why.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG, memoryNeeded, rankModels, ratedPlace } from "../../src/pool/catalog.ts";
import { CatalogSchema } from "../../src/pool/catalog-schema.ts";
import { buildCatalog } from "../../src/pool/hf/build.ts";
import { DEFAULTS, HfClient, HfError } from "../../src/pool/hf/client.ts";
import { RATING_RULES } from "../../src/pool/hf/quality.ts";
import { fakeHub, HF_FIXTURES } from "../helpers/hf-fixtures.ts";

const GiB = 1024 ** 3;
const NOW = new Date("2026-10-01T23:00:00Z");

async function build(hub = fakeHub(), over: Partial<Parameters<typeof buildCatalog>[0]> = {}) {
  const client = new HfClient({ fetch: hub.fetch });
  const r = await buildCatalog({ client, now: NOW, ...over });
  return { r, hub, model: (id: string) => r.catalog.models.find((m) => m.id === id)! };
}
const reasons = (r: Awaited<ReturnType<typeof build>>["r"]): Record<string, string> => Object.fromEntries(r.skips.map((s) => [s.repo, s.reason]));

describe("what is built", () => {
  test("the catalog the fixtures give: current original models from established makers with a standard 4-bit GGUF and readable numbers", async () => {
    const { r } = await build();
    expect(r.catalog.models.map((m) => m.id).sort()).toEqual([
      "gemma-4-12b-it", "gemma-4-31b-it", "gemma-4-e4b-it", "gpt-oss-120b", "gpt-oss-20b", "laguna-s-2.1", "lfm2.5-1.2b-instruct",
      "lfm2.5-8b-a1b", "ling-3.0-flash", "nvidia-nemotron-3.5-lightning-30b-a3b-bf16", "ornith-1.5-9b", "qwen3.5-9b", "qwen3.6-35b-a3b",
      "qwen3.8-27b", "qwen3.8-flash-next", "step-3.7-flash",
    ]);
    expect(CatalogSchema.safeParse(r.catalog).success).toBe(true);
    expect(r.catalog.origin).toEqual({ kind: "huggingface", at: "2026-10-01T23:00:00.000Z" });
    expect(r.catalog.updated).toBe("2026-10-01");
    expect(r.catalog.context_tokens).toBe(CATALOG.context_tokens);
  });

  test("what was left out, and why", async () => {
    const { r } = await build();
    const why = reasons(r);
    expect(why["orcarouter/Qwen3.8-27B-Uncensored"]).toBe("derivative");
    expect(why["unsloth/Qwen3.5-9B"]).toBe("derivative");
    expect(why["XingChen-AGI/Xing4.0-29B-A4B"]).toBe("not_established");
    expect(why["ReadyArt/gemma-4-31B-it-scotoma-2"]).toBe("derivative"); // a fine-tune of Google's Gemma with no base_model, named after it
    expect(why["Qwen/Qwen3.5-2B-Base"]).toBe("checkpoint");
    expect(why["LiquidAI/LFM2.5-2.6B-DSpark"]).toBe("checkpoint"); // a speculative-decoding drafter (0.33B), a same-maker fine-tune that no base_model rule catches
    expect(why["LiquidAI/LFM2.5-8B-A1B-DSpark"]).toBe("checkpoint");
    expect(why["google/diffusiongemma-26B-A4B-it"]).toBe("checkpoint"); // a text-diffusion model: its speed is not bytes read per token
    expect(why["Qwen/Qwen3-8B"]).toBe("old");
    expect(why["ornith-ai/Ornith-1.0-35B"]).toBe("bad_params"); // safetensors.total reads 664944
    expect(why["google/gemma-3n-E4B-it"]).toBe("no_config"); // gated: its config.json needs a login
    expect(why["zai-org/GLM-5.3-Flash"]).toBe("no_gguf"); // only Q8_0 and BF16 in the trusted repositories
    expect(why["zai-org/GLM-4.7-Flash"]).toBe("no_active"); // a Mixture of Experts whose card states no active parameters
    expect(r.skipped.derivative).toBe(5); // + two of DavidAU's "Uncensored" Qwen fine-tunes, caught by name before anyone looks them up
    expect(Object.values(r.skipped).reduce((a, b) => a + b, 0)).toBe(r.skips.length);
  });
});

describe("a model's numbers", () => {
  test("Qwen3.8-27B: sized from the 4-bit and 8-bit files of Unsloth's repository, hybrid layers read from the config", async () => {
    const { model } = await build();
    const m = model("qwen3.8-27b");
    expect(m).toMatchObject({
      name: "Qwen3.8-27B", maker: "Qwen", active_b: null, license: "apache-2.0", released: "2026-08-05", gguf_repo: "unsloth/Qwen3.8-27B-GGUF",
      source: "https://huggingface.co/Qwen/Qwen3.8-27B", config_source: "https://huggingface.co/Qwen/Qwen3.8-27B/blob/main/config.json", verified: true,
      arch: { layers: 64, kv_heads: 4, head_dim: 256, hybrid: { full_layers: 16 } },
    });
    expect(m.params_b).toBeCloseTo(27.78, 2);
    expect(m.weights_gib!.q4).toBeCloseTo(16464440224 / GiB, 2);
    expect(m.weights_gib!.q8).toBeCloseTo(29047086048 / GiB, 2);
    // The stored memory figure is the documented formula over those sizes, plus the KV cache of 16 layers at 8K.
    expect(m.mem_gib.q4).toBeCloseTo(((memoryNeeded(m, "q4") as number) / GiB), 1);
    const kv = (2 * 16 * 4 * 256 * 8192 * 2) / GiB;
    expect(m.mem_gib.q4!).toBeCloseTo(16464440224 / GiB + kv + 1, 1);
  });

  test("Mixture of Experts: active parameters from the name (A3B), from the card (gpt-oss, Step, Flash-Next), effective ones from E4B", async () => {
    const { model } = await build();
    expect(model("qwen3.6-35b-a3b").active_b).toBe(3);
    expect(model("gpt-oss-20b").active_b).toBe(3.6);
    expect(model("gpt-oss-120b").active_b).toBe(5.1);
    expect(model("step-3.7-flash").active_b).toBe(11);
    expect(model("qwen3.8-flash-next").active_b).toBe(6);
    expect(model("gemma-4-e4b-it").active_b).toBe(4);
    expect(model("lfm2.5-8b-a1b").active_b).toBe(1);
    expect(model("ling-3.0-flash").active_b).toBe(5.1);
    expect(model("qwen3.8-27b").active_b).toBeNull();
    expect(model("gemma-4-12b-it").active_b).toBeNull();
    expect(model("qwen3.6-35b-a3b").note).toContain("Mixture of experts");
  });

  test("the file sizes decide the 4-bit and 8-bit memory: a sharded model sums its shards, a model with no Q8_0 has no 8-bit figure", async () => {
    const { model } = await build();
    const next = model("qwen3.8-flash-next");
    expect(next.gguf_repo).toBe("bartowski/Qwen3.8-Flash-Next-GGUF"); // Unsloth's repository lists no 4-bit file: the next trusted one is used
    expect(next.weights_gib!.q4).toBeCloseTo((39956571840 + 39505063904 + 39652077728 + 485316608) / GiB, 2);
    expect(model("gpt-oss-120b").weights_gib!.q8).toBeNull();
    expect(model("gpt-oss-120b").mem_gib.q8).toBeNull();
    expect(memoryNeeded(model("gpt-oss-120b"), "q8")).toBeNull();
  });

  test("an own '-GGUF' repository without a base_model tag is used (Ornith 1.5 9B), and a repository from outside the trusted set never is", async () => {
    const { model, r } = await build();
    expect(model("ornith-1.5-9b").gguf_repo).toBe("ornith-ai/Ornith-1.5-9B-GGUF");
    for (const m of r.catalog.models) expect(["Qwen", "unsloth", "bartowski", "lmstudio-community", "ggml-org", "openai", "google", "LiquidAI", "ornith-ai", "nvidia", "inclusionAI", "stepfun-ai", "poolside"]).toContain(m.gguf_repo!.split("/")[0]!);
  });

  test("every stored memory figure is the formula (weights + KV cache at 8K + overhead), the same check the shipped list passes", async () => {
    const { r } = await build();
    for (const m of r.catalog.models) {
      for (const q of ["q4", "q8"] as const) {
        const need = memoryNeeded(m, q, r.catalog.context_tokens, r.catalog);
        if (m.mem_gib[q] === null) expect(need).toBeNull();
        else expect(Math.abs((need as number) / GiB - (m.mem_gib[q] as number))).toBeLessThanOrEqual(0.05);
      }
    }
  });
});

describe("quality", () => {
  test("PR-associated results are excluded; eligible sparse self-reports retain values without a rating", async () => {
    const { model } = await build();
    expect(model("qwen3.8-27b").quality).toEqual({ basis: "unrated", rules: RATING_RULES });
    expect(model("lfm2.5-1.2b-instruct").quality).toEqual({ basis: "unrated", scores: { GPQA: 38.9 }, rules: RATING_RULES });
    expect(model("lfm2.5-8b-a1b").quality?.basis).toBe("unrated");
  });

  test("without enough admitted evidence, fixture models use unrated ordering and have no rated place", async () => {
    const { r, model } = await build();
    const ranked = rankModels(r.catalog.models).map((m) => m.id);
    expect(ranked.indexOf("qwen3.8-27b")).toBeLessThan(ranked.indexOf("gpt-oss-120b"));
    expect(ranked.indexOf("qwen3.6-35b-a3b")).toBeLessThan(ranked.indexOf("qwen3.5-9b"));
    expect(r.catalog.models.every((m) => m.quality?.basis === "unrated")).toBe(true);
    expect(ratedPlace(r.catalog, model("qwen3.8-27b"))).toBeNull();
    expect(ranked.slice(-2).every((id) => model(id).quality?.basis === "unrated")).toBe(true);
  });
});

describe("what is not looked at", () => {
  test("a base whose own GGUF repositories are all older than 16 months is old without a request: it cannot be newer than they are", async () => {
    const { r, hub } = await build();
    expect(reasons(r)["Qwen/Qwen3-8B"]).toBe("old");
    expect(hub.calls.some((c) => c.url.includes("/api/models/Qwen/Qwen3-8B?"))).toBe(false);
    expect(hub.calls.some((c) => c.url.includes("/api/models/Qwen/Qwen3.8-27B?"))).toBe(true); // a current one is looked up
  });

  test("drafters and a text-diffusion model are left out by name, before any request is made for them", async () => {
    const { r, hub } = await build();
    expect(hub.calls.some((c) => /DSpark|diffusiongemma/i.test(c.url))).toBe(false);
    expect(r.catalog.models.some((m) => /dspark|diffusion/i.test(m.id))).toBe(false);
  });

  test("by the Hub's tags, after the record: a drafter or a diffusion model with an ordinary name is not a chat model either", async () => {
    const hub = fakeHub();
    const record = (repo: string, extra: string[]): string => {
      const rec = JSON.parse(readFileSync(join(HF_FIXTURES, "models", `${repo.replace("/", "__")}.json`), "utf8")) as { tags: string[] };
      return JSON.stringify({ ...rec, tags: [...rec.tags, ...extra] });
    };
    const answer = (body: string) => () => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    hub.inject("/api/models/Qwen/Qwen3.5-9B?", answer(record("Qwen/Qwen3.5-9B", ["speculative-decoding", "draft-model"])));
    hub.inject("/api/models/Qwen/Qwen3.6-35B-A3B?", answer(record("Qwen/Qwen3.6-35B-A3B", ["diffusion_gemma"])));
    const { r } = await build(hub);
    expect(reasons(r)["Qwen/Qwen3.5-9B"]).toBe("not_chat");
    expect(reasons(r)["Qwen/Qwen3.6-35B-A3B"]).toBe("not_chat");
    expect(r.catalog.models.some((m) => m.id === "qwen3.5-9b" || m.id === "qwen3.6-35b-a3b")).toBe(false);
    expect(r.catalog.models.some((m) => m.id === "qwen3.8-27b")).toBe(true); // the rest is untouched
  });

  test("a request budget that runs short part-way keeps what was read: the least downloaded bases are left out, and it says so", async () => {
    const full = await build(fakeHub(), { concurrency: 1 });
    const n = full.hub.calls.length;
    const hub = fakeHub();
    const client = new HfClient({ fetch: hub.fetch, maxRequests: Math.floor(n * 0.8) });
    const r = await buildCatalog({ client, now: NOW, concurrency: 1 });
    expect(r.skipped.budget).toBeGreaterThan(0);
    expect(r.catalog.models.length).toBeGreaterThanOrEqual(5);
    expect(r.catalog.models.length).toBeLessThan(full.r.catalog.models.length);
    expect(client.requests).toBeLessThanOrEqual(Math.floor(n * 0.8));
    const fullIds = new Set(full.r.catalog.models.map((m) => m.id));
    expect(r.catalog.models.every((m) => fullIds.has(m.id))).toBe(true);
    expect(CatalogSchema.safeParse(r.catalog).success).toBe(true);
  });
});

describe("how it asks", () => {
  test("plain GETs to huggingface.co only, within the request budget and the Hub's anonymous windows", async () => {
    const { hub } = await build();
    expect(hub.calls.length).toBeLessThanOrEqual(DEFAULTS.maxRequests);
    expect(hub.count("api")).toBeLessThan(500);
    for (const c of hub.calls) {
      expect(c.method).toBe("GET");
      expect(new URL(c.url).origin).toBe("https://huggingface.co");
      expect(Object.keys(c.headers).sort()).toEqual(["accept", "user-agent"]);
    }
    expect(hub.calls.filter((c) => c.url.includes("/api/models?filter=gguf&pipeline_tag="))).toHaveLength(5);
  });

  test("deterministic: the same answers give the same catalog", async () => {
    const a = await build();
    const b = await build();
    expect(JSON.stringify(a.r.catalog)).toBe(JSON.stringify(b.r.catalog));
  });

  test("a config.json is fetched only for models that got through every cheaper check", async () => {
    const { hub } = await build();
    const configs = hub.calls.filter((c) => c.url.includes("/resolve/main/config.json")).map((c) => c.url);
    expect(configs.some((u) => u.includes("Qwen3-8B"))).toBe(false); // too old
    expect(configs.some((u) => u.includes("Qwen3.5-2B-Base"))).toBe(false); // a checkpoint
    expect(configs.some((u) => u.includes("Xing4.0"))).toBe(false); // not an established maker
  });
});

describe("when the Hub does not cooperate", () => {
  test("offline: the refresh fails as 'offline'", async () => {
    const down = (async () => { throw new TypeError("Unable to connect"); }) as unknown as typeof fetch;
    const err = await buildCatalog({ client: new HfClient({ fetch: down }), now: NOW }).catch((e) => e as HfError);
    expect((err as HfError).kind).toBe("offline");
  });

  test("rate limited part-way: the refresh fails as 'rate_limited', it does not publish half a list", async () => {
    const hub = fakeHub();
    hub.inject("/api/models/", () => new Response("slow down", { status: 429 }), 100);
    const err = await buildCatalog({ client: new HfClient({ fetch: hub.fetch }), now: NOW }).catch((e) => e as HfError);
    expect((err as HfError).kind).toBe("rate_limited");
  });

  test("the Hub's window nearly used up: the refresh stops rather than be cut off", async () => {
    const hub = fakeHub({ limits: { api: 60, resolvers: 3000 } });
    const err = await buildCatalog({ client: new HfClient({ fetch: hub.fetch }), now: NOW }).catch((e) => e as HfError);
    expect((err as HfError).kind).toBe("rate_limited");
  });

  test("one repository answering 500, or garbage, skips that model only", async () => {
    const hub = fakeHub();
    hub.inject("/api/models/Qwen/Qwen3.5-9B?", () => new Response("boom", { status: 500 }));
    hub.inject("/api/models/google/gemma-4-31B-it?", () => new Response("not json", { status: 200 }));
    const { r } = await build(hub);
    const why = reasons(r);
    expect(why["Qwen/Qwen3.5-9B"]).toBe("error");
    expect(why["google/gemma-4-31B-it"]).toBe("error");
    expect(r.catalog.models.some((m) => m.id === "qwen3.8-27b")).toBe(true);
  });

  test("lists that are not lists, all five: 'malformed'", async () => {
    const hub = fakeHub();
    hub.inject("/api/models?filter=gguf", () => new Response(JSON.stringify({ error: "nope" }), { status: 200 }), 5);
    const err = await buildCatalog({ client: new HfClient({ fetch: hub.fetch }), now: NOW }).catch((e) => e as HfError);
    expect((err as HfError).kind).toBe("malformed");
  });

  test("too few usable models (a catalog needs at least five): 'malformed'", async () => {
    const err = await buildCatalog({ client: new HfClient({ fetch: fakeHub().fetch }), now: NOW, minModels: 40 }).catch((e) => e as HfError);
    expect((err as HfError).kind).toBe("malformed");
    expect((err as HfError).message).toContain("16");
  });
});

describe("for the built-in list (pins)", () => {
  test("every file of a pinned model carries its sha256 and the repository's revision, from the same trusted repositories", async () => {
    const { r } = await build(fakeHub(), { pins: true });
    const p = r.pins.get("qwen3.8-27b")!;
    expect(p.repo).toBe("unsloth/Qwen3.8-27B-GGUF");
    expect(p.revision).toBe("4ca720788d1e01f1bff70c033e0d0028fd02e502");
    expect(p.q4).toEqual([{ path: "Qwen3.8-27B-UD-Q4_K_M.gguf", size: 16464440224, sha256: "322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482" }]);
    expect(p.q8!.map((f) => f.sha256?.length)).toEqual([64]);
    expect(r.pins.size).toBe(r.catalog.models.length);
  });
});
