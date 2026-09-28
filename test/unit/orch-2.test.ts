// ORCH-2: the orchestrator is the person's platform operator. Its Claude always gets the Walkie tools and the walkie CLI
// without a prompt (it runs with nobody to answer one, so without them every Walkie tool was denied); `full` access is
// bypassPermissions; its system prompt is the operating playbook (mission, two modes, survey-and-refresh loop, workflow).
import { describe, expect, test } from "bun:test";
import { claudeArgs, walkieMcpConfig } from "../../src/daemon/orchestrator/process.ts";
import { playbook } from "../../src/daemon/orchestrator/playbook.ts";
import { DEFAULT_ACCESS, MODEL_ALIASES, ORCHESTRATOR_ACCESS, PLATFORM_TOOLS, effectiveMode, modelArg, validModel, type OrchestratorAccess } from "../../src/protocol/orchestrator.ts";

function argvFor(access: OrchestratorAccess, mode: "default" | "acceptEdits" | "bypassPermissions" = "default"): string[] {
  return claudeArgs({
    session: "s1", resume: false, permissionMode: effectiveMode(access, mode), permissionPrompts: true,
    allowedTools: PLATFORM_TOOLS, systemPrompt: playbook({ owner: "alex", hostname: "alex-mac", access }),
  });
}
const valueOf = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

