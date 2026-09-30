import { expect, test } from "bun:test";

test("site tests block non-loopback fetches", async () => {
  await expect(fetch("https://example.com/guard-probe")).rejects.toThrow("test fetch blocked non-loopback URL");
});
