// ACCOUNTS-2: reading and rewriting Claude Code / Codex command lines (subcommands pass through, the prompt is found
// past value / optional / variadic options, relaunches resume the same session with the same options).
import { describe, expect, test } from "bun:test";
import { claudeArgv, codexArgv, parseClaude, parseCodex } from "../../src/switch/args.ts";

const SID = "3f9a2b7c-1111-4222-8333-944455556666";

describe("claude", () => {
  test("subcommands, --help and --version pass straight through; -p is headless", () => {
    expect(parseClaude(["mcp", "list"]).mode).toBe("passthrough");
    expect(parseClaude(["setup-token"]).mode).toBe("passthrough");
    expect(parseClaude(["--version"]).mode).toBe("passthrough");
    expect(parseClaude(["-p", "hello"]).mode).toBe("headless");
    expect(parseClaude([]).mode).toBe("interactive");
    // A prompt that happens to be a subcommand word, after an option, is a prompt.
    expect(parseClaude(["--model", "opus", "update the docs"]).prompt).toBe("update the docs");
  });

  test("finds the prompt past value, optional-value and variadic options", () => {
    const p = parseClaude(["--model", "opus", "--add-dir", "a", "b", "--permission-mode", "plan", "--verbose", "fix it"]);
    expect(p.prompt).toBe("fix it");
    expect(p.model).toBe("opus");
    expect(p.kept).toEqual(["--model", "opus", "--add-dir", "a", "b", "--permission-mode", "plan", "--verbose"]);
    expect(parseClaude(["--model=sonnet", "hi"]).model).toBe("sonnet");
    expect(parseClaude(["--debug", "api", "hi"]).prompt).toBe("hi"); // --debug [filter] took "api"
    expect(parseClaude(["--settings", "{}", "x"]).settings).toBe(true);
  });

  test("session options: --resume <id>, --session-id, -c, -r picker, --fork-session", () => {
    expect(parseClaude(["--resume", SID]).session).toBe(SID);
    expect(parseClaude(["--session-id", SID]).session).toBe(SID);
    expect(parseClaude(["-c"]).sessionFromRun).toBe(true);
    expect(parseClaude(["-r"]).sessionFromRun).toBe(true);
    expect(parseClaude(["-r", "search words"]).sessionFromRun).toBe(true);
    expect(parseClaude(["--resume", SID, "--fork-session"]).fork).toBe(true);
    expect(parseClaude(["-r", SID, "--model", "opus"]).kept).toEqual(["--model", "opus"]);
  });

  test("first launch: the command line as given, a new session pinned to a known id", () => {
    const p = parseClaude(["--model", "opus", "hello"]);
    expect(claudeArgv(p, { session: SID, relaunch: false, prompt: null })).toEqual(["--session-id", SID, "--model", "opus", "hello"]);
    const r = parseClaude(["--resume", SID, "--model", "opus"]);
    expect(claudeArgv(r, { session: SID, relaunch: false, prompt: null })).toEqual(["--resume", SID, "--model", "opus"]);
  });

  test("relaunch: same options, --resume <id>, the continuation prompt last; fresh = a new session id", () => {
    // (After a variadic option Claude itself would read "hello" as another directory, and so does the parser.)
    expect(parseClaude(["--add-dir", "x", "hello"]).prompt).toBeNull();
    const p = parseClaude(["--model", "opus", "hello", "--add-dir", "x"]);
    expect(claudeArgv(p, { session: SID, relaunch: true, prompt: null })).toEqual(["--model", "opus", "--add-dir", "x", "--resume", SID]);
    expect(claudeArgv(p, { session: SID, relaunch: true, prompt: "go on" })).toEqual(["--model", "opus", "--add-dir", "x", "--resume", SID, "go on"]);
    expect(claudeArgv(p, { session: SID, relaunch: true, prompt: "summary", fresh: true })).toEqual(["--model", "opus", "--add-dir", "x", "--session-id", SID, "summary"]);
    // A worktree session relaunches in place, never creating another worktree.
    const w = parseClaude(["-w", "feat", "hi"]);
    expect(claudeArgv(w, { session: SID, relaunch: true, prompt: null })).toEqual(["--resume", SID]);
  });
});

describe("codex", () => {
  test("login and other subcommands pass through untouched; exec is headless", () => {
    expect(parseCodex(["login"]).mode).toBe("passthrough");
    expect(parseCodex(["mcp", "list"]).mode).toBe("passthrough");
    expect(parseCodex(["exec", "do it"]).mode).toBe("headless");
    expect(parseCodex(["-m", "gpt-5", "fix"]).mode).toBe("interactive");
  });

  test("resume forms and the relaunch argv", () => {
    const r = parseCodex(["resume", "-m", "gpt-5", SID, "keep going"]);
    expect(r.session).toBe(SID);
    expect(r.prompt).toBe("keep going");
    expect(parseCodex(["resume", "--last"]).sessionFromRun).toBe(true);
    const n = parseCodex(["-m", "gpt-5", "-c", "a=1", "build it"]);
    expect(n.prompt).toBe("build it");
    expect(codexArgv(n, { session: null, relaunch: false, prompt: null })).toEqual(["-m", "gpt-5", "-c", "a=1", "build it"]);
    expect(codexArgv(n, { session: SID, relaunch: true, prompt: null })).toEqual(["resume", "-m", "gpt-5", "-c", "a=1", "--", SID]);
    expect(codexArgv(n, { session: SID, relaunch: true, prompt: "go" })).toEqual(["resume", "-m", "gpt-5", "-c", "a=1", "--", SID, "go"]);
    expect(codexArgv(n, { session: null, relaunch: true, prompt: "summary", fresh: true })).toEqual(["-m", "gpt-5", "-c", "a=1", "--", "summary"]);
    expect(codexArgv(n, { session: null, relaunch: true, prompt: null, fresh: true })).toEqual(["-m", "gpt-5", "-c", "a=1"]);
  });
});
