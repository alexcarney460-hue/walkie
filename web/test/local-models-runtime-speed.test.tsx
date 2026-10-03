// Review F2 (local-models-hf-review), the dashboard side: a pick timed at a GPU that Walkie's own runtime does not use
// (a DGX Spark, an NVIDIA card on Linux arm64) says so next to its speed in the Mission Control card and on the Team page,
// in the best overall, each pick row and the whole-team pick; a Metal Mac or a Linux x64 CUDA box never gets the line.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { NodeView } from "../src/api/types.ts";
import { installWindow } from "./window-stub.ts";
import { CATALOG } from "../../src/pool/catalog.ts";

installWindow();
const { LocalModelsCard, LocalModelsSection } = await import("../src/components/LocalModels.tsx");
const GiB = 1024 ** 3;
const CAVEAT = "assumes a GPU build of llama.cpp: Walkie's own runtime is counted as CPU only on";
const models = { catalog: CATALOG, source: "built-in" as const, state: "built-in" as const, checkedAt: null, note: null };
const text = (html: string): string => html.replace(/&#x27;/g, "'").replace(/<[^>]+>/g, " ");
const count = (s: string, sub: string): number => s.split(sub).length - 1;

const spark = (id: string, self: boolean): NodeView => ({
  node_id: id, hostname: id, handle: "fixture", ip: "192.0.2.1", online: true, self, rtt_ms: self ? 0 : 1, last_seen: 1, sync: { behind: 0, last_sync: 1 },
  pool: { share: true, runtime: true, busy: false, cap: null, serve: true },
  stats: { at: 1, temp_c: null, sys: { os: "linux", arch: "arm64", cpus: 20, load1: 0 },
    mem: { total: 128 * GiB, used: 8 * GiB, swap_used: 0, pressure: "normal" },
    accel: { chip: null, unified: false, gpu_limit: null, gpus: [{ name: "NVIDIA GB10", vram: 0, unified: true }] } },
});
const mac: NodeView = { ...spark("metal-fixture", true), stats: { ...spark("m", true).stats!, sys: { os: "darwin", arch: "arm64", cpus: 12, load1: 0 },
  accel: { chip: "Apple M4 Max", unified: true, gpu_limit: null, gpus: [] } } };
const cuda: NodeView = { ...spark("cuda-fixture", true), stats: { ...spark("c", true).stats!, sys: { os: "linux", arch: "x64", cpus: 24, load1: 0 },
  accel: { chip: null, unified: false, gpu_limit: null, gpus: [{ name: "NVIDIA GeForce RTX 4090", vram: 24 * GiB }] }, gpu_free: [22 * GiB] } };

test("Team page: a spark's best overall, pick rows and whole-team pick carry the caveat", () => {
  const html = text(renderToStaticMarkup(<LocalModelsSection nodes={[spark("spark-a", true), spark("spark-b", false)]} models={models} />));
  expect(html).toContain(`Speed ${CAVEAT}`); // the best overall's note
  expect(html).toContain(`· speed ${CAVEAT}`); // the whole-team pick's note
  expect(count(html, CAVEAT)).toBeGreaterThanOrEqual(4); // plus each machine's Best and Faster rows
  expect(html).toContain("runtime capacity is counted as CPU only"); // the machine's own note stays
});

test("Mission Control card: the best overall carries the caveat", () => {
  const html = text(renderToStaticMarkup(<LocalModelsCard nodes={[spark("spark-a", true)]} models={models} />));
  expect(html).toContain(`Speed ${CAVEAT}`);
});

test("a Metal Mac and a Linux x64 CUDA box never get the caveat, on either surface", () => {
  for (const n of [mac, cuda]) {
    expect(text(renderToStaticMarkup(<LocalModelsSection nodes={[n]} models={models} />))).not.toContain("assumes a GPU build");
    expect(text(renderToStaticMarkup(<LocalModelsCard nodes={[n]} models={models} />))).not.toContain("assumes a GPU build");
  }
});
