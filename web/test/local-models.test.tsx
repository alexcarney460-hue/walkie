import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { NodeView } from "../src/api/types.ts";

import { installWindow } from "./window-stub.ts";
import { LEGACY } from "../../test/helpers/pool-legacy.ts";
import { fakeHub } from "../../test/helpers/hf-fixtures.ts";
import { mac16, spark } from "../../test/helpers/pool-machines.ts";
import { buildCatalog } from "../../src/pool/hf/build.ts";
import { HfClient } from "../../src/pool/hf/client.ts";
import { CATALOG } from "../../src/pool/catalog.ts";
import { suggestTeam } from "../../src/pool/suggest.ts";
import { catalogOf, mk, rated, withRatings } from "../../test/helpers/pool-catalog.ts";
import type { ModelsView } from "../../src/pool/hf/view.ts";

// lib/route.ts reads window.location at import: the shared stand-in (window-stub.ts), so a later file's go() still
// reaches the router's hashchange listener.
installWindow();
const { LocalModelsCard, LocalModelsSection, PickRow } = await import("../src/components/LocalModels.tsx");

// The scenario tests below name models of the frozen 13-model list (test/helpers/pool-legacy.ts); the new ones use the
// list the pipeline builds from the real Hugging Face responses.
const T = Date.parse("2026-10-01T22:40:00Z");
const legacy: ModelsView & { refreshing?: boolean } = { catalog: LEGACY, source: "built-in", state: "built-in", checkedAt: null, note: null };
// The conservative admission rates none of the recorded Hub models, so the rank wording is tested on a list with some rated.
const liveCatalog = withRatings((await buildCatalog({ client: new HfClient({ fetch: fakeHub().fetch }), now: new Date(T) })).catalog);
const live: ModelsView & { refreshing?: boolean } = { catalog: liveCatalog, source: "huggingface", state: "fresh", checkedAt: T, note: null };

const GiB = 1024 ** 3;
const node = (hostname: string, over: Partial<NodeView>, total: number, used: number, chip: string | null, gpus: { name: string; vram: number }[] = []): NodeView => ({
  node_id: hostname, handle: "maren", hostname, ip: "100.88.14.2", online: true, last_seen: 1, rtt_ms: 2, self: false,
  sync: { behind: 0, last_sync: 1 },
  stats: { at: 1, temp_c: 50, mem: { total: total * GiB, used: used * GiB, swap_used: 0, pressure: "normal" }, accel: { chip, unified: gpus.length === 0 && !!chip?.startsWith("Apple"), gpu_limit: null, gpus } },
  ...over,
});
const lan: NodeView[] = [
  node("maren-mbp", { self: true, rtt_ms: 0 }, 16, 11.4, "Apple M3"),
  node("atlas", { rtt_ms: 1 }, 64, 41.2, "AMD Ryzen 9 7950X", [{ name: "NVIDIA GeForce RTX 4090", vram: 24 * GiB }]),
  node("office-studio", { rtt_ms: 2 }, 128, 30.5, "Apple M4 Max"),
  node("office-mini", { rtt_ms: 3 }, 64, 18.1, "Apple M4 Pro"),
  node("tobias-mbp", { rtt_ms: 23 }, 32, 28.9, "Apple M2 Pro"),
  node("sol-x1", { online: false }, 16, 14.9, "Intel(R) Core(TM) i7-1365U"),
];

test("Mission Control card: the best group, its single-machine and split picks, speed tags, a link to the details", () => {
  const out = renderToStaticMarkup(<LocalModelsCard nodes={lan} models={legacy} />);
  expect(out).toContain("What your team could run locally");
  expect(out).toContain("estimate");
  expect(out).toContain("Local network · 4 machines");
  expect(out).toContain("gpt-oss-120b · 4-bit");
  expect(out).toContain("lm-speed lm-speed-fast");
  expect(out).toContain("Split across 2");
  expect(out).toContain("Qwen3 235B-A22B · 4-bit");
  expect(out).toContain("on office-studio + office-mini");
  expect(out).toContain('href="#/team?tab=models"');
});

