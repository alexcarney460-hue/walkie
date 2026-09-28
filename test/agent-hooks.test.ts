import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTask, normalizeAgentName, repoContext, resolveAgentName } from "../src/agent/identity.ts";
import { describeTool, titleFromPrompt } from "../src/hooks/activity.ts";
import { transition } from "../src/hooks/claude.ts";
import { codexAgentName } from "../src/hooks/codex.ts";
import { withClaudeHooks, withCodexBlock } from "../src/hooks/install.ts";
import { addressedToMe, shouldPush } from "../src/mcp/server.ts";
import type { Event } from "../src/protocol/schemas.ts";

describe("agent identity", () => {
  test("hooks and MCP derive the same name from the session id", () => {
    const env = { CLAUDE_CODE_SESSION_ID: "3F9A2B7C-1111-2222" };
    expect(resolveAgentName(env)).toBe("cc-3f9a2b");
    expect(resolveAgentName({ CLAUDECODE: "1" }, "3f9a2b7c-1111")).toBe("cc-3f9a2b");
  });
  test("WALKIE_AGENT wins and is normalized", () => {
    expect(resolveAgentName({ WALKIE_AGENT: "UX Seat!", CLAUDE_CODE_SESSION_ID: "abc" })).toBe("ux-seat-");
    expect(normalizeAgentName("---")).toBeNull();
  });
  test("Codex thread ids are UUIDv7 (time first): sessions from the same hours get distinct names", () => {
    // Three real Codex sessions on one Mac, started within an hour: all begin 35a3fc.
    const ids = ["35a3fc06-a27b-7106-8fd8-f2bb6d700e29", "35a3fc4a-ca9d-7ff5-b71f-a8b9aaca8f3d", "35a3fc26-0c0f-7566-898a-ecceef7cd805"];
    const names = ids.map((id) => resolveAgentName({ CODEX_THREAD_ID: id }));
    expect(new Set(names).size).toBe(3);
    expect(names[0]).toBe("codex-700e29"); // the random tail
    expect(resolveAgentName({}, ids[0]) ?? resolveAgentName({ CODEX_HOME: "/x" }, ids[0])).toBe("codex-700e29");
    // Claude Code's ids are random (v4): unchanged, the first six.
    expect(resolveAgentName({ CLAUDE_CODE_SESSION_ID: "f7091ac7-5c72-4c93-be33-a387f987ccb3" })).toBe("cc-f7091a");
  });
  test("the Codex notify hook names a Codex started inside a Claude Code session by its own thread", () => {
    const inherited = { CLAUDE_CODE_SESSION_ID: "f7091ac7-5c72-4c93-be33-a387f987ccb3", CLAUDECODE: "1", CODEX_HOME: "/x" };
    expect(codexAgentName(inherited, "35a3fc06-a27b-7106-8fd8-f2bb6d700e29")).toBe("codex-700e29");
    expect(codexAgentName({ WALKIE_AGENT: "ux-seat", ...inherited }, "35a3fc06-a27b-7106-8fd8-f2bb6d700e29")).toBe("ux-seat");
  });
  test("a human at the CLI has no agent", () => {
    expect(resolveAgentName({})).toBeNull();
  });
  test("task detection", () => {
    expect(detectTask("fix ALE-5156 please")).toBe("ALE-5156");
    expect(detectTask(undefined, "FEAT/ENG-12-X")).toBe("ENG-12");
    expect(detectTask("no key here")).toBeUndefined();
    expect(detectTask("merge dashboard + FIX-1, dual audit (ALE-5156)")).toBe("ALE-5156");
  });
  test("repo context reads HEAD without git, including worktree .git files", () => {
    const root = mkdtempSync(join(tmpdir(), "walkie-repo-"));
    mkdirSync(join(root, "main", ".git"), { recursive: true });
    writeFileSync(join(root, "main", ".git", "HEAD"), "ref: refs/heads/feat/x\n");
    mkdirSync(join(root, "main", "src"));
    expect(repoContext(join(root, "main", "src"))).toMatchObject({ repo: "main", branch: "feat/x" });
    mkdirSync(join(root, "wt-git", "HEAD-holder"), { recursive: true });
    writeFileSync(join(root, "wt-git", "HEAD"), "ref: refs/heads/wt-branch\n");
    mkdirSync(join(root, "wt"));
    writeFileSync(join(root, "wt", ".git"), `gitdir: ${join(root, "wt-git")}\n`);
    expect(repoContext(join(root, "wt"))).toMatchObject({ repo: "wt", branch: "wt-branch" });
  });
});

