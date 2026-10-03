// Host tool allow-list for seats (WALK-76 Phase 0). These assertions fail on grok-base: the config schema
// drops `tools`, Claude's seat argv has no tool flags, and the doctor does not mention a policy.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeatsConfig, loadConfig } from "../../src/daemon/config.ts";
import { doctorChecks, doctorFacts, type DoctorFacts } from "../../src/daemon/seats/doctor.ts";
import { claudeSeatArgs, grokSeatArgs, seatSystemPrompt } from "../../src/daemon/seats/runtime.ts";
import { parseArgs } from "../../src/cli/args.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import { USAGE } from "../../src/cli/main.ts";
import { localLine, seats } from "../../src/cli/commands/seats.ts";
import type { Ctx } from "../../src/cli/context.ts";
import { SeatRun, type SeatMode, type SeatsLocalView } from "../../src/protocol/seats.ts";
import {
  GROK_VERSION_MAX_OUTPUT_BYTES, SeatToolPolicySchema, clearGrokVersionCache, grokToolFlags, grokVersionPolicyRefusal, parseGrokVersion, readGrokVersion, resolveSeatTools, seatToolPolicyRefusal, toolPolicyPhrase, toolPolicyRestartLine,
  type GrokVersionProbe, type SeatToolPolicy,
} from "../../src/daemon/seats/tool-policy.ts";

const facts: DoctorFacts = {
  team: "aka", release: false, runnerProblem: null, helper: "ok", rootsFile: "ok",
  runtimes: { claude: "/x/claude", codex: "/x/codex" },
};

function local(extra: Partial<SeatsLocalView> = {}): SeatsLocalView {
  return {
    allow: true, launchers: [], launchers_default: true, runtimes: ["claude", "codex"], max: 3, dir: "~/walkie-seats",
    channel: "seats-abc", channel_ok: true, ephemeral: false, same_user: true, readable_home: false,
    claude_login: "machine", running: 0, paused: 0, queued: 0,
    availability: { state: "available", max: 3, running: 0 },
    ...extra,
  };
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("a tool policy is kept, trimmed and rejected when it cannot be enforced as flags", () => {
  const ok = SeatsConfig.safeParse({ allow: true, tools: { allow: [" Read ", "Grep", "Read"], deny: ["WebFetch"] } });
  expect(ok.success).toBe(true);
  if (!ok.success) return;
  expect(ok.data.tools).toEqual({ allow: ["Read", "Grep"], deny: ["WebFetch"] });
  expect(SeatsConfig.safeParse({ allow: true }).data?.tools).toBeUndefined();
  expect(SeatsConfig.safeParse({ allow: true, tools: {} }).success).toBe(false);
  expect(SeatsConfig.safeParse({ allow: true, tools: { deny: [] } }).success).toBe(false);
  expect(SeatsConfig.safeParse({ allow: true, tools: { allow: [] } }).success).toBe(true);
  expect(SeatsConfig.safeParse({ allow: true, tools: { allow: ["Read"], deny: ["Read"] } }).success).toBe(false);
  for (const name of ["Bad,Name", "-rf", "tool\"x", "a\nb", "$(id)", "Bash;rm", ""]) {
    expect(SeatToolPolicySchema.safeParse({ allow: [name] }).success).toBe(false);
  }
  // A space is rejected, including inside a pattern. Parentheses and * still match the character check.
  expect(SeatToolPolicySchema.safeParse({ allow: ["Bash(git commit:*)"] }).success).toBe(false);
  expect(SeatToolPolicySchema.safeParse({ allow: ["Bash(git:*)"] }).success).toBe(true);
  // Claude's `--tools=default` means every tool. A space is a second tool (`Read Grep` → Read and Grep).
  expect(SeatToolPolicySchema.safeParse({ allow: ["default"] }).success).toBe(false);
  expect(SeatToolPolicySchema.safeParse({ allow: ["Default"] }).success).toBe(false);
  expect(SeatToolPolicySchema.safeParse({ allow: ["Read Grep"] }).success).toBe(false);
  expect(SeatToolPolicySchema.safeParse({ allow: ["Read\tGrep"] }).success).toBe(false);
  expect(SeatToolPolicySchema.safeParse({ deny: ["Read Grep"] }).success).toBe(false);
  expect(SeatToolPolicySchema.safeParse({ allow: ["Read"], deny: ["WebFetch"] }).success).toBe(true);
  expect(SeatToolPolicySchema.safeParse({ allow: Array.from({ length: 65 }, (_, i) => `Tool${i}`) }).success).toBe(false);
  expect(SeatsConfig.safeParse({ allow: true, tools: null }).success).toBe(false);
});

test("config.json round-trips a policy and still loads a pre-policy file", () => {
  const dir = mkdtempSync(join(tmpdir(), "seat-tools-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ seats: { allow: true, launchers: ["@alex"] } }));
    expect(loadConfig(path, false).seats?.tools).toBeUndefined();
    writeFileSync(path, JSON.stringify({ seats: { allow: true, tools: { allow: ["Read"], deny: ["WebFetch"] } } }));
    expect(loadConfig(path, false).seats?.tools).toEqual({ allow: ["Read"], deny: ["WebFetch"] });
    writeFileSync(path, JSON.stringify({ seats: { allow: true, tools: { allow: ["Bad,Name"] } } }));
    expect(() => loadConfig(path, false)).toThrow(/tools/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the launcher cannot put a tool list on the replicated run body", () => {
  const run = { op: "run", v: 1, runtime: "claude", prompt: "hi", timeout_s: 60, max_concurrent: 1 };
  expect(SeatRun.safeParse(run).success).toBe(true);
  expect(SeatRun.safeParse({ ...run, tools: { allow: ["Read"] } }).success).toBe(false);
});

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

test("Claude seat argv carries the allow-list as one value per flag and does not add flags when unset", () => {
  const bare = claudeSeatArgs({ session: "s1", mode: "bypassPermissions", permissionPrompts: true, systemPrompt: "sys prompt" });
  expect(bare.some((a) => a.startsWith("--allowedTools") || a.startsWith("--disallowedTools") || a.startsWith("--tools") || a === "--strict-mcp-config")).toBe(false);
  // Every Claude seat, policy or not: project settings in the work tree must not load.
  // `--setting-sources user` is the whole isolation flag. A `--settings` override would turn user hooks off.
  expect(flagValue(bare, "--setting-sources")).toBe("user");
  expect(bare).not.toContain("--settings");
  expect(bare.some((a) => a.startsWith("--settings"))).toBe(false);
  expect(bare.filter((a) => a === "--setting-sources").length).toBe(1);
  const args = claudeSeatArgs({
    session: "s1", mode: "bypassPermissions", permissionPrompts: true, systemPrompt: "sys prompt",
    tools: { allow: ["Read", "Grep"], deny: ["WebFetch"] },
  });
  expect(args).toContain("--tools=Read,Grep");
  expect(args).toContain("--allowedTools=Read,Grep");
  expect(args).toContain("--disallowedTools=WebFetch");
  expect(args).toContain("--strict-mcp-config");
  expect(args.filter((a) => a === "--allowedTools" || a === "--disallowedTools" || a === "--tools")).toEqual([]);
  expect(args.filter((a) => a.startsWith("--allowedTools")).length).toBe(1);
  expect(flagValue(args, "--setting-sources")).toBe("user");
  expect(args).not.toContain("--settings");
  expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("sys prompt");
  const none = claudeSeatArgs({ session: "s1", mode: "default", permissionPrompts: false, systemPrompt: "sys", tools: { allow: [] } });
  expect(none).toContain("--tools=");
  expect(none.some((a) => a.startsWith("--allowedTools"))).toBe(false);
  expect(none).toContain("--strict-mcp-config");
  const denyOnly = claudeSeatArgs({ session: "s1", mode: "acceptEdits", permissionPrompts: false, systemPrompt: "sys", tools: { deny: ["WebSearch"] } });
  expect(denyOnly).toContain("--disallowedTools=WebSearch");
  expect(denyOnly.some((a) => a.startsWith("--tools"))).toBe(false);
  expect(flagValue(denyOnly, "--setting-sources")).toBe("user");
  // A project settings file is not an input to the argv. The hook command stays out of it.
  const project = mkdtempSync(join(tmpdir(), "seat-claude-project-"));
  try {
    writeFileSync(join(project, "settings.json"), JSON.stringify({
      disableAllHooks: false,
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "fixture-project-hook" }] }] },
    }));
    const locked = claudeSeatArgs({ session: "s1", mode: "acceptEdits", permissionPrompts: false, systemPrompt: "sys", tools: { allow: ["Read"] } });
    expect(locked.join("\n")).not.toContain("fixture-project-hook");
    expect(locked.join("\n")).not.toContain("disableAllHooks");
    expect(locked).not.toContain("--settings");
    expect(flagValue(locked, "--setting-sources")).toBe("user");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Grok enforces a policy without widening default mode, and an unset policy is unchanged", () => {
  const base = { taskFile: "TASK.md", cwd: "/tmp/seat", session: "11111111-1111-4111-8111-111111111111", home: "/fixture/home", seatHome: "/fixture/seat/grok-home" };
  const untouched = grokSeatArgs({ ...base, mode: "default" });
  expect(untouched.slice(untouched.indexOf("--tools"), untouched.indexOf("--tools") + 2)).toEqual(["--tools", "read_file,grep,list_dir"]);
  // Bash is not a verified --tools id. Naming it refuses, including next to a name that would narrow.
  expect(() => grokSeatArgs({ ...base, mode: "default", tools: { allow: ["read_file", "Bash"] } })).toThrow(/Bash/);
  const narrowed = grokSeatArgs({ ...base, mode: "default", tools: { allow: ["read_file"] }, grokVersion: "1.0.46" });
  expect(narrowed.slice(narrowed.indexOf("--tools"), narrowed.indexOf("--tools") + 2)).toEqual(["--tools", "read_file"]);
  const denies = narrowed.flatMap((arg, i) => arg === "--deny" ? [narrowed[i + 1]] : []);
  expect(denies).toContain("Bash");
  expect(denies).toContain("MCPTool");
  expect(narrowed).toContain("--no-subagents");
  const mapped = grokSeatArgs({ ...base, mode: "default", tools: { allow: ["Read", "Grep"] }, grokVersion: "1.0.46" });
  expect(mapped.slice(mapped.indexOf("--tools"), mapped.indexOf("--tools") + 2)).toEqual(["--tools", "read_file,grep"]);
  const full = grokSeatArgs({ ...base, mode: "bypassPermissions", tools: { allow: ["read_file"], deny: ["WebFetch", "run_terminal_command"] }, grokVersion: "1.0.46" });
  expect(full.slice(full.indexOf("--tools"), full.indexOf("--tools") + 2)).toEqual(["--tools", "read_file"]);
  const fullDenies = full.flatMap((arg, i) => arg === "--deny" ? [full[i + 1]] : []);
  expect(fullDenies).toContain("WebFetch");
  // The shell is denied under Grok's rule name. The --tools id does not block it.
  expect(fullDenies).toContain("Bash");
  expect(fullDenies).not.toContain("run_terminal_command");
  expect(fullDenies).toContain("MCPTool");
  expect(full).toContain("--no-subagents");
  expect(full).not.toContain("--sandbox");
  expect(() => grokSeatArgs({ ...base, mode: "bypassPermissions", tools: { allow: ["read_file", "Bash", "MCPTool"], deny: ["WebFetch"] } })).toThrow(/Bash|MCPTool/);
});

