import { expect, test } from "bun:test";
import { buildCatalog } from "../../src/pool/hf/build.ts";
import { HfClient, DEFAULTS } from "../../src/pool/hf/client.ts";
import { listText, reasonText } from "../../src/pool/format.ts";

const now = new Date("2026-10-01T00:00:00Z");

// Every synthetic base is viable. Only discovery order and the three bounds exclude it.
async function bounded(count: number, ownerOf: (i: number) => string, established: (owner: string) => boolean = () => true) {
  const calls: URL[] = [];
  const bases = Array.from({ length: count }, (_, i) => `${ownerOf(i)}/Candidate${String(i).padStart(3, "0")}-1B`);
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(url);
    const path = url.pathname;
    if (path === "/api/models") {
      if (url.searchParams.has("pipeline_tag")) return answer(bases.map((base, i) => ({ id: `${base}-GGUF`, downloads: count - i })));
      return answer([]); // the maker's own GGUF is in the discovery list
    }
    if (path.startsWith("/api/organizations/")) {
      const name = path.split("/")[3]!;
      return answer({ name, numFollowers: established(name) ? 2000 : 0 });
    }
    if (path.endsWith("/config.json")) return answer({ num_hidden_layers: 16, num_attention_heads: 8, num_key_value_heads: 2, hidden_size: 1024 });
    if (url.searchParams.has("blobs")) return answer({ id: path.slice("/api/models/".length), sha: "a".repeat(40), siblings: [{ rfilename: "model-Q4_K_M.gguf", size: 610_000_000 }] });
    if (path.startsWith("/api/models/")) return answer({
      id: path.slice("/api/models/".length), pipeline_tag: "text-generation", createdAt: "2026-09-01T00:00:00Z",
      safetensors: { total: 1e9 }, tags: ["license:apache-2.0"],
      // Distinct ordinary scores keep this discovery fixture out of the quality
      // fitter's zero-variance case; quality math is tested in its own suite.
      evalResults: ["Idavidrein/gpqa", "TIGER-Lab/MMLU-Pro"].map((id) => ({ data: { dataset: { id }, value: 30 + bases.indexOf(path.slice("/api/models/".length)) % 50 } })),
    });
    throw new Error(`Unexpected fixture request: ${url}`);
  }) as typeof globalThis.fetch;
  const result = await buildCatalog({ client: new HfClient({ fetch }), now, concurrency: 1 });
  expect(result.requests).toBeLessThanOrEqual(DEFAULTS.maxRequests);
  const copy = listText({ source: "huggingface", checkedAt: now.getTime(), catalog: result.catalog });
  expect(copy).toContain("up to 150 candidates, 60 maker lookups and 70 base models");
  expect(copy).toContain("ordered by downloads");
  expect(copy).toContain("Best and rankings refer only to the current list, not all Hub models");
  for (const model of result.catalog.models) {
    expect(reasonText(model, result.catalog)).toContain("in the current list");
    expect(reasonText(model, result.catalog)).toContain("self-reported");
  }
  return { result, calls, bases };
}

test("more than 70 viable bases: only the first 70 by downloads are examined", async () => {
  const { result, calls, bases } = await bounded(71, () => "Maker");
  expect(result.catalog.models).toHaveLength(70);
  expect(calls.some((u) => u.pathname === `/api/models/${bases[70]}`)).toBe(false);
});

test("more than 60 makers: a viable base from the 61st maker is not examined", async () => {
  const { result, calls, bases } = await bounded(61, (i) => `Maker${i}`);
  expect(result.catalog.models).toHaveLength(60);
  expect(calls.filter((u) => u.pathname.startsWith("/api/organizations/"))).toHaveLength(60);
  expect(calls.some((u) => u.pathname === `/api/models/${bases[60]}`)).toBe(false);
});

test("the maker lookup cap separates unqueried makers from a queried unestablished maker", async () => {
  const { result, calls, bases } = await bounded(62, (i) => `Maker${i}`, (o) => o !== "Maker0");
  const lookups = calls.filter((u) => u.pathname.startsWith("/api/organizations/"));
  expect(lookups.map((u) => u.pathname)).toEqual(
    Array.from({ length: 60 }, (_, i) => `/api/organizations/Maker${i}/overview`),
  );
  expect(result.catalog.models.map((m) => m.source).sort()).toEqual(
    bases.slice(1, 60).map((base) => `https://huggingface.co/${base}`).sort(),
  );
  expect(result.requests).toBe(301); // five discovery pages + 60 makers + four reads per retained base
  expect(calls).toHaveLength(result.requests);
  for (const base of [bases[0], ...bases.slice(60)]) {
    expect(calls.some((u) => u.pathname === `/api/models/${base}`)).toBe(false);
  }
  expect(result.skips).toEqual([
    { repo: bases[0]!, reason: "not_established" },
    { repo: bases[60]!, reason: "maker_unqueried" },
    { repo: bases[61]!, reason: "maker_unqueried" },
  ]);
  expect(result.skipped).toEqual({ not_established: 1, maker_unqueried: 2 });
});

test("more than 150 candidates: a viable lower-download base is never examined even with room in the base budget", async () => {
  const { result, calls, bases } = await bounded(151, (i) => i >= 145 ? "Maker" : "Unestablished", (o) => o === "Maker");
  expect(result.catalog.models).toHaveLength(5);
  expect(calls.some((u) => u.pathname === `/api/models/${bases[149]}`)).toBe(true);
  expect(calls.some((u) => u.pathname === `/api/models/${bases[150]}`)).toBe(false);
});
