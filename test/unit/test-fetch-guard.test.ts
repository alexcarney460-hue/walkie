import { expect, test } from "bun:test";

test("test runs refuse external fetch before opening a connection", async () => {
  await expect(fetch("https://example.invalid/"))
    .rejects.toThrow("test fetch blocked non-loopback URL");
});

test("test runs allow a loopback fetch", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("local") });
  try {
    expect(await (await fetch(`http://127.0.0.1:${server.port}`)).text()).toBe("local");
  } finally { server.stop(true); }
});
