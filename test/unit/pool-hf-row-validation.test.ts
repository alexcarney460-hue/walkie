import { expect, spyOn, test } from "bun:test";
import * as catalog from "../../src/pool/catalog.ts";
import { CatalogSchema } from "../../src/pool/catalog-schema.ts";
import { buildCatalog } from "../../src/pool/hf/build.ts";
import { HfClient } from "../../src/pool/hf/client.ts";
import * as quality from "../../src/pool/hf/quality.ts";
import { REPO_ID, RepoId } from "../../src/pool/hf/schemas.ts";
import { fakeHub } from "../helpers/hf-fixtures.ts";

const now = new Date("2026-10-01T23:00:00Z");
const repo = "Qwen/Qwen3.8-27B";
const id = "qwen3.8-27b";
const build = (hub = fakeHub(), minModels = 5) => buildCatalog({ client: new HfClient({ fetch: hub.fetch }), now, minModels, pins: true });

for (const name of ["Qwen/Qwen3.8-27B", "org/model_name", "org/.model", "org/model.v2"]) {
  test(`ordinary repository id: ${name}`, () => {
    expect(REPO_ID.test(name)).toBe(true);
    expect(RepoId.safeParse(name).success).toBe(true);
  });
}
for (const name of ["org/.", "org/..", "org/..."]) {
  test(`dot-only model name rejected: ${name}`, () => {
    expect(REPO_ID.test(name)).toBe(false);
    expect(RepoId.safeParse(name).success).toBe(false);
  });
}

function badArch() {
  const hub = fakeHub();
  hub.inject(`/${repo}/resolve/main/config.json`, () => Response.json({ num_hidden_layers: 16, num_attention_heads: 512, num_key_value_heads: 512, head_dim: 128 }));
  return hub;
}

test("one out-of-range architecture leaves the other fifteen fixture models usable", async () => {
  const r = await build(badArch());
  expect(r.catalog.models).toHaveLength(15);
  expect(r.catalog.models.some((m) => m.id === id)).toBe(false);
  expect(r.pins.has(id)).toBe(false);
  expect(r.skips).toContainEqual({ repo, reason: "bad_config" });
  expect(CatalogSchema.safeParse(r.catalog).success).toBe(true);
});

test("insufficient valid rows fail with the usable count", async () => {
  await expect(build(badArch(), 16)).rejects.toThrow("too few usable models on Hugging Face (15 of the 16 needed)");
});

for (const value of [NaN, Infinity, 4097 * 1024 ** 3]) {
  test(`invalid computed draft memory (${value}) is excluded before rating`, async () => {
    const original = catalog.memoryNeeded;
    const memory = spyOn(catalog, "memoryNeeded").mockImplementation((m, ...args) => m.id === id ? value : original(m, ...args));
    const rate = spyOn(quality, "rateModels");
    try {
      const r = await build();
      expect(r.catalog.models).toHaveLength(15);
      expect(r.skips).toContainEqual({ repo, reason: "invalid_model" });
      expect(r.pins.has(id)).toBe(false);
      expect(rate.mock.calls[0]![0].has(`https://huggingface.co/${repo}`)).toBe(false);
      expect(CatalogSchema.safeParse(r.catalog).success).toBe(true);
    } finally { memory.mockRestore(); rate.mockRestore(); }
  });
}

for (const score of [NaN, Infinity, 21]) {
  test(`invalid rated row (${score}) does not invalidate healthy rows or retain its pin`, async () => {
    const rating = spyOn(quality, "qualityOf").mockImplementationOnce(() => ({ basis: "rated", score }));
    try {
      const r = await build();
      expect(r.catalog.models).toHaveLength(15);
      expect(r.skipped.invalid_model).toBe(1);
      const rejected = r.skips.find((s) => s.reason === "invalid_model")!;
      expect(r.catalog.models.some((m) => m.source === `https://huggingface.co/${rejected.repo}`)).toBe(false);
      expect(r.pins.size).toBe(15);
      expect(CatalogSchema.safeParse(r.catalog).success).toBe(true);
    } finally { rating.mockRestore(); }
  });
}

test("too few rows after rating fail clearly", async () => {
  const rating = spyOn(quality, "qualityOf").mockImplementationOnce(() => ({ basis: "rated", score: Infinity }));
  try {
    await expect(build(fakeHub(), 16)).rejects.toThrow("too few usable models on Hugging Face (15 of the 16 needed)");
  } finally { rating.mockRestore(); }
});