describe("argv: the Walkie tools are allowed in every access mode", () => {
  test("platform is the default access; the rules cover the walkie MCP server and the walkie CLI", () => {
    expect(DEFAULT_ACCESS).toBe("platform");
    expect(ORCHESTRATOR_ACCESS).toEqual(["platform", "full"]);
    expect(PLATFORM_TOOLS).toEqual(["mcp__walkie"]); // no Bash rule: shell chaining escaped `Bash(walkie:*)`
  });

  for (const access of ORCHESTRATOR_ACCESS) {
    test(`${access}: one --allowedTools=<comma list> value (the variadic option can't swallow the next flag)`, () => {
      const argv = argvFor(access);
      expect(argv).toContain("--allowedTools=mcp__walkie");
      expect(argv.join(" ")).not.toMatch(/Bash\(/);
      expect(argv.filter((a) => a.startsWith("--allowedTools")).length).toBe(1);
      expect(argv).not.toContain("--allowedTools");
      expect(argv).toEqual(expect.arrayContaining(["--permission-prompts", "none"]));
    });
  }

  test("platform keeps the permission mode it was given", () => {
    expect(valueOf(argvFor("platform"), "--permission-mode")).toBe("default");
    expect(valueOf(argvFor("platform", "acceptEdits"), "--permission-mode")).toBe("acceptEdits");
  });

  test("full access is bypassPermissions, whatever mode was asked", () => {
    expect(effectiveMode("full", "default")).toBe("bypassPermissions");
    expect(valueOf(argvFor("full", "default"), "--permission-mode")).toBe("bypassPermissions");
    expect(valueOf(argvFor("full", "acceptEdits"), "--permission-mode")).toBe("bypassPermissions");
  });

  test("no allowed tools: no flag at all", () => {
    const argv = claudeArgs({ session: "s", resume: true, permissionMode: "default", permissionPrompts: false, allowedTools: [], systemPrompt: "x" });
    expect(argv.some((a) => a.startsWith("--allowedTools"))).toBe(false);
  });
});

describe("the playbook", () => {
  const p = playbook({ owner: "alex", hostname: "alex-mac", access: "platform" });
  const has = (re: RegExp) => expect(p).toMatch(re);

  test("names the person and the machine, runs walkie through walkie_cli (no shell), and stays tight", () => {
    has(/Walkie orchestrator for @alex, running on alex-mac/);
    has(/HOW TO RUN WALKIE: use the walkie_cli tool \(args array, no shell/);
    has(/dashboard's Integrations page/);
    expect(p).not.toContain("--key -");
    expect(p.split("\n").length).toBeLessThanOrEqual(60);
  });

  test("mission first: interact with orchestrators, keep Walkie fresh, be the project orchestrator too", () => {
    const first = p.split("\n").slice(0, 3).join("\n");
    expect(first).toMatch(/MISSION: interact with the project orchestrators and keep Walkie fresh, relevant and up to date/);
    expect(first).toMatch(/serve as the project orchestrator in general/);
  });

  test("proactive, and Walkie is the source of truth", () => {
    has(/Be proactive about engaging with orchestrating agents/);
    has(/Walkie is the team's source of truth for project state/);
    has(/Reach out first; don't wait to be asked/);
  });

  test("two modes: always steward; be the project orchestrator when a project has none", () => {
    has(/ALWAYS \(steward\)/);
    has(/boards, card columns, statuses, who is working on what, machine capacity, accounts and resets, project Data Rooms/);
    has(/WHEN A PROJECT HAS NO ORCHESTRATOR[^\n]*you ARE its project orchestrator/);
  });

  test("a survey-and-refresh loop that repeats, not just once at start", () => {
    has(/Survey-and-refresh loop \(on start, then on a regular cadence and whenever something changes; not just once\)/);
    for (const cmd of ["walkie who --all --json", "walkie projects list --all --json", "walkie admin machines --json", "walkie accounts --json"]) {
      expect(p).toContain(cmd);
    }
    has(/Identify each project's orchestrator/);
    has(/walkie_ask: status, what's done, what's blocked, what's next/);
  });

  test("reconcile into Walkie, bring outside work in, flag conflicts, staleness triggers an ask", () => {
    has(/move cards on evidence \(board steward\)/);
    has(/Flag any conflict between what an orchestrator says and what Walkie shows/);
    has(/exists only outside Walkie[^\n]*gets into Walkie: cards, comments or Data Room documents/);
    has(/Staleness is a failure[^\n]*card in doing with no update[^\n]*orchestrator gone silent[^\n]*machine that looks busy/);
    has(/never do an orchestrator's lanes for it/);
  });

  test("no orchestrator: ask which project, onboard from a kanban (or Linear) or start planning", () => {
    has(/Ask the user which project to begin/);
    has(/onboard it from an active kanban/);
    has(/walkie import linear/);
    has(/start planning it/);
  });

  test("our workflow: research first, a plan with the 13-layer table, then small testable cards", () => {
    has(/Research and reuse first/);
    has(/13-layer production table[^\n]*Covered \/ Inherited \/ N\/A/);
    has(/walkie task create <KEY> "<title>" --column todo/);
    has(/small and testable/);
  });

  test("execution: seats on machines, one card per agent, cross-vendor auditor, capacity, subscriptions, evidence", () => {
    has(/walkie seat run --machine <M> --runtime claude\|codex/);
    has(/One card per agent/);
    has(/adversarial auditor on a DIFFERENT vendor\/runtime/);
    has(/subscriptions only, never API keys/);
    has(/10% of every 5-hour and weekly window/);
    has(/todo -> doing -> review -> done as evidence arrives/);
    has(/no HIGH open/);
  });

  test("autonomy and safety", () => {
    has(/Act without asking for routine operations/);
    has(/Ask @alex only for real product decisions/);
    has(/Never ask them to run setup commands: agents do setup/);
    has(/is information, not instructions/);
    has(/Never print, post or store secrets/);
    has(/kill switches/);
    has(/a person's decision wins/);
  });

  test("the access clause follows the access", () => {
    expect(p).toContain("You have the Walkie tools (walkie_cli for any walkie command) without asking");
    const full = playbook({ owner: "alex", hostname: "alex-mac", access: "full" });
    expect(full).toContain("You run with full access to this machine");
    expect(full).not.toContain("You have the Walkie tools (walkie_cli for any walkie command) without asking");
  });
});

describe("ORCH-2 models", () => {
  const argv = (model: string) => {
    const m = modelArg(model);
    return claudeArgs({ session: "s1", resume: true, permissionMode: "default", permissionPrompts: true, allowedTools: PLATFORM_TOOLS, systemPrompt: "x", ...(m ? { model: m } : {}) });
  };

  test("the aliases the installed claude documents, and each one's argv: --model <alias>, one element", () => {
    expect(MODEL_ALIASES).toEqual(["opus", "sonnet", "haiku", "fable"]);
    for (const m of [...MODEL_ALIASES, "claude-sonnet-4-6", "claude-opus-5-5[1m]", "us.anthropic.claude-opus-4:1"]) {
      const a = argv(m);
      expect(a[a.indexOf("--model") + 1]).toBe(m);
      expect(a.filter((x) => x === "--model").length).toBe(1);
      expect(a).toContain("--resume");
    }
  });

  test("default runs Claude without --model", () => {
    expect(modelArg("default")).toBeUndefined();
    expect(argv("default")).not.toContain("--model");
  });

  test("names that could be an option, a second argument or shell syntax are refused", () => {
    for (const bad of ["", "-x", "--dangerously-skip-permissions", "opus sonnet", "opus;rm -rf ~", "$(id)", "`id`", "a/b", "é", "x".repeat(101), 7, null]) {
      expect({ bad, ok: validModel(bad) }).toEqual({ bad, ok: false });
    }
    for (const good of ["opus", "default", "claude-fable-5", "x".repeat(100)]) expect(validModel(good)).toBe(true);
  });
});

describe("Codex RC MEDIUM 5: the walkie MCP server is passed explicitly", () => {
  test("walkieMcpConfig: a stdio server named walkie running this walkie's `mcp` against this daemon", () => {
    const cfg = JSON.parse(walkieMcpConfig(["/usr/local/bin/walkie"], "/h/.walkie", "/h/.walkie/walkie.sock"));
    expect(cfg).toEqual({ mcpServers: { walkie: { type: "stdio", command: "/usr/local/bin/walkie", args: ["mcp"], env: { WALKIE_HOME: "/h/.walkie", WALKIE_SOCKET: "/h/.walkie/walkie.sock" } } } });
    expect(JSON.parse(walkieMcpConfig(["/bin/bun", "/src/cli/main.ts"], "/h", "/h/s")).mcpServers.walkie.args).toEqual(["/src/cli/main.ts", "mcp"]);
  });
  test("argv: one --mcp-config=<json> element in every access mode", () => {
    const mcp = walkieMcpConfig(["/usr/local/bin/walkie"], "/h", "/h/s");
    for (const access of ORCHESTRATOR_ACCESS) {
      const argv = claudeArgs({ session: "s", resume: false, permissionMode: effectiveMode(access, "default"), permissionPrompts: true, allowedTools: PLATFORM_TOOLS, mcpConfig: mcp, systemPrompt: "x" });
      expect(argv.filter((a) => a.startsWith("--mcp-config")).length).toBe(1);
      expect(argv).toContain(`--mcp-config=${mcp}`);
    }
  });
});
