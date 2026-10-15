import { expect, test } from "bun:test";
import { fetchBrowserRequest } from "./network.ts";

test("pinned browser fetch refuses a private DNS answer before making a request", async () => {
  const privateDns = (async () => [{ address: "169.254.169.254", family: 4 }]) as never;
  await expect(fetchBrowserRequest("http://public.example/metadata", "GET", {}, null, [], privateDns))
    .rejects.toThrow("private address");
});
