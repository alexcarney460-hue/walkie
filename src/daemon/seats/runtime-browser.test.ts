import { expect, test } from "bun:test";
import { claudeSeatArgs } from "./runtime.ts";

test("an allowed Claude seat gets an explicit Walkie MCP config even under a host tool policy", () => {
  const config = JSON.stringify({ mcpServers: { walkie: { command: "/walkie", args: ["mcp"] } } });
  const args = claudeSeatArgs({ session: "test", mode: "acceptEdits", permissionPrompts: false,
    systemPrompt: "seat", tools: { allow: ["mcp__walkie__browser_read"] }, mcpConfig: config });
  expect(args).toContain(`--mcp-config=${config}`);
  expect(args).toContain("--strict-mcp-config");
  expect(args).toContain("--tools=mcp__walkie__browser_read");
});

test("a seat without a grant does not receive a Walkie MCP config from its launcher", () => {
  const args = claudeSeatArgs({ session: "test", mode: "acceptEdits", permissionPrompts: false, systemPrompt: "seat" });
  expect(args.some((arg) => arg.startsWith("--mcp-config="))).toBe(false);
});
