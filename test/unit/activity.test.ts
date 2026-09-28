// WALKIE-MISSION-1: the signals discovery judges a session by (activity.ts): CPU time from ps, session-file tails
// (Claude transcript, Codex rollout), titles from prompts, and the working/idle verdict.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVE_WINDOW_MS, CpuTracker, MID_TURN_MAX_MS, SessionFiles, TAIL_BYTES, claudeProjectSlug, judge, parseCpuTime, parseTail, titleOf,
} from "../../src/daemon/activity.ts";
import { parsePs, type ProcRow } from "../../src/daemon/procs.ts";

const dir = mkdtempSync("/tmp/walkie-activity-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const jl = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
const user = (content: unknown, extra = {}) => ({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (content: unknown[], model = "claude-opus-5-5") => ({ type: "assistant", message: { role: "assistant", model, content } });
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: "t1", name, input });

describe("CPU time", () => {
  test("ps time column: macOS M:SS.cc and Linux [DD-]HH:MM:SS", () => {
    expect(parseCpuTime("0:01.23")).toBe(1_230);
    expect(parseCpuTime("125:03.50")).toBe((125 * 60 + 3.5) * 1000);
    expect(parseCpuTime("01:02:03")).toBe((3600 + 120 + 3) * 1000);
    expect(parseCpuTime("2-01:00:00")).toBe((2 * 86_400 + 3600) * 1000);
    expect(parseCpuTime("garbage")).toBeNull();
  });

  test("parsePs reads the time column when present and still parses listings without it", () => {
    const [mac, linux, old] = parsePs([
      "  6141  6125   501   12:34.56 Fri Sep  4 12:18:20 2026     /Users/u/.local/bin/claude -p go",
      "  700   1   1000 1-02:03:04 Sat Sep 26 08:24:59 2026 codex exec -C /w do it",
      "    1     0     0 Thu Sep 24 17:53:38 2026     /sbin/launchd",
    ].join("\n"));
    expect(mac).toMatchObject({ pid: 6141, cpuMs: (12 * 60 + 34.56) * 1000, command: "/Users/u/.local/bin/claude -p go" });
    expect(linux).toMatchObject({ pid: 700, uid: 1000, cpuMs: (86_400 + 7_384) * 1000, command: "codex exec -C /w do it" });
    expect(old).toMatchObject({ pid: 1, command: "/sbin/launchd" });
    expect(old?.cpuMs).toBeUndefined();
  });

  test("the tracker measures a session's whole process tree between samples; new children count in full", () => {
    const t = new CpuTracker();
    const row = (pid: number, ppid: number, cpuMs: number, startedAt = 1_000): ProcRow => ({ pid, ppid, uid: 1, startedAt, command: "x", cpuMs });
    const root = row(10, 1, 1_000);
    expect(t.sample([root, row(11, 10, 50)], [root], 100_000).get(10)).toBeNull(); // first sample: unknown
    const root2 = row(10, 1, 1_150);
    // 15 s later: the CLI used 150 ms, its old child nothing, a new test run 3 s.
    const r = t.sample([root2, row(11, 10, 50), row(12, 11, 3_000, 101_000), row(99, 1, 60_000)], [root2], 115_000).get(10) as number;
    expect(r).toBeCloseTo(3_150 / 15_000, 5);
    const root3 = row(10, 1, 1_300);
    expect(t.sample([root3, row(11, 10, 50)], [root3], 130_000).get(10)).toBeCloseTo(150 / 15_000, 5); // idle CLI: 1 %
  });
});

describe("session file tails", () => {
  test("Claude: a tool call or a tool result in flight is mid-turn; the last tool is the step; a finished turn is not", () => {
    const running = parseTail(jl(
      user("Fix the parser for ALE-5286"),
      assistant([{ type: "text", text: "ok" }, toolUse("Bash", { command: "bun test test/unit" })]),
    ), "claude", true, "/w", true);
    expect(running).toEqual({ midTurn: true, toolRunning: true, newestIsTurn: true, turnSeen: true, step: "$ bun test test/unit", model: "claude-opus-5-5", prompt: "Fix the parser for ALE-5286" });
    const replying = parseTail(jl(assistant([toolUse("Edit", { file_path: "/w/src/x.ts" })]), user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]), { type: "attachment" }), "claude", true, "/w", true);
    expect(replying).toMatchObject({ midTurn: true, step: "Edit src/x.ts" });
    const done = parseTail(jl(assistant([toolUse("Read", { file_path: "/w/a" })]), user([{ type: "tool_result", content: "x" }]), assistant([{ type: "text", text: "Done." }]), { type: "system", subtype: "turn_duration" }), "claude", true, "/w", true);
    expect(done).toMatchObject({ midTurn: false, step: "Read a" });
    // Injected notices are not prompts; sidechain (subagent) records don't decide the main turn.
    const notice = parseTail(jl(user("<task-notification>x</task-notification>"), assistant([{ type: "text", text: "hm" }], "m"), { ...assistant([toolUse("Bash", { command: "ls" })]), isSidechain: true }), "claude", true);
    expect(notice.prompt).toBeUndefined();
    expect(notice.midTurn).toBe(false);
  });

  test("Codex: task_complete ends the turn; function calls are steps; the model comes from turn_context", () => {
    const rec = (type: string, payload: Record<string, unknown>) => ({ type, payload });
    const working = parseTail(jl(
      rec("turn_context", { model: "gpt-6-codex" }),
      rec("event_msg", { type: "user_message", message: "Add the archive view" }),
      rec("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "bun run typecheck" }) }),
    ), "codex", true, "", true);
    expect(working).toEqual({ midTurn: true, toolRunning: true, newestIsTurn: true, turnSeen: true, step: "$ bun run typecheck", model: "gpt-6-codex", prompt: "Add the archive view" });
    const done = parseTail(jl(
      rec("response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["git", "status"] }) }),
      rec("response_item", { type: "message", role: "assistant" }),
      rec("event_msg", { type: "task_complete" }),
      rec("event_msg", { type: "token_count" }),
    ), "codex", true, "", true);
    expect(done).toMatchObject({ midTurn: false, step: "$ git status" });
    // Code mode: a script that calls tools.exec_command / write_stdin.
    const script = (input: string) => parseTail(jl(rec("response_item", { type: "custom_tool_call", name: "exec", input })), "codex", true, "", true).step;
    expect(script('const r=await tools.exec_command({cmd:"bun test \\"a b\\"",yield_time_ms:1000});')).toBe('$ bun test "a b"');
    expect(script("const r=await tools.write_stdin({session_id:1,chars:\"\"});")).toBe("Waiting on a command's output");
    expect(script("await tools.view_image({path:'x'})")).toBe("view_image");
    expect(parseTail(jl(rec("response_item", { type: "function_call", name: "wait", arguments: "{}" })), "codex", true).step).toBe("Waiting on a command's output");
  });

  test("a partial first line of a tail is skipped", () => {
    const text = `ol":"x"}}\n${JSON.stringify(assistant([toolUse("Grep", { pattern: "archive" })]))}\n`;
    expect(parseTail(text, "claude", false, "", true)).toMatchObject({ midTurn: true, step: "Search archive" });
    expect(parseTail(text, "claude", false)).toMatchObject({ midTurn: true, step: "Searching" }); // share_activity off
  });

  test("titles: first line that says something, headings unmarked, secrets redacted", () => {
    expect(titleOf("<!-- BUILDER PREAMBLE v1 -->\n\n## Task: WALKIE-MISSION-1 (ALE-5286) — accurate Mission Control\nmore")).toBe("Task: WALKIE-MISSION-1 (ALE-5286) — accurate Mission Control");
    expect(titleOf(("<system>\nuse key sk" + "-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 to deploy"))).not.toContain("abcdefghijklmnop");
    expect(titleOf("   \n")).toBeUndefined();
    expect(titleOf(undefined)).toBeUndefined();
  });
});

describe("session files on disk", () => {
  test("Claude's transcript is found by the cwd slug, else by looking through the projects; tails re-read only on change", () => {
    const cfg = join(dir, "claude");
    const cwd = "/Users/u/work/walkie.git/.claude/worktrees/m1";
    const slug = claudeProjectSlug(cwd);
    expect(slug).toBe("-Users-u-work-walkie-git--claude-worktrees-m1");
    mkdirSync(join(cfg, "projects", slug), { recursive: true });
    mkdirSync(join(cfg, "projects", "-elsewhere"), { recursive: true });
    const sid = "aaaa1111-0000-4000-8000-000000000000";
    const other = "bbbb2222-0000-4000-8000-000000000000";
    const p1 = join(cfg, "projects", slug, `${sid}.jsonl`);
    const p2 = join(cfg, "projects", "-elsewhere", `${other}.jsonl`);
    writeFileSync(p1, jl(user("first prompt"), assistant([toolUse("Bash", { command: "ls" })])));
    writeFileSync(p2, jl(user("x")));
    const files = new SessionFiles({ detail: true });
    expect(files.claudeTranscript(cfg, cwd, sid, 1)).toBe(p1);
    expect(files.claudeTranscript(cfg, "/somewhere/else", other, 1)).toBe(p2);
    expect(files.claudeTranscript(cfg, cwd, "cccc3333-0000-4000-8000-000000000000", 1)).toBeNull();
    const first = files.read(p1, "claude");
    expect(first?.info).toMatchObject({ midTurn: true, step: "$ ls" });
    utimesSync(p1, new Date(5_000_000), new Date(5_000_000));
    expect(files.read(p1, "claude")?.mtime).toBe(5_000_000);
    expect(files.firstPrompt(p1, "claude")).toBe("first prompt");
    // Subagents' transcripts count as the session's activity.
    mkdirSync(join(cfg, "projects", slug, sid, "subagents"), { recursive: true });
    const sub = join(cfg, "projects", slug, sid, "subagents", "agent-1.jsonl");
    writeFileSync(sub, jl(user("sub")));
    utimesSync(sub, new Date(9_000_000), new Date(9_000_000));
    expect(files.subagentsMtime(p1)).toBe(9_000_000);
  });

  test("only the last TAIL_BYTES of a large transcript are read", () => {
    const p = join(dir, "big.jsonl");
    const filler = jl(...Array.from({ length: 2_000 }, (_, i) => user(`old prompt ${i}`)));
    writeFileSync(p, filler + jl(assistant([toolUse("Write", { file_path: "/w/new.ts" })])));
    expect(filler.length).toBeGreaterThan(TAIL_BYTES * 2);
    const r = new SessionFiles({ detail: true }).read(p, "claude", "/w");
    expect(r?.info).toMatchObject({ midTurn: true, step: "Write new.ts" });
    expect(r?.info.prompt).toMatch(/^old prompt \d+$/);
  });
});

describe("verdict", () => {
  test("working = a write or busy CPU in the last minute, or a turn in progress written within 10 min", () => {
    const now = 10_000_000;
    expect(judge(now, now - ACTIVE_WINDOW_MS + 1, false, null)).toEqual({ working: true, lastActiveAt: now - ACTIVE_WINDOW_MS + 1 });
    expect(judge(now, now - ACTIVE_WINDOW_MS - 1, false, null).working).toBe(false);
    expect(judge(now, now - 5 * 60_000, true, null).working).toBe(true); // a long tool call or a long reply
    expect(judge(now, now - MID_TURN_MAX_MS - 1, true, null).working).toBe(false);
    expect(judge(now, null, false, now - 10_000)).toEqual({ working: true, lastActiveAt: now - 10_000 });
    expect(judge(now, null, false, null)).toEqual({ working: false, lastActiveAt: null });
  });
});
