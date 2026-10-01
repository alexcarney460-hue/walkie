import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../daemon/store.ts";
import { applyHermesStatus } from "../daemon/hermes-status.ts";
import { hermesObservation, hermesUpdate, recordHermesUpdate, runHermesHook } from "./hermes.ts";

const base = { session_id: "sess_abc123", profile: "default", cwd: "/fixture/project" };
const raw = (event: string, extra: Record<string, unknown> = {}) => JSON.stringify({ ...base, hook_event_name: event, ...extra });

test("Hermes lifecycle fixture maps to view-only status and runtime", () => {
  for (const [event, state] of [["on_session_start", "idle"], ["pre_llm_call", "working"],
    ["pre_tool_call", "working"], ["post_tool_call", "working"], ["post_llm_call", "idle"],
    ["on_session_end", "idle"], ["on_session_finalize", "offline"]] as const) {
    expect(hermesUpdate(raw(event))?.body).toMatchObject({ agent: "hermes-default", runtime: "other", runtime_name: "hermes", state });
  }
});

test("Hermes observation uses event ordering and hashes the session", () => {
  const event = hermesObservation(raw("post_llm_call", { timestamp: "2026-09-30T00:00:00.000Z", event_sequence: 20 }));
  expect(event).toMatchObject({ profile: "default", at: Date.parse("2026-09-30T00:00:00.000Z"),
    sequence: 20, state: "idle", fallback: "idle" });
  expect(event?.session).toBe(createHash("sha256").update(base.session_id).digest("hex"));
});

test("Hermes observation carries a valid process id when supplied", () => {
  expect(hermesObservation(raw("pre_llm_call", { pid: 202 }))?.pid).toBe(202);
  expect(hermesObservation(raw("pre_llm_call"))).not.toHaveProperty("pid");
});

test("a malformed process id is ignored and the rest of the observation is kept", () => {
  const tool = { tool_name: "terminal", event_sequence: 7, timestamp: 1_700_000_000_000 };
  const control = hermesObservation(raw("pre_tool_call", tool));
  expect(control).toMatchObject({ profile: "default", state: "working", fallback: "working", sequence: 7, at: 1_700_000_000_000 });
  for (const pid of ["123", null, 0, -5, 1.5, true, [1], {}, 1e20, Number.MAX_SAFE_INTEGER + 2]) {
    const event = hermesObservation(raw("pre_tool_call", { ...tool, pid }));
    expect([pid, event]).toEqual([pid, control]);
    expect(event).not.toHaveProperty("pid");
    expect(hermesUpdate(raw("pre_tool_call", { ...tool, pid }))?.body).toMatchObject({ agent: "hermes-default", state: "working" });
  }
});

// ---- privacy by default: a profile shows its state only, unless config.json lists it in hermes_activity_profiles ------------------------
const EVERYTHING = { prompts: true, activity: true, paths: true };
const STATE_EVENTS = ["on_session_start", "pre_llm_call", "pre_tool_call", "post_tool_call", "post_llm_call", "on_session_end", "on_session_finalize"];

test("by default every profile shows its state only, whatever it is called and whatever the share policy says", () => {
  // names that look like money or customer profiles get no special treatment: nobody is listed, so nobody shows activity
  for (const profile of ["example-billing", "payroll", "customer-support", "finance-ops", "default", "social-assistant"]) {
    for (const event of STATE_EVENTS) {
      const payload = raw(event, { profile, tool_name: "terminal", tool_input: { command: "SECRET_COMMAND" }, extra: { user_message: "SECRET_PROMPT" } });
      const update = hermesUpdate(payload, [], EVERYTHING);
      expect([profile, event, update?.body.activity, update?.provenance]).toEqual([profile, event, undefined, {}]);
      const observation = hermesObservation(payload, [], EVERYTHING);
      expect([profile, event, observation?.activity, observation?.source]).toEqual([profile, event, undefined, undefined]);
      expect(JSON.stringify([update, observation])).not.toMatch(/SECRET_COMMAND|SECRET_PROMPT|terminal/);
    }
    expect(hermesUpdate(raw("pre_tool_call", { profile, tool_name: "terminal" }), [], EVERYTHING)?.body)
      .toEqual({ agent: `hermes-${profile}`, state: "working", runtime: "other", runtime_name: "hermes" });
  }
});

