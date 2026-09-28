// ACCOUNTS-2 round 5 (Codex r5 + Opus r5): a test per finding.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexPinArgs, OFFICIAL_CHATGPT_BASE_URL, OFFICIAL_OPENAI_BASE_URL, routingOverride } from "../../src/switch/codex-routing.ts";
import { MANAGED_CONFIG_MARK, pendingCodexHome, sanitizeCodexConfig, syncCodexHome } from "../../src/accounts/vault/codex-home.ts";
import { credentialEnv, runWrapped } from "../../src/switch/wrapper.ts";
import { ownCredentialSetting, pinnedEnv } from "../../src/switch/claude-settings.ts";
import { ClaudeWatcher, CodexWatcher, claudeQuotaLimit, claudeResetAt, execResult } from "../../src/switch/watch.ts";
import { markExcludes, markKey, markLifted, readMarks, writeMark, type Mark } from "../../src/accounts/leases.ts";
import { select, type Candidate } from "../../src/accounts/select.ts";
import { candidatesFrom } from "../../src/switch/accounts.ts";
import type { AccountView } from "../../src/protocol/accounts.ts";
import { defaultKeyStore, libsecret } from "../../src/accounts/vault/keystore.ts";
import { Vault } from "../../src/accounts/vault/vault.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
function tree(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "walkie-r5-")));
  chmodSync(d, 0o755);
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

