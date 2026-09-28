// ACCOUNTS-2 round 4 (Codex r4 + Opus r4): a test per finding.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_ENDPOINT_KEYS, CLAUDE_PROXY_KEYS, launchSettings, OFFICIAL_ANTHROPIC_BASE_URL, pinnedEnv, readUserSettings, settingsValue, withoutSettings,
} from "../../src/switch/claude-settings.ts";
import { credentialEnv, withStopped } from "../../src/switch/wrapper.ts";
import { codexLoginEnv } from "../../src/cli/commands/vault.ts";
import { setConfigField } from "../../src/cli/commands/vault.ts";
import { trustedRecipient } from "../../src/switch/trusted.ts";
import { candidatesFrom } from "../../src/switch/accounts.ts";
import { selectOwnFirst } from "../../src/accounts/select.ts";
import type { AccountView } from "../../src/protocol/accounts.ts";
import { libsecret } from "../../src/accounts/vault/keystore.ts";
import { Vault } from "../../src/accounts/vault/vault.ts";
import { ClaudeWatcher, CodexWatcher, claudeQuotaLimit, codexRetryAt, runningSessions, taskNotification } from "../../src/switch/watch.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
function tree(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "walkie-r4-")));
  chmodSync(d, 0o755);
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

describe("finding 1: credential routing pinned in the wrapper's own --settings", () => {
  const ca = { file: "/etc/ssl/cert.pem", dir: "" };
  test("ANTHROPIC_BASE_URL is the official endpoint; every other endpoint / socket / proxy / CA / TLS key is pinned", () => {
    const env = pinnedEnv({ allowProxy: false, ca });
    expect(env.ANTHROPIC_BASE_URL).toBe(OFFICIAL_ANTHROPIC_BASE_URL);
    for (const k of [...CLAUDE_ENDPOINT_KEYS, ...CLAUDE_PROXY_KEYS]) expect(env[k]).toBe("");
    expect(env.ANTHROPIC_UNIX_SOCKET).toBe("");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("");
    expect(env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("1");
    expect(env.SSL_CERT_FILE).toBe("/etc/ssl/cert.pem"); // the system bundle, never "" (that breaks TLS in tools)
    // allow-proxy: the proxy keys are left to the person; nothing else changes.
    const withProxy = pinnedEnv({ allowProxy: true, ca });
    for (const k of CLAUDE_PROXY_KEYS) expect(k in withProxy).toBe(false);
    expect(withProxy.ANTHROPIC_BASE_URL).toBe(OFFICIAL_ANTHROPIC_BASE_URL);
  });

  test("a caller's --settings is merged: its keys and hooks stay, the routing keys are overridden, the switch hooks added", () => {
    const user = { model: "opus", env: { ANTHROPIC_BASE_URL: "https://collector.example", HTTPS_PROXY: "http://evil:1", MY_VAR: "kept" }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }] } };
    const merged = JSON.parse(launchSettings({ walkie: "/w/walkie", allowProxy: false, user, ca })) as { model: string; env: Record<string, string>; hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(merged.model).toBe("opus");
    expect(merged.env).toMatchObject({ ANTHROPIC_BASE_URL: OFFICIAL_ANTHROPIC_BASE_URL, HTTPS_PROXY: "", MY_VAR: "kept" });
    expect(merged.hooks.SessionStart?.map((h) => h.hooks[0]?.command)).toEqual(["echo mine", "/w/walkie hook switch # walkie-managed"]);
    expect(Object.keys(merged.hooks).sort()).toEqual(["SessionEnd", "SessionStart", "UserPromptSubmit"]);
  });

  test("--settings as inline JSON or a file; one that cannot be read throws (the run gets no credentials)", () => {
    const d = tree();
    writeFileSync(join(d, "s.json"), JSON.stringify({ env: { A: "1" } }));
    expect(readUserSettings("s.json", d)).toEqual({ env: { A: "1" } });
    expect(readUserSettings('{"x":1}', d)).toEqual({ x: 1 });
    expect(() => readUserSettings("missing.json", d)).toThrow();
    expect(() => readUserSettings("[1]", d)).toThrow();
    expect(settingsValue(["--model", "x", "--settings", "a.json", "--settings={\"b\":1}", "--", "--settings", "p"])).toBe('{"b":1}');
    expect(withoutSettings(["--settings", "a", "-p", "--settings=x", "--", "--settings"])).toEqual(["-p", "--", "--settings"]);
  });

  test("the parent environment loses unix sockets and Claude endpoint hosts too", () => {
    const out = credentialEnv({ PATH: "/bin", ANTHROPIC_UNIX_SOCKET: "/tmp/s", ANTHROPIC_API_HOST: "x", CLAUDE_AI_HOST: "y", CLAUDE_CODE_PROXY_URL: "p", CLAUDE_CODE_USE_BEDROCK: "1" }, false);
    expect(out).toEqual({ PATH: "/bin" });
    expect(credentialEnv({ CLAUDE_CODE_PROXY_URL: "p" }, true)).toEqual({ CLAUDE_CODE_PROXY_URL: "p" });
  });

  test("the release build turns off .env / bunfig.toml autoload (WALKIE_TOKEN_VIA only from the real environment)", () => {
    const build = readFileSync(join(import.meta.dir, "..", "..", "scripts", "build.ts"), "utf8");
    expect(build).toContain("--no-compile-autoload-dotenv");
    expect(build).toContain("--no-compile-autoload-bunfig");
  });
});