test("card when nothing fits now: says so and names what idle machines could run; empty team", () => {
  const busy = renderToStaticMarkup(<LocalModelsCard nodes={[node("me", { self: true }, 16, 12.3, "Apple M5")]} models={legacy} />);
  expect(busy).toContain("Nothing in the catalog fits in the memory free right now.");
  // Audit 2026-09-26 finding 7: Walkie doesn't attribute memory to agents, so the card doesn't claim stopping them helps.
  expect(busy).not.toContain("agents stopped");
  expect(busy).toContain("If the machines were otherwise idle</span>: <strong>Qwen3 14B · 4-bit</strong> on me");
  expect(busy).toContain("only the OS and about 4 GB of apps running");
  const none = renderToStaticMarkup(<LocalModelsCard nodes={[{ ...node("me", { self: true }, 16, 4, "Apple M5"), stats: undefined }]} models={legacy} />);
  expect(none).toContain("No machine has reported its memory yet");
});

test("Team section: every group with its why, machines, picks with model-card links, what isn't counted", () => {
  const out = renderToStaticMarkup(<LocalModelsSection nodes={lan} models={legacy} />);
  expect(out).toContain("This machine and 3 others answer within 5 ms (slowest 3 ms)");
  expect(out).toContain("NVIDIA GeForce RTX 4090 · 24 GB VRAM + 64 GB RAM");
  // Audit 2026-09-26 finding 5: no free-VRAM reading = the GPU counts only if idle, labelled.
  expect(out).toContain("Free GPU memory not measured: the GPU counts only in the &quot;if idle&quot; figure");
  expect(out).toContain("GB free now");
  expect(out).toContain('href="https://huggingface.co/openai/gpt-oss-120b"');
  expect(out).toContain('rel="noreferrer noopener"');
  expect(out).toContain("Next one up");
  expect(out).toContain("doesn&#x27;t fit");
  expect(out).toContain("tobias-mbp");
  expect(out).toContain("23 ms from this machine");
  expect(out).toContain("Not counted: sol-x1 (offline).");
  expect(out).toContain("nothing is downloaded or run");
});

test("Mission Control card labels an unmeasured GPU and uses free VRAM when it is reported", () => {
  const rig = () => ({ ...node("rig", { self: true }, 32, 30, "AMD Ryzen 9", [{ name: "NVIDIA GeForce RTX 4090", vram: 24 * GiB }]) });
  const unmeasured = renderToStaticMarkup(<LocalModelsCard nodes={[rig()]} models={legacy} />);
  expect(unmeasured).toContain("Free GPU memory isn&#x27;t measured on some machines");
  const measured = rig();
  measured.stats = { ...measured.stats!, gpu_free: [2 * GiB] };
  const busy = renderToStaticMarkup(<LocalModelsCard nodes={[measured]} models={legacy} />);
  expect(busy).not.toContain("isn&#x27;t measured");
  // 22 of 24 GiB VRAM in use: 1.5 GiB usable now (0.5 GiB reserve, POOL-REAL-1), so nothing fits now; the whole card only if idle.
  expect(busy).toContain("1.5 GB free for a model now");
  expect(busy).toContain("Nothing in the catalog fits in the memory free right now.");
  expect(busy).toContain("otherwise idle</span>: <strong>Qwen3 32B · 4-bit</strong> on rig");
});

test("a hostile hardware name renders as text", () => {
  const out = renderToStaticMarkup(<LocalModelsSection nodes={[node("me", { self: true }, 64, 4, "<img src=x onerror=alert(1)>")]} models={legacy} />);
  expect(out).not.toContain("<img");
  expect(out).toContain("&lt;img");
});

// WALKIE-POOL-2: the headline is what ALL the machines could run together, wherever they are, with where each part runs.
const fleet: NodeView[] = [
  node("maren-mbp", { self: true, rtt_ms: 0, pool: { share: false, cap: null, runtime: true, busy: false } }, 16, 9, "Apple M5"),
  node("tobias-mbp", { rtt_ms: 24, pool: { share: true, cap: null, runtime: true, busy: false } }, 36, 14, "Apple M3 Pro"),
  node("atlas", { rtt_ms: 31, pool: { share: true, cap: null, runtime: true, busy: false } }, 64, 12, "AMD Ryzen 9 7950X", [{ name: "NVIDIA GeForce RTX 4090", vram: 24 * GiB }]),
  node("sol-x1", { rtt_ms: 38 }, 48, 7, "Intel(R) Core(TM) Ultra 7 155H"), // big-ish, and not shared
  node("ines-studio", { rtt_ms: 27, pool: { share: true, cap: null, runtime: true, busy: false } }, 24, 10, "Apple M4"),
];