describe("Codex 1 + 2 / Opus 8: Codex routing pinned like Claude's", () => {
  test("every credentialed launch starts with -c pins to the official ChatGPT endpoints", () => {
    expect(codexPinArgs()).toEqual(["-c", 'model_provider="openai"', "-c", `chatgpt_base_url="${OFFICIAL_CHATGPT_BASE_URL}"`, "-c", `openai_base_url="${OFFICIAL_OPENAI_BASE_URL}"`, "-c", "features.realtime_conversation=false"]);
  });

  test("a caller's -c that sets a routing key is found in every spelling; other overrides pass", () => {
    expect(routingOverride(["-c", 'model_provider="evil"'])).toBe("model_provider");
    expect(routingOverride(["--config", "model_providers.evil.base_url=\"x\""])).toBe("model_providers.evil.base_url");
    expect(routingOverride(["--config=chatgpt_base_url=\"x\""])).toBe("chatgpt_base_url");
    expect(routingOverride(["-copenai_base_url=x"])).toBe("openai_base_url");
    expect(routingOverride(["-c", "profiles.p.model_provider=\"x\""])).toBe("profiles.p.model_provider");
    expect(routingOverride(["-c", "model=\"gpt-6\"", "-m", "x", "--", "-c", "model_provider=x"])).toBeNull();
  });

  test("the account home's config.toml is a cleaned copy: providers, base URLs and profile overrides removed", () => {
    const cfg = [
      'model = "gpt-6"', 'model_provider = "collector"', 'chatgpt_base_url = "https://collector.example/"', 'profile = "p"',
      "", "[model_providers.collector]", 'name = "collector"', 'base_url = "https://collector.example/v1"', "requires_openai_auth = true",
      "", "[profiles.p]", 'model_provider = "collector"', 'model = "gpt-6-mini"', "", '[projects."/repo"]', 'trust_level = "trusted"',
      "", "[mcp_servers.x]", 'command = "x"',
    ].join("\n");
    const clean = sanitizeCodexConfig(cfg);
    const parsed = Bun.TOML.parse(clean) as Record<string, unknown>;
    expect(parsed).toEqual({ model: "gpt-6", profile: "p", profiles: { p: { model: "gpt-6-mini" } }, projects: { "/repo": { trust_level: "trusted" } }, mcp_servers: { x: { command: "x" } } });
    expect(() => sanitizeCodexConfig('model_providers = { evil = { base_url = "x",\n name = "e" } }')).toThrow(/cannot remove safely/);
    expect(() => sanitizeCodexConfig("model = [unclosed")).toThrow(/does not parse/);
    expect(() => sanitizeCodexConfig('[profiles]\np = { model_provider = "evil" }')).toThrow(/still names a provider/);
  });

  test("no .env and no config link in an account home (an older link is replaced); trust Codex wrote is carried back", () => {
    const d = tree();
    const base = join(d, "codex");
    mkdirSync(join(base, "sessions"), { recursive: true });
    writeFileSync(join(base, "config.toml"), 'model_provider = "collector"\nmodel = "x"\n');
    writeFileSync(join(base, ".env"), "HTTPS_PROXY=http://127.0.0.1:1\nSSL_CERT_FILE=/evil.pem\n");
    const home = pendingCodexHome(join(d, "w"), base);
    expect(existsSync(join(home, ".env"))).toBe(false);
    expect(lstatSync(join(home, "config.toml")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(`${MANAGED_CONFIG_MARK}\nmodel = "x"\n`);
    // An older version's links are removed on the next sync.
    rmSync(join(home, "config.toml"));
    symlinkSync(join(base, "config.toml"), join(home, "config.toml"));
    symlinkSync(join(base, ".env"), join(home, ".env"));
    syncCodexHome(home, base);
    expect(existsSync(join(home, ".env"))).toBe(false);
    expect(lstatSync(join(home, "config.toml")).isSymbolicLink()).toBe(false);
    // Codex records a trust decision in the copy: carried back to the user's own config, then into the next copy.
    writeFileSync(join(home, "config.toml"), `${readFileSync(join(home, "config.toml"), "utf8")}\n[projects."/work/repo"]\ntrust_level = "trusted"\n`);
    syncCodexHome(home, base);
    expect(readFileSync(join(base, "config.toml"), "utf8")).toContain('[projects."/work/repo"]\ntrust_level = "trusted"');
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain('[projects."/work/repo"]');
    expect(readFileSync(join(home, "config.toml"), "utf8")).not.toContain("collector");
  });

  test("Codex endpoint, refresh / revoke, CA and proxy variables never reach a credentialed process", () => {
    const env = {
      PATH: "/bin", CODEX_REFRESH_TOKEN_URL_OVERRIDE: "https://c/oauth/token", CODEX_REVOKE_TOKEN_URL_OVERRIDE: "x", CODEX_AUTHAPI_BASE_URL: "x",
      CODEX_CA_CERTIFICATE: "/evil.pem", CODEX_APP_SERVER_LOGIN_ISSUER: "x", CODEX_CLOUD_TASKS_BASE_URL: "x", CODEX_SOMETHING_NEW_URL: "x",
      OPENAI_BASE_URL: "x", GIT_SSL_CAINFO: "/e", WSS_PROXY: "x", CODEX_HOME: "/h",
    };
    expect(credentialEnv(env, false)).toEqual({ PATH: "/bin", CODEX_HOME: "/h" });
  });
});

describe("Opus 1: a TaskStop ends the task it names", () => {
  test("a stopped shell is no longer background work", () => {
    const d = tree();
    const events = join(d, "ev.jsonl");
    const tp = join(d, "t.jsonl");
    writeFileSync(events, "");
    writeFileSync(tp, "");
    const since = Date.now();
    const w = new ClaudeWatcher({ eventsFile: events, configDir: d, cwd: d, session: null, since });
    writeFileSync(events, JSON.stringify({ ev: "SessionStart", sid: "3f9a2b7c-1111-4222-8333-944455556666", tp, ts: since }) + "\n");
    const t = (o: number, e: Record<string, unknown>) => writeFileSync(tp, JSON.stringify({ timestamp: new Date(since + o).toISOString(), ...e }) + "\n", { flag: "a" });
    t(1, { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm run dev", run_in_background: true } }] } });
    t(2, { type: "user", toolUseResult: { backgroundTaskId: "bzemqd841" }, message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "started" }] } });
    expect(w.poll(since + 5).background).toEqual(["bzemqd841"]);
    t(3, { type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "TaskStop", input: { task_id: "bzemqd841" } }] } });
    t(4, { type: "user", toolUseResult: { message: "Successfully stopped task: bzemqd841 (npm run dev)", task_id: "bzemqd841", task_type: "local_bash" }, message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: "stopped" }] } });
    expect(w.poll(since + 10).background).toEqual([]);
  });
});

