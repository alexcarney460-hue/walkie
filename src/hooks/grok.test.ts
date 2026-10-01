import { expect, test } from "bun:test";
import { grokUpdate } from "./grok.ts";
import { GROK_EVENTS } from "./grok-events.ts";
import { hookDeliveryKey } from "../protocol/hook-delivery.ts";

const sid = "abc123-4567";
const env = { GROK_SESSION_ID: sid, CLAUDE_CODE_SESSION_ID: "inherited" };
const prev = { injected: [] };
const share = { prompts: false, activity: false };

test("Grok camelCase lifecycle reports one named private agent", () => {
  const fixture = (hook_event_name: string, extra = {}) => JSON.stringify({ hook_event_name, sessionId: sid, cwd: "/fixture", ...extra });
  for (const [event, state] of [["SessionStart", "idle"], ["UserPromptSubmit", "working"], ["PreToolUse", "working"], ["PostToolUse", "working"], ["Stop", "idle"], ["SessionEnd", "offline"]] as const) {
    const update = grokUpdate(fixture(event, { prompt: "private prompt", toolName: "run_terminal_command", toolInput: { command: "private command" } }), env, prev, share, 1000, null);
    expect(update?.body).toMatchObject({ agent: "grok-abc123", state, runtime: "other", runtime_name: "grok", session: sid });
    expect(JSON.stringify(update)).not.toContain("private prompt");
    expect(JSON.stringify(update)).not.toContain("private command");
  }
});

test("Grok one-shot and interrupted turns settle; malformed or anonymous input is ignored", () => {
  expect(grokUpdate(JSON.stringify({ hookEventName: "stop_cancelled", sessionId: sid }), {}, prev, share, 1000, null)?.body.state).toBe("idle");
  expect(grokUpdate(JSON.stringify({ hook_event_name: "StopFailure", sessionId: sid }), {}, prev, share, 1000, null)?.body.state).toBe("idle");
  for (const raw of ["null", "[]", "{", JSON.stringify({ hook_event_name: "Stop", sessionId: "../bad" }), JSON.stringify({ hook_event_name: "Stop" })]) {
    expect(grokUpdate(raw, {}, prev, share, 1000, null)).toBeNull();
  }
});

test("Grok falls back to a recognized camelCase event when snake_case is unrecognized", () => {
  const raw = JSON.stringify({ hook_event_name: "postToolUseFailure", hookEventName: "post_tool_use_failure", sessionId: sid, toolName: "Bash" });
  expect(grokUpdate(raw, env, prev, share, 1000, null)?.body.state).toBe("working");
});

test("a delayed stop from an older turn or a blocked stop cannot idle the active turn", () => {
  const started = grokUpdate(JSON.stringify({ hook_event_name: "UserPromptSubmit", sessionId: sid, promptId: "new" }), env, prev, share, 1000, null);
  expect(started?.next.grok_turn_id).toBe("new");
  expect(grokUpdate(JSON.stringify({ hook_event_name: "Stop", sessionId: sid, promptId: "old" }), env, started!.next, share, 1001, null)).toBeNull();
  expect(grokUpdate(JSON.stringify({ hook_event_name: "Stop", sessionId: sid, promptId: "new", stopHookActive: true }), env, started!.next, share, 1002, null)).toBeNull();
  expect(grokUpdate(JSON.stringify({ hook_event_name: "Stop", sessionId: sid, promptId: "new" }), env, started!.next, share, 1003, null)?.body.state).toBe("idle");
  expect(grokUpdate(JSON.stringify({ hook_event_name: "Stop", sessionId: sid, subagentType: "explore" }), env, started!.next, share, 1004, null)).toBeNull();
});

test("each hook path reports only the events it owns", () => {
  for (const e of GROK_EVENTS) {
    const raw = JSON.stringify({ hook_event_name: e.name, sessionId: sid, toolName: "Bash", notificationType: "idle_prompt" });
    const other = e.path === "claude" ? "native" : "claude";
    expect(grokUpdate(raw, env, prev, share, 1000, e.path), `${e.name} on its own path`).not.toBeNull();
    expect(grokUpdate(raw, env, prev, share, 1000, other), `${e.name} on the other path`).toBeNull();
  }
});