test("card headline: all our machines together, the placement, who starts it, who isn't sharing, then the fast options", () => {
  const out = renderToStaticMarkup(<LocalModelsCard nodes={fleet} models={legacy} />);
  const all = out.indexOf("With all our machines together");
  const fast = out.indexOf("Fast options: one machine, or machines on one network");
  expect(all).toBeGreaterThan(0);
  expect(fast).toBeGreaterThan(all);
  expect(out).toMatch(/gpt-oss-120b · 4-bit/);
  expect(out).toMatch(/split across \d machines/);
  expect(out).toContain("starts it");
  expect(out).toContain("not sharing");
  expect(out).toMatch(/\d+ ms compute \+ \d+ ms network \(\d round trips? from [a-z0-9-]+[;)].* per token · estimate/);
  const section = renderToStaticMarkup(<LocalModelsSection nodes={fleet} models={legacy} />);
  expect(section).toContain("With all our machines together");
  expect(section).toContain("a person starts the run");
});

test("POOL-REAL-1: a model one machine runs at least as fast as the split is shown on that machine, not split", () => {
  const withBig = fleet.map((n) => (n.hostname === "sol-x1" ? node("sol-x1", { rtt_ms: 38 }, 96, 7, "Intel(R) Core(TM) Ultra 7 155H") : n));
  const out = renderToStaticMarkup(<LocalModelsCard nodes={withBig} models={legacy} />);
  expect(out).toMatch(/gpt-oss-120b · 4-bit/);
  expect(out).toContain("on one machine");
  expect(out).not.toMatch(/about [\d.]+ tokens\/s, split across \d machines/);
  // And the serve block offers the fastest GPU a model fits on whole.
  expect(out).toContain("Serve on one machine");
});

// ---- LOCAL-MODELS-HF-1: the list's source, the best overall, each machine's best and faster pick, Hugging Face links ----

const sparks = (): NodeView[] => {
  const asView = (g: ReturnType<typeof spark>): NodeView => ({ node_id: g.node_id, handle: "alex", hostname: g.hostname, ip: "100.64.0.1", online: true, last_seen: 1, rtt_ms: g.rtt_ms, self: g.self, sync: { behind: 0, last_sync: 1 }, stats: g.stats } as NodeView);
  return [
    asView(spark("spark-115f", "machine-stats/meminfo-gb10-spark-115f.txt", { self: true, rtt_ms: null })),
    asView(spark("spark-0e86", "machine-stats/meminfo-gb10-spark-0e86.txt", { rtt_ms: 1 }, "machine-stats/nvidia-smi-gb10-spark-0e86.txt")),
    asView({ ...mac16("alex-mac", { rtt_ms: 40 }) }),
  ];
};