describe("finding 2 (Codex 2): `accounts add codex` runs only the trusted native codex, in a clean environment", () => {
  test("a script codex is refused; a native one passes; the login environment is cleaned", () => {
    const d = tree();
    mkdirSync(join(d, "work"));
    mkdirSync(join(d, "w"));
    const mk = (rel: string, body: string | Buffer) => { const p = join(d, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, body, { mode: 0o755 }); chmodSync(p, 0o755); return p; };
    const script = mk("npm/bin/codex", "#!/usr/bin/env node\n");
    const native = mk("bin/codex", Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.alloc(32)]));
    const o = { cwd: join(d, "work"), stopAt: d, adminGroup: null, acl: () => [] as string[] };
    const bad = trustedRecipient(join(d, "w"), "codex", script, o);
    expect(bad.ok).toBe(false);
    expect(bad.ok ? "" : bad.why).toMatch(/install the native codex/);
    expect(trustedRecipient(join(d, "w"), "codex", native, o)).toMatchObject({ ok: true, argv: [native] });
    const env = codexLoginEnv({ PATH: "/bin", NODE_OPTIONS: "--require x", OPENAI_BASE_URL: "https://evil", HTTPS_PROXY: "http://p", OPENAI_API_KEY: "k", WALKIE_REAL_CODEX: "/x" }, join(d, "w"), "/h");
    expect(env).toEqual({ PATH: "/bin", CODEX_HOME: "/h", WALKIE_NO_SWITCH: "1" });
    setConfigField(join(d, "w"), "allow_proxy", true);
    expect(codexLoginEnv({ HTTPS_PROXY: "http://p" }, join(d, "w"), "/h").HTTPS_PROXY).toBe("http://p");
  });
});

