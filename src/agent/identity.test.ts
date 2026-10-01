import { expect, test } from "bun:test";
import { detectRuntime, otherRuntimeName, resolveAgentName } from "./identity.ts";

test("Grok session identity wins over inherited Claude and matches hooks and discovery", () => {
  const env = { GROK_SESSION_ID: "ABC123-4567", CLAUDE_CODE_SESSION_ID: "inherited" };
  expect(detectRuntime(env)).toBe("other");
  expect(otherRuntimeName(env)).toBe("grok");
  expect(resolveAgentName(env)).toBe("grok-abc123");
  expect(resolveAgentName({ GROK_HOOK_EVENT: "Stop" }, "ABC123-4567")).toBe("grok-abc123");
});
