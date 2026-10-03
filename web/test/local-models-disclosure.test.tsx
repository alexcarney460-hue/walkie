import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CATALOG } from "../../src/pool/catalog.ts";
import { buildCatalog } from "../../src/pool/hf/build.ts";
import { HfClient } from "../../src/pool/hf/client.ts";
import type { ModelsView } from "../../src/pool/hf/view.ts";
import { fakeHub } from "../../test/helpers/hf-fixtures.ts";
import { withRatings } from "../../test/helpers/pool-catalog.ts";
import { spark } from "../../test/helpers/pool-machines.ts";
import type { NodeView } from "../src/api/types.ts";
import { installWindow } from "./window-stub.ts";

installWindow();
const { LocalModelsCard, LocalModelsSection } = await import("../src/components/LocalModels.tsx");
const checkedAt = Date.parse("2026-10-01T00:00:00Z");
// The conservative admission rates none of the recorded Hub models, so the rank wording is tested on a list with some rated.
const catalog = withRatings((await buildCatalog({ client: new HfClient({ fetch: fakeHub().fetch }), now: new Date(checkedAt) })).catalog);
const machine = spark("fixture-spark", "machine-stats/meminfo-gb10-spark-115f.txt", { self: true });
const nodes = [{ ...machine, ip: "127.0.0.1", last_seen: 1, sync: { behind: 0, last_sync: 1 } } as NodeView];

for (const Component of [LocalModelsCard, LocalModelsSection]) {
  for (const state of ["fresh", "stale", "built-in"] as const) {
    test(`${Component.name}: ${state} ranks and best picks disclose the current list`, () => {
      const models: ModelsView = state === "built-in"
        ? { catalog: withRatings(CATALOG), source: "built-in", state, checkedAt: null, note: null } // the shipped list has no rated model; local-models-ranking.test.tsx covers that
        : { catalog, source: "huggingface", state, checkedAt, note: null };
      const html = renderToStaticMarkup(<Component nodes={nodes} models={models} />);
      expect(html).toContain("Best and rankings refer only to the current list, not all Hub models");
      if (Component === LocalModelsSection) {
        expect(html).toContain("The best open-weight model in the current list");
        expect(html).toContain("self-reported benchmark results on Hugging Face within the current list");
        expect(html).not.toContain("newest and strongest first");
      }
      if (state !== "built-in") expect(html).toContain("up to 150 candidates, 60 maker lookups and 70 base models");
      const ranks = html.match(/Rated #[^<]+/g) ?? [];
      expect(ranks.length).toBeGreaterThan(0);
      for (const rank of ranks) {
        expect(rank).toContain("in the current list");
        expect(rank).toContain("self-reported");
      }
      expect(html).toContain('class="lm-pick has-meta"');
    });
  }
  test(`${Component.name}: refreshing describes the bounded list`, () => {
    const models = { catalog, source: "huggingface", state: "fresh", checkedAt, note: null, refreshing: true } as const;
    const html = renderToStaticMarkup(<Component nodes={nodes} models={models} />);
    expect(html).toContain("Refreshing the bounded Hugging Face list…");
    expect(html).not.toContain("Looking at Hugging Face for the best models");
  });
}