function toolsValue(flags: readonly string[]): string | undefined {
  const i = flags.indexOf("--tools");
  return i < 0 ? undefined : flags[i + 1];
}

test("grokToolFlags never yields an empty --tools value", () => {
  const modes = ["default", "acceptEdits", "bypassPermissions"] as const;
  const allows = [[], ["Read", "Grep"], ["Bash(git commit:*)"], ["WebFetch"], ["Glob", "LS"], ["read_file", "Bash"], ["default"]];
  for (const mode of modes) {
    for (const allow of allows) {
      const flags = grokToolFlags(mode, { allow });
      for (let i = 0; i < flags.length - 1; i++) {
        if (flags[i] === "--tools") expect(flags[i + 1]).not.toBe("");
      }
      expect(toolsValue(flags)).not.toBe("");
    }
    expect(toolsValue(grokToolFlags(mode, undefined))).not.toBe("");
  }
  expect(toolsValue(grokToolFlags("default", { allow: ["Read", "Grep"] }))).toBe("read_file,grep");
  expect(toolsValue(grokToolFlags("acceptEdits", { allow: ["Read", "Grep"] }))).toBe("read_file,grep");
  expect(toolsValue(grokToolFlags("bypassPermissions", { allow: ["Glob", "LS"] }))).toBe("list_dir");
  expect(toolsValue(grokToolFlags("default", { allow: ["Bash(git commit:*)"] }))).toBeUndefined();
  expect(toolsValue(grokToolFlags("bypassPermissions", { allow: [] }))).toBeUndefined();
  expect(toolsValue(grokToolFlags("default", { allow: [] }))).toBeUndefined();
  expect(toolsValue(grokToolFlags("acceptEdits", { allow: ["run_terminal_command"] }))).toBeUndefined();
  const denyOnly = grokToolFlags("bypassPermissions", { deny: ["WebFetch"] });
  expect(denyOnly.includes("--tools")).toBe(false);
  expect(denyOnly).toContain("WebFetch");
});

/** Ids verified on grok 1.0.46 (2026-10-02) to narrow `--tools`. Must match GROK_VERIFIED_TOOLS. */
const VERIFIED_GROK_TOOLS = ["read_file", "grep", "list_dir", "search_replace", "web_search"] as const;

function denyValues(flags: readonly string[]): string[] {
  return flags.flatMap((arg, i) => arg === "--deny" ? [flags[i + 1] ?? ""] : []);
}

test("Grok --tools never names an id outside the verified set, and an unknown allow name refuses", () => {
  const source = readFileSync(new URL("../../src/daemon/seats/tool-policy.ts", import.meta.url), "utf8");
  const block = /export const GROK_VERIFIED_TOOLS = \[([\s\S]*?)\] as const/.exec(source);
  const body = block?.[1];
  expect(typeof body).toBe("string");
  if (typeof body !== "string") return;
  const listed = [...body.matchAll(/"([^"]+)"/g)].flatMap((m) => {
    const name = m[1];
    return name === undefined ? [] : [name];
  });
  expect(listed).toEqual([...VERIFIED_GROK_TOOLS]);
  const modes = ["default", "acceptEdits", "bypassPermissions"] as const;
  const allows = [
    [], ["Read", "Grep"], ["Glob", "LS"], ["read_file", "grep", "list_dir"],
    ["search_replace", "read_file"], ["web_search"], ["Read", "search_replace"],
    ["run_terminal_command"], ["spawn_subagent"], ["write"], ["terminal"], ["bogus_tool"],
    ["read_file", "run_terminal_command"], ["read_file", "spawn_subagent", "write"],
  ];
  for (const mode of modes) {
    for (const allow of allows) {
      const value = toolsValue(grokToolFlags(mode, { allow }));
      if (value === undefined) continue;
      expect(value).not.toBe("");
      for (const name of value.split(",")) expect(VERIFIED_GROK_TOOLS as readonly string[]).toContain(name);
    }
  }
  for (const name of ["spawn_subagent", "run_terminal_command", "write", "terminal", "bogus_tool"]) {
    for (const mode of modes) {
      const why = seatToolPolicyRefusal("grok", { allow: [name] }, mode);
      expect(why).toContain(name);
      expect(why!.length).toBeLessThanOrEqual(280);
      const value = toolsValue(grokToolFlags(mode, { allow: [name] }));
      expect(value ?? "").not.toContain(name);
    }
  }
  const mixed = seatToolPolicyRefusal("grok", { allow: ["read_file", "run_terminal_command", "write"] }, "bypassPermissions");
  expect(mixed).toContain("run_terminal_command");
  expect(mixed).toContain("write");
  expect(toolsValue(grokToolFlags("bypassPermissions", { allow: ["read_file", "run_terminal_command"] })) ?? "").not.toContain("run_terminal_command");
});

