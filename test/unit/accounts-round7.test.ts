// ACCOUNTS-2 round 7 (Opus r6 + Codex r6): a test per finding. The real-Codex regressions for the same findings
// are in test/integration/switch-real-codex.test.ts (opt-in lab).
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexPinArgs, pinnedCodexArgv, routingOverride } from "../../src/switch/codex-routing.ts";
import { sanitizeCodexConfig, syncCodexHome } from "../../src/accounts/vault/codex-home.ts";
import { credentialEnv } from "../../src/switch/wrapper.ts";
import { pinnedEnv } from "../../src/switch/claude-settings.ts";
import { CodexWatcher } from "../../src/switch/watch.ts";
import { select, selectOwnFirst, type Candidate } from "../../src/accounts/select.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
function tree(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "walkie-r7-")));
  chmodSync(d, 0o755);
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const P = codexPinArgs();

describe("Opus r6 HIGH 1: profile files are cleaned copies", () => {
  test("every <name>.config.toml (and any other TOML) is a cleaned copy, never a link; a copy of a removed profile goes", () => {
    const d = tree();
    const base = join(d, "codex");
    mkdirSync(join(base, "sessions"), { recursive: true });
    writeFileSync(join(base, "config.toml"), 'model = "x"\n');
    writeFileSync(join(base, "work.config.toml"), 'model_provider = "gw"\nmodel = "gpt-6"\n[model_providers.gw]\nbase_url = "https://collector.example/v1"\n');
    writeFileSync(join(base, "other.toml"), 'chatgpt_base_url = "https://collector.example/"\nx = 1\n');
    const home = join(d, "acct");
    mkdirSync(home, { mode: 0o700 });
    symlinkSync(join(base, "work.config.toml"), join(home, "work.config.toml")); // an older version's link
    syncCodexHome(home, base);
    for (const n of ["work.config.toml", "other.toml"]) expect(lstatSync(join(home, n)).isSymbolicLink()).toBe(false);
    expect(Bun.TOML.parse(readFileSync(join(home, "work.config.toml"), "utf8"))).toEqual({ model: "gpt-6" });
    expect(Bun.TOML.parse(readFileSync(join(home, "other.toml"), "utf8"))).toEqual({ x: 1 });
    rmSync(join(base, "work.config.toml"));
    syncCodexHome(home, base);
    expect(existsSync(join(home, "work.config.toml"))).toBe(false);
  });

  test("a profile file that cannot be cleaned stops the sync (no credentials)", () => {
    const d = tree();
    const base = join(d, "codex");
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "p.config.toml"), "model_providers = {\n evil = {} }\n");
    mkdirSync(join(d, "acct"), { mode: 0o700 });
    expect(() => syncCodexHome(join(d, "acct"), base)).toThrow();
  });
});

describe("Opus r6 HIGH 1 / MED 2: pins after every subcommand (a subcommand's -c list replaces the root one)", () => {
  test("exec, resume, exec resume, login and the bare TUI all carry the pins where Codex reads them", () => {
    expect(pinnedCodexArgv(["exec", "-c", 'model_reasoning_effort="low"', "-p", "work", "task"])).toEqual([...P, "exec", ...P, "-c", 'model_reasoning_effort="low"', "-p", "work", "task", ...P]);
    expect(pinnedCodexArgv(["resume", "-c", "x=1", "-p", "work", "--last"])).toEqual([...P, "resume", ...P, "-c", "x=1", "-p", "work", "--last", ...P]);
    expect(pinnedCodexArgv(["exec", "resume", "--last", "hi"])).toEqual([...P, "exec", ...P, "resume", ...P, "--last", "hi", ...P]);
    expect(pinnedCodexArgv(["login", "status"])).toEqual([...P, "login", ...P, "status", ...P, ...P]); // round 8: every nested subcommand
    expect(pinnedCodexArgv(["-m", "gpt-5", "hello"])).toEqual([...P, "-m", "gpt-5", "hello", ...P]);
    // The caller's own root -c overrides are carried after the subcommand's pins (they would be dropped otherwise).
    expect(pinnedCodexArgv(["-c", "x=1", "exec", "-p", "work", "hi"])).toEqual([...P, "-c", "x=1", "exec", ...P, "-c", "x=1", "-p", "work", "hi", ...P]);
    // A prompt that looks like a subcommand after the first positional is just an argument.
    expect(pinnedCodexArgv(["exec", "resume the work"])).toEqual([...P, "exec", ...P, "resume the work", ...P]);
    expect(pinnedCodexArgv(["--", "exec"])).toEqual([...P, ...P, "--", "exec"]);
  });
});

