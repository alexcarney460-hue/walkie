import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { NodeView } from "../src/api/types.ts";
import { MachineStatsLine, statsTitle } from "../src/components/MachineStats.tsx";

const GB = 1024 ** 3;
const node = (over: Partial<NodeView> = {}): NodeView => ({
  node_id: "a1b2c3d4e5f60718", handle: "maren", hostname: "maren-mbp", ip: "100.88.14.2", online: true, last_seen: Date.now(),
  rtt_ms: 4, self: false, sync: { behind: 0, last_sync: null },
  stats: { at: Date.now() - 120_000, mem: { total: 16 * GB, used: 12 * GB, swap_used: 2.5 * GB, pressure: "warn" }, temp_c: 74.4 },
  ...over,
});
const html = (n: NodeView, part?: "rail" | "cell") => renderToStaticMarkup(<MachineStatsLine node={n} part={part} />);

test("memory bar: used/total GB, fill width and meter value, coloured by pressure", () => {
  const out = html(node(), "cell");
  expect(out).toContain("12.0/16.0 GB");
  expect(out).toContain('role="meter"');
  expect(out).toContain('aria-valuenow="75"');
  expect(out).toContain("width:75.0%");
  expect(out).toContain("ms-mem ms-lv-warn");
  expect(html(node({ stats: { at: 1, mem: { total: 16 * GB, used: 4 * GB, swap_used: 0, pressure: "normal" }, temp_c: 40 } }), "cell")).toContain("ms-lv-normal");
  expect(html(node({ stats: { at: 1, mem: { total: 16 * GB, used: 16 * GB, swap_used: 0, pressure: "critical" }, temp_c: 40 } }), "cell")).toContain("ms-lv-critical");
});

test("temperature bands: green below 70, amber 70 to 85, red above 85", () => {
  const t = (c: number) => html(node({ stats: { at: 1, mem: null, temp_c: c } }), "cell");
  expect(t(69.4)).toContain("ms-lv-normal");
  expect(t(69.4)).toContain("69 °C");
  expect(t(70)).toContain("ms-lv-warn");
  expect(t(85)).toContain("ms-lv-warn");
  expect(t(85.2)).toContain("ms-lv-critical");
});

test("n/a when a reading is missing or the machine never reported", () => {
  const none = html(node({ stats: undefined }));
  expect(none).toContain("mem n/a");
  expect(none.match(/n\/a/g)).toHaveLength(2);
  expect(none).not.toContain('role="meter"');
  expect(none).toContain("no memory or temperature reported");
  const wsl = html(node({ stats: { at: 1, mem: { total: 16 * GB, used: 8 * GB, swap_used: 0, pressure: null }, temp_c: null } }));
  expect(wsl).toContain("8.0/16.0 GB");
  expect(wsl).toContain("ms-lv-none");
  expect(wsl).toMatch(/ms-temp[^>]*><span class="ms-na">temp n\/a<\/span>/);
});

test("offline: values greyed as last known", () => {
  const out = html(node({ online: false }));
  expect(out).toContain("ms-stale");
  expect(out).toContain("last known, machine offline");
  expect(html(node())).not.toContain("ms-stale");
});

test("tooltip: memory, pressure, swap, temperature and when it was sampled", () => {
  const now = Date.now();
  const title = statsTitle("maren-mbp", node().stats, true, now);
  expect(title).toContain("Memory 12.0 of 16.0 GB used · pressure elevated");
  expect(title).toContain("Swap 2.5 GB used");
  expect(title).toContain("Temperature 74.4 °C");
  expect(title).toContain("Updated 2m ago");
  expect(statsTitle("maren-mbp", node().stats, false, now)).toContain("Last known (machine offline), sampled 2m ago");
});

test("WALKIE-TEMP-WSL: the temperature shows its source; a GPU fallback is labelled GPU; Windows zones in the tooltip", () => {
  const cpu = html(node({ stats: { at: 1, mem: null, temp_c: 86.1, temp_src: "cpu", temp_zones: [{ name: "TZ00", c: 27.9 }, { name: "THRM", c: 86.1 }], gpu_temp: [61] } }));
  expect(cpu).toContain('86 °C <span class="ms-src" data-testid="temp-src">CPU</span>');
  const gpu = html(node({ stats: { at: 1, mem: null, temp_c: 34, temp_src: "gpu", gpu_temp: [34] } }));
  expect(gpu).toContain('34 °C <span class="ms-src" data-testid="temp-src">GPU</span>');
  expect(html(node({ stats: { at: 1, mem: null, temp_c: 50 } }))).toContain(">CPU</span>"); // an older daemon: CPU sensors only
  expect(html(node({ stats: { at: 1, mem: null, temp_c: null } }))).not.toContain("ms-src");
  const now = Date.now();
  const t1 = statsTitle("hestia", { at: now, mem: null, temp_c: 86.1, temp_src: "cpu", temp_zones: [{ name: "TZ00", c: 27.9 }, { name: "THRM", c: 86.1 }], gpu_temp: [61] }, true, now);
  expect(t1).toContain("Temperature 86.1 °C (hottest Windows thermal zone, CPU/board)");
  expect(t1).toContain("Windows thermal zones: TZ00 28 °C, THRM 86 °C");
  expect(t1).toContain("GPU 61 °C");
  const t2 = statsTitle("almond", { at: now, mem: null, temp_c: 34, temp_src: "gpu", gpu_temp: [34] }, true, now);
  expect(t2).toContain("Temperature 34.0 °C (GPU; no CPU or board sensor)");
  expect(t2).not.toContain("GPU 34 °C");
  const t3 = statsTitle("hestia", { at: now, mem: null, temp_c: 70, temp_src: "cpu", temp_zones: [{ name: "THRM", c: 70 }], temp_route: "session" }, true, now);
  expect(t3).toContain("(hottest Windows thermal zone, CPU/board, read through another WSL session)");
});

test("WALKIE-TEMP-WSL: machine page temperature gauge names the source; the accelerator card shows each GPU's temperature", async () => {
  const { MachineGauges } = await import("../src/views/machine/MachineGauges.tsx");
  const accel = { chip: "AMD Ryzen 7", unified: false, gpu_limit: null, gpus: [{ name: "NVIDIA GeForce RTX 5070", vram: 12 * GB }] };
  const gauges = (stats: NodeView["stats"]) => renderToStaticMarkup(<MachineGauges node={node({ stats })} />);
  const gpu = gauges({ at: Date.now(), mem: null, temp_c: 34, temp_src: "gpu", accel, gpu_free: [11 * GB], gpu_temp: [34] });
  expect(gpu).toContain("°C · GPU");
  expect(gpu).toContain("GPU; no CPU or board sensor");
  expect(gpu).toContain("11.0 of 12.0 GB free · 34 °C");
  const zones = gauges({ at: Date.now(), mem: null, temp_c: 86.1, temp_src: "cpu", temp_zones: [{ name: "TZ00", c: 27.9 }, { name: "THRM", c: 86.1 }] });
  expect(zones).toContain("°C · CPU");
  expect(zones).toContain("Hottest Windows thermal zone, CPU/board · TZ00 28°, THRM 86°");
  expect(gauges({ at: Date.now(), mem: null, temp_c: null })).toContain("No readable sensor");
});
