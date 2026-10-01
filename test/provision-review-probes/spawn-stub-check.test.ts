import { expect, test, spyOn } from "bun:test";
test("Bun.spawn / spawnSync / fetch are stubbable", async () => {
  const calls: unknown[] = [];
  const s1 = spyOn(Bun, "spawn").mockImplementation(((argv: unknown) => { calls.push(argv); throw new Error("blocked"); }) as never);
  const s2 = spyOn(Bun, "spawnSync").mockImplementation(((argv: unknown) => { calls.push(argv); throw new Error("blocked"); }) as never);
  expect(() => Bun.spawn(["echo", "x"])).toThrow("blocked");
  expect(() => Bun.spawnSync(["echo", "x"])).toThrow("blocked");
  s1.mockRestore(); s2.mockRestore();
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("no network"); }) as never;
  await expect(fetch("https://example.invalid")).rejects.toThrow("no network");
  globalThis.fetch = real;
  expect(calls.length).toBe(2);
});