describe("finding 3 (Codex 3): owner-qualified identity; a teammate cannot shadow an own account", () => {
  const NOW = Date.now();
  const ID = "c".repeat(24);
  const usage = (used: number) => ({ at: NOW, state: "ok" as const, reason: null, source: "api" as const, until: null, windows: [{ kind: "session" as const, used_pct: used, resets_at: NOW + 3_600_000, window_s: null, scope: null }] });
  const view = (owner: string, label: string, online: boolean, policy: "own" | "shared", used: number): AccountView => ({
    key: `${owner}:${ID}`, id: ID, provider: "claude", label, plan: null, owners: [owner], claimed_by: [], usage: usage(used), usage_host: null, last_seen: 1,
    machines: [{ node_id: `n-${owner}`, hostname: `${owner}-mac`, handle: owner, online, self: false, agents: [], usage: null, vault: policy === "shared" ? { policy, share_with: ["kira"] } : { policy } }],
    vault: { policy }, leases: [],
  });
  const gather = (views: AccountView[]) => candidatesFrom({ provider: "claude", entries: [], saved: new Map(), marks: {}, localLeases: new Map(), borrow: true, pooled: { accounts: views, me: "kira" } });

  test("a teammate advertising the same account id (listed first) never hides the healthy own account", () => {
    const attacker = view("mallory", "aaa first", true, "shared", 1);
    const mine = view("kira", "zzz mine", true, "own", 10);
    const cands = gather([attacker, mine]);
    expect(cands.map((c) => [c.owner, c.own])).toEqual([["kira", true], ["mallory", false]]);
    expect(selectOwnFirst(cands, { provider: "claude", now: NOW }).pick?.owner).toBe("kira");
  });

  test("the own account's machine offline: listed unavailable, and the teammate's same-id account is not borrowed", () => {
    const cands = gather([view("mallory", "aaa first", true, "shared", 1), view("kira", "zzz mine", false, "own", 10)]);
    expect(cands.find((c) => c.own)?.unavailable).toBe(true);
    expect(selectOwnFirst(cands, { provider: "claude", now: NOW }).pick).toBeNull();
  });
});

describe("finding 5 (Codex 5): a new vault key never goes to libsecret", () => {
  test("first-key creation with libsecret selected falls back to the create-only 0600 file, with a notice", async () => {
    const d = tree();
    const home = join(d, "w");
    const tool = join(d, "secret-tool");
    const calls = join(d, "calls.txt");
    writeFileSync(tool, `#!/bin/sh\necho "$1" >> ${calls}\nexit 1\n`);
    chmodSync(tool, 0o755);
    const ks = libsecret(d, tool);
    await expect(ks.put("v", Buffer.alloc(32))).rejects.toThrow(/create-only/);
    const v = Vault.open(home, { keystore: ks });
    try {
      await v.addClaude({ id: "a".repeat(24), label: "al***@ex***.com", plan: null, token: ("sk" + "-ant-oat01-FAKEROUNDFOURTOKEN000000000000000000000"), linked: false });
      const used = await v.keyStore();
      expect(used.kind).toBe("file");
      expect(used.warning).toMatch(/libsecret cannot store a new key create-only/);
      expect(existsSync(join(home, "vault.key"))).toBe(true);
      expect(await v.claudeToken("a".repeat(24))).toBe(("sk" + "-ant-oat01-FAKEROUNDFOURTOKEN000000000000000000000"));
      expect(readFileSync(calls, "utf8")).not.toContain("store"); // secret-tool was never asked to store
    } finally {
      v.close();
    }
  });
});

describe("finding 6 (Codex 6): task completion only from runtime notification records", () => {
  const block = (id: string, status = "completed") => `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>${status}</status>\n</task-notification>`;
  test("queue operations, queued_command attachments and task-notification user messages count; text in a tool result does not", () => {
    expect(taskNotification({ type: "queue-operation", operation: "enqueue", content: block("b1") })).toEqual({ id: "b1", status: "completed" });
    expect(taskNotification({ type: "attachment", attachment: { type: "queued_command", prompt: block("b2", "killed") } })).toEqual({ id: "b2", status: "killed" });
    expect(taskNotification({ type: "user", origin: { kind: "task-notification" }, message: { content: block("b3") } })).toEqual({ id: "b3", status: "completed" });
    expect(taskNotification({ type: "user", toolUseResult: { stdout: block("b4") }, message: { content: [{ type: "tool_result", tool_use_id: "t", content: block("b4") }] } })).toBeNull();
    expect(taskNotification({ type: "user", message: { content: `docs: ${block("b5")}` } })).toBeNull();
    expect(taskNotification({ type: "queue-operation", operation: "enqueue", content: `quoted ${block("b6")}` })).toBeNull();
  });

  test("a live task quoted in a tool result stays pending", () => {
    const d = tree();
    const events = join(d, "ev.jsonl");
    const tp = join(d, "t.jsonl");
    writeFileSync(events, "");
    writeFileSync(tp, "");
    const since = Date.now();
    const w = new ClaudeWatcher({ eventsFile: events, configDir: d, cwd: d, session: null, since });
    writeFileSync(events, JSON.stringify({ ev: "SessionStart", sid: "3f9a2b7c-1111-4222-8333-944455556666", tp, ts: since }) + "\n");
    const t = (o: number, e: Record<string, unknown>) => writeFileSync(tp, JSON.stringify({ timestamp: new Date(since + o).toISOString(), ...e }) + "\n", { flag: "a" });
    t(1, { type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm run dev", description: "dev server", run_in_background: true } }] } });
    t(2, { type: "user", toolUseResult: { backgroundTaskId: "bg-live" }, message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "started" }] } });
    t(3, { type: "user", toolUseResult: { stdout: block("bg-live") }, message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: block("bg-live") }] } });
    const s = w.poll(since + 10);
    expect(s.background).toEqual(["bg-live"]);
    expect(s.backgroundInfo["bg-live"]).toBe("Bash: dev server");
  });
});

