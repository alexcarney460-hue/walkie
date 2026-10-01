import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

test("guest documentation and tool consent describe the assigned-card disclosure", () => {
  const docs = ["docs/GUEST-GATEWAY.md", "docs/plans/AGENT-BRIDGE-1.md"]
    .map((path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
  for (const doc of docs) {
    expect(doc).toMatch(/guests see what is written on their assigned cards/i);
    expect(doc).toContain("cards must never carry secrets");
    expect(doc).not.toMatch(/(?:never|no) (?:secrets|join links) (?:in|reach) guest/i);
  }
});
