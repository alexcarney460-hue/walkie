// scripts/refresh-pool-catalog.ts --ratings-only reads every model already in the list as an "extra" repository so it is
// rated in the same fit as the freshly built ones. Most of them are ALSO built (they are the most downloaded), and a model
// counted twice weighs double in the fit, so ratings would depend on how many extras were asked for. Offline: a fixture fetch.
import { expect, test } from "bun:test";
import { buildCatalog } from "../../src/pool/hf/build.ts";
import { HfClient } from "../../src/pool/hf/client.ts";
import { MIN_RESULTS } from "../../src/pool/hf/quality.ts";

const now = new Date("2026-10-01T00:00:00Z");
const DATASETS = ["Idavidrein/gpqa", "TIGER-Lab/MMLU-Pro", "cais/hle", "MathArena/aime_2026"];
const COUNT = 14;
const bases = Array.from({ length: COUNT }, (_, i) => `Maker/Candidate${String(i).padStart(2, "0")}-1B`);

/** Every base is viable and reports all four benchmarks, with values that differ by model and by benchmark. */
function hub(): typeof globalThis.fetch {
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    if (path === "/api/models") return url.searchParams.has("pipeline_tag") ? answer(bases.map((base, i) => ({ id: `${base}-GGUF`, downloads: COUNT - i }))) : answer([]);
    if (path.startsWith("/api/organizations/")) return answer({ name: path.split("/")[3]!, numFollowers: 2000 });
    if (path.endsWith("/config.json")) return answer({ num_hidden_layers: 16, num_attention_heads: 8, num_key_value_heads: 2, hidden_size: 1024 });
    if (url.searchParams.has("blobs")) return answer({ id: path.slice("/api/models/".length), sha: "a".repeat(40), siblings: [{ rfilename: "model-Q4_K_M.gguf", size: 610_000_000 }] });
    if (path.startsWith("/api/models/")) {
      const i = bases.indexOf(path.slice("/api/models/".length));
      return answer({
        id: path.slice("/api/models/".length), pipeline_tag: "text-generation", createdAt: "2026-09-01T00:00:00Z",
        safetensors: { total: 1e9 }, tags: ["license:apache-2.0"],
        evalResults: DATASETS.map((id, j) => ({ data: { dataset: { id }, value: 20 + ((i * 7 + j * 13 + i * j) % 55) + i } })),
      });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  }) as typeof globalThis.fetch;
}

test("a repository asked for as an extra that was also built is counted once", async () => {
  const plain = await buildCatalog({ client: new HfClient({ fetch: hub() }), now });
  const withExtras = await buildCatalog({ client: new HfClient({ fetch: hub() }), now, extraRepos: bases });
  // The fixture is ratable: every model is rated, on at least the minimum number of results.
  expect(plain.catalog.models).toHaveLength(COUNT);
  for (const m of plain.catalog.models) {
    expect(m.quality?.basis).toBe("rated");
    expect(Object.keys(m.quality!.scores!).length).toBeGreaterThanOrEqual(MIN_RESULTS);
  }
  // Asking for the same models as extras changes no rating, and each extra's quality is the built model's.
  const byId = (r: typeof plain) => new Map(r.catalog.models.map((m) => [m.id, m.quality]));
  expect(byId(withExtras)).toEqual(byId(plain));
  for (const m of plain.catalog.models) {
    const repo = m.source.replace("https://huggingface.co/", "");
    expect(withExtras.extra.get(repo)?.quality).toEqual(m.quality);
  }
});

test("an extra repository that was not built is still rated, in the same fit", async () => {
  const outsider = "Maker/Outsider-1B";
  const base = hub();
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === `/api/models/${outsider}`) {
      return new Response(JSON.stringify({ id: outsider, createdAt: "2026-09-01T00:00:00Z", downloads: 5, evalResults: DATASETS.map((id) => ({ data: { dataset: { id }, value: 61 } })) }));
    }
    return base(input, init);
  }) as typeof globalThis.fetch;
  const r = await buildCatalog({ client: new HfClient({ fetch }), now, extraRepos: [outsider] });
  const q = r.extra.get(outsider)?.quality;
  expect(q?.basis).toBe("rated");
  expect(Object.keys(q!.scores!)).toHaveLength(DATASETS.length);
  expect(r.catalog.models.some((m) => m.source.endsWith(outsider))).toBe(false);
});
