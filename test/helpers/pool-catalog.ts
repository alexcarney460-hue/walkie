// Small hand-made catalogs for tests of the ranking, fit and speed logic, so those tests do not depend on which
// models the shipped catalog holds today. `mk` fills the stored memory figures with the documented formula.
import { CATALOG, memoryNeeded, rankModels, type Catalog, type CatalogModel } from "../../src/pool/catalog.ts";

export function mk(id: string, over: Partial<CatalogModel> & { params_b: number }): CatalogModel {
  const m: CatalogModel = {
    id, name: id, maker: "Test", active_b: null, arch: { layers: 32, kv_heads: 8, head_dim: 128 },
    mem_gib: { q4: null, q8: null }, license: "Apache-2.0",
    source: `https://huggingface.co/test/${id}`, config_source: `https://huggingface.co/test/${id}/blob/main/config.json`,
    verified: true, ...over,
  };
  const GiB = 1024 ** 3;
  const fig = (q: "q4" | "q8"): number | null => {
    const n = memoryNeeded(m, q, CATALOG.context_tokens, CATALOG);
    return n === null ? null : Math.round((n / GiB) * 10) / 10;
  };
  return { ...m, mem_gib: over.mem_gib ?? { q4: fig("q4"), q8: fig("q8") } };
}

export const catalogOf = (models: CatalogModel[], over: Partial<Catalog> = {}): Catalog => ({ ...CATALOG, ...over, models });

/** A rated quality (the one-factor score) with the benchmark values behind it. */
export const rated = (score: number, scores: Record<string, number> = {}): NonNullable<CatalogModel["quality"]> => ({ basis: "rated", score, scores });

/**
 * `cat` with its first `n` models rated (best first, scores falling from 1; a model with no benchmark numbers gets a GPQA one
 * so the rank line shows them), the rest as they were. The conservative
 * admission (three admitted benchmarks, no Hub pull-request results) rates none of the models the pipeline builds from the
 * recorded Hub responses, so a test of the "Rated #n of m" wording or of rated-first ordering over that list uses this.
 */
export function withRatings(cat: Catalog, n = 6): Catalog {
  return { ...cat, models: rankModels(cat.models.map((m, i) => (i < n ? { ...m, quality: rated(1 - i / n, Object.keys(m.quality?.scores ?? {}).length ? m.quality!.scores! : { GPQA: 90 - 5 * i }) } : m))) };
}