describe("findings 7 and 10 (Codex 7 / Opus 4, 6): Codex exec sessions and code-mode cells, correlated", () => {
  function rollout() {
    const d = tree();
    const f = join(d, "rollout-2026-09-26T10-00-00-35a3fc06-a27b-7106-8fd8-f2bb6d700e29.jsonl");
    const since = Date.now();
    const put = (o: number, payload: Record<string, unknown>) => writeFileSync(f, JSON.stringify({ timestamp: new Date(since + o).toISOString(), type: "response_item", payload }) + "\n", { flag: "a" });
    // A root conversation's session_meta first (round 5: only a root rollout binds a new session).
    writeFileSync(f, JSON.stringify({ timestamp: new Date(since).toISOString(), type: "session_meta", payload: { id: "35a3fc06-a27b-7106-8fd8-f2bb6d700e29", cwd: d, thread_source: "user", source: "cli" } }) + "\n");
    const w = new CodexWatcher({ sessionsDir: d, cwd: d, session: null, since, openRollout: async () => f });
    return { put, w, since };
  }

  test("text form: 'Process running with session ID 3', then write_stdin to 3 answered 'Process exited with code 0'", async () => {
    const r = rollout();
    r.put(1, { type: "function_call", name: "exec_command", call_id: "c1", arguments: JSON.stringify({ cmd: "npm test" }) });
    r.put(2, { type: "function_call_output", call_id: "c1", output: "Chunk ID: a\nWall time: 1.0 seconds\nProcess running with session ID 3\nOutput:\n" });
    expect((await r.w.refresh(r.since + 10)).background).toEqual(["exec:3"]);
    r.put(20, { type: "function_call", name: "write_stdin", call_id: "c2", arguments: JSON.stringify({ session_id: 3, chars: "" }) });
    r.put(21, { type: "function_call_output", call_id: "c2", output: "Chunk ID: b\nWall time: 0.2 seconds\nProcess exited with code 0\nOutput:\nok\n" });
    expect(r.w.poll(r.since + 30).background).toEqual([]);
  });

  test("JSON form: {session_id} while running; the exit result has NO session_id (Codex drops it) — correlated by the call", async () => {
    const r = rollout();
    r.put(1, { type: "function_call", name: "exec_command", call_id: "c1", arguments: "{}" });
    r.put(2, { type: "function_call_output", call_id: "c1", output: JSON.stringify({ chunk_id: "a", wall_time_seconds: 1, session_id: 7, output: "" }) });
    expect((await r.w.refresh(r.since + 10)).background).toEqual(["exec:7"]);
    r.put(3, { type: "function_call", name: "write_stdin", call_id: "c2", arguments: JSON.stringify({ session_id: 7 }) });
    r.put(4, { type: "function_call_output", call_id: "c2", output: JSON.stringify({ chunk_id: "b", exit_code: 0, output: "done" }) });
    expect(r.w.poll(r.since + 20).background).toEqual([]);
  });

  test("code mode: a session left running inside an exec cell, polled by a later cell's tools.write_stdin", async () => {
    const r = rollout();
    const cellOut = (inner: Record<string, unknown>) => [{ type: "input_text", text: "Script completed\nWall time 1.3 seconds\nOutput:\n" }, { type: "input_text", text: JSON.stringify(inner) }];
    r.put(1, { type: "custom_tool_call", name: "exec", call_id: "x1", input: 'const r = await tools.exec_command({cmd:"pnpm test"}); text(JSON.stringify(r))' });
    r.put(2, { type: "custom_tool_call_output", call_id: "x1", output: cellOut({ chunk_id: "1", wall_time_seconds: 1.0, session_id: 36508, original_token_count: 5, output: "running" }) });
    expect((await r.w.refresh(r.since + 10)).background).toEqual(["exec:36508"]);
    r.put(3, { type: "custom_tool_call", name: "exec", call_id: "x2", input: "const r = await tools.write_stdin({session_id:36508,chars:\"\",yield_time_ms:1000});\ntext(JSON.stringify(r))" });
    r.put(4, { type: "custom_tool_call_output", call_id: "x2", output: cellOut({ chunk_id: "2", wall_time_seconds: 5.0, session_id: 36508, output: "still" }) });
    expect(r.w.poll(r.since + 20).background).toEqual(["exec:36508"]);
    r.put(5, { type: "custom_tool_call", name: "exec", call_id: "x3", input: "const r = await tools.write_stdin({session_id:36508,chars:\"\"});" });
    r.put(6, { type: "custom_tool_call_output", call_id: "x3", output: cellOut({ chunk_id: "3", wall_time_seconds: 0.5, exit_code: 0, original_token_count: 2, output: "passed" }) });
    expect(r.w.poll(r.since + 30).background).toEqual([]);
  });

  test("code mode: 'Script running with cell ID 111' until a wait on cell 111 no longer says so", async () => {
    const r = rollout();
    r.put(1, { type: "custom_tool_call", name: "exec", call_id: "x1", input: "await long()" });
    r.put(2, { type: "custom_tool_call_output", call_id: "x1", output: "Script running with cell ID 111\nWall time 31.0 seconds\nOutput:\n" });
    const s = await r.w.refresh(r.since + 10);
    expect(s.background).toEqual(["cell:111"]);
    expect(s.backgroundInfo["cell:111"]).toBe("exec: await long()");
    r.put(3, { type: "function_call", name: "wait", call_id: "w1", arguments: JSON.stringify({ cell_id: "111", yield_time_ms: 30000 }) });
    r.put(4, { type: "function_call_output", call_id: "w1", output: "Script running with cell ID 111\nWall time 30.0 seconds\nOutput:\n" });
    expect(r.w.poll(r.since + 20).background).toEqual(["cell:111"]);
    r.put(5, { type: "function_call", name: "wait", call_id: "w2", arguments: JSON.stringify({ cell_id: "111" }) });
    r.put(6, { type: "function_call_output", call_id: "w2", output: "Script completed\nWall time 3.0 seconds\nOutput:\nok" });
    expect(r.w.poll(r.since + 30).background).toEqual([]);
  });

  test("runningSessions: an id next to an exit code in the same result is not running", () => {
    expect(runningSessions('{"chunk_id":"a","exit_code":0,"session_id":5,"output":"x"}')).toEqual([]);
    expect(runningSessions('Output:\n{"chunk_id":"a","wall_time_seconds":1,"session_id":5,"original_token_count":0,"output":"{\\"exit_code\\":1}"}')).toEqual(["5"]);
  });
});

