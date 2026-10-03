// PROJECT-REPORTS-1: the duty's model turn needs no tool at all (the facts are in its prompt and the daemon delivers from
// its reply), so it runs in a Claude that has none: nothing for a card title's injected instruction to call. This file
// pins the child's argv for such a turn and that every other turn is exactly what it was.
import { describe, expect, test } from "bun:test";
import { claudeArgs, TOOLLESS_FLAGS, walkieMcpConfig, type ArgsSpec } from "../../src/daemon/orchestrator/process.ts";
import { PLATFORM_TOOLS } from "../../src/protocol/orchestrator.ts";

const MCP = walkieMcpConfig(["/usr/local/bin/walkie"], "/home/alex/.walkie", "/home/alex/.walkie/walkie.sock");
const base: ArgsSpec = {
  session: "s1", resume: false, permissionMode: "bypassPermissions", permissionPrompts: true, allowedTools: PLATFORM_TOOLS,
  mcpConfig: MCP, systemPrompt: "sys", model: "opus",
};
const valueOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

describe("the flags only a tool-less turn has", () => {
  test("are exactly the ones the host treats as 'this Claude cannot run a tool-less turn' when it rejects one", () => {
    const flagsOf = (argv: string[]) => new Set(argv.filter((a) => a.startsWith("--")).map((a) => a.split("=")[0] as string));
    const normal = flagsOf(claudeArgs(base));
    const added = [...flagsOf(claudeArgs({ ...base, tools: "none" }))].filter((f) => !normal.has(f)).sort();
    expect(added).toEqual([...TOOLLESS_FLAGS].sort());
  });
});

describe("the child's argv", () => {
  test("a turn that needs no tools gets none: no built-in tool, no MCP server to load, nothing allowed", () => {
    const argv = claudeArgs({ ...base, tools: "none" });
    expect(argv).toContain("--tools=");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv.some((a) => a.startsWith("--mcp-config"))).toBe(false);
    expect(argv.some((a) => a.startsWith("--allowedTools"))).toBe(false);
    expect(argv.join(" ")).not.toContain("mcp__walkie");
    expect(argv.join(" ")).not.toContain("mcpServers");
    // The empty value is bound to the flag (one argv element), so the variadic option cannot swallow the next flag.
    expect(argv.filter((a) => a === "--tools" || a.startsWith("--tools"))).toEqual(["--tools="]);
  });

  test("it is never run with permissions bypassed, whatever the access setting says", () => {
    expect(valueOf(claudeArgs({ ...base, tools: "none" }), "--permission-mode")).toBe("default");
    expect(valueOf(claudeArgs({ ...base, tools: "none", permissionMode: "acceptEdits" }), "--permission-mode")).toBe("default");
  });

  test("the rest of a no-tools turn's argv is the ordinary one: streaming, session, prompts denied, model, system prompt", () => {
    const argv = claudeArgs({ ...base, tools: "none" });
    expect(argv.slice(0, 7)).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
    expect(valueOf(argv, "--session-id")).toBe("s1");
    expect(valueOf(argv, "--setting-sources")).toBe("");
    expect(argv).toEqual(expect.arrayContaining(["--permission-prompts", "none", "--model", "opus", "--append-system-prompt", "sys"]));
    const resumed = claudeArgs({ ...base, tools: "none", resume: true });
    expect(valueOf(resumed, "--resume")).toBe("s1");
    expect(resumed).toContain("--tools=");
  });

  test("every other turn is unchanged: the Walkie tools allowed, the walkie MCP server loaded, no tools flag", () => {
    const argv = claudeArgs(base);
    expect(argv).toContain("--allowedTools=mcp__walkie");
    expect(argv).toContain(`--mcp-config=${MCP}`);
    expect(argv.some((a) => a.startsWith("--tools"))).toBe(false);
    expect(argv).not.toContain("--strict-mcp-config");
    expect(valueOf(argv, "--permission-mode")).toBe("bypassPermissions");
    // Exactly the no-tools argv with the tool arguments swapped back: nothing else moved.
    const none = claudeArgs({ ...base, tools: "none" });
    const without = (a: string[]) => a.filter((x) => !x.startsWith("--tools") && x !== "--strict-mcp-config" && !x.startsWith("--allowedTools") && !x.startsWith("--mcp-config"));
    const normal = (a: string[]) => without(a).map((x) => (x === "default" || x === "bypassPermissions" ? "<mode>" : x));
    expect(normal(none)).toEqual(normal(argv));
  });
});