test("a listed profile shows activity, a tool's name only with share_activity, and no other profile does", () => {
  const payload = (profile: string, event = "pre_tool_call") => raw(event, { profile, tool_name: "search", tool_input: { q: "SECRET_QUERY" }, extra: { user_message: "SECRET_PROMPT" } });
  const listed = ["social-assistant"];
  expect(hermesUpdate(payload("social-assistant"), listed, EVERYTHING)).toEqual({
    body: { agent: "hermes-social-assistant", state: "working", runtime: "other", runtime_name: "hermes", activity: "Using search" }, provenance: { activity: "tool" } });
  expect(hermesObservation(payload("social-assistant"), listed, EVERYTHING)).toMatchObject({ profile: "social-assistant", activity: "Using search", source: "tool" });
  // without share_activity the same profile shows a fixed phrase, never the tool's name
  expect(hermesUpdate(payload("social-assistant"), listed, { prompts: false, activity: false })?.body.activity).toBe("Using a tool");
  expect(hermesUpdate(payload("social-assistant", "pre_llm_call"), listed, { prompts: false, activity: false })?.body.activity).toBe("Thinking");
  expect(hermesUpdate(payload("social-assistant", "post_llm_call"), listed, { prompts: false, activity: false })?.body.activity).toBe("Finished turn");
  // a profile that is not listed stays state only while another is
  expect(hermesUpdate(payload("example-billing"), listed, EVERYTHING)?.body).toEqual({ agent: "hermes-example-billing", state: "working", runtime: "other", runtime_name: "hermes" });
  expect(hermesObservation(payload("example-billing"), listed, EVERYTHING)).not.toHaveProperty("activity");
  // neither side ever carries tool input or prompts
  expect(JSON.stringify([hermesUpdate(payload("social-assistant"), listed, EVERYTHING), hermesObservation(payload("social-assistant"), listed, EVERYTHING)]))
    .not.toMatch(/SECRET_QUERY|SECRET_PROMPT/);
});

/**
 * The body the real hook entry (`walkie hook hermes`) posts for a pre_tool_call of `profile`, in a throwaway Walkie home holding this
 * config.json (or none). A fake daemon on that home's unix socket records it, so nothing here can reach a real daemon.
 */