test("Team section from the Hugging Face list: where it came from, the best overall, each machine's best and faster pick, a link on every pick", () => {
  const out = renderToStaticMarkup(<LocalModelsSection nodes={sparks()} models={live} />);
  expect(out).toContain("Models from Hugging Face, read 2026-10-01 22:40 UTC (16 models)");
  expect(out).toContain("Best overall");
  expect(out).toContain("NVIDIA GB10 · 122 GB unified");
  expect(out).not.toContain("No GPU found");
  // The two sparks share a network: each has its own best and faster pick under it.
  const group = out.slice(out.indexOf("Local network · 2 machines"), out.indexOf("alex-mac"));
  expect((group.match(/class="lm-pick-label">Best</g) ?? []).length).toBe(2);
  expect(group).toContain('class="lm-pick-label">Faster<');
  // Every pick names its maker and size, why it ranks there, and links to its Hugging Face page.
  expect(out).toMatch(/Rated #\d+ of \d+ on Hugging Face benchmark results/);
  expect(out).toMatch(/href="https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+" target="_blank" rel="noreferrer noopener"/);
  expect(out).toMatch(/Qwen · \d+B|Qwen · \d+(\.\d+)?B/);
});

test("Mission Control card: the best overall first, the source line, then the fast options", () => {
  const out = renderToStaticMarkup(<LocalModelsCard nodes={sparks()} models={live} />);
  expect(out.indexOf("Best overall")).toBeGreaterThan(0);
  expect(out.indexOf("Best overall")).toBeLessThan(out.indexOf("Fast options: one machine, or machines on one network"));
  expect(out).toContain("Models from Hugging Face, read 2026-10-01 22:40 UTC");
  expect(out).toMatch(/href="https:\/\/huggingface\.co\//);
});

test("a list that could not be read: the built-in list's name and the reason, in words, with a way to ask again", () => {
  const note = `Couldn't reach Hugging Face (no network), so this is the list built into Walkie (updated ${CATALOG.updated}).`;
  const out = renderToStaticMarkup(<LocalModelsSection nodes={sparks()} models={{ catalog: CATALOG, source: "built-in", state: "built-in", checkedAt: null, note }} />);
  expect(out).toContain(`Built-in list (v${CATALOG.version}, updated ${CATALOG.updated})`);
  expect(out).toContain(note.replace("'", "&#x27;"));
  expect(out).toContain("Check Hugging Face again");
});

test("while Hugging Face is being read: says so (a status region) and still shows the list it has", () => {
  const out = renderToStaticMarkup(<LocalModelsSection nodes={sparks()} models={{ ...legacy, refreshing: true }} />);
  expect(out).toMatch(/role="status"[^>]*>[^<]*Refreshing the bounded Hugging Face list…/);
  expect(out).toContain("Best and rankings refer only to the current list, not all Hub models");
  expect(out).toContain("self-reported benchmark results on Hugging Face within the current list");
  expect(out).toContain("Local network · 2 machines");
});

test("a pick Walkie cannot start says so; the split-run button only ever offers pinned models", () => {
  // A model the shipped pinned list has never heard of, the best of its list (so this does not depend on what ships).
  const novel = catalogOf([mk("zz-novel-30b", { params_b: 30, released: "2026-09-30", quality: rated(2, { GPQA: 95 }) }), ...liveCatalog.models.slice(0, 6)]);
  const out = renderToStaticMarkup(<LocalModelsSection nodes={sparks()} models={{ ...live, catalog: novel }} />);
  expect(out).toContain("zz-novel-30b");
  expect(out).toContain("Walkie starts only the models in its pinned list");
});

test("a pick row that shows its facts carries the has-meta class (the stylesheet lays it out in three rows); one without does not", () => {
  const withFacts = renderToStaticMarkup(<LocalModelsSection nodes={sparks()} models={live} />);
  expect(withFacts).toContain('class="lm-pick has-meta"');
  expect(withFacts).toContain("lm-pick-meta");
  const pick = suggestTeam(sparks(), { cat: liveCatalog }).machines[0]!.best!;
  const bare = renderToStaticMarkup(<ul><PickRow label="Best" pick={pick} /></ul>);
  expect(bare).toContain('class="lm-pick"');
  expect(bare).not.toContain("has-meta");
});

test("when every pick is in the pinned list there is no such note", () => {
  const out = renderToStaticMarkup(<LocalModelsSection nodes={sparks()} models={{ ...live, catalog: catalogOf(CATALOG.models) }} />);
  expect(out).not.toContain("Walkie starts only the models in its pinned list");
});

test("a hostile maker or model name from the list renders as text", () => {
  const hostile = catalogOf([mk("evil", { params_b: 8, maker: "Acme <img src=x onerror=alert(1)>", name: "Evil<script>alert(1)</script>-8B", released: "2026-09-01", quality: rated(1, { GPQA: 90 }) })]);
  const out = renderToStaticMarkup(<LocalModelsSection nodes={sparks()} models={{ catalog: hostile, source: "huggingface", state: "fresh", checkedAt: T, note: null }} />);
  expect(out).not.toContain("<img");
  expect(out).not.toContain("<script>");
  expect(out).toContain("&lt;img");
});