test("search_replace is passed only together with read_file", () => {
  const modes = ["default", "acceptEdits", "bypassPermissions"] as const;
  for (const mode of modes) {
    const alone = seatToolPolicyRefusal("grok", { allow: ["search_replace"] }, mode);
    expect(alone).toMatch(/read_file|Read tool/);
    expect(alone!.length).toBeLessThanOrEqual(280);
    expect(toolsValue(grokToolFlags(mode, { allow: ["search_replace"] })) ?? "").not.toBe("search_replace");
    const withGrep = seatToolPolicyRefusal("grok", { allow: ["search_replace", "grep"] }, mode);
    expect(withGrep).toMatch(/read_file|Read tool/);
  }
  expect(seatToolPolicyRefusal("grok", { allow: ["search_replace", "read_file"] }, "acceptEdits")).toBeNull();
  expect(toolsValue(grokToolFlags("acceptEdits", { allow: ["search_replace", "read_file"] }))).toBe("search_replace,read_file");
  expect(seatToolPolicyRefusal("grok", { allow: ["search_replace", "Read"] }, "bypassPermissions")).toBeNull();
  expect(toolsValue(grokToolFlags("bypassPermissions", { allow: ["search_replace", "Read"] }))).toBe("search_replace,read_file");
  // Default mode stays read-only: the edit is not emitted, and the read remains.
  expect(seatToolPolicyRefusal("grok", { allow: ["search_replace", "read_file"] }, "default")).toBeNull();
  expect(toolsValue(grokToolFlags("default", { allow: ["search_replace", "read_file"] }))).toBe("read_file");
  expect(seatToolPolicyRefusal("grok", { allow: ["web_search"] }, "bypassPermissions")).toBeNull();
  const web = grokToolFlags("bypassPermissions", { allow: ["web_search"] });
  expect(toolsValue(web)).toBe("web_search");
  expect(denyValues(web)).toContain("MCPTool");
});

test("a Grok deny name is emitted as a deny rule, and an unmapped deny name refuses", () => {
  const shell = grokToolFlags("bypassPermissions", { allow: ["read_file"], deny: ["run_terminal_command"] });
  expect(denyValues(shell)).toContain("Bash");
  expect(denyValues(shell)).not.toContain("run_terminal_command");
  expect(seatToolPolicyRefusal("grok", { allow: ["read_file"], deny: ["run_terminal_command"] }, "bypassPermissions")).toBeNull();
  const edit = grokToolFlags("acceptEdits", { allow: ["read_file"], deny: ["search_replace", "write", "Write"] });
  expect(denyValues(edit)).toContain("Edit");
  expect(denyValues(edit)).not.toContain("search_replace");
  expect(denyValues(edit)).not.toContain("write");
  expect(denyValues(edit)).not.toContain("Write");
  const read = grokToolFlags("bypassPermissions", { allow: ["grep"], deny: ["read_file"] });
  expect(denyValues(read)).toContain("Read");
  expect(denyValues(read)).not.toContain("read_file");
  for (const name of ["spawn_subagent", "list_dir", "Glob", "Task", "not_a_tool"]) {
    const why = seatToolPolicyRefusal("grok", { allow: ["read_file"], deny: [name] }, "bypassPermissions");
    expect(why).toContain(name);
    expect(why!.length).toBeLessThanOrEqual(280);
    expect(grokToolFlags("bypassPermissions", { allow: ["read_file"], deny: [name] })).not.toContain(name);
    expect(seatToolPolicyRefusal("grok", { deny: [name] }, "acceptEdits")).toContain(name);
  }
  const long = "T" + "o".repeat(199);
  const clipped = seatToolPolicyRefusal("grok", { allow: [long] }, "bypassPermissions");
  expect(clipped).not.toBeNull();
  expect(clipped!.length).toBeLessThanOrEqual(280);
});

test("a Grok allow list that maps to no tool is refused, and Claude's empty list is not", () => {
  const modes: SeatMode[] = ["default", "acceptEdits", "bypassPermissions"];
  for (const mode of modes) {
    const empty = seatToolPolicyRefusal("grok", { allow: [] }, mode);
    expect(empty).toContain("empty --tools");
    expect(empty!.length).toBeLessThanOrEqual(280);
    for (const name of ["Bash(git commit:*)", "WebFetch"]) {
      const why = seatToolPolicyRefusal("grok", { allow: [name] }, mode);
      expect(why).toContain(name);
      expect(why!.length).toBeLessThanOrEqual(280);
    }
    expect(seatToolPolicyRefusal("grok", { allow: ["Read", "Grep"] }, mode)).toBeNull();
    expect(seatToolPolicyRefusal("claude", { allow: [] }, mode)).toBeNull();
  }
  expect(seatToolPolicyRefusal("grok", { allow: ["run_terminal_command"] }, "default")).toContain("run_terminal_command");
  expect(seatToolPolicyRefusal("grok", { allow: ["run_terminal_command"] }, "bypassPermissions")).toContain("run_terminal_command");
  expect(seatToolPolicyRefusal("grok", { deny: ["WebFetch"] }, "bypassPermissions")).toBeNull();
  const base = { taskFile: "TASK.md", cwd: "/tmp/seat", session: "11111111-1111-4111-8111-111111111111", home: "/fixture/home", seatHome: "/fixture/seat/grok-home" };
  expect(() => grokSeatArgs({ ...base, mode: "bypassPermissions", tools: { allow: [] } })).toThrow(/empty --tools/);
  expect(() => grokSeatArgs({ ...base, mode: "default", tools: { allow: ["Bash(git commit:*)"] } })).toThrow(/Bash\(git commit:\*\)/);
});

test("Codex and Kimi launches are refused while a policy is set; Claude and Grok are not", () => {
  const policy = { allow: ["Read"] };
  expect(seatToolPolicyRefusal("claude", policy)).toBeNull();
  expect(seatToolPolicyRefusal("grok", policy)).toBeNull();
  expect(seatToolPolicyRefusal("codex", undefined)).toBeNull();
  expect(seatToolPolicyRefusal("kimi", undefined)).toBeNull();
  const codex = seatToolPolicyRefusal("codex", policy);
  const kimi = seatToolPolicyRefusal("kimi", policy);
  expect(codex).toContain("Codex");
  expect(codex).toContain("no per-launch tool flags");
  expect(kimi).toContain("Kimi");
  expect(kimi).toContain("no tool flags");
  expect(codex).not.toContain("firewall");
  // SeatState.reason is 300 characters; a SeatRefusal is cut at 280. The whole reason must fit.
  expect(codex!.length).toBeLessThanOrEqual(280);
  expect(kimi!.length).toBeLessThanOrEqual(280);
  expect(seatToolPolicyRefusal("claude", { allow: [] })).toBeNull();
  expect(seatToolPolicyRefusal("grok", { allow: [] })).toContain("empty --tools");
});