describe("finding 8 (Codex 8 / Opus 5): a hard limit only on affirmative quota evidence", () => {
  const err = (text: string, extra: Record<string, unknown> = {}) => ({ type: "assistant", isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429, message: { content: [{ type: "text", text }] }, ...extra });
  test("per-minute throttles and overloads are not limits; quota headers and Claude Code's limit messages are", () => {
    expect(claudeQuotaLimit(err("API Error: Rate limit reached for requests per minute. Please retry shortly."))).toBeNull();
    expect(claudeQuotaLimit(err("Overloaded"))).toBeNull();
    expect(claudeQuotaLimit(err("rate limited", { quotaLimits: { status: "allowed_warning", rateLimitType: "five_hour" } }))).toBeNull();
    expect(claudeQuotaLimit(err("x", { quotaLimits: { status: "rejected", resetsAt: 1_790_421_000, rateLimitType: "seven_day" } }))).toEqual({ until: 1_790_421_000_000, window: "seven_day" });
    expect(claudeQuotaLimit(err("You've hit your session limit · resets 3pm"))).toMatchObject({ window: "usage" });
    expect(claudeQuotaLimit(err("You're out of usage credits. Run /usage-credits to keep using"))).not.toBeNull();
    expect(claudeQuotaLimit(err("see https://claude.ai/settings/usage?from=cc_cli_limit_message"))).not.toBeNull();
    expect(claudeQuotaLimit({ type: "assistant", message: { content: "You've hit your session limit" } })).toBeNull(); // not an API error record
  });
});

