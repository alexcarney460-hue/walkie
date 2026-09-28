import { expect, test } from "bun:test";
import { withKimiHooks, KIMI_EVENTS } from "../../src/hooks/install-kimi.ts";
import { kimiUpdate } from "../../src/hooks/kimi.ts";

const sid = "session_5eed0001-1111-4222-8333-944455556666";
const share = { prompts: false, activity: false };
test("Kimi installer preserves existing hooks/settings, is idempotent and reversible", () => {
  const src = '# my settings\nmodel = "fixture"\n[[hooks]]\nevent = "Stop"\ncommand = "echo custom"\ntimeout = 7\n[services.example]\nenabled = true\n';
  const next = withKimiHooks(src, "'/path with space/walkie'", true);
  expect((Bun.TOML.parse(next) as { hooks: unknown[] }).hooks).toHaveLength(KIMI_EVENTS.length + 1);
  expect(withKimiHooks(next, "'/path with space/walkie'", true)).toBe(next);
  expect(withKimiHooks(next, "'/path with space/walkie'", false)).toBe(src);
  expect(next).toContain('hook kimi');
});
test("Kimi installer refuses malformed/ambiguous TOML without echoing values", () => {
  expect(() => withKimiHooks('secret = "sensitive\n', "walkie", true)).toThrow("Kimi config is not valid TOML");
  expect(() => withKimiHooks('hooks = [{event="Stop",command="keep"}]\n', "walkie", true)).toThrow();
});
test("Kimi schema snake-case input produces private working status with runtime-specific identity", () => {
  const update = kimiUpdate(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sid, cwd: "/fixture/project", prompt: "SECRET_PROMPT" }),
    { CLAUDE_CODE_SESSION_ID: "inherited", CODEX_THREAD_ID: "inherited" }, { injected: [] }, share, 1000);
  expect(update?.body).toMatchObject({ agent: "kimi-5eed00", runtime: "kimi", state: "working", session: sid.slice(8), title: "Working on a task" });
  expect(JSON.stringify(update)).not.toContain("SECRET_PROMPT");
});
test("Kimi events include lifecycle and attention; invalid input is ignored", () => {
  for (const [event, state] of [["SessionStart", "idle"], ["Stop", "idle"], ["SessionEnd", "offline"], ["PermissionRequest", "waiting"], ["PostToolUse", "working"]] as const) {
    expect(kimiUpdate(JSON.stringify({ hook_event_name: event, session_id: sid, tool_name: "ReadFile" }), {}, { injected: [] }, share, 1000)?.body.state).toBe(state);
  }
  for (const raw of ["null", "[]", "{", '{"hook_event_name":"Stop","session_id":"../../secret"}']) expect(kimiUpdate(raw, {}, { injected: [] }, share, 1000)).toBeNull();
});