test("walkie seats and the doctor show the policy and which runtimes cannot enforce it", () => {
  const policy = { allow: ["Read", "Grep"], deny: ["WebFetch"] };
  expect(toolPolicyPhrase({ tools: policy })).toBe("tool allow-list: allow Read, Grep; deny WebFetch");
  const line = plain(localLine(local({ tools: policy })));
  expect(line).toContain("tool allow-list: allow Read, Grep; deny WebFetch");
  expect(line).toContain("codex refused");
  const checks = doctorChecks(local({ tools: policy }), facts);
  const hit = checks.find((c) => c.what.startsWith("tool allow-list:"));
  expect(hit?.ok).toBe("warn");
  expect(hit?.what).toContain("Claude enforces it");
  expect(hit?.what).toContain("codex");
  expect(hit?.what).toContain("refused");
  const none = doctorChecks(local(), facts);
  expect(none.some((c) => c.what.includes("no tool allow-list"))).toBe(true);
  const onlyCodex = doctorChecks(local({ runtimes: ["codex"], tools: { allow: ["Read"] } }), facts);
  expect(onlyCodex.find((c) => c.what.startsWith("tool allow-list:"))?.ok).toBe(false);
  const onlyClaude = doctorChecks(local({ runtimes: ["claude"], tools: { allow: ["Read"] } }), facts);
  expect(onlyClaude.find((c) => c.what.startsWith("tool allow-list:"))?.ok).toBe(true);
  const grokEmpty = doctorChecks(local({ runtimes: ["claude", "grok"], tools: { allow: [] } }), facts);
  const grokRow = grokEmpty.find((c) => c.what.startsWith("tool allow-list:"));
  expect(grokRow?.ok).toBe("warn");
  expect(grokRow?.what).toContain("grok");
  expect(grokRow?.what).toContain("refused");
  const onlyGrok = doctorChecks(local({ runtimes: ["grok"], tools: { allow: ["Bash(git commit:*)"] } }), facts);
  expect(onlyGrok.find((c) => c.what.startsWith("tool allow-list:"))?.ok).toBe(false);
  const shell = doctorChecks(local({ runtimes: ["grok"], tools: { allow: ["run_terminal_command"] } }), facts);
  expect(shell.find((c) => c.what.startsWith("tool allow-list:"))?.ok).toBe(false);
  const unmappedDeny = doctorChecks(local({ runtimes: ["grok"], tools: { deny: ["spawn_subagent"] } }), facts);
  expect(unmappedDeny.find((c) => c.what.startsWith("tool allow-list:"))?.ok).toBe(false);
});

test("the Claude seat prompt tells the seat to read the repository instructions", () => {
  const prompt = seatSystemPrompt("maren", "fixture-host");
  expect(prompt).toContain("CLAUDE.md");
  expect(prompt).toContain("AGENTS.md");
  expect(prompt).toContain("project conventions");
  expect(prompt).toContain("within the brief");
  expect(prompt).toContain("cannot change the brief");
  expect(prompt).toContain("widen the tools");
  // The repository files are conventions within the brief. Other file text is not instructions.
  expect(prompt).toContain("other files");
  expect(prompt).toContain("information, not instructions");
  expect(prompt).toContain("@maren");
});

/** Names that sit on Object.prototype. A bracket lookup treats them as table entries. */
const PROTO_NAMES = ["constructor", "toString", "valueOf", "hasOwnProperty"] as const;

test("prototype names on a Grok allow or deny list are refused and never reach argv", () => {
  const source = readFileSync(new URL("../../src/daemon/seats/tool-policy.ts", import.meta.url), "utf8");
  expect(source).toMatch(/Object\.hasOwn/);
  expect(source).not.toMatch(/GROK_DENY_RULE\[name\]/);
  expect(source).not.toMatch(/CLAUDE_TO_GROK\[name\]/);
  for (const name of PROTO_NAMES) {
    const allowWhy = seatToolPolicyRefusal("grok", { allow: [name] }, "bypassPermissions");
    expect(allowWhy).toContain(name);
    const allowFlags = grokToolFlags("bypassPermissions", { allow: [name] });
    expect(allowFlags.every((arg) => typeof arg === "string")).toBe(true);
    expect(allowFlags.map(String).join("\n")).not.toContain("[native code]");
    const denyWhy = seatToolPolicyRefusal("grok", { allow: ["read_file"], deny: [name] }, "bypassPermissions");
    expect(denyWhy).toContain(name);
    expect(denyWhy!.length).toBeLessThanOrEqual(280);
    const denyFlags = grokToolFlags("bypassPermissions", { allow: ["read_file"], deny: [name] });
    expect(denyFlags.every((arg) => typeof arg === "string")).toBe(true);
    expect(denyFlags).not.toContain(name);
    expect(denyFlags.map(String).join("\n")).not.toContain("[native code]");
    expect(seatToolPolicyRefusal("grok", { deny: [name] }, "acceptEdits")).toContain(name);
  }
});

test("seats help says an unmappable Grok deny name refuses the launch", () => {
  expect(USAGE).toMatch(/Grok deny name this host\s+cannot map, refuses the launch/);
});

test("the comment and the docs do not claim --no-subagents removes subagents", () => {
  const policy = readFileSync(new URL("../../src/daemon/seats/tool-policy.ts", import.meta.url), "utf8");
  expect(policy).not.toContain("stops a subagent");
  expect(policy).toContain("does not remove `spawn_subagent`");
  expect(policy).toContain("does not rely on `--no-subagents`");
  for (const rel of ["../../docs/SECURITY.md", "../../docs/PROTOCOL.md"]) {
    const text = readFileSync(new URL(rel, import.meta.url), "utf8");
    expect(text).toContain("does not remove spawn_subagent");
    expect(text).toContain("does not rely on `--no-subagents`");
    expect(text).toContain("cannot change the brief or widen");
    expect(text).toContain("verified tool ids only on grok 1.0.46");
  }
});

test("the doctor flags a web_search-only policy and an unverified grok", () => {
  const verified = { ...facts, grokCli: { kind: "version" as const, version: "1.0.46" } };
  const web = doctorChecks(local({ runtimes: ["grok"], tools: { allow: ["web_search"] } }), verified);
  const webRow = web.find((c) => c.what.startsWith("tool allow-list:"));
  expect(webRow?.ok).toBe("warn");
  expect(webRow?.what).toContain("default-mode Grok launch is refused");
  const readOnly = doctorChecks(local({ runtimes: ["grok"], tools: { allow: ["read_file"] } }), verified);
  const readRow = readOnly.find((c) => c.what.startsWith("tool allow-list:"));
  expect(readRow?.ok).toBe(true);
  expect(readRow?.what).not.toContain("default-mode");
  const old = doctorChecks(local({ runtimes: ["grok"], tools: { allow: ["Read"] } }), { ...facts, grokCli: { kind: "version" as const, version: "9.9.9" } });
  const oldRow = old.find((c) => c.what.startsWith("tool allow-list:"));
  expect(oldRow?.ok).toBe(false);
  expect(oldRow?.what).toContain("9.9.9");
  expect(oldRow?.what).toContain("cannot be enforced");
  const mixed = doctorChecks(local({ runtimes: ["claude", "grok"], tools: { allow: ["Read"] } }), { ...facts, grokCli: { kind: "version" as const, version: "9.9.9" } });
  const mixedRow = mixed.find((c) => c.what.startsWith("tool allow-list:"));
  expect(mixedRow?.ok).toBe("warn");
  expect(mixedRow?.what).toContain("9.9.9");
  expect(mixedRow?.what).toContain("Claude enforces it");
  const unread = doctorChecks(local({ runtimes: ["grok"], tools: { allow: ["Read"] } }), facts);
  const unreadRow = unread.find((c) => c.what.startsWith("tool allow-list:"));
  expect(unreadRow?.ok).toBe(false);
  expect(unreadRow?.what).toContain("cannot be enforced");
  const junk = doctorChecks(local({ runtimes: ["grok"], tools: { allow: ["Read"] } }), { ...facts, grokCli: { kind: "unparseable" as const, found: "nope" } });
  expect(junk.find((c) => c.what.startsWith("tool allow-list:"))?.what).toContain("nope");
  const timed = doctorChecks(local({ runtimes: ["grok"], tools: { allow: ["Read"] } }), { ...facts, grokCli: { kind: "timeout" as const } });
  expect(timed.find((c) => c.what.startsWith("tool allow-list:"))?.what).toContain("timed out");
});