describe("finding 9 (Opus 3): Monitor watches are background work; the resumed session hears what the move stopped", () => {
  test("a taskId result (no backgroundTaskId) is tracked with its description; the continuation names what was stopped", () => {
    const d = tree();
    const events = join(d, "ev.jsonl");
    const tp = join(d, "t.jsonl");
    writeFileSync(events, "");
    writeFileSync(tp, "");
    const since = Date.now();
    const w = new ClaudeWatcher({ eventsFile: events, configDir: d, cwd: d, session: null, since });
    writeFileSync(events, JSON.stringify({ ev: "SessionStart", sid: "3f9a2b7c-1111-4222-8333-944455556666", tp, ts: since }) + "\n");
    const t = (o: number, e: Record<string, unknown>) => writeFileSync(tp, JSON.stringify({ timestamp: new Date(since + o).toISOString(), ...e }) + "\n", { flag: "a" });
    t(1, { type: "assistant", message: { content: [{ type: "tool_use", id: "tm", name: "Monitor", input: { command: "tail -f log", description: "deploy watch", timeout_ms: 1_800_000 } }] } });
    t(2, { type: "user", toolUseResult: { taskId: "bdn02q721", timeoutMs: 1_800_000, persistent: false }, message: { content: [{ type: "tool_result", tool_use_id: "tm", content: "watching" }] } });
    const s = w.poll(since + 10);
    expect(s.background).toEqual(["bdn02q721"]);
    const prompt = withStopped("Continue.", s.background.map((b) => `${s.backgroundInfo[b]} (${b})`));
    expect(prompt).toBe("Continue.\n\nBackground work that was still running when the session moved was stopped by the move: Monitor: deploy watch (bdn02q721). Start it again if it is still needed.");
    expect(withStopped("Continue.", [])).toBe("Continue.");
  });
});

describe("finding 11 (Opus 7): Codex retry times", () => {
  test("'try again at 8:29 PM' is the next 8:29 PM; a full date still parses", () => {
    const now = new Date(2026, 8, 26, 18, 0, 0).getTime();
    expect(codexRetryAt("You've hit your usage limit. Try again at 8:29 PM.", now)).toBe(new Date(2026, 8, 26, 20, 29, 0).getTime());
    expect(codexRetryAt("You've hit your usage limit. Try again at 5:15 PM.", now)).toBe(new Date(2026, 8, 27, 17, 15, 0).getTime());
    expect(codexRetryAt("Try again at 12:05 AM.", now)).toBe(new Date(2026, 8, 27, 0, 5, 0).getTime());
    expect(codexRetryAt("Try again at Sep 30th, 2026 8:54 PM.", now)).toBe(Date.parse("Sep 30, 2026 8:54 PM"));
    expect(codexRetryAt("Try again at 25:99.", now)).toBeNull();
  });
});
