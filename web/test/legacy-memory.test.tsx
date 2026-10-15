import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LegacyMemory } from "../src/views/seats/LegacyMemory.tsx";

test("the dashboard presents a typed legacy deletion without showing quarantined notes", () => {
  const html = renderToStaticMarkup(<LegacyMemory />);
  expect(html).toContain("Legacy memory");
  expect(html).toContain("delete legacy memory");
  expect(html).toContain("disabled");
  expect(html).not.toContain("Alex private recovery note");
});