async function postedBy(config: string | null, profile: string): Promise<Record<string, unknown> | null> {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-hook-config-"));
  const sock = join(root, "walkie.sock");
  const saved = { home: process.env.WALKIE_HOME, socket: process.env.WALKIE_SOCKET };
  const bodies: Array<Record<string, unknown>> = [];
  const server = Bun.serve({ unix: sock, fetch: async (req: Request) => {
    bodies.push(await req.json() as Record<string, unknown>);
    return Response.json({ event: null }, { status: 202 });
  } } as unknown as Parameters<typeof Bun.serve>[0]);
  try {
    if (config !== null) writeFileSync(join(root, "config.json"), config);
    process.env.WALKIE_HOME = root;
    process.env.WALKIE_SOCKET = sock;
    await runHermesHook(raw("pre_tool_call", { profile, tool_name: "terminal", event_sequence: 3 }));
    return bodies[0] ?? null;
  } finally {
    await server.stop(true);
    for (const [name, value] of [["WALKIE_HOME", saved.home], ["WALKIE_SOCKET", saved.socket]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("the hook reads the allow list from config.json on every call: a listed profile shows activity, no other does", async () => {
  const both = JSON.stringify({ share_activity: true, hermes_activity_profiles: ["example-research", "example-writer"] });
  expect(await postedBy(both, "example-research")).toMatchObject({ profile: "example-research", state: "working", activity: "Using terminal", source: "tool" });
  expect(await postedBy(both, "example-writer")).toMatchObject({ activity: "Using terminal" });
  const state = await postedBy(both, "example-billing");
  expect(state).toMatchObject({ profile: "example-billing", state: "working" });
  expect(state).not.toHaveProperty("activity");
  expect(state).not.toHaveProperty("source");
  // the share policy still decides the wording: a listed profile shows a fixed phrase, never the tool's name, without share_activity
  expect(await postedBy(JSON.stringify({ hermes_activity_profiles: ["example-research"] }), "example-research")).toMatchObject({ activity: "Using a tool", source: "phrase" });
});

test("a missing or damaged allow list shows no activity at all (fail private)", async () => {
  const damaged = [null, "", "{", "[]", "null", "{}", JSON.stringify({ hermes_activity_profiles: [] }),
    JSON.stringify({ share_activity: true, hermes_activity_profiles: "example-research" }),
    JSON.stringify({ share_activity: true, hermes_activity_profiles: [42] }),
    JSON.stringify({ share_activity: true, hermes_activity_profiles: ["Example-Research"] }), // not a name Walkie carries
    JSON.stringify({ share_activity: true, hermes_activity_profiles: ["example-research", "../invalid"] }), // one bad entry voids the list
    JSON.stringify({ share_activity: true, hermes_activity_profiles: ["example-research", ...Array.from({ length: 64 }, (_, i) => `p${i}`)] }), // over the bound
    JSON.stringify({ share_activity: true, hermes_activity_profiles: { 0: "example-research" } })];
  for (const config of damaged) {
    const body = await postedBy(config, "example-research");
    expect([config, body === null ? "no post" : "posted"]).toEqual([config, "posted"]); // the state is still reported
    expect([config, body]).toEqual([config, expect.not.objectContaining({ activity: expect.anything() })]);
  }
});

test("invalid payloads and ordering fields are rejected", () => {
  for (const input of ["{", "null", raw("pre_llm_call", { profile: "../billing" }),
    raw("pre_llm_call", { session_id: "" }), raw("pre_tool_call", { tool_name: "secret <script>" }),
    raw("pre_llm_call", { event_sequence: -1 }), raw("pre_llm_call", { timestamp: "bad" }),
    raw("unknown"), "x".repeat(128 * 1024 + 1)]) expect(hermesObservation(input)).toBeNull();
});

test("each invocation publishes directly and leaves no local state after a failed publish", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-crash-"));
  const calls: string[] = [];
  try {
    const first = recordHermesUpdate(raw("pre_llm_call", { event_sequence: 1 }), [], { prompts: false, activity: false },
      async (event) => { calls.push(event.state); throw new Error("simulated crash"); });
    await expect(first).rejects.toThrow("simulated crash");
    await recordHermesUpdate(raw("post_llm_call", { event_sequence: 2 }), [], { prompts: false, activity: false },
      async (event) => { calls.push(event.state); });
    expect(calls).toEqual(["working", "idle"]);
    expect(readdirSync(root)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("hook publication returns before its deadline with a delayed provider", async () => {
  const start = Date.now();
  await recordHermesUpdate(raw("pre_llm_call"), [], { prompts: false, activity: false },
    async () => { await Bun.sleep(100); }, 20);
  expect(Date.now() - start).toBeLessThan(90);
});

test("21 out-of-order hooks finish within the installed deadline and leave the final idle state", async () => {
  const root = mkdtempSync(join(tmpdir(), "walkie-hermes-hook-burst-"));
  const store = new Store(join(root, "test.db"));
  try {
    const started = Date.now();
    const at = started;
    const results = await Promise.all(Array.from({ length: 21 }, (_, sequence) =>
      recordHermesUpdate(raw(sequence === 20 ? "post_llm_call" : "pre_llm_call", { timestamp: at, event_sequence: sequence }),
        [], { prompts: false, activity: false }, async (event) => {
          await Bun.sleep((20 - sequence) * 3); // Inject arrival disorder without consuming CPU.
          applyHermesStatus(store, event, at);
        })));
    expect(results).toHaveLength(21);
    expect(Date.now() - started).toBeLessThan(500);
    expect(applyHermesStatus(store, results[0]!, at).body.state).toBe("idle");
  } finally { store.db.close(); rmSync(root, { recursive: true, force: true }); }
});

