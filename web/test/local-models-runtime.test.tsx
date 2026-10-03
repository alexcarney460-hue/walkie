import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { NodeView } from "../src/api/types.ts";
import { installWindow } from "./window-stub.ts";
import { CATALOG } from "../../src/pool/catalog.ts";

installWindow();
const { ServeBlock } = await import("../src/components/LocalModelsServe.tsx");
const { LocalModelsSection } = await import("../src/components/LocalModels.tsx");
const GiB = 1024 ** 3;
const spark: NodeView = {
  node_id: "runtime-fixture", hostname: "arm-worker", handle: "fixture", ip: "192.0.2.1",
  online: true, self: true, rtt_ms: 0, last_seen: 1, sync: { behind: 0, last_sync: 1 },
  pool: { share: true, runtime: true, busy: false, cap: null, serve: true },
  stats: { at: 1, temp_c: null, sys: { os: "linux", arch: "arm64", cpus: 20, load1: 0 },
    mem: { total: 128 * GiB, used: 8 * GiB, swap_used: 0, pressure: "normal" },
    accel: { chip: null, unified: false, gpu_limit: null, gpus: [{ name: "NVIDIA GB10", vram: 0, unified: true }] } },
};

test("CPU-only pinned runtime explains the unavailable GPU serve action", () => {
  const html = renderToStaticMarkup(<ServeBlock nodes={[spark]} />);
  expect(html).toContain("CPU only");
  expect(html).toContain("GPU serving is unavailable");
  expect(html).not.toContain("lm-run-go");
});

test("hardware suggestions retain GB10 capability alongside the runtime caveat", () => {
  const html = renderToStaticMarkup(<LocalModelsSection nodes={[spark]} models={{ catalog: CATALOG,
    source: "built-in", state: "built-in", checkedAt: null, note: null }} />);
  expect(html).toContain("NVIDIA GB10");
  expect(html).toContain("128 GB unified");
  expect(html).toContain("runtime capacity is counted as CPU only");
});

test("known CUDA and Metal keep a serve action without the CPU runtime note", () => {
  for (const os of ["linux", "darwin"] as const) {
    const gpu: NodeView = { ...spark, stats: { ...spark.stats!,
      sys: { os, arch: os === "linux" ? "x64" : "arm64", cpus: 20, load1: 0 },
      accel: os === "linux" ? spark.stats!.accel : { chip: "Apple M4 Max", unified: true, gpu_limit: null, gpus: [] } } };
    const html = renderToStaticMarkup(<ServeBlock nodes={[gpu]} />);
    expect(html).toContain("lm-run-go");
    expect(html).not.toContain("GPU serving is unavailable");
  }
});