describe("Codex r6 HIGH 1: voice and thread-store endpoints", () => {
  test("voice is switched off by the pins; its endpoints and --enable are refused; config copies drop them", () => {
    expect(P).toContain("features.realtime_conversation=false");
    expect(routingOverride(["-c", 'experimental_realtime_webrtc_call_base_url="https://c/v1"'])).toBe("experimental_realtime_webrtc_call_base_url");
    expect(routingOverride(["-c", 'experimental_realtime_ws_base_url="wss://c"'])).not.toBeNull();
    expect(routingOverride(["-c", 'experimental_thread_store_endpoint="https://c"'])).not.toBeNull();
    expect(routingOverride(["-c", "features.realtime_conversation=true"])).not.toBeNull();
    expect(routingOverride(["--enable", "realtime_conversation"])).toBe("--enable realtime_conversation");
    expect(routingOverride(["--enable=realtime_conversation"])).toBe("--enable realtime_conversation");
    expect(routingOverride(["--enable", "unified_exec"])).toBeNull();
    const clean = sanitizeCodexConfig('experimental_realtime_webrtc_call_base_url = "https://c"\nexperimental_thread_store_endpoint = "https://c"\n[profiles.p]\nexperimental_realtime_ws_base_url = "wss://c"\nmodel = "m"\n');
    expect(Bun.TOML.parse(clean)).toEqual({ profiles: { p: { model: "m" } } });
  });
});

describe("Opus r6 LOW: more Claude endpoint variables", () => {
  test("stripped from the environment and pinned in --settings", () => {
    const names = ["CLAUDE_REMOTE_TOOLS_BRIDGE_URL", "CLAUDE_RUNNER_API_BASE_URL", "CLAUDE_AI_ORIGIN", "CLAUDE_LOCAL_OAUTH_API_BASE", "CLAUDE_LOCAL_OAUTH_APPS_BASE", "CLAUDE_LOCAL_OAUTH_CONSOLE_BASE"];
    expect(credentialEnv(Object.fromEntries([["PATH", "/bin"], ...names.map((n) => [n, "https://c"])]), false)).toEqual({ PATH: "/bin" });
    const env = pinnedEnv({ allowProxy: false, ca: { file: "", dir: "" } });
    for (const n of names) expect(env[n]).toBe("");
  });
});

describe("Codex r6 MED 2: a composite code-mode script never completes a session", () => {
  test("write_stdin(7) plus another command in one script: the other command's exit code does not end session 7", async () => {
    const d = tree();
    const f = join(d, "rollout-2026-09-26T10-00-00-35a3fc06-a27b-7106-8fd8-f2bb6d700e29.jsonl");
    const since = Date.now();
    const put = (o: number, payload: Record<string, unknown>, type = "response_item") => writeFileSync(f, JSON.stringify({ timestamp: new Date(since + o).toISOString(), type, payload }) + "\n", { flag: "a" });
    put(0, { id: "35a3fc06-a27b-7106-8fd8-f2bb6d700e29", cwd: d, thread_source: "user" }, "session_meta");
    const w = new CodexWatcher({ sessionsDir: d, cwd: d, session: null, since, openRollout: async () => f });
    const cell = (inner: Record<string, unknown>) => [{ type: "input_text", text: "Script completed\nWall time 1.0 seconds\nOutput:\n" }, { type: "input_text", text: JSON.stringify(inner) }];
    put(1, { type: "function_call", name: "exec_command", call_id: "c1", arguments: "{}" });
    put(2, { type: "function_call_output", call_id: "c1", output: JSON.stringify({ chunk_id: "a", session_id: 7, output: "" }) });
    put(3, { type: "custom_tool_call", name: "exec", call_id: "x1", input: 'await tools.write_stdin({session_id:7, chars:""});\ntext(await tools.exec_command({cmd:"true"}));' });
    put(4, { type: "custom_tool_call_output", call_id: "x1", output: cell({ chunk_id: "b", exit_code: 0, output: "" }) });
    expect((await w.refresh(since + 10)).background).toEqual(["exec:7"]);
    // The poll alone, in its own script, reporting the exit: that ends it.
    put(5, { type: "custom_tool_call", name: "exec", call_id: "x2", input: "text(await tools.write_stdin({session_id:7, chars:\"\"}))" });
    put(6, { type: "custom_tool_call_output", call_id: "x2", output: cell({ chunk_id: "c", exit_code: 0, output: "done" }) });
    expect(w.poll(since + 20).background).toEqual([]);
  });
});

describe("Codex r6 MED 4: exclusions are owner-qualified", () => {
  test("excluding a teammate's same-id account never excludes the own one", () => {
    const ID = "c".repeat(24);
    const now = Date.now();
    const usage = { at: now, state: "ok" as const, reason: null, source: "api" as const, until: null, windows: [{ kind: "session" as const, used_pct: 10, resets_at: null, window_s: null, scope: null }] };
    const mine: Candidate = { id: ID, provider: "claude", label: "mine", owner: "kira", own: true, source: "local", usage, leases: 0 };
    const theirs: Candidate = { id: ID, provider: "claude", label: "theirs", owner: "mallory", own: false, source: "peer", node: "n", usage, leases: 0 };
    expect(select([mine], { provider: "claude", now, exclude: [`mallory:${ID}`] }).pick?.label).toBe("mine");
    expect(select([theirs], { provider: "claude", now, exclude: [ID] }).pick?.label).toBe("theirs");
    const out = selectOwnFirst([{ ...mine, usage: { ...usage, windows: [{ ...usage.windows[0] as (typeof usage.windows)[number], used_pct: 100 }] } }, theirs], { provider: "claude", now, exclude: [] });
    expect(out.pick?.label).toBe("theirs");
    expect(out.excluded[0]?.key).toBe(ID);
  });
});
