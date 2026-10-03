import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { swapBinary, restartService, waitForDaemon } from "../../src/cli/commands/update.ts";
import type { Ctx } from "../../src/cli/context.ts";

const target = "/virtual/walkie";
const old = "old binary";
const fresh = new TextEncoder().encode("new binary");
const timers = { setTimeout: globalThis.setTimeout };
let files: Map<string, string>;
let restores: Array<() => void>;
function spy(object: any, key: string, implementation: (...args: any[]) => any) {
  const s = spyOn(object, key).mockImplementation(implementation);
  restores.push(() => s.mockRestore());
  return s;
}
beforeEach(() => {
  files = new Map([[target, old]]);
  restores = [];
  spy(fs, "copyFileSync", (a, b) => files.set(b, files.get(a)!));
  spy(fs, "writeFileSync", (p, bytes) => files.set(p, new TextDecoder().decode(bytes)));
  spy(fs, "chmodSync", () => {});
  spy(fs, "renameSync", (a, b) => { files.set(b, files.get(a)!); files.delete(a); });
  spy(fs, "rmSync", (p) => files.delete(p));
  spy(fs, "existsSync", (p) => files.has(p));
  // Exercise the production deadline, shortening only its wall-clock duration.
  spy(globalThis, "setTimeout", (fn, ms, ...args) => timers.setTimeout(fn, ms === 10_000 ? 20 : ms, ...args));
});
afterEach(() => { for (const restore of restores.reverse()) restore(); });

function probe(output: string | null, code: number | null) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = spyOn({ cancel() {} }, "cancel");
  const stdout = new ReadableStream<Uint8Array>({
    start(c) { controller = c; if (output !== null) { c.enqueue(new TextEncoder().encode(output)); c.close(); } },
    cancel,
  });
  let exit!: (code: number) => void;
  const exited = code === null ? new Promise<number>((resolve) => { exit = resolve; }) : Promise.resolve(code);
  const kill = spyOn({ kill() {} }, "kill");
  const spawn = spy(Bun, "spawn", () => ({ stdout, exited, kill }));
  return { cancel, kill, spawn, finish() { if (output === null && !cancel.mock.calls.length) controller.close(); if (code === null) exit(0); } };
}
async function boundedSwap() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      swapBinary(target, fresh, "v0.2.0"),
      new Promise<never>((_, reject) => { timer = timers.setTimeout(() => reject(new Error("probe exceeded test deadline")), 250); }),
    ]);
  } finally { clearTimeout(timer); }
}
function restored() { expect([...files]).toEqual([[target, old]]); }

for (const [name, output, code] of [
  ["delayed stdout even after exit", null, 0],
  ["delayed exit after correct stdout", "walkie 0.2.0", null],
  ["delayed stdout and exit", null, null],
] as const) {
  test(`probe bounds ${name} and restores previous binary`, async () => {
    const p = probe(output, code);
    try {
      expect((await boundedSwap()).ok).toBe(false);
      restored();
      expect(p.kill).toHaveBeenCalledWith("SIGKILL");
      if (output === null) expect(p.cancel).toHaveBeenCalled();
    } finally { p.finish(); }
  });
}
test("correct stdout with nonzero exit is rejected and restored", async () => {
  probe("walkie 0.2.0", 7);
  expect((await boundedSwap()).ok).toBe(false);
  restored();
});
test("matching version and successful exit keeps new binary and removes backup", async () => {
  const p = probe("walkie 0.2.0\n", 0);
  expect(await boundedSwap()).toEqual({ ok: true });
  expect([...files]).toEqual([[target, "new binary"]]);
  expect(p.kill).not.toHaveBeenCalled();
  expect(p.spawn.mock.calls[0]?.[0]).toEqual([target, "version"]);
});
test("wrong version restores previous binary", async () => {
  probe("walkie 0.1.0", 0);
  expect((await boundedSwap()).ok).toBe(false);
  restored();
});
test("spawn failure restores previous binary", async () => {
  spy(Bun, "spawn", () => { throw new Error("cannot spawn fixture"); });
  expect((await boundedSwap()).ok).toBe(false);
  restored();
});
test("stdout read failure terminates probe and restores previous binary", async () => {
  const kill = spyOn({ kill() {} }, "kill");
  spy(Bun, "spawn", () => ({
    stdout: new ReadableStream({ start(c) { c.error(new Error("fixture read failed")); } }),
    exited: new Promise<number>(() => {}), kill,
  }));
  expect((await boundedSwap()).ok).toBe(false);
  restored();
  expect(kill).toHaveBeenCalledWith("SIGKILL");
});
test("exit rejection restores previous binary", async () => {
  spy(Bun, "spawn", () => ({
    stdout: new Response("walkie 0.2.0").body,
    exited: Promise.reject(new Error("fixture wait failed")), kill() {},
  }));
  expect((await boundedSwap()).ok).toBe(false);
  restored();
});
test("mocked restart waits for healthy matching version and rejects unsuccessful restart", async () => {
  const ctx = { out() {}, err() {} } as unknown as Ctx;
  files.set("/virtual/service", "unit");
  const plan = { platform: "systemd" as const, path: "/virtual/service", content: "", load: [], unload: [], restart: ["fixture-restart"] };
  const spawn = spy(Bun, "spawn", () => ({ exited: Promise.resolve(0) }));
  let calls = 0;
  const health = async () => ({ ok: true, version: ++calls === 1 ? "0.1.0" : "0.2.0" });
  expect(await restartService(ctx, "0.2.0", { plan, probe: health, intervalMs: 1, timeoutMs: 100 })).toBe(true);
  expect(calls).toBe(2);
  spawn.mockImplementation(() => ({ exited: Promise.resolve(7) }));
  expect(await restartService(ctx, "0.2.0", { plan, probe: health })).toBe(false);
  expect(calls).toBe(2);
  expect(await waitForDaemon("0.2.0", async () => ({ ok: false, version: "0.2.0" }), 0)).toEqual({ ok: false, last: "answering unhealthy as 0.2.0" });
  files.delete("/virtual/service");
  expect(await restartService(ctx, "0.2.0", { plan, probe: health })).toBe(true);
});