test("a policy launch needs a verified grok version, and a seat with no policy does not", () => {
  const base = { taskFile: "TASK.md", cwd: "/tmp/seat", session: "11111111-1111-4111-8111-111111111111", home: "/fixture/home", seatHome: "/fixture/seat/grok-home" };
  expect(() => grokSeatArgs({ ...base, mode: "bypassPermissions", tools: { allow: ["read_file"] }, grokVersion: "9.9.9" })).toThrow(/9\.9\.9/);
  expect(() => grokSeatArgs({ ...base, mode: "bypassPermissions", tools: { allow: ["read_file"] }, grokVersion: "9.9.9" })).toThrow(/cannot be enforced/);
  expect(() => grokSeatArgs({ ...base, mode: "acceptEdits", tools: { allow: ["read_file"] } })).toThrow(/cannot be enforced/);
  const launched = grokSeatArgs({ ...base, mode: "bypassPermissions", tools: { allow: ["read_file"] }, grokVersion: "1.0.46" });
  expect(launched.slice(launched.indexOf("--tools"), launched.indexOf("--tools") + 2)).toEqual(["--tools", "read_file"]);
  const bare = grokSeatArgs({ ...base, mode: "default", grokVersion: "9.9.9" });
  expect(bare.slice(bare.indexOf("--tools"), bare.indexOf("--tools") + 2)).toEqual(["--tools", "read_file,grep,list_dir"]);
});