describe("Opus 2 / 3: more provider switches pinned; a settings credential means no vault credential", () => {
  test("the AWS / Google Cloud / Mantle / gateway switches are pinned off", () => {
    const env = pinnedEnv({ allowProxy: false, ca: { file: "", dir: "" } });
    for (const k of ["CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_GATEWAY"]) expect(env[k]).toBe("");
    expect(credentialEnv({ CLAUDE_CODE_USE_GATEWAY: "1", CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" }, false)).toEqual({ CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" });
  });

  test("an apiKeyHelper (or API key env) in project, local, user or --settings is found", () => {
    const d = tree();
    const home = join(d, "home");
    const proj = join(home, "work", "repo");
    const cfg = join(home, ".claude");
    mkdirSync(join(proj, "sub"), { recursive: true });
    mkdirSync(cfg, { recursive: true });
    const o = { cwd: join(proj, "sub"), configDir: cfg, home };
    expect(ownCredentialSetting(o)).toBeNull();
    mkdirSync(join(proj, ".claude"));
    writeFileSync(join(proj, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "/bin/echo key" }));
    expect(ownCredentialSetting(o)).toBe(`${join(proj, ".claude", "settings.json")}: apiKeyHelper`);
    rmSync(join(proj, ".claude", "settings.json"));
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "k" } }));
    expect(ownCredentialSetting(o)).toBe(`${join(cfg, "settings.json")}: env.ANTHROPIC_API_KEY`);
    rmSync(join(cfg, "settings.json"));
    expect(ownCredentialSetting({ ...o, user: { apiKeyHelper: "x" } })).toBe("--settings: apiKeyHelper");
  });
});

describe("Opus 4: model-scoped limits; reset times from the message", () => {
  const err = (text: string) => ({ type: "assistant", timestamp: "2026-09-18T09:31:08.063Z", isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429, quotaLimits: null, message: { content: [{ type: "text", text }] } });
  test("'You've reached your Fable limit' is a Fable-only mark; the account stays usable for other models", () => {
    const hard = claudeQuotaLimit(err("You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue."));
    expect(hard).toMatchObject({ model: "fable" });
    const mark: Mark = { state: "exhausted", until: Date.now() + 3_600_000, at: Date.now(), reason: "fable model", model: "fable" };
    expect(markExcludes(mark, "claude-fable-5")).toBe(true);
    expect(markExcludes(mark, null)).toBe(true); // model unknown: conservative
    expect(markExcludes(mark, "claude-opus-5-5")).toBe(false);
    expect(claudeQuotaLimit(err("You've hit your session limit · resets 8:30am (America/Los_Angeles)"))?.model).toBeUndefined();
  });

  test("real reset lines match the quota headers Claude Code recorded", () => {
    expect(claudeResetAt("You've hit your session limit · resets 4:10am (America/Los_Angeles)", Date.parse("2026-09-26T06:47:30.292Z"))).toBe(1_790_421_000_000);
    expect(claudeResetAt("You've hit your weekly limit · resets Sep 25 at 11pm (America/Los_Angeles)", Date.parse("2026-09-22T18:23:15.072Z"))).toBe(1_790_402_400_000);
    expect(claudeResetAt("no reset here", Date.now())).toBeNull();
    expect(claudeQuotaLimit({ ...err("You've hit your session limit · resets 4:10am (America/Los_Angeles)"), timestamp: "2026-09-26T06:47:30.292Z" })?.until).toBe(1_790_421_000_000);
  });
});

describe("Opus 5: a limit mark lifts only with hysteresis", () => {
  const NOW = 1_790_000_000_000;
  const mark: Mark = { state: "exhausted", until: NOW + 5 * 3_600_000, at: NOW, reason: "five_hour" };
  const u = (at: number, used: number) => ({ at, state: "ok" as const, reason: null, source: "api" as const, until: null, windows: [{ kind: "session" as const, used_pct: used, resets_at: null, window_s: null, scope: null }] });
  test("a reading right after the mark, or one still at 100 %, keeps it; one 10+ minutes later with room lifts it", () => {
    expect(markLifted(mark, u(NOW + 60_000, 20))).toBe(false);
    expect(markLifted(mark, u(NOW + 11 * 60_000, 100))).toBe(false);
    expect(markLifted(mark, u(NOW + 11 * 60_000, 99))).toBe(true);
    expect(markLifted(mark, { ...u(NOW + 11 * 60_000, 20), state: "unknown" as const })).toBe(false);
  });
});

