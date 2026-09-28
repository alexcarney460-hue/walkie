// ADD-MACHINE-3: which terminals count as an agent's for person-only commands (src/cli/agent-detect.ts), and boolean
// switches given a value (`--for-agent=true` used to read as off).
import { describe, expect, test } from "bun:test";
import { agentAncestor, agentMarker, agentProcessOf, agentSignals, envAgentMarker, readProcessTable, type ProcRow } from "../../src/cli/agent-detect.ts";
import { bool, parseArgs, UsageError } from "../../src/cli/args.ts";

describe("agent runtime processes", () => {
  test("native executables, npm/python entry points and grok's versioned binary", () => {
    const cases: Array<[string, string | null]> = [
      ["/Users/a/.local/bin/claude", "claude"], ["claude -p hello", "claude"], ["/Users/a/.kimi-code/bin/kimi -p x", "kimi"], ["kimi-code  ", "kimi-code"],
      ["/opt/homebrew/bin/codex exec --sandbox read-only x", "codex"], ["codex app-server", "codex"],
      ["node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js", "claude"],
      ["node /x/node_modules/@google/gemini-cli/dist/index.js", "gemini"], ["/usr/bin/python3 /Users/a/.local/bin/aider --model x", "aider"],
      ["/Users/a/.grok/downloads/grok-1.2.3-darwin-arm64", "grok"], ["cursor-agent", "cursor-agent"],
      // Hermes gateway, runner subcommands, interpreter flags (Opus r3 HIGH 1; Codex r3 HIGH).
      ["/Users/a/.hermes/venv/bin/python -m hermes_cli.main gateway run", "hermes"], ["python3 -m aider", "aider"],
      ["python3 -W ignore -m aider --model x", "aider"], ["python3 -maider", "aider"], ["python3 -u /x/bin/aider", "aider"],
      ["node --no-warnings /x/node_modules/@anthropic-ai/claude-code/cli.js", "claude"],
      ["bun run /x/node_modules/@google/gemini-cli/dist/index.js", "gemini"], ["deno run -A npm:@google/gemini-cli", "gemini"],
      ["python3 -m http.server", null], ["python3 script.py", null], ["bun run dev", null],
      // GUI apps and their helpers are never agents (paths with spaces included).
      ["/Applications/Claude.app/Contents/MacOS/Claude", null], ["/Applications/Codex.app/Contents/MacOS/Codex", null],
      ["/Applications/Windsurf.app/Contents/Frameworks/Windsurf Helper (Plugin).app/Contents/MacOS/Windsurf Helper (Plugin) --type=utility", null],
      ["/Applications/Grok Bot.app/Contents/MacOS/Grok Bot", null], ["/Applications/Hermes.app/Contents/MacOS/Hermes", null],
      ["/Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper --type=gpu", null],
      ["/usr/share/windsurf/windsurf", null],
      // Round 4 (Opus LOW): a CLI inside a bundle's Resources is a CLI; Claude's native versions path; trimmed argv.
      ["/Applications/Codex.app/Contents/Resources/codex app-server", "codex"],
      ["/Users/a/.local/share/claude/versions/2.1.283 --resume", "claude"],
      ["/bin/zsh", null], ["-zsh", null], ["/usr/bin/login -pf alex", null], ["/Applications/Ghostty.app/Contents/MacOS/ghostty", null],
      ["tmux new -s x", null], ["/Applications/Cursor.app/Contents/MacOS/Cursor", null], ["node server.js", null],
      ["sh -c claude", null], ["python3 -m http.server", null], ["/usr/local/bin/claude-mem worker", null],
    ];
    for (const [cmd, want] of cases) expect([cmd, agentProcessOf(cmd)]).toEqual([cmd, want]);
  });

  test("exact argv (Linux /proc) and a ps line whose script path has spaces (a real file)", () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
    const dir = mkdtempSync("/tmp/walkie-sp-");
    try {
      mkdirSync(`${dir}/Alex Smith/bin`, { recursive: true });
      writeFileSync(`${dir}/Alex Smith/bin/aider`, "#!/usr/bin/env python3\n");
      expect(agentProcessOf(`/usr/bin/python3 ${dir}/Alex Smith/bin/aider --model x`)).toBe("aider");
      expect(agentProcessOf(["/usr/bin/python3", `${dir}/Alex Smith/bin/aider`, "--model", "x"])).toBe("aider");
      expect(agentProcessOf(["/usr/bin/python3", "-m", "hermes_cli.main", "gateway", "run"])).toBe("hermes");
      expect(agentProcessOf(["/usr/bin/python3", `${dir}/Alex Smith/bin/tool.py`])).toBeNull();
      expect(agentProcessOf(["python3", "-c", "from hermes_cli.main import main; main()"])).toBe("hermes");
      expect(agentProcessOf([" /usr/bin/python3 ", " -m ", " aider "])).toBe("aider");
      expect(agentProcessOf(["python3", "-c", "print(1)"])).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("the nearest agent above the CLI; a person's chain has none; loops and gaps end the walk", () => {
    const t = (rows: Array<[number, number, string]>) => new Map<number, ProcRow>(rows.map(([pid, ppid, command]) => [pid, { ppid, command }]));
    const agent = t([[40, 30, "/bin/zsh"], [30, 20, "/Users/a/.kimi-code/bin/kimi"], [20, 10, "/Users/a/.local/bin/claude"], [10, 1, "zsh"]]);
    expect(agentAncestor(agent, 40)).toEqual({ name: "kimi", pid: 30 });
    const person = t([[40, 30, "/bin/zsh"], [30, 20, "/usr/bin/login -pf alex"], [20, 1, "/Applications/Ghostty.app/Contents/MacOS/ghostty"]]);
    expect(agentAncestor(person, 40)).toBeNull();
    // tmux: a pane's shell belongs to the tmux server, whose parent is init, not the agent shell that started it.
    expect(agentAncestor(t([[50, 45, "-zsh"], [45, 1, "tmux new -s work"]]), 50)).toBeNull();
    expect(agentAncestor(t([[5, 6, "zsh"], [6, 5, "zsh"]]), 5)).toBeNull();
    expect(agentAncestor(t([[5, 999, "zsh"]]), 5)).toBeNull();
    expect(agentAncestor(null, 5)).toBeNull();
  });

  test("inspection that stops before init is reported as incomplete, not ok (Codex r4 LOW 2)", () => {
    const missingParent = () => new Map<number, ProcRow>([[7, { ppid: 5, command: "zsh" }]]);
    expect(agentSignals({ env: {}, table: missingParent, ppid: 7 })).toEqual({ marker: null, inspection: "incomplete" });
    const unreadable = () => new Map<number, ProcRow>([[7, { ppid: 1, command: "", argv: [] }]]);
    expect(agentSignals({ env: {}, table: unreadable, ppid: 7 }).inspection).toBe("incomplete");
    const whole = () => new Map<number, ProcRow>([[7, { ppid: 1, command: "zsh" }]]);
    expect(agentSignals({ env: {}, table: whole, ppid: 7 })).toEqual({ marker: null, inspection: "ok" });
    expect(agentSignals({ env: {}, table: () => null, ppid: 7 }).inspection).toBe("unavailable");
  });

  test("agentMarker: the flag, then the environment, then the ancestors; words for the error", () => {
    const table = () => new Map<number, ProcRow>([[7, { ppid: 3, command: "/x/kimi" }], [3, { ppid: 1, command: "zsh" }]]);
    expect(agentMarker({ forAgentFlag: true, env: {}, table, ppid: 7 })).toBe("--for-agent was given");
    expect(agentMarker({ env: { CLAUDECODE: "1" }, table, ppid: 7 })).toBe("CLAUDECODE is set in its environment");
    expect(agentMarker({ env: { CODEX_HOME: "/x" }, table, ppid: 7 })).toBe("it runs under kimi (pid 7)");
    expect(agentMarker({ env: {}, table: () => null, ppid: 7 })).toBeNull();
    expect(envAgentMarker({ AI_AGENT: "claude-code_2_agent", CODEX_CI: "1" })).toBe("AI_AGENT");
  });

  test("this machine's process table reads, and holds this process", () => {
    const table = readProcessTable();
    expect(table?.get(process.pid)?.ppid).toBe(process.ppid);
  });
});

describe("boolean switches given a value (r2 HIGH)", () => {
  const B = new Set(["for-agent", "json", "no-open"]);
  test("=true/1/yes/on is on, =false/0/no/off is off, anything else is a usage error", () => {
    for (const v of ["true", "1", "yes", "on", "TRUE", "Yes"]) expect(bool(parseArgs([`--for-agent=${v}`], B), "for-agent")).toBe(true);
    for (const v of ["false", "0", "no", "off"]) expect(bool(parseArgs([`--for-agent=${v}`], B), "for-agent")).toBe(false);
    for (const v of ["", "maybe", "2", "tru"]) expect(() => parseArgs([`--for-agent=${v}`], B)).toThrow(UsageError);
  });
  test("every declared switch is stored as true (the === true checks read it), a valued flag keeps its string", () => {
    const a = parseArgs(["--json=true", "--no-open=1", "--handle=kira", "--for-agent"], B);
    expect([a.flags.get("json"), a.flags.get("no-open"), a.flags.get("handle"), a.flags.get("for-agent")]).toEqual([true, true, "kira", true]);
    expect(parseArgs(["--json=false"], B).flags.has("json")).toBe(false);
  });
});
