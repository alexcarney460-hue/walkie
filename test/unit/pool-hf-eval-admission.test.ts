import { expect, test } from "bun:test";
import { BENCHMARKS, benchmarkValues, qualityOf, RATING_RULES, rateModels } from "../../src/pool/hf/quality.ts";
import { EvalEntry, evalEntries, ModelRecord } from "../../src/pool/hf/schemas.ts";
import { buildCatalog } from "../../src/pool/hf/build.ts";
import { HfClient } from "../../src/pool/hf/client.ts";
import { fakeHub } from "../helpers/hf-fixtures.ts";
import { ModelQualitySchema } from "../../src/pool/catalog-schema.ts";

const ids = BENCHMARKS.slice(0, 4).map((b) => b.id);
const dataset = ids[0]!;

test("duplicate results cannot raise the admitted value, regardless of order or repetition", () => {
  const rows = [70, 99, 70].map((value) => ({ dataset, value }));
  expect(benchmarkValues(rows).get(dataset)).toBe(70);
  expect([...benchmarkValues([...rows].reverse())]).toEqual([...benchmarkValues(rows)]);
});

test("missing and false verification remain self-reports; PR-associated results are excluded even if verified", () => {
  expect(benchmarkValues([{ dataset, value: 70 }]).get(dataset)).toBe(70);
  expect(benchmarkValues([{ dataset, value: 70, verified: false }]).get(dataset)).toBe(70);
  for (const verified of [true, false, undefined]) {
    expect(benchmarkValues([{ dataset, value: 99, verified, pullRequest: 3 }]).size).toBe(0);
  }
});

test("malformed provenance cannot turn into missing provenance at the schema boundary", () => {
  const data = { dataset: { id: dataset }, value: 70 };
  expect(EvalEntry.safeParse({ data }).success).toBe(true);
  for (const flags of [{ verified: "true" }, { pullRequest: "3" }, { pullRequest: null }, { pullRequest: -1 }]) {
    expect(EvalEntry.safeParse({ data, ...flags }).success).toBe(false);
  }
  const record = ModelRecord.parse({ id: "test/model", createdAt: "2026-10-01T00:00:00Z", evalResults: [
    { data, verified: false, pullRequest: 3 }, { data, pullRequest: "3" },
  ] });
  const parsed = evalEntries(record);
  expect(parsed.bad).toBe(1);
  expect(parsed.entries[0]?.pullRequest).toBe(3);
  expect(parsed.entries[0]?.verified).toBe(false);
});

test("ambiguous fraction-scale values are excluded without guessing units", () => {
  for (const value of [0, 0.89, 1, -1, 101, NaN, Infinity]) {
    expect(benchmarkValues([{ dataset, value }]).size).toBe(0);
  }
  expect(benchmarkValues([{ dataset, value: 89 }]).get(dataset)).toBe(89);
});

const table = (equal = false) => new Map(Array.from({ length: 12 }, (_, i) => [
  `m${i}`, new Map(ids.map((id, j) => [id, equal ? 50 : 20 + i * 4 + j])),
]));

test("two high observations do not qualify a model for a production rating", () => {
  const obs = table();
  obs.set("sparse", new Map(ids.slice(0, 2).map((id) => [id, 100])));
  const fit = rateModels(obs);
  expect(fit.scores.size).toBe(12);
  expect(fit.scores.has("sparse")).toBe(false);
});

test("all-equal and near-equal tables carry no rating evidence", () => {
  expect(rateModels(table(true)).scores.size).toBe(0);
  const near = new Map([...table(true)].map(([m, r], i) => [m, new Map([...r].map(([b, v]) => [b, v + i * 1e-10]))]));
  expect(rateModels(near).scores.size).toBe(0);
});

test("constant benchmarks cannot satisfy the minimum coverage", () => {
  const obs = new Map([...table()].map(([m, r]) => [m, new Map([...r].map(([b, v], j) => [b, j < 2 ? 50 : v]))]));
  expect(rateModels(obs).scores.size).toBe(0);
});

test("finite bounded scores and schema-valid quality, including invalid direct inputs", () => {
  const obs = table();
  obs.set("invalid", new Map([[ids[0]!, NaN], [ids[1]!, Infinity], [ids[2]!, 101]]));
  const fit = rateModels(obs);
  expect(fit.scores.has("invalid")).toBe(false);
  expect(fit.scores.size).toBe(12);
  for (const [m, score] of fit.scores) {
    expect(Number.isFinite(score)).toBe(true);
    expect(Math.abs(score)).toBeLessThanOrEqual(20);
    expect(ModelQualitySchema.safeParse(qualityOf(obs.get(m)!, score)).success).toBe(true);
  }
  for (const score of [NaN, Infinity, -Infinity, -21, 21]) {
    const quality = qualityOf(new Map([[dataset, NaN]]), score);
    expect(quality.basis).toBe("unrated");
    expect(ModelQualitySchema.safeParse(quality).success).toBe(true);
  }
});


test("fixture pipeline retains PR provenance through valuesOf", async () => {
  const hub = fakeHub();
  const { catalog } = await buildCatalog({ client: new HfClient({ fetch: hub.fetch }), now: new Date("2026-10-01T23:00:00Z") });
  // All Qwen3.8-27B fixture results are PR-associated; they cannot reach displayed scores or the fit.
  const model = catalog.models.find((m) => m.id === "qwen3.8-27b");
  expect(model).toBeDefined();
  expect(model!.quality).toEqual({ basis: "unrated", rules: RATING_RULES });
});

test("invalid thresholds do not bypass evidence requirements", () => {
  for (const minResults of [0, 1, NaN, Infinity, 2.5]) {
    expect(rateModels(table(), { minResults }).scores.size).toBe(0);
  }
  for (const minReporters of [0, 1, 2, NaN, Infinity, 3.5]) {
    expect(rateModels(table(), { minReporters }).scores.size).toBe(0);
  }
});