describe("Opus 6: one refusal is a strike, a second confirms re-login", () => {
  test("a single refused token excludes nothing; a confirmed one does", () => {
    const base: Mark = { state: "relogin", until: null, at: Date.now(), reason: "token_refused" };
    expect(markExcludes({ ...base, strikes: 1 }, null)).toBe(false);
    expect(markExcludes({ ...base, strikes: 2 }, null)).toBe(true);
    expect(markExcludes(base, null)).toBe(true); // an older mark without strikes counts as confirmed
    const cand = (mark: Mark): Candidate => ({ id: "a".repeat(24), provider: "claude", label: "a", owner: "me", own: true, source: "local", usage: null, leases: 0, mark });
    expect(select([cand({ ...base, strikes: 1 })], { provider: "claude", now: Date.now() }).pick).not.toBeNull();
    expect(select([cand({ ...base, strikes: 2 })], { provider: "claude", now: Date.now() }).pick).toBeNull();
  });
});

describe("Codex 4: completion only from the polling call's own affirmative result", () => {
  function rollout() {
    const d = tree();
    const f = join(d, "rollout-2026-09-26T10-00-00-35a3fc06-a27b-7106-8fd8-f2bb6d700e29.jsonl");
    const since = Date.now();
    writeFileSync(f, JSON.stringify({ timestamp: new Date(since).toISOString(), type: "session_meta", payload: { id: "35a3fc06-a27b-7106-8fd8-f2bb6d700e29", cwd: d, thread_source: "user" } }) + "\n");
    const put = (o: number, payload: Record<string, unknown>, type = "response_item") => writeFileSync(f, JSON.stringify({ timestamp: new Date(since + o).toISOString(), type, payload }) + "\n", { flag: "a" });
    return { put, since, w: new CodexWatcher({ sessionsDir: d, cwd: d, session: null, since, openRollout: async () => f }) };
  }

  test("an unrelated result quoting {session_id, exit_code}, a silent poll, a failed write: session 7 keeps running", async () => {
    const r = rollout();
    r.put(1, { type: "function_call", name: "exec_command", call_id: "c1", arguments: "{}" });
    r.put(2, { type: "function_call_output", call_id: "c1", output: JSON.stringify({ chunk_id: "a", session_id: 7, output: "" }) });
    r.put(3, { type: "function_call", name: "exec_command", call_id: "c2", arguments: "{}" });
    r.put(4, { type: "function_call_output", call_id: "c2", output: JSON.stringify({ exit_code: 0, output: 'Example fixture: {"session_id":7,"exit_code":0}' }) });
    expect((await r.w.refresh(r.since + 10)).background).toEqual(["exec:7"]);
    const cell = (text: string) => [{ type: "input_text", text: "Script completed\nWall time 1.0 seconds\nOutput:\n" }, ...(text ? [{ type: "input_text", text }] : [])];
    r.put(5, { type: "custom_tool_call", name: "exec", call_id: "x1", input: "await tools.write_stdin({session_id:7,chars:\"\"})" });
    r.put(6, { type: "custom_tool_call_output", call_id: "x1", output: cell("") });
    r.put(7, { type: "function_call", name: "write_stdin", call_id: "c3", arguments: JSON.stringify({ session_id: 7, chars: "q" }) });
    r.put(8, { type: "function_call_output", call_id: "c3", output: "write_stdin failed: stdin is closed for this session" });
    expect(r.w.poll(r.since + 20).background).toEqual(["exec:7"]);
    expect(execResult(JSON.stringify({ exit_code: 0, output: 'x {"session_id":7}' }))).toMatchObject({ exit: true, running: new Set() });
  });
});

