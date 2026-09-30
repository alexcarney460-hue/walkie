// CLI-HELP-AUDIT: every command registered in main.ts's COMMANDS table must have a line in its own USAGE text,
// so `walkie help` never silently omits a command that `walkie <cmd>` actually runs.
import { describe, expect, test } from "bun:test";
import { COMMANDS, USAGE } from "../../src/cli/main.ts";

describe("walkie help coverage", () => {
  for (const name of Object.keys(COMMANDS)) {
    test(`"${name}" is mentioned in USAGE`, () => {
      expect(USAGE).toMatch(new RegExp(`\\b${name}\\b`));
    });
  }
});

test("seats allow help explains person and exact agent entries", () => {
  expect(USAGE).toContain("person entries cover their agents");
  expect(USAGE).toContain("exact agents");
  expect(USAGE).toContain("@alex/alex-mac");
});
