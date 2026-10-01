import { expect, test } from "bun:test";
import { GROK_EVENTS, GROK_NATIVE_EVENTS, grokEvent, isGrokHook } from "./grok-events.ts";
import { withClaudeHooks } from "./install.ts";
import { withGrokHooks } from "./install-grok.ts";

test("every Grok event Walkie reports belongs to exactly one delivery path", () => {
  const names = GROK_EVENTS.map((e) => e.name);
  expect(new Set(names).size).toBe(names.length);
  expect(new Set(GROK_EVENTS.map((e) => e.snake)).size).toBe(names.length);
  for (const e of GROK_EVENTS) expect(["claude", "native"]).toContain(e.path);
  expect(GROK_NATIVE_EVENTS).toEqual(GROK_EVENTS.filter((e) => e.path === "native").map((e) => e.name));
});

test("the native hook file registers exactly the events the Claude-compatible path does not own", () => {
  const registered = Object.keys(withGrokHooks({}, "walkie", true).hooks ?? {}).sort();
  expect(registered).toEqual([...GROK_NATIVE_EVENTS].sort());
  for (const name of registered) expect(GROK_EVENTS.find((e) => e.name === name)?.path).toBe("native");
});

test("the Claude install registers every Claude-owned event, and a native-owned one only for Agent/Task launches (where that handler stands down)", () => {
  const claude = withClaudeHooks({}, "walkie", true).hooks ?? {};
  for (const e of GROK_EVENTS) {
    const entries = claude[e.name] ?? [];
    if (e.path === "claude") {
      expect(entries.length).toBeGreaterThan(0);
      if (e.name === "PostToolUse") expect(entries.some((entry) => !entry.matcher || entry.matcher === "*")).toBe(true);
    } else {
      // Grok-only events never reach Claude's file; PreToolUse reaches it for the launch tools alone, never for Bash.
      for (const entry of entries) expect(entry.matcher).toBe("Agent|Task");
    }
  }
});

test("one resolver names the event for both paths: Grok's PascalCase and snake_case names, the second field as fallback", () => {
  expect(grokEvent({ hook_event_name: "StopFailure" })?.name).toBe("StopFailure");
  expect(grokEvent({ hookEventName: "stop_cancelled" })?.name).toBe("StopCancelled");
  expect(grokEvent({ hook_event_name: "unknown", hookEventName: "stop" })?.name).toBe("Stop");
  expect(grokEvent({ hook_event_name: "postToolUseFailure", hookEventName: "post_tool_use_failure" })?.walkie).toBe("PostToolUse");
  for (const name of ["", "SubagentStart", "PermissionDenied", "__proto__", "constructor", "toString"]) {
    expect(grokEvent({ hook_event_name: name })).toBeUndefined();
  }
  expect(grokEvent({})).toBeUndefined();
});

test("a hook process is Grok's only when Grok's hook runner started it: GROK_HOOK_EVENT, never an inherited GROK_SESSION_ID", () => {
  expect(isGrokHook({ GROK_HOOK_EVENT: "stop" })).toBe(true);
  expect(isGrokHook({ GROK_HOOK_EVENT: "stop", GROK_SESSION_ID: "abc123-4567", CLAUDE_CODE_SESSION_ID: "5e55a1b2-0000-4000-8000-000000000000" })).toBe(true);
  // A Claude Code started from a Grok tool shell inherits GROK_SESSION_ID; its hooks are Claude Code's.
  expect(isGrokHook({ GROK_SESSION_ID: "abc123-4567" })).toBe(false);
  expect(isGrokHook({ GROK_SESSION_ID: "abc123-4567", CLAUDE_CODE_SESSION_ID: "5e55a1b2-0000-4000-8000-000000000000" })).toBe(false);
  expect(isGrokHook({ CLAUDE_CODE_SESSION_ID: "5e55a1b2-0000-4000-8000-000000000000" })).toBe(false);
  expect(isGrokHook({ GROK_HOOK_EVENT: "" })).toBe(false);
  expect(isGrokHook({})).toBe(false);
});