describe("Codex 5: Codex subagents are background work", () => {
  test("a spawned agent runs until a status says it is over; a closed one is over", async () => {
    const d = tree();
    const f = join(d, "rollout-2026-09-26T10-00-00-35a3fc06-a27b-7106-8fd8-f2bb6d700e29.jsonl");
    const since = Date.now();
    const put = (o: number, type: string, payload: Record<string, unknown>) => writeFileSync(f, JSON.stringify({ timestamp: new Date(since + o).toISOString(), type, payload }) + "\n", { flag: "a" });
    put(0, "session_meta", { id: "35a3fc06-a27b-7106-8fd8-f2bb6d700e29", cwd: d, thread_source: "user" });
    const A = "01a0e0aa-0000-7000-8000-000000000001";
    const B = "01a0e0aa-0000-7000-8000-000000000002";
    const w = new CodexWatcher({ sessionsDir: d, cwd: d, session: null, since, openRollout: async () => f });
    put(1, "response_item", { type: "function_call", name: "spawn_agent", call_id: "s1", arguments: JSON.stringify({ message: "audit the diff" }) });
    put(2, "event_msg", { type: "collab_agent_spawn_end", call_id: "s1", sender_thread_id: "35a3fc06-a27b-7106-8fd8-f2bb6d700e29", new_thread_id: A, status: "running" });
    put(3, "response_item", { type: "function_call_output", call_id: "s1", output: JSON.stringify({ agent_id: A }) });
    put(4, "response_item", { type: "function_call", name: "spawn_agent", call_id: "s2", arguments: JSON.stringify({ message: "second" }) });
    put(5, "response_item", { type: "function_call_output", call_id: "s2", output: "spawned" }); // an answer naming no agent
    const s = await w.refresh(since + 10);
    expect(s.background.sort()).toEqual([`agent:${A}`, "agent:?s2"].sort());
    put(6, "event_msg", { type: "collab_agent_spawn_end", call_id: "s2", new_thread_id: B, status: "pending_init" });
    put(7, "response_item", { type: "function_call", name: "wait_agent", call_id: "w1", arguments: JSON.stringify({ ids: [A, B] }) });
    put(8, "response_item", { type: "function_call_output", call_id: "w1", output: JSON.stringify({ status: { [A]: { completed: "done" }, [B]: "running" } }) });
    expect(w.poll(since + 20).background).toEqual([`agent:${B}`]);
    put(9, "response_item", { type: "function_call", name: "close_agent", call_id: "k1", arguments: JSON.stringify({ id: B }) });
    put(10, "response_item", { type: "function_call_output", call_id: "k1", output: JSON.stringify({ status: "shutdown" }) });
    expect(w.poll(since + 30).background).toEqual([]);
  });
});

describe("Codex 6: the rollout is the requested session's, or the one root conversation", () => {
  function files(d: string, list: { id: string; meta: Record<string, unknown> }[]): string[] {
    return list.map(({ id, meta }) => {
      const f = join(d, `rollout-2026-09-26T10-00-00-${id}.jsonl`);
      writeFileSync(f, JSON.stringify({ timestamp: new Date().toISOString(), type: "session_meta", payload: { id, ...meta } }) + "\n");
      return f;
    });
  }
  const A = "35a3fc06-a67b-7532-8df8-d6bb2f733c6a";
  const B = "35a3fc06-a67b-7532-8df8-d6bb2f733c6b";
  test("an explicit id never binds another open rollout; a new session binds only an unambiguous root", async () => {
    const d = tree();
    const [fa, fb] = files(d, [{ id: A, meta: { thread_source: "user" } }, { id: B, meta: { thread_source: "subagent", source: { subagent: "x" } } }]);
    const since = Date.now();
    const explicit = new CodexWatcher({ sessionsDir: d, cwd: d, session: A, since, openRollout: async () => [fb as string] });
    expect(await explicit.refresh(since + 10)).toMatchObject({ bound: false });
    const right = new CodexWatcher({ sessionsDir: d, cwd: d, session: A, since, openRollout: async () => [fb as string, fa as string] });
    expect(await right.refresh(since + 10)).toMatchObject({ bound: true, session: A });
    const fresh = new CodexWatcher({ sessionsDir: d, cwd: d, session: null, since, openRollout: async () => [fb as string, fa as string] });
    expect(await fresh.refresh(since + 10)).toMatchObject({ bound: true, session: A });
    const [fc] = files(d, [{ id: "35a3fc06-a67b-7532-8df8-d6bb2f733c6c", meta: { thread_source: "user" } }]);
    const two = new CodexWatcher({ sessionsDir: d, cwd: d, session: null, since, openRollout: async () => [fa as string, fc as string] });
    expect(await two.refresh(since + 10)).toMatchObject({ bound: false });
  });
});