test("one payload reaches exactly one path, whichever field names its event", () => {
  const raws = [
    JSON.stringify({ hook_event_name: "unknown", hookEventName: "stop", sessionId: sid }),
    JSON.stringify({ hookEventName: "stop_cancelled", sessionId: sid }),
    JSON.stringify({ hook_event_name: "PostToolUseFailure", sessionId: sid, toolName: "Bash" }),
    JSON.stringify({ hookEventName: "pre_tool_use", hook_event_name: "PreToolUse", sessionId: sid, toolName: "spawn_subagent" }),
  ];
  for (const raw of raws) {
    const reported = (["claude", "native"] as const).filter((path) => grokUpdate(raw, env, prev, share, 1000, path));
    expect(reported).toHaveLength(1);
  }
});

test("an update carries the identity of its delivery, the same from either path", () => {
  const event = { hook_event_name: "PostToolUse", hookEventName: "post_tool_use", sessionId: sid, toolName: "Bash", toolUseId: "t1", promptId: "p1", timestamp: "2026-10-01T00:00:01Z" };
  const identity = { session: sid, event: "PostToolUse", at: "2026-10-01T00:00:01Z", call: "t1", turn: "p1" };
  expect(grokUpdate(JSON.stringify(event), env, prev, share, 1000, null)?.delivery).toEqual(identity);
  expect(grokUpdate(JSON.stringify(event), env, prev, share, 5000, "claude")?.delivery).toEqual(identity);
  // The same Grok event reaching the native handler under its Grok-only name keeps its own identity.
  const failure = { ...event, hook_event_name: "PostToolUseFailure", hookEventName: "post_tool_use_failure" };
  expect(grokUpdate(JSON.stringify(failure), env, prev, share, 1000, "native")?.delivery).toEqual({ ...identity, event: "PostToolUseFailure" });
});

test("a notification's identity carries its type, so two notifications of one second are told apart", () => {
  const at = "2026-10-01T00:00:05Z";
  const note = (notificationType: string | undefined, message = "m") => JSON.stringify({ hook_event_name: "Notification", hookEventName: "notification", sessionId: sid, cwd: "/fixture", timestamp: at, ...(notificationType ? { notificationType } : {}), message });
  const permission = grokUpdate(note("permission_prompt"), env, prev, share, 1000, "claude");
  const idle = grokUpdate(note("idle_prompt"), env, prev, share, 1000, "claude");
  expect([permission?.body.state, idle?.body.state]).toEqual(["waiting", "idle"]);
  expect(permission?.delivery).toEqual({ session: sid, event: "Notification", at, kind: "permission_prompt" });
  expect(idle?.delivery).toEqual({ session: sid, event: "Notification", at, kind: "idle_prompt" });
  expect(hookDeliveryKey("grok-abc123", permission!.delivery!)).not.toBe(hookDeliveryKey("grok-abc123", idle!.delivery!));
  // The same notification reached through either path is still one delivery.
  expect(grokUpdate(note("idle_prompt"), env, prev, share, 9000, null)?.delivery).toEqual(idle?.delivery);
  // No type (Walkie then reads the message), no kind: the identity is what it was.
  expect(grokUpdate(note(undefined, "waiting for input"), env, prev, share, 1000, "claude")?.delivery).toEqual({ session: sid, event: "Notification", at });
  // Only a notification has one.
  const stop = JSON.stringify({ hook_event_name: "Stop", sessionId: sid, timestamp: at, notificationType: "idle_prompt" });
  expect(grokUpdate(stop, env, prev, share, 1000, "claude")?.delivery).toEqual({ session: sid, event: "Stop", at });
});

test("an event with no timestamp, or a malformed one, is still reported, without an identity", () => {
  const base = { hook_event_name: "Stop", sessionId: sid };
  expect(grokUpdate(JSON.stringify(base), env, prev, share, 1000, null)?.delivery).toBeUndefined();
  for (const timestamp of [12345, null, { at: 1 }, "x".repeat(65)]) {
    const update = grokUpdate(JSON.stringify({ ...base, timestamp }), env, prev, share, 1000, null);
    expect(update?.body.state).toBe("idle");
    expect(update?.delivery).toBeUndefined();
  }
});
