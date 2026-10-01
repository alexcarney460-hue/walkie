import { expect, test } from "bun:test";
import { validAgentHeader } from "../../src/daemon/local-routes.ts";
import { StatusReq } from "../../src/protocol/schemas.ts";
import { z } from "zod";

test("local callers cannot impersonate reserved cloud guest names", () => {
  expect(() => validAgentHeader("dots-ops")).toThrow(/reserved/);
  expect(() => validAgentHeader("grokbot-build")).toThrow(/reserved/);
  expect(validAgentHeader("grok-cli-1")).toBe("grok-cli-1");
});

test("guest status stays on the old peer runtime wire shape", () => {
  const parsed = StatusReq.parse({ agent: "dots-ops", state: "working", runtime: "other", runtime_name: "dots", title: "Working", task: "WEB-1" });
  expect(parsed.runtime).toBe("other");
  expect(parsed.runtime_name).toBe("dots");
  const pre5Shape = z.object({ agent: z.string(), state: z.string(), runtime: z.enum(["claude-code", "codex", "kimi", "cli", "other"]) });
  expect(pre5Shape.parse(parsed)).toEqual({ agent: "dots-ops", state: "working", runtime: "other" });
});
