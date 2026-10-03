// Interactions between the Hugging Face lanes that no single lane could test, because each was built on the same base
// without the others: lane 02's bounded-discovery fixtures had to vary their scores to stay out of "the zero-variance
// failure" (c20-07's review called the equal-score limitation inherited and unfixed); lane 03 then made a table with no
// spread rate nobody, and lane 05 validates each built row. Offline: a fixture fetch only.
import { expect, test } from "bun:test";
import { listText, reasonText } from "../../src/pool/format.ts";
import { buildCatalog } from "../../src/pool/hf/build.ts";
import { HfClient } from "../../src/pool/hf/client.ts";

const now = new Date("2026-10-01T00:00:00Z");

/** `count` viable bases from one established maker; every one reports the same two benchmark values. */
async function equalScores(count: number, value: number) {
  const bases = Array.from({ length: count }, (_, i) => `Maker/Candidate${String(i).padStart(3, "0")}-1B`);
  const answer = (body: unknown) => new Response(JSON.stringify(body));
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname;
    if (path === "/api/models") return url.searchParams.has("pipeline_tag") ? answer(bases.map((base, i) => ({ id: `${base}-GGUF`, downloads: count - i }))) : answer([]);
    if (path.startsWith("/api/organizations/")) return answer({ name: path.split("/")[3]!, numFollowers: 2000 });
    if (path.endsWith("/config.json")) return answer({ num_hidden_layers: 16, num_attention_heads: 8, num_key_value_heads: 2, hidden_size: 1024 });
    if (url.searchParams.has("blobs")) return answer({ id: path.slice("/api/models/".length), sha: "a".repeat(40), siblings: [{ rfilename: "model-Q4_K_M.gguf", size: 610_000_000 }] });
    if (path.startsWith("/api/models/")) return answer({
      id: path.slice("/api/models/".length), pipeline_tag: "text-generation", createdAt: "2026-09-01T00:00:00Z",
      safetensors: { total: 1e9 }, tags: ["license:apache-2.0"],
      evalResults: ["Idavidrein/gpqa", "TIGER-Lab/MMLU-Pro", "cais/hle"].map((id) => ({ data: { dataset: { id }, value } })),
    });
    throw new Error(`Unexpected fixture request: ${url}`);
  }) as typeof globalThis.fetch;
  return buildCatalog({ client: new HfClient({ fetch }), now, concurrency: 1 });
}

test("sixty models that all report the same scores build a valid list, none of them rated", async () => {
  const result = await equalScores(60, 50);
  expect(result.catalog.models).toHaveLength(60);
  for (const m of result.catalog.models) {
    expect(m.quality?.basis).toBe("unrated");
    expect(reasonText(m, result.catalog)).toContain("ranked within the current list by");
  }
  expect(result.skipped.invalid_model ?? 0).toBe(0); // no row was thrown out: the evidence was simply not enough to rate
  expect(listText({ source: "huggingface", checkedAt: now.getTime(), catalog: result.catalog })).toContain("(60 models)");
});

test("the same holds near both edges of the admitted range (1.5; values of 1 or less are declined, 100 is the top), and the refresh still succeeds", async () => {
  for (const value of [1.5, 100]) {
    const result = await equalScores(8, value);
    expect(result.catalog.models).toHaveLength(8);
    expect(result.catalog.models.every((m) => m.quality?.basis === "unrated")).toBe(true);
  }
});