function writeSh(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

test("doctorFacts reads grok --version only when a tool policy is set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-doc-"));
  const prev = process.env.PATH;
  try {
    writeSh(dir, "grok", "echo 'grok 9.9.9 (fixture)'\n");
    process.env.PATH = `${dir}:/usr/bin:/bin`;
    const withPolicy = await doctorFacts(local({ runtimes: ["grok"], tools: { allow: ["Read"] } }), "aka");
    expect(withPolicy.grokCli).toEqual({ kind: "version", version: "9.9.9" });
    const row = doctorChecks(local({ runtimes: ["grok"], tools: { allow: ["Read"] } }), withPolicy).find((c) => c.what.startsWith("tool allow-list:"));
    expect(row?.what).toContain("cannot be enforced");
    expect(row?.what).toContain("9.9.9");
    const marked = join(dir, "called");
    writeSh(dir, "grok", `echo called >> ${JSON.stringify(marked)}\necho 'grok 1.0.46 (fixture)'\n`);
    const noPolicy = await doctorFacts(local({ runtimes: ["grok"] }), "aka");
    expect(noPolicy.grokCli).toBeUndefined();
    expect(existsSync(marked)).toBe(false);
  } finally {
    process.env.PATH = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("grok --version is cached by path and mtime, and a bad or slow answer refuses", async () => {
  const mod = await import("../../src/daemon/seats/tool-policy.ts");
  expect(typeof mod.readGrokVersion).toBe("function");
  expect(typeof mod.grokVersionPolicyRefusal).toBe("function");
  expect(typeof mod.grokLaunchVersionRefusal).toBe("function");
  expect(mod.GROK_VERIFIED_VERSIONS).toEqual(["1.0.46"]);
  const source = readFileSync(new URL("../../src/daemon/seats/tool-policy.ts", import.meta.url), "utf8");
  expect(source).toMatch(/2026-10-02[\s\S]{0,500}GROK_VERIFIED_VERSIONS|GROK_VERIFIED_VERSIONS[\s\S]{0,500}2026-10-02/);
  if (typeof mod.readGrokVersion !== "function" || typeof mod.grokVersionPolicyRefusal !== "function" || typeof mod.grokLaunchVersionRefusal !== "function") return;
  const dir = mkdtempSync(join(tmpdir(), "grok-ver-"));
  try {
    const good = writeSh(dir, "good", "echo 'grok 1.0.46 (fixture)'\n");
    const goodProbe = await mod.readGrokVersion(good);
    expect(goodProbe).toEqual({ kind: "version", version: "1.0.46" });
    expect(mod.grokVersionPolicyRefusal(goodProbe)).toBeNull();
    const launched = grokSeatArgs({
      taskFile: "TASK.md", cwd: "/tmp/seat", session: "11111111-1111-4111-8111-111111111111",
      home: "/fixture/home", seatHome: "/fixture/seat/grok-home", mode: "bypassPermissions",
      tools: { allow: ["read_file"] }, grokVersion: goodProbe.kind === "version" ? goodProbe.version : "",
    });
    expect(launched.slice(launched.indexOf("--tools"), launched.indexOf("--tools") + 2)).toEqual(["--tools", "read_file"]);
    const badWhy = mod.grokVersionPolicyRefusal(await mod.readGrokVersion(writeSh(dir, "bad", "echo 'grok 9.9.9 (fixture)'\n")));
    expect(badWhy).toContain("9.9.9");
    expect(badWhy).toContain("cannot be enforced");
    expect(badWhy!.length).toBeLessThanOrEqual(280);
    const junkWhy = mod.grokVersionPolicyRefusal(await mod.readGrokVersion(writeSh(dir, "junk", "echo nope\n")));
    expect(junkWhy).toContain("nope");
    expect(junkWhy).toContain("cannot be enforced");
    const hangWhy = mod.grokVersionPolicyRefusal(await mod.readGrokVersion(writeSh(dir, "hang", "sleep 30\n"), { timeoutMs: 200 }));
    expect(hangWhy).toContain("timed out");
    expect(hangWhy).toContain("cannot be enforced");
    expect(hangWhy!.length).toBeLessThanOrEqual(280);
    const count = join(dir, "count");
    writeFileSync(count, "0");
    const cached = writeSh(dir, "cached", `n=$(cat ${JSON.stringify(count)}); echo $((n+1)) > ${JSON.stringify(count)}; echo 'grok 1.0.46 (fixture)'\n`);
    await mod.readGrokVersion(cached);
    await mod.readGrokVersion(cached);
    expect(readFileSync(count, "utf8").trim()).toBe("1");
    const later = new Date(Date.now() + 5_000);
    utimesSync(cached, later, later);
    await mod.readGrokVersion(cached);
    expect(readFileSync(count, "utf8").trim()).toBe("2");
    let calls = 0;
    const miss = () => { calls++; return { kind: "timeout" as const }; };
    expect(await mod.grokLaunchVersionRefusal(undefined, miss)).toBeNull();
    expect(calls).toBe(0);
    expect(await mod.grokLaunchVersionRefusal({ allow: ["read_file"] }, () => { calls++; return { kind: "version" as const, version: "1.0.46" }; })).toBeNull();
    expect(calls).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a CLI update merges one side and clears the whole policy", () => {
  expect(resolveSeatTools(undefined, {})).toBeUndefined();
  expect(resolveSeatTools({ allow: ["Read"] }, { deny: ["WebFetch"] })).toEqual({ allow: ["Read"], deny: ["WebFetch"] });
  expect(resolveSeatTools({ allow: ["Read"], deny: ["WebFetch"] }, { allow: null })).toEqual({ deny: ["WebFetch"] });
  expect(resolveSeatTools({ allow: ["Read"] }, { clear: true })).toBeNull();
  expect(resolveSeatTools({ allow: ["Read"] }, { allow: [] })).toEqual({ allow: [] });
  expect(resolveSeatTools({ deny: ["WebFetch"] }, { deny: null })).toBeNull();
});

test("a policy change says running and paused seats keep the flags they started with", async () => {
  expect(toolPolicyRestartLine(0, 0)).toBeNull();
  expect(toolPolicyRestartLine(2, 0)).toContain("Running seats");
  expect(toolPolicyRestartLine(0, 1)).toContain("Paused seats");
  expect(toolPolicyRestartLine(1, 1)).toContain("Running and paused seats");
  expect(toolPolicyRestartLine(1, 1)).toContain("until they are restarted");
  const lines: string[] = [];
  let stored = local({ running: 1, paused: 2 });
  const client = {
    seats: async () => ({ local: stored }),
    seatsConfig: async (body: { tools?: SeatsLocalView["tools"] }) => {
      stored = local({ ...stored, ...(body.tools ? { tools: body.tools } : {}) });
      return { local: stored };
    },
  };
  const ctx = {
    args: parseArgs(["allow", "--allowed-tools", "Read,Grep"], CLI_BOOLEANS), json: false,
    agentMarker: () => null, agentSignals: () => ({ marker: null, inspection: "ok" as const }),
    person: { interactive: () => true, ask: async () => "yes", note: () => undefined },
    client: () => client, out: (s: string) => lines.push(plain(s)), err: () => undefined,
  } as unknown as Ctx;
  expect(await seats(ctx)).toBe(0);
  expect(lines.some((line) => line.includes("Running and paused seats") && line.includes("until they are restarted"))).toBe(true);
  const quiet: string[] = [];
  stored = local({ running: 0, paused: 0 });
  const quietCtx = {
    ...ctx,
    args: parseArgs(["allow", "--allowed-tools", "Read"], CLI_BOOLEANS),
    out: (s: string) => quiet.push(plain(s)),
  } as unknown as Ctx;
  expect(await seats(quietCtx)).toBe(0);
  expect(quiet.some((line) => line.includes("until they are restarted"))).toBe(false);
});

// macOS grok prints `grok X.Y.Z (commit) [channel]`. The Spark line has no channel tag.
const MAC_GROK_VERSION = "grok 1.0.46 (2765805b9442) [stable]";
const SPARK_GROK_VERSION = "grok 1.0.46 (2765805b9442)";
const BETA_GROK_VERSION = "grok 1.0.46 (2765805b9442) [beta]";
const OTHER_CHANNEL_VERSION = "grok 1.0.41 (4220f3b224a6) [stable]";

test("grok --version accepts a channel tag and compares only the version number", async () => {
  expect(parseGrokVersion(MAC_GROK_VERSION)).toBe("1.0.46");
  expect(parseGrokVersion(SPARK_GROK_VERSION)).toBe("1.0.46");
  expect(parseGrokVersion(BETA_GROK_VERSION)).toBe("1.0.46");
  expect(parseGrokVersion("grok 1.0.46 [canary-1.2]")).toBe("1.0.46");
  expect(grokVersionPolicyRefusal({ kind: "version", version: "1.0.46" })).toBeNull();
  expect(parseGrokVersion(OTHER_CHANNEL_VERSION)).toBe("1.0.41");
  expect(grokVersionPolicyRefusal({ kind: "version", version: "1.0.41" })).toContain("1.0.41");
  expect(parseGrokVersion(`${MAC_GROK_VERSION} extra`)).toBeNull();
  expect(parseGrokVersion("grok 1.0.46 (2765805b9442) [stable channel]")).toBeNull();
  expect(parseGrokVersion("grok 1.0.46 (2765805b9442) [stable!]")).toBeNull();
  expect(parseGrokVersion("grok 1.0.46 []")).toBeNull();
  expect(parseGrokVersion("grok 1.0.46 [stable] (2765805b9442)")).toBeNull();
  const dir = mkdtempSync(join(tmpdir(), "grok-channel-"));
  try {
    const mac = writeSh(dir, "mac", `echo '${MAC_GROK_VERSION}'\n`);
    expect(await readGrokVersion(mac)).toEqual({ kind: "version", version: "1.0.46" });
    const beta = writeSh(dir, "beta", `echo '${BETA_GROK_VERSION}'\n`);
    const betaProbe = await readGrokVersion(beta);
    expect(betaProbe).toEqual({ kind: "version", version: "1.0.46" });
    expect(grokVersionPolicyRefusal(betaProbe)).toBeNull();
    const extra = writeSh(dir, "extra", `echo '${MAC_GROK_VERSION} extra'\n`);
    expect((await readGrokVersion(extra)).kind).toBe("unparseable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failure or a timeout is not cached, and the refusal says to retry or run the doctor", async () => {
  const why = grokVersionPolicyRefusal({ kind: "timeout" });
  expect(why).toContain("timed out");
  expect(why).toMatch(/retry/i);
  expect(why).toContain("walkie seats doctor");
  expect(why!.length).toBeLessThanOrEqual(280);
  expect(grokVersionPolicyRefusal({ kind: "failed", found: "exit 1" })).toContain("walkie seats doctor");
  expect(grokVersionPolicyRefusal({ kind: "missing" })).toContain("walkie seats doctor");
  expect(grokVersionPolicyRefusal({ kind: "version", version: "9.9.9" })).not.toContain("walkie seats doctor");
  const dir = mkdtempSync(join(tmpdir(), "grok-fail-"));
  const count = join(dir, "count");
  try {
    writeFileSync(count, "0");
    const fail = writeSh(dir, "fail", `n=$(cat ${JSON.stringify(count)}); echo $((n+1)) > ${JSON.stringify(count)}; echo no; exit 1\n`);
    clearGrokVersionCache();
    await readGrokVersion(fail);
    await readGrokVersion(fail);
    expect(readFileSync(count, "utf8").trim()).toBe("2");
    writeFileSync(count, "0");
    const hang = writeSh(dir, "hang", `n=$(cat ${JSON.stringify(count)}); echo $((n+1)) > ${JSON.stringify(count)}; sleep 30\n`);
    // Long enough for the shell to start and count itself before the timeout kills it (200 ms was not, on a loaded Mac).
    await readGrokVersion(hang, { timeoutMs: 1_500 });
    await readGrokVersion(hang, { timeoutMs: 1_500 });
    expect(readFileSync(count, "utf8").trim()).toBe("2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Two version scripts of equal size, so a same-mtime replace is not visible as a size change. */
function paddedVersionScript(version: string, countFile?: string): string {
  const count = countFile
    ? `n=$(cat ${JSON.stringify(countFile)} 2>/dev/null || echo 0); echo $((n+1)) > ${JSON.stringify(countFile)}; `
    : "";
  const core = `#!/bin/sh\n${count}echo 'grok ${version} (fixture)'\n`;
  const width = 240;
  if (core.length > width) throw new Error(`script is longer than the pad (${core.length})`);
  return `${core}${"#".repeat(width - core.length)}\n`;
}

function writePadded(dir: string, name: string, version: string, countFile?: string): string {
  const path = join(dir, name);
  writeFileSync(path, paddedVersionScript(version, countFile), { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function touchR(from: string, to: string): void {
  const r = Bun.spawnSync(["touch", "-r", from, to], { stdout: "ignore", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString() || "touch -r failed");
}

test("touch -r keeps mtime and still misses the version cache when ctime changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-touch-"));
  const count = join(dir, "count");
  try {
    writeFileSync(count, "0");
    const bin = writePadded(dir, "grok", "1.0.46", count);
    const snap = join(dir, "snap");
    writeFileSync(snap, "snap");
    touchR(bin, snap);
    clearGrokVersionCache();
    expect(await readGrokVersion(bin)).toEqual({ kind: "version", version: "1.0.46" });
    const before = statSync(bin);
    writeFileSync(bin, paddedVersionScript("9.9.9", count));
    chmodSync(bin, 0o755);
    touchR(snap, bin);
    const after = statSync(bin);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(after.ino).toBe(before.ino);
    expect(after.ctimeMs).not.toBe(before.ctimeMs);
    expect(await readGrokVersion(bin)).toEqual({ kind: "version", version: "9.9.9" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hard-link swap with the same mtime does not keep the cached grok version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-link-"));
  try {
    const first = writePadded(dir, "first", "1.0.46");
    const second = writePadded(dir, "second", "9.9.9");
    touchR(first, second);
    const bin = join(dir, "grok");
    linkSync(first, bin);
    clearGrokVersionCache();
    expect(await readGrokVersion(bin)).toEqual({ kind: "version", version: "1.0.46" });
    const before = statSync(bin);
    unlinkSync(bin);
    linkSync(second, bin);
    const after = statSync(bin);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).not.toBe(before.ino);
    expect(await readGrokVersion(bin)).toEqual({ kind: "version", version: "9.9.9" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rename-over with the same mtime does not keep the cached grok version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-ren-"));
  try {
    const bin = writePadded(dir, "grok", "1.0.46");
    const next = writePadded(dir, "next", "9.9.9");
    touchR(bin, next);
    clearGrokVersionCache();
    expect(await readGrokVersion(bin)).toEqual({ kind: "version", version: "1.0.46" });
    const before = statSync(bin);
    renameSync(next, bin);
    chmodSync(bin, 0o755);
    const after = statSync(bin);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).not.toBe(before.ino);
    expect(await readGrokVersion(bin)).toEqual({ kind: "version", version: "9.9.9" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retargeting a grok symlink does not keep the cached version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-sym-"));
  try {
    const first = writePadded(dir, "first", "1.0.46");
    const second = writePadded(dir, "second", "9.9.9");
    touchR(first, second);
    const bin = join(dir, "grok");
    symlinkSync(first, bin);
    clearGrokVersionCache();
    expect(await readGrokVersion(bin)).toEqual({ kind: "version", version: "1.0.46" });
    expect(statSync(bin).mtimeMs).toBe(statSync(second).mtimeMs);
    unlinkSync(bin);
    symlinkSync(second, bin);
    expect(await readGrokVersion(bin)).toEqual({ kind: "version", version: "9.9.9" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function killPidFile(file: string): void {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    if (pid > 1) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* not a group */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  } catch { /* no pid file */ }
}

test("grok --version does not freeze the event loop and kills grandchildren on timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-async-"));
  const grand = join(dir, "grand.pid");
  const leader = join(dir, "leader.pid");
  const bin = join(dir, "grok");
  writeFileSync(bin, `#!/bin/sh\necho $$ > ${JSON.stringify(leader)}\n(sleep 8) >/dev/null 2>&1 &\necho $! > ${JSON.stringify(grand)}\nexec sleep 8\n`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 30);
  try {
    clearGrokVersionCache();
    const started = Date.now();
    const probe = await readGrokVersion(bin, { timeoutMs: 350 });
    const elapsed = Date.now() - started;
    clearInterval(timer);
    expect(probe.kind).toBe("timeout");
    expect(elapsed).toBeLessThan(2500);
    expect(ticks).toBeGreaterThan(2);
    const pid = Number(readFileSync(grand, "utf8").trim());
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  } finally {
    clearInterval(timer);
    killPidFile(grand);
    killPidFile(leader);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a grandchild holding stdout is killed when grok --version's leader exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-hold-"));
  const grand = join(dir, "grand.pid");
  const bin = join(dir, "grok");
  // The grandchild inherits stdout. Waiting for the pipe to close must not wait out its sleep.
  writeFileSync(bin, `#!/bin/sh\n(sleep 8) &\necho $! > ${JSON.stringify(grand)}\nexit 0\n`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  try {
    clearGrokVersionCache();
    const started = Date.now();
    await readGrokVersion(bin, { timeoutMs: 1000 });
    expect(Date.now() - started).toBeLessThan(2500);
    const pid = Number(readFileSync(grand, "utf8").trim());
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
  } finally {
    killPidFile(grand);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overlapping probes of one hung grok share a process, and the timeout is not reused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-flight-"));
  const count = join(dir, "count");
  const leader = join(dir, "leader.pid");
  try {
    writeFileSync(count, "0");
    const bin = writeSh(dir, "hang", `echo $$ > ${JSON.stringify(leader)}\nn=$(cat ${JSON.stringify(count)}); echo $((n+1)) > ${JSON.stringify(count)}; sleep 30\n`);
    clearGrokVersionCache();
    const first = readGrokVersion(bin, { timeoutMs: 300 });
    const second = readGrokVersion(bin, { timeoutMs: 300 });
    const [a, b] = await Promise.all([first, second]);
    expect(a.kind).toBe("timeout");
    expect(b.kind).toBe("timeout");
    expect(readFileSync(count, "utf8").trim()).toBe("1");
    expect((await readGrokVersion(bin, { timeoutMs: 300 })).kind).toBe("timeout");
    expect(readFileSync(count, "utf8").trim()).toBe("2");
  } finally {
    killPidFile(leader);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refusal text is built from GROK_VERIFIED_VERSIONS", () => {
  const source = readFileSync(new URL("../../src/daemon/seats/tool-policy.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/grok 1\.0\.46 exits 1/);
  expect(source).not.toMatch(/which grok 1\.0\.46 does not narrow/);
  expect(source).not.toMatch(/grok 1\.0\.46 deny rule/);
  expect(source).toMatch(/GROK_VERIFIED_VERSIONS\.join/);
  const allow = seatToolPolicyRefusal("grok", { allow: ["not_a_tool"] }, "bypassPermissions");
  const deny = seatToolPolicyRefusal("grok", { deny: ["spawn_subagent"] }, "acceptEdits");
  const edit = seatToolPolicyRefusal("grok", { allow: ["search_replace"] }, "bypassPermissions");
  for (const why of [allow, deny, edit]) {
    expect(why).toContain(`grok ${["1.0.46"].join(", ")}`);
    expect(why!.length).toBeLessThanOrEqual(280);
  }
});

test("the version probe is an async process-group spawn, not spawnSync", () => {
  const source = readFileSync(new URL("../../src/daemon/seats/tool-policy.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/Bun\.spawnSync/);
  expect(source).toMatch(/detached:\s*true/);
  expect(source).toMatch(/process\.kill\(-/);
});

test("the doctor sentences name an unmappable policy and a bad version separately", () => {
  const verified = { ...facts, grokCli: { kind: "version" as const, version: "1.0.46" } };
  const web = doctorChecks(local({ runtimes: ["grok"], tools: { allow: ["web_search"] } }), verified);
  const webRow = web.find((c) => c.what.startsWith("tool allow-list:"));
  expect(webRow?.what).toMatch(/launch\. A default-mode Grok launch is refused\./);
  const both = doctorChecks(local({ runtimes: ["grok"], tools: { allow: ["not_a_tool"] } }), { ...facts, grokCli: { kind: "version" as const, version: "9.9.9" } });
  const bothRow = both.find((c) => c.what.startsWith("tool allow-list:"));
  expect(bothRow?.what).toContain("does not narrow");
  expect(bothRow?.what).toContain("9.9.9");
  expect(bothRow?.what).not.toMatch(/refused this Grok/);
  const deny = doctorChecks(local({ runtimes: ["grok"], tools: { deny: ["spawn_subagent"] } }), { ...facts, grokCli: { kind: "timeout" as const } });
  const denyRow = deny.find((c) => c.what.startsWith("tool allow-list:"));
  expect(denyRow?.what).toContain("cannot map");
  expect(denyRow?.what).toContain("timed out");
  expect(denyRow?.what).not.toContain("walkie seats doctor");
  expect(denyRow?.what).toContain("Retry.");
  expect(denyRow?.what).not.toMatch(/refused this Grok/);
});

test("doctorFacts uses findRuntime, so a non-executable grok on PATH is not the one it probes", async () => {
  const home = mkdtempSync(join(tmpdir(), "grok-doc-home-"));
  const pathDir = join(home, "path");
  const localBin = join(home, ".local", "bin");
  mkdirSync(pathDir, { recursive: true });
  mkdirSync(localBin, { recursive: true });
  const blocked = join(pathDir, "grok");
  writeFileSync(blocked, "#!/bin/sh\necho 'grok 9.9.9 (blocked)'\n", { mode: 0o644 });
  chmodSync(blocked, 0o644);
  writeSh(localBin, "grok", "echo 'grok 1.0.46 (fallback)'\n");
  const prevPath = process.env.PATH;
  const prevHome = process.env.HOME;
  try {
    process.env.PATH = `${pathDir}:/usr/bin:/bin`;
    process.env.HOME = home;
    clearGrokVersionCache();
    const found = await doctorFacts(local({ runtimes: ["grok"], tools: { allow: ["Read"] } }), "aka");
    expect(found.grokCli).toEqual({ kind: "version", version: "1.0.46" });
  } finally {
    process.env.PATH = prevPath;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("every doctor sentence after a period starts with a capital, and the doctor never sends the user to the doctor", () => {
  const probes: Array<[string, GrokVersionProbe | undefined]> = [
    ["unchecked", undefined],
    ["wrong version", { kind: "version", version: "9.9.9" }],
    ["unparseable", { kind: "unparseable", found: "nope" }],
    ["timeout", { kind: "timeout" }],
    ["failed", { kind: "failed", found: "exit 1" }],
    ["missing", { kind: "missing" }],
    ["verified", { kind: "version", version: "1.0.46" }],
  ];
  const policies: Array<[string, SeatToolPolicy, Array<"claude" | "codex" | "grok">]> = [
    ["mappable, grok only", { allow: ["Read"] }, ["grok"]],
    ["mappable, claude and grok", { allow: ["Read"] }, ["claude", "grok"]],
    ["unmappable allow", { allow: ["run_terminal_command"] }, ["claude", "grok"]],
    ["unmappable deny", { deny: ["spawn_subagent"] }, ["codex", "grok"]],
    ["web_search only", { allow: ["web_search"] }, ["grok"]],
    ["empty allow", { allow: [] }, ["claude", "grok"]],
  ];
  let checked = 0;
  for (const [policyName, tools, runtimes] of policies) {
    for (const [probeName, grokCli] of probes) {
      const row = doctorChecks(local({ runtimes, tools }), { ...facts, ...(grokCli ? { grokCli } : {}) }).find((c) => c.what.startsWith("tool allow-list:"));
      const label = `${policyName} / ${probeName}`;
      expect(row, label).toBeDefined();
      expect(row!.what, label).not.toMatch(/[.!?] [a-z]/);
      expect(row!.what, label).not.toContain("walkie seats doctor");
      expect(`${row!.fix ?? ""}`, label).not.toContain("walkie seats doctor");
      checked++;
    }
  }
  expect(checked).toBe(policies.length * probes.length);
  const unmapped = doctorChecks(local({ runtimes: ["grok"], tools: { allow: ["run_terminal_command"] } }), { ...facts, grokCli: { kind: "version", version: "1.0.41" } })
    .find((c) => c.what.startsWith("tool allow-list:"));
  expect(unmapped?.what).toMatch(/is refused\. This Grok seat's tool policy/);
  // The launch refusal still points a retry at the doctor.
  expect(grokVersionPolicyRefusal({ kind: "timeout" })).toContain("walkie seats doctor");
  expect(grokVersionPolicyRefusal({ kind: "timeout" }, { doctor: true })).not.toContain("walkie seats doctor");
});

test("grok --version output is read up to 4 KB; a flood is cut off, killed and refused as unparseable", async () => {
  expect(GROK_VERSION_MAX_OUTPUT_BYTES).toBe(4096);
  const dir = mkdtempSync(join(tmpdir(), "grok-flood-"));
  const leader = join(dir, "leader.pid");
  const head = "grok 1.0.46\n";
  try {
    // Exactly 4096 bytes on stdout, version line first: still a version.
    const edge = writeSh(dir, "edge", `printf 'grok 1.0.46\n'; head -c ${4096 - head.length} /dev/zero | tr '\\0' ' '\n`);
    clearGrokVersionCache();
    expect(await readGrokVersion(edge)).toEqual({ kind: "version", version: "1.0.46" });
    // One byte more is over the cap, whatever the first line says.
    const over = writeSh(dir, "over", `printf 'grok 1.0.46\n'; head -c ${4096 - head.length + 1} /dev/zero | tr '\\0' ' '\n`);
    clearGrokVersionCache();
    const overProbe = await readGrokVersion(over);
    expect(overProbe.kind).toBe("unparseable");
    expect(grokVersionPolicyRefusal(overProbe)).toContain("cannot be enforced");
    for (const stream of ["", ">&2"]) {
      rmSync(leader, { force: true });
      const flood = writeSh(dir, `flood${stream ? "-err" : ""}`, `echo $$ > ${JSON.stringify(leader)}\nexec yes 'grok 1.0.46 (flood) [stable]' ${stream}\n`);
      clearGrokVersionCache();
      const started = Date.now();
      const probe = await readGrokVersion(flood, { timeoutMs: 8000 });
      const elapsed = Date.now() - started;
      // Cut off by size, not by the 8 s timeout, and the flooding process is gone.
      expect(probe.kind, `flood ${stream || "stdout"}`).toBe("unparseable");
      expect(probe).toMatchObject({ found: expect.stringContaining("4096") });
      expect(elapsed).toBeLessThan(3000);
      const pid = Number(readFileSync(leader, "utf8").trim());
      let alive = true;
      try { process.kill(pid, 0); } catch { alive = false; }
      expect(alive, `flood ${stream || "stdout"} still running`).toBe(false);
      // Unparseable is cached for that file, like any other unreadable line.
      const again = Date.now();
      expect((await readGrokVersion(flood, { timeoutMs: 8000 })).kind).toBe("unparseable");
      expect(Date.now() - again).toBeLessThan(200);
    }
  } finally {
    killPidFile(leader);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a flood that ignores SIGPIPE is still cut off at 4 KB by killing its group (WALK-76 r6 review LOW-1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-nopipe-"));
  try {
    const bin = writeSh(dir, "nopipe", "trap '' PIPE\nwhile :; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; done\n");
    clearGrokVersionCache();
    const started = Date.now();
    const probe = await readGrokVersion(bin);
    expect(probe).toEqual({ kind: "unparseable", found: `over ${GROK_VERSION_MAX_OUTPUT_BYTES} bytes of output` });
    expect(Date.now() - started).toBeLessThan(2_500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a grok that crashes with a long error is refused for that launch but not cached: it is asked again (WALK-76 r6 review LOW-2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-crash-"));
  try {
    const count = join(dir, "count");
    writeFileSync(count, "0");
    // First run: over 4 KB on stderr, then exit 1 by itself. Later runs: a clean version line.
    const bin = writeSh(dir, "crashy", `n=$(cat '${count}'); echo $((n + 1)) > '${count}'\nif [ "$n" = 0 ]; then head -c 5000 /dev/zero | tr '\\0' 'e' >&2; exit 1; fi\necho 'grok 1.0.46'\n`);
    clearGrokVersionCache();
    const first = await readGrokVersion(bin);
    expect(first.kind === "failed" || first.kind === "unparseable").toBe(true);
    const second = await readGrokVersion(bin); // same unchanged file: not served from the cache
    expect(second).toEqual({ kind: "version", version: "1.0.46" });
    expect(readFileSync(count, "utf8").trim()).toBe("2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Credential-path denies stay next to the flags, and the version cache is described", () => {
  const protocol = readFileSync(new URL("../../docs/PROTOCOL.md", import.meta.url), "utf8");
  const security = readFileSync(new URL("../../docs/SECURITY.md", import.meta.url), "utf8");
  const flags = protocol.indexOf("Walkie does not rely on `--no-subagents`.");
  const cred = protocol.indexOf("Credential-path denies stay after those flags");
  const doctorSent = protocol.indexOf("`walkie seats doctor` shows the same refusal");
  expect(flags).toBeGreaterThan(-1);
  expect(cred).toBeGreaterThan(flags);
  expect(doctorSent).toBeGreaterThan(cred);
  expect(protocol).not.toContain("per binary path and mtime");
  expect(security).not.toContain("per binary path and mtime");
  expect(protocol).toContain("[stable]");
  expect(protocol).toContain("change time");
  expect(security).toContain("[stable]");
});

test("a tool policy's key ignores list order and repeats, so an equivalent edit does not refuse a preparing seat", async () => {
  const { toolPolicyKey } = await import("../../src/daemon/seats/tool-policy.ts");
  expect(toolPolicyKey({ allow: ["Read", "Grep"] })).toBe(toolPolicyKey({ allow: ["Grep", "Read", "Read"] }));
  expect(toolPolicyKey({ allow: ["Read"] })).not.toBe(toolPolicyKey({ allow: ["Read", "Grep"] }));
  expect(toolPolicyKey({ allow: [] })).not.toBe(toolPolicyKey(undefined)); // no tools is not no policy
  expect(toolPolicyKey({ deny: ["WebFetch"] })).not.toBe(toolPolicyKey({ allow: ["WebFetch"] }));
  expect(toolPolicyKey({ allow: ["Read"], deny: [] })).toBe(toolPolicyKey({ allow: ["Read"] })); // an empty deny list denies nothing
});