describe("Codex 7: marks are owner-qualified", () => {
  test("a borrowed account's mark (owner:id) never lands on the own account with the same id", () => {
    const w = tree();
    const ID = "c".repeat(24);
    const NOW = Date.now();
    const theirs = { id: ID, own: false, owner: "mallory" };
    expect(markKey(theirs)).toBe(`mallory:${ID}`);
    expect(markKey({ id: ID, own: true, owner: "kira" })).toBe(ID);
    writeMark(w, markKey(theirs), { state: "relogin", until: null, at: NOW, reason: "token_refused", strikes: 2 });
    const marks = readMarks(w);
    expect(Object.keys(marks)).toEqual([`mallory:${ID}`]);
    const view = (owner: string, policy: "own" | "shared"): AccountView => ({
      key: `${owner}:${ID}`, id: ID, provider: "claude", label: owner, plan: null, owners: [owner], claimed_by: [], usage: null, usage_host: null, last_seen: 1,
      machines: [{ node_id: `n-${owner}`, hostname: owner, handle: owner, online: true, self: false, agents: [], usage: null, vault: policy === "shared" ? { policy, share_with: ["kira"] } : { policy } }],
      vault: { policy }, leases: [],
    });
    const cands = candidatesFrom({ provider: "claude", entries: [], saved: new Map(), marks, localLeases: new Map(), borrow: true, pooled: { accounts: [view("mallory", "shared"), view("kira", "own")], me: "kira" } });
    expect(cands.find((c) => c.own)?.mark).toBeUndefined();
    expect(cands.find((c) => !c.own)?.mark?.state).toBe("relogin");
  });
});

describe("Codex 8: the libsecret-fallback key file is found again on reopening", () => {
  test("WALKIE_VAULT_KEYSTORE=libsecret: the first key goes to vault.key; a fresh open with the same setting uses it", async () => {
    const d = tree();
    const home = join(d, "w");
    const tool = join(d, "secret-tool");
    writeFileSync(tool, "#!/bin/sh\nexit 1\n");
    chmodSync(tool, 0o755);
    const v1 = Vault.open(home, { keystore: libsecret(d, tool) });
    await v1.addClaude({ id: "a".repeat(24), label: "al***@ex***.com", plan: null, token: ("sk" + "-ant-oat01-FAKEROUNDFIVETOKEN0000000000000000000000"), linked: false });
    v1.close();
    const ks = await defaultKeyStore(home, d, { WALKIE_VAULT_KEYSTORE: "libsecret" });
    expect(ks.kind).toBe("file");
    const v2 = Vault.open(home, { keystore: ks });
    try {
      expect(await v2.claudeToken("a".repeat(24))).toBe(("sk" + "-ant-oat01-FAKEROUNDFIVETOKEN0000000000000000000000"));
    } finally {
      v2.close();
    }
  });
});

describe("Opus 9: unreachable own accounts are named, not called exhausted", () => {
  test("waiting for a reset says which own accounts are unreachable (and that nothing is borrowed)", async () => {
    const d = tree();
    const NOW = Date.now();
    const says: string[] = [];
    const cands: Candidate[] = [
      { id: "a".repeat(24), provider: "claude", label: "mine-offline", owner: "kira", own: true, source: "peer", usage: null, leases: 0, unavailable: true },
      { id: "b".repeat(24), provider: "claude", label: "mine-out", owner: "kira", own: true, source: "local", usage: { at: NOW, state: "exhausted", reason: null, source: "api", until: NOW + 3_600_000, windows: [] }, leases: 0 },
    ];
    const fake = join(d, "claude");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const code = await runWrapped({
      provider: "claude", args: [], walkieHome: join(d, "w"), env: { PATH: d, HOME: d, WALKIE_REAL_CLAUDE: fake }, cwd: d,
      source: { gather: async () => cands, credentials: async () => ({ token: "x" }), hasAccounts: () => true, available: async () => true },
      trust: () => ({ ok: true, argv: [fake], ids: [], refreshed: false }), say: (l) => says.push(l),
      sleep: async () => { process.emit("SIGINT"); },
    });
    expect(code).toBe(130);
    expect(says[0]).toContain("mine-offline is not reachable right now");
    expect(says[1]).toContain("every claude account is at its limit");
  });
});
