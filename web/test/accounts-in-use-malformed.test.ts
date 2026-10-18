import { expect, test } from "bun:test";
import { inUse } from "../src/components/Accounts.tsx";
import type { AccountView } from "../src/api/types.ts";

// Settings counts accounts in use with inUse; a malformed machine list from a peer must not throw.
test("inUse is false, not a crash, for malformed machine lists", () => {
  const shapes = [{ machines: null }, { machines: [null] }, { machines: [{}] }, { machines: [{ agents: null }] }];
  for (const shape of shapes) expect(inUse(shape as unknown as AccountView)).toBe(false);
  expect(inUse({ machines: [{ agents: [{}] }] } as unknown as AccountView)).toBe(true);
});
