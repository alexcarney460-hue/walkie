import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

test("the dashboard page title names Sqwakie", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  expect(html).toContain("<title>Sqwakie</title>");
});
