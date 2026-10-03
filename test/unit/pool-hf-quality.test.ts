// LOCAL-MODELS-HF-1 item 7: "best" is quality, not size or popularity. Hugging Face evaluation results (self-reported
// benchmark scores, real ones in test/fixtures/pool-hf/models) are combined into one ability per model by a one-factor
// fit. Historical fit controls explicitly allow two results; production admission requires three.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BENCHMARKS, benchmarkValues, qualityOf, RATING_RULES, rateModels } from "../../src/pool/hf/quality.ts";
import { compareModels, rankModels, ratedPlace, type CatalogModel } from "../../src/pool/catalog.ts";
import { catalogOf, mk, rated } from "../helpers/pool-catalog.ts";
import { HF_FIXTURES } from "../helpers/hf-fixtures.ts";

const ids = BENCHMARKS.map((b) => b.id);
const [B0, B1, B2, B3, B4] = ids as [string, string, string, string, string];

/** A deterministic pseudo-random sequence (a small LCG), so the synthetic tables are the same on every run. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}
const obsOf = (rows: Record<string, Record<string, number>>): Map<string, Map<string, number>> =>
  new Map(Object.entries(rows).map(([m, r]) => [m, new Map(Object.entries(r))]));

const spearman = (a: number[], b: number[]): number => {
  const rank = (xs: number[]) => xs.map((x) => xs.filter((y) => y < x).length);
  const ra = rank(a), rb = rank(b);
  const n = a.length;
  const d2 = ra.reduce((s, r, i) => s + (r - rb[i]!) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
};

describe("the benchmark list", () => {
  test("a fixed, reviewable list of nine text benchmarks with plain labels", () => {
    expect(BENCHMARKS.map((b) => b.label)).toEqual(["MMLU-Pro", "GPQA", "HLE", "SWE-bench Verified", "SWE-bench Pro", "Terminal-Bench 2.1", "AIME 2026", "HMMT Feb 2026", "IFStruct"]);
    expect(new Set(ids).size).toBe(9);
  });

  test("benchmarkValues: only listed datasets, a percentage in (1, 100], the lowest value when a benchmark is reported twice", () => {
    const v = benchmarkValues([
      { dataset: "Idavidrein/gpqa", value: 81.7 }, { dataset: "Idavidrein/gpqa", value: 84.3 },
      { dataset: "TIGER-Lab/MMLU-Pro", value: 0 }, { dataset: "cais/hle", value: 101 }, { dataset: "cais/hle", value: Number.NaN },
      { dataset: "internlm/WildClawBench", value: 516 }, { dataset: "evil/benchmark", value: 99 }, { dataset: "MathArena/aime_2026", value: 92.5 },
    ]);
    expect(Object.fromEntries(v)).toEqual({ "Idavidrein/gpqa": 81.7, "MathArena/aime_2026": 92.5 });
  });
});

describe("rateModels: the one-factor fit", () => {
  // 30 models of known ability; five benchmarks of different difficulty and spread; each model reports 2 to 5 of them.
  const truth = Array.from({ length: 30 }, (_, i) => -1.5 + i * 0.1);
  const scale: Record<string, [number, number]> = { [B0]: [70, 12], [B1]: [60, 20], [B2]: [30, 14], [B3]: [55, 18], [B4]: [80, 8] };
  function table(noise = 0, seed = 7): Map<string, Map<string, number>> {
    const rnd = lcg(seed);
    const rows: Record<string, Record<string, number>> = {};
    truth.forEach((a, i) => {
      const how = 2 + Math.floor(rnd() * 4);
      const pick = [B0, B1, B2, B3, B4].sort(() => rnd() - 0.5).slice(0, how);
      rows[`m${String(i).padStart(2, "0")}`] = Object.fromEntries(pick.map((b) => [b, Math.min(100, Math.max(1, scale[b]![0] + scale[b]![1] * (a + noise * (rnd() - 0.5))))]));
    });
    return obsOf(rows);
  }

  test("recovers the order of the true abilities (rank correlation 0.95 or better) from noise-free sparse results", () => {
    const { scores } = rateModels(table(), { minReporters: 4, minResults: 2 });
    const names = [...scores.keys()].sort();
    expect(names.length).toBe(30);
    expect(spearman(names.map((n) => scores.get(n)!), names.map((n) => truth[Number(n.slice(1))]!))).toBeGreaterThan(0.95);
  });

  test("still close with noise in the results", () => {
    const { scores } = rateModels(table(0.6, 11), { minReporters: 4, minResults: 2 });
    const names = [...scores.keys()].sort();
    expect(spearman(names.map((n) => scores.get(n)!), names.map((n) => truth[Number(n.slice(1))]!))).toBeGreaterThan(0.85);
  });

  test("rescaling a benchmark (a different unit or difficulty) changes no model's place", () => {
    const base = table();
    const stretched = new Map([...base].map(([m, r]) => [m, new Map([...r].map(([b, v]) => [b, b === B2 ? 0.5 * v + 10 : v]))]));
    const a = rateModels(base, { minReporters: 4, minResults: 2 }).scores;
    const b = rateModels(stretched, { minReporters: 4, minResults: 2 }).scores;
    const order = (s: Map<string, number>) => [...s.entries()].sort((x, y) => y[1] - x[1]).map(([m]) => m);
    expect(order(b)).toEqual(order(a));
  });

  test("a model that beats another on every benchmark both report is rated higher", () => {
    const t = table();
    t.set("ace", new Map([[B0, 99], [B1, 99]]));
    t.set("dud", new Map([[B0, 5], [B1, 5]]));
    const { scores } = rateModels(t, { minReporters: 4, minResults: 2 });
    expect(scores.get("ace")!).toBeGreaterThan(scores.get("dud")!);
  });

  test("fewer than two results: not rated (one self-reported number does not crown a model); a benchmark few models report is ignored", () => {
    const t = table();
    t.set("thin", new Map([[B0, 99]]));
    t.set("tiny-bench", new Map([[B0, 50], [ids[8]!, 99]])); // IFStruct is reported by this model alone
    const { scores, benchmarks } = rateModels(t, { minReporters: 4, minResults: 2 });
    expect(scores.has("thin")).toBe(false);
    expect(benchmarks).not.toContain(ids[8]!);
    expect(scores.has("tiny-bench")).toBe(false); // its second result is on a benchmark nobody else reports
  });

  test("the same strength on two results rates below the same strength on five (the cautious bound)", () => {
    const t = table();
    const strong = { [B0]: 82, [B1]: 84, [B2]: 54, [B3]: 70, [B4]: 87 };
    t.set("five", new Map(Object.entries(strong)));
    t.set("two", new Map(Object.entries({ [B0]: 82, [B1]: 84 })));
    const { scores } = rateModels(t, { minReporters: 4, minResults: 2 });
    expect(scores.get("five")!).toBeGreaterThan(scores.get("two")!);
  });

  test("too few rated models, or no benchmark enough models report: nothing is rated", () => {
    expect(rateModels(obsOf({ a: { [B0]: 1, [B1]: 2 }, b: { [B0]: 3, [B1]: 4 } })).scores.size).toBe(0);
    expect(rateModels(new Map()).scores.size).toBe(0);
  });

  test("deterministic: the same results give the same scores", () => {
    const a = rateModels(table(), { minReporters: 4, minResults: 2 }).scores;
    const b = rateModels(table(), { minReporters: 4, minResults: 2 }).scores;
    expect([...a]).toEqual([...b]);
  });
});

// Historical numeric controls intentionally omit provenance and allow two results.
// Admission and the production threshold are covered in pool-hf-eval-admission.test.ts.
describe("on the historical numeric evaluation results of 25 models", () => {
  const records = readdirSync(join(HF_FIXTURES, "models")).map((f) => ({
    repo: f.replace(".json", "").replace("__", "/"),
    json: JSON.parse(readFileSync(join(HF_FIXTURES, "models", f), "utf8")) as { evalResults: { data?: { dataset: { id: string }; value: number } }[] },
  }));
  const values = new Map(records.map((r) => [r.repo, benchmarkValues(r.json.evalResults.flatMap((e) => (e.data ? [{ dataset: e.data.dataset.id, value: e.data.value }] : [])))]));
  const { scores } = rateModels(values, { minReporters: 4, minResults: 2 });
  const s = (repo: string): number => scores.get(repo) ?? Number.NaN;

  test("newer generations of a family outrank the older ones; larger sizes outrank smaller ones of the same generation", () => {
    expect(s("Qwen/Qwen3.8-27B")).toBeGreaterThan(s("Qwen/Qwen3.6-35B-A3B"));
    expect(s("Qwen/Qwen3.6-35B-A3B")).toBeGreaterThan(s("Qwen/Qwen3.5-9B"));
    expect(s("google/gemma-4-31B-it")).toBeGreaterThan(s("google/gemma-4-12B-it"));
    expect(s("google/gemma-4-12B-it")).toBeGreaterThan(s("google/gemma-4-E4B-it"));
    expect(s("openai/gpt-oss-120b")).toBeGreaterThan(s("openai/gpt-oss-20b"));
  });

  test("a recent 27B beats the older, bigger gpt-oss-120b", () => {
    expect(s("Qwen/Qwen3.8-27B")).toBeGreaterThan(s("openai/gpt-oss-120b"));
  });

  test("models with a single result are not rated, however high it is (LFM2.5 8B-A1B reports only AIME)", () => {
    expect(scores.has("LiquidAI/LFM2.5-8B-A1B")).toBe(false);
    expect(values.get("LiquidAI/LFM2.5-8B-A1B")!.size).toBe(1);
  });

  test("qualityOf: rated with its scores by label, or unrated with what it has", () => {
    const q = qualityOf(values.get("Qwen/Qwen3.8-27B")!, scores.get("Qwen/Qwen3.8-27B"));
    expect(q.basis).toBe("rated");
    expect(q.scores).toEqual({ GPQA: 89.2, HLE: 30.8, "SWE-bench Pro": 61.7, "Terminal-Bench 2.1": 73 });
    expect(typeof q.score).toBe("number");
    expect(qualityOf(values.get("LiquidAI/LFM2.5-8B-A1B")!, undefined)).toEqual({ basis: "unrated", scores: { "AIME 2026": 50 }, rules: RATING_RULES });
    expect(qualityOf(new Map(), undefined)).toEqual({ basis: "unrated", rules: RATING_RULES });
  });
});

describe("ranking models (catalog.ts compareModels)", () => {
  const ms = (over: Record<string, Partial<CatalogModel> & { params_b: number }>): CatalogModel[] => Object.entries(over).map(([id, o]) => mk(id, o));
  const order = (models: CatalogModel[]): string[] => rankModels(models).map((m) => m.id);

  test("rated models by score; a newer better model beats an older bigger one", () => {
    const models = ms({
      "old-70b": { params_b: 70, released: "2024-07-01", quality: rated(-0.4) },
      "new-30b": { params_b: 30, released: "2026-08-01", quality: rated(0.7) },
      "mid-120b-moe": { params_b: 120, active_b: 5, released: "2025-08-01", quality: rated(0.0) },
    });
    expect(order(models)).toEqual(["new-30b", "mid-120b-moe", "old-70b"]);
  });

  test("popularity does not crown a small or old model: 50 million downloads rank below a better rated model with none", () => {
    const models = ms({
      "tiny-popular": { params_b: 0.6, released: "2025-04-01", downloads: 50_000_000, quality: rated(-3.0) },
      "unknown-8b": { params_b: 8, released: "2026-05-01", downloads: 10, quality: rated(0.1) },
      "unrated-tiny-popular": { params_b: 0.6, released: "2025-04-01", downloads: 90_000_000 },
    });
    expect(order(models)).toEqual(["unknown-8b", "tiny-popular", "unrated-tiny-popular"]);
  });

  test("unrated models rank after every rated one: newest month first, then effective size (a Mixture of Experts counts sqrt(total x active)), then downloads", () => {
    const models = ms({
      "rated-weak": { params_b: 1, released: "2023-01-01", quality: rated(-9) },
      "unrated-new-small": { params_b: 3, released: "2026-09-10" },
      "unrated-new-big": { params_b: 70, released: "2026-09-02" },
      "unrated-new-moe": { params_b: 120, active_b: 5, released: "2026-09-15" }, // effective 24.5B: below the dense 70B of the same month
      "unrated-old": { params_b: 400, released: "2025-01-01", downloads: 999 },
      "unrated-same-month-more-downloads": { params_b: 70, released: "2026-09-20", downloads: 5 },
    });
    expect(order(models)).toEqual(["rated-weak", "unrated-same-month-more-downloads", "unrated-new-big", "unrated-new-moe", "unrated-new-small", "unrated-old"]);
  });

  test("a catalog with no release dates or ratings (a hand-made one) is ordered by size as before", () => {
    const models = ms({ a: { params_b: 8 }, b: { params_b: 70 }, c: { params_b: 32 } });
    expect(order(models)).toEqual(["b", "c", "a"]);
  });

  test("compareModels is a total order: equal models tie only with themselves", () => {
    const a = mk("a", { params_b: 8, quality: rated(1) });
    const b = mk("b", { params_b: 8, quality: rated(1) });
    expect(compareModels(a, a)).toBe(0);
    expect(Math.sign(compareModels(a, b))).toBe(-Math.sign(compareModels(b, a)));
  });

  test("ratedPlace: '#2 of 3' among the rated ones, null for an unrated model", () => {
    const models = ms({ x: { params_b: 8, quality: rated(0.5) }, y: { params_b: 8, quality: rated(0.9) }, z: { params_b: 8, quality: rated(0.1) }, u: { params_b: 8 } });
    const cat = catalogOf(models);
    expect(ratedPlace(cat, models[0]!)).toEqual({ place: 2, of: 3 });
    expect(ratedPlace(cat, models[3]!)).toBeNull();
  });
});