describe("hook transitions", () => {
  const empty = { injected: [] };
  const ALL = { prompts: true, activity: true };
  test("prompt → working with a redacted title and task (share_prompts on)", () => {
    const t = transition({ hook_event_name: "UserPromptSubmit", prompt: ("\n  ship ALE-5156 with key sk" + "-ant-api03-abcdefghijklmnopqrstuvwxyz0123\nmore") }, empty, 1000, ALL);
    expect(t?.state).toBe("working");
    expect(t?.next.task).toBe("ALE-5156");
    expect(t?.next.title).not.toContain("sk-ant-api03");
    expect(t?.next.started_at).toBe(1000);
  });
  test("prompt sharing off (the default) hides the prompt and its issue key", () => {
    const t = transition({ hook_event_name: "UserPromptSubmit", prompt: "secret plan ALE-9999" }, empty, 1);
    expect(t?.next).toMatchObject({ title: "Working on a task", title_src: "placeholder" });
    expect(t?.next.task).toBeUndefined();
  });
  test("tool use keeps title, sets activity (the tool's text only with share_activity)", () => {
    const prev = { injected: [], title: "T" };
    const t = transition({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/w/r/src/a.ts" }, cwd: "/w/r" }, prev, 1, ALL);
    expect(t?.next).toBe(prev);
    expect(t?.activity).toBe("Edit src/a.ts");
    const quiet = transition({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "psql -h db.internal secret_db" }, cwd: "/w/r" }, prev, 1);
    expect(quiet?.activity).toBe("Running a command");
  });
  test("notification → waiting, stop → idle, end → offline, unknown → null", () => {
    expect(transition({ hook_event_name: "Notification", message: "needs permission" }, empty, 1)?.state).toBe("waiting");
    expect(transition({ hook_event_name: "Stop" }, empty, 1)?.state).toBe("idle");
    expect(transition({ hook_event_name: "SessionEnd" }, empty, 1)?.state).toBe("offline");
    expect(transition({ hook_event_name: "Whatever" }, empty, 1)).toBeNull();
  });
  test("bash activity is redacted and bounded", () => {
    const a = describeTool("Bash", { command: `curl -H "Authorization: token ghp_${"a".repeat(36)}" ${"x".repeat(300)}` }, "/", true);
    expect(a).not.toContain("ghp_aaaa");
    expect(a.length).toBeLessThanOrEqual(180);
    expect(describeTool("mcp__linear__save_issue", {}, "/", true)).toBe("MCP linear.save_issue");
    expect(describeTool("mcp__linear__save_issue", {}, "/")).toBe("Using a tool");
  });
  test("title is the first non-empty line", () => {
    expect(titleFromPrompt("\n\n  hello world \nsecond")).toBe("hello world");
  });
});

describe("installers are idempotent and preserve foreign config", () => {
  const foreign = { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "bash other.sh" }] }] }, model: "x" };
  test("claude: install twice = once; uninstall restores", () => {
    const once = withClaudeHooks(foreign, "walkie", true);
    const twice = withClaudeHooks(once, "walkie", true);
    expect(twice).toEqual(once);
    expect(once.hooks?.Stop?.length).toBe(2);
    expect(once.hooks?.PostToolUse?.[0]?.matcher).toBe("*");
    expect(withClaudeHooks(twice, "walkie", false)).toEqual(foreign);
  });
  test("codex: notify only when absent, block replaced not duplicated", () => {
    const base = 'model = "gpt"\n\n[profiles.x]\nfoo = 1\n';
    const a = withCodexBlock(base, ["/bin/walkie"], true);
    expect(a.notifySkipped).toBe(false);
    expect(a.toml.indexOf("notify =")).toBeLessThan(a.toml.indexOf("[profiles.x]"));
    const b = withCodexBlock(a.toml, ["/bin/walkie"], true);
    expect(b.toml).toBe(a.toml);
    expect(withCodexBlock(b.toml, ["/bin/walkie"], false).toml.trim()).toBe(base.trim());
    expect(withCodexBlock('notify = ["x"]\n', ["/bin/walkie"], true).notifySkipped).toBe(true);
  });
});

describe("MCP push routing", () => {
  const me = { handle: "kira", hostname: "kiras-mbp", agent: "cc-abc123", node: "0123456789abcdef" };
  const ev = (over: Partial<Event>): Event => ({
    v: 1, team: "aaaaaaaaaaaaaaaa", id: "fedcba9876543210:1", origin: "fedcba9876543210", seq: 1, ts: 1,
    author: { handle: "alex", node: "fedcba9876543210", agent: "cc-zzz" }, kind: "msg.post", body: { text: "hi" }, sig: "x", ...over,
  });
  test("address matching", () => {
    expect(addressedToMe("@kira", me)).toBe(true);
    expect(addressedToMe("@kira/kiras-mbp", me)).toBe(true);
    expect(addressedToMe("@kira/kiras-mbp/cc-abc123", me)).toBe(true);
    expect(addressedToMe("@kira/other-mac", me)).toBe(false);
    expect(addressedToMe("@kira/kiras-mbp/cc-other", me)).toBe(false);
    expect(addressedToMe("@alex", me)).toBe(false);
  });
  test("pushes asks to me, agent mentions and replies in my threads; not my own or chatter", () => {
    const threads = new Set(["0123456789abcdef:7"]);
    expect(shouldPush(ev({ kind: "ask", body: { to: "@kira", text: "q" } }), me, threads)).toBe(true);
    expect(shouldPush(ev({ body: { text: "x", mentions: ["@kira/kiras-mbp/cc-abc123"] } }), me, threads)).toBe(true);
    expect(shouldPush(ev({ body: { text: "x", thread: "0123456789abcdef:7" } }), me, threads)).toBe(true);
    expect(shouldPush(ev({ body: { text: "general chatter" } }), me, threads)).toBe(false);
    expect(shouldPush(ev({ kind: "ask", body: { to: "@kira" }, author: { handle: "kira", node: me.node, agent: me.agent } }), me, threads)).toBe(false);
  });
});
