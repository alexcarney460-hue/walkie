// The ratings of the list built into Walkie (src/pool/models.json) must be the ones the CURRENT rules produce, and a
// ratings-only refresh must not move anything else. d33393b8 changed the rules (three results, the lowest duplicate, no
// Hub pull-request results) but the built-in list was still rated under the old ones, and nothing could tell offline: every
// stored quality now carries the rules it was produced under (quality.ts RATING_RULES). Offline: no network.
import { describe, expect, test } from "bun:test";
import { CATALOG, type CatalogModel } from "../../src/pool/catalog.ts";
import { CatalogSchema, ModelQualitySchema } from "../../src/pool/catalog-schema.ts";
import { MIN_RESULTS, qualityOf, RATING_RULES } from "../../src/pool/hf/quality.ts";
import { rerate, repoOf } from "../../src/pool/hf/ratings.ts";
import { PINS } from "../../src/pool/run/gguf.ts";
import { catalogOf, mk, rated } from "../helpers/pool-catalog.ts";

describe("every stored quality says which rules produced it", () => {
  test("qualityOf stamps rated and unrated results with the rules in force", () => {
    expect(qualityOf(new Map(), undefined)).toEqual({ basis: "unrated", rules: RATING_RULES });
    expect(qualityOf(new Map([["Idavidrein/gpqa", 61.2]]), undefined)).toEqual({ basis: "unrated", scores: { GPQA: 61.2 }, rules: RATING_RULES });
    expect(qualityOf(new Map([["Idavidrein/gpqa", 61.2]]), 0.5)).toEqual({ basis: "rated", score: 0.5, scores: { GPQA: 61.2 }, rules: RATING_RULES });
  });

  test("the schema accepts the stamp, still accepts an older list without one, and refuses nonsense", () => {
    expect(ModelQualitySchema.safeParse({ basis: "unrated", rules: 2 }).success).toBe(true);
    expect(ModelQualitySchema.safeParse({ basis: "unrated" }).success).toBe(true);
    for (const rules of [0, 1.5, -1, "2", null]) expect(ModelQualitySchema.safeParse({ basis: "unrated", rules }).success).toBe(false);
  });
});

describe("the list built into Walkie was rated under the rules in force", () => {
  test("every model's quality carries the current rules stamp", () => {
    const stale = CATALOG.models.filter((m) => m.quality?.rules !== RATING_RULES).map((m) => m.id);
    expect(stale).toEqual([]);
  });

  test("every rated model has at least the minimum number of results and a score; a Hub pull-request result cannot be in it", () => {
    const rated = CATALOG.models.filter((m) => m.quality?.basis === "rated");
    for (const m of rated) {
      expect(Object.keys(m.quality!.scores ?? {}).length).toBeGreaterThanOrEqual(MIN_RESULTS);
      expect(m.quality!.score).toBeDefined();
      // Results from Hub pull requests are not admitted under the stamped rules (quality.ts), so a stamp at the current
      // rules is the offline proof that none of these values came from one.
      expect(m.quality!.rules).toBe(RATING_RULES);
    }
    // And no unrated model shows a score it was rated by.
    for (const m of CATALOG.models.filter((x) => x.quality?.basis !== "rated")) expect(m.quality?.score).toBeUndefined();
  });

  test("the list and its pins still name the same models", () => {
    expect(CATALOG.models.map((m) => m.id).sort()).toEqual(Object.keys(PINS.models).sort());
    expect(CatalogSchema.safeParse(CATALOG).success).toBe(true);
  });
});

describe("a ratings-only refresh changes nothing but each model's quality", () => {
  const before = catalogOf([
    mk("old-rated", { params_b: 70, released: "2026-06-01", downloads: 9, quality: rated(1.2, { GPQA: 80, HLE: 40 }) }),
    mk("old-unrated", { params_b: 8, released: "2026-05-01", quality: { basis: "unrated", scores: { GPQA: 50 } } }),
    mk("gone", { params_b: 3, quality: rated(0.1, { GPQA: 30, HLE: 10 }) }),
    mk("filler-a", { params_b: 4 }), // a list needs five models
    mk("filler-b", { params_b: 5 }),
  ], { version: 4, updated: "2026-09-01" });
  const now = new Date("2026-10-02T03:04:05Z");
  const fresh = (repo: string) => repo === "test/old-rated" ? qualityOf(new Map([["Idavidrein/gpqa", 80], ["cais/hle", 40], ["TIGER-Lab/MMLU-Pro", 70]]), 0.9)
    : repo === "test/old-unrated" ? qualityOf(new Map([["Idavidrein/gpqa", 50]]), undefined)
    : repo.startsWith("test/filler") ? qualityOf(new Map(), undefined) : undefined;

  test("same models in the same order with every other field byte-for-byte as it was", () => {
    const r = rerate(before, fresh, now);
    expect(r.catalog.models.map((m) => m.id)).toEqual(before.models.map((m) => m.id));
    const strip = (m: CatalogModel) => { const { quality: _q, ...rest } = m; return rest; };
    expect(r.catalog.models.map(strip)).toEqual(before.models.map(strip));
    expect(JSON.stringify(r.catalog.models.map(strip))).toBe(JSON.stringify(before.models.map(strip)));
    expect(r.catalog.models.every((m) => m.quality?.rules === RATING_RULES)).toBe(true);
    const { models: _a, version: _v, updated: _u, origin: _o, ...restAfter } = r.catalog;
    const { models: _b, version: _w, updated: _x, origin: _y, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
    expect(r.catalog.version).toBe(5);
    expect(r.catalog.updated).toBe("2026-10-02");
    expect(r.catalog.origin).toEqual({ kind: "built-in", at: now.toISOString() });
    expect(CatalogSchema.safeParse(r.catalog).error?.issues[0]).toBeUndefined(); // and the result is a valid list
  });

  test("a model that could not be read is left unrated with no scores, never kept on the old rules", () => {
    const r = rerate(before, fresh, now);
    expect(r.unread).toEqual(["gone"]);
    expect(r.catalog.models.find((m) => m.id === "gone")!.quality).toEqual({ basis: "unrated", rules: RATING_RULES });
    expect(r.changes.find((c) => c.id === "gone")).toEqual({ id: "gone", before: "rated 0.1 (2 results)", after: "unrated (not read)" });
  });

  test("each change says what the model was and is", () => {
    const r = rerate(before, fresh, now);
    expect(r.changes.find((c) => c.id === "old-rated")).toEqual({ id: "old-rated", before: "rated 1.2 (2 results)", after: "rated 0.9 (3 results)" });
    expect(r.changes.find((c) => c.id === "old-unrated")).toEqual({ id: "old-unrated", before: "unrated (1 result)", after: "unrated (1 result)" });
  });

  test("the input list is not modified", () => {
    const snapshot = JSON.stringify(before);
    rerate(before, fresh, now);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(repoOf(before.models[0]!)).toBe("test/old-rated");
  });
});
