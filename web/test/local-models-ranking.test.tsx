// The dashboard side of "what does best mean when nothing is rated": the list's source line says so, the best overall
// and each machine's pick are "Newest", never "Best", and a list with a rated model that fits keeps "Best".
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { NodeView } from "../src/api/types.ts";
import { installWindow } from "./window-stub.ts";
import { CATALOG } from "../../src/pool/catalog.ts";
import { NO_RATING_NOTE } from "../../src/pool/format.ts";
import { catalogOf, mk, rated } from "../../test/helpers/pool-catalog.ts";

installWindow();
const { LocalModelsCard, LocalModelsSection } = await import("../src/components/LocalModels.tsx");
const { LocalModelSection } = await import("../src/views/machine/MachineDetail.tsx");
const GiB = 1024 ** 3;
const mac: NodeView = {
  node_id: "ranking-fixture", hostname: "studio", handle: "fixture", ip: "192.0.2.1", online: true, self: true, rtt_ms: 0, last_seen: 1, sync: { behind: 0, last_sync: 1 },
  pool: { share: true, runtime: true, busy: false, cap: null, serve: true },
  stats: { at: 1, temp_c: null, sys: { os: "darwin", arch: "arm64", cpus: 12, load1: 0 }, mem: { total: 64 * GiB, used: 8 * GiB, swap_used: 0, pressure: "normal" },
    accel: { chip: "Apple M4 Max", unified: true, gpu_limit: null, gpus: [] } },
};
const unrated = catalogOf([
  mk("newest-20b", { params_b: 20, released: "2026-09-10" }),
  mk("older-20b", { params_b: 20, released: "2026-03-10", quality: { basis: "unrated", scores: { GPQA: 50 } } }),
  mk("small-3b", { params_b: 3, released: "2026-09-01" }),
]);
const withRated = catalogOf([mk("rated-20b", { params_b: 20, released: "2026-01-10", quality: rated(0.7, { GPQA: 80, HLE: 40, "MMLU-Pro": 70 }) }), ...unrated.models]);
const models = (catalog: typeof unrated, source: "huggingface" | "built-in" = "huggingface") =>
  ({ catalog, source, state: source === "built-in" ? "built-in" : "fresh", checkedAt: source === "built-in" ? null : Date.parse("2026-10-01T22:40:00Z"), note: null }) as const;
const text = (html: string): string => html.replace(/&#x27;/g, "'").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

for (const [name, Component] of [["Team page", LocalModelsSection], ["Mission Control card", LocalModelsCard]] as const) {
  test(`${name}: a list with nothing rated says so and labels picks "Newest"`, () => {
    const html = renderToStaticMarkup(<Component nodes={[mac]} models={models(unrated)} />);
    expect(text(html)).toContain(NO_RATING_NOTE);
    expect(html).toContain(">Newest overall<");
    expect(html).not.toContain(">Best overall<");
    expect(html).not.toContain("Rated #");
    expect(text(html)).toContain("Not enough published benchmark results to rate (0 of 3 needed");
  });

  test(`${name}: the list built into Walkie as shipped has no rated model, and says so`, () => {
    const html = renderToStaticMarkup(<Component nodes={[mac]} models={models(CATALOG, "built-in")} />);
    expect(text(html)).toContain(NO_RATING_NOTE);
    expect(html).toContain(">Newest overall<");
  });

  test(`${name}: a list with a rated model that fits keeps "Best" and shows no note`, () => {
    const html = renderToStaticMarkup(<Component nodes={[mac]} models={models(withRated)} />);
    expect(text(html)).not.toContain(NO_RATING_NOTE);
    expect(html).toContain(">Best overall<");
  });
}

test("the Team page's per-machine rows read 'Newest' for an unrated pick (machines on one network)", () => {
  const second: NodeView = { ...mac, node_id: "second", hostname: "studio-2", self: false, rtt_ms: 1 };
  const html = renderToStaticMarkup(<LocalModelsSection nodes={[mac, second]} models={models(unrated)} />);
  expect(html).toContain('class="lm-pick-label">Newest<');
  expect(html).not.toContain('class="lm-pick-label">Best<');
});

// The machine page: "Best on this machine" is a quality claim, so an unrated list says "Newest on this machine" and why.
test("machine page: nothing rated -> 'Newest on this machine' and the note; not 'Best on this machine'", () => {
  const html = renderToStaticMarkup(<LocalModelSection node={mac} models={models(unrated)} />);
  expect(html).toContain('class="lm-pick-label">Newest on this machine<');
  expect(html).not.toContain("Best on this machine");
  expect(text(html)).toContain(NO_RATING_NOTE);
});

test("machine page: the list built into Walkie as shipped says the same", () => {
  const html = renderToStaticMarkup(<LocalModelSection node={mac} models={models(CATALOG, "built-in")} />);
  expect(html).toContain("Newest on this machine");
  expect(text(html)).toContain(NO_RATING_NOTE);
});

test("machine page: a rated pick keeps 'Best on this machine' and shows no note", () => {
  const html = renderToStaticMarkup(<LocalModelSection node={mac} models={models(withRated)} />);
  expect(html).toContain('class="lm-pick-label">Best on this machine<');
  expect(text(html)).not.toContain(NO_RATING_NOTE);
});

test("the Team page's alternatives never read 'Better' for unrated picks", () => {
  const html = renderToStaticMarkup(<LocalModelsSection nodes={[mac]} models={models(unrated)} />);
  expect(html).not.toMatch(/class="lm-pick-label">Better/);
});
