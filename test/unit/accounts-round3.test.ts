// ACCOUNTS-2 round 3 (Codex r3 + Opus r3, "simplify"): a test per decision.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { checkTrusted, isNative, NATIVE_INSTALL, parseAce, recordTrusted, trustProblem, type TrustOptions } from "../../src/switch/trusted.ts";
import { credentialEnv, proxyAllowed } from "../../src/switch/wrapper.ts";
import { fileKeyStore, macKeychain } from "../../src/accounts/vault/keystore.ts";
import { selectOwnFirst, type Candidate } from "../../src/accounts/select.ts";
import { candidatesFrom } from "../../src/switch/accounts.ts";
import type { AccountView } from "../../src/protocol/accounts.ts";
import { ClaudeWatcher, CodexWatcher } from "../../src/switch/watch.ts";
import { execLease, setConfigField } from "../../src/cli/commands/vault.ts";
import { activeLeases, writeLease } from "../../src/accounts/leases.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
function tree(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "walkie-r3-")));
  chmodSync(d, 0o755);
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}
const NATIVE = Buffer.concat([Buffer.from("cffaedfe", "hex"), Buffer.alloc(64)]);
function file(root: string, rel: string, body: string | Buffer = NATIVE): string {
  const p = join(root, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}
const base = (root: string, extra: Partial<TrustOptions> = {}): TrustOptions => ({ cwd: join(root, "work"), stopAt: root, adminGroup: null, acl: () => [], ...extra });

describe("decision 2: credentials only to a native executable", () => {
  test("Mach-O / ELF magic is native; a shebang launcher is refused with the official install command", () => {
    const root = tree();
    mkdirSync(join(root, "work"));
    const native = file(root, "bin/claude");
    const elf = file(root, "bin/codex", Buffer.concat([Buffer.from("7f454c46", "hex"), Buffer.alloc(16)]));
    const script = file(root, "npm/bin/claude", "#!/usr/bin/env node\nrequire('./cli.js')\n");
    expect(isNative(native)).toBe(true);
    expect(isNative(elf)).toBe(true);
    expect(isNative(script)).toBe(false);
    expect(trustProblem(native, base(root))).toBeNull();
    expect(trustProblem(script, base(root))).toMatch(/not a native executable/);
    expect(() => recordTrusted(join(root, "w"), "claude", script, base(root))).toThrow(new RegExp(`install the native claude: ${NATIVE_INSTALL.claude.replace(/[|.*+?^${}()[\]\\/]/g, "\\$&")}`));
  });

  test("re-validated at every launch: a trusted native binary replaced by a script loses its credentials", () => {
    const root = tree();
    mkdirSync(join(root, "work"));
    mkdirSync(join(root, "w"));
    const cli = file(root, "bin/claude");
    recordTrusted(join(root, "w"), "claude", cli, base(root));
    const ok = checkTrusted(join(root, "w"), "claude", cli, base(root));
    expect(ok).toMatchObject({ ok: true, argv: [cli] }); // the validated path is what runs (no interpreter first)
    writeFileSync(cli, "#!/bin/sh\necho replaced\n");
    const r = checkTrusted(join(root, "w"), "claude", cli, base(root));
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.why).toMatch(/install the native claude/);
  });
});

describe("decision 3: ACL entries parsed structurally, failing closed", () => {
  test("parseAce: inherited entries, principals with spaces, unknown rights", () => {
    expect(parseAce(" 0: group:everyone inherited allow add_file,delete_child")).toEqual({ principal: "group:everyone", inherited: true, allow: true, rights: ["add_file", "delete_child"] });
    expect(parseAce(" 1: group:Domain Users allow write")).toMatchObject({ principal: "group:Domain Users", inherited: false });
    expect(parseAce(" 2: user:alex deny delete")).toMatchObject({ allow: false });
    expect(parseAce(" 3: group:everyone allow frobnicate")).toBeNull(); // a right this does not know
    expect(parseAce("garbage")).toBeNull();
  });

  test("inherited / spaced-principal write entries, unrecognised entries and an unreadable ACL are all refused", () => {
    const root = tree();
    mkdirSync(join(root, "work"));
    const cli = file(root, "home/bin/claude");
    const at = (lines: string[] | null) => (p: string) => (p === join(root, "home") ? lines : []);
    const o = (acl: TrustOptions["acl"]) => base(root, { acl, user: "alex" });
    expect(trustProblem(cli, o(at([" 0: group:everyone inherited allow add_file"])))).toMatch(/letting group:everyone write \(inherited\)/);
    expect(trustProblem(cli, o(at([" 0: group:Domain Users allow write"])))).toMatch(/letting group:Domain Users write/);
    expect(trustProblem(cli, o(at([" 0: something odd"])))).toMatch(/could not be understood/);
    expect(trustProblem(cli, o(at(null)))).toMatch(/ACL could not be read/);
    expect(trustProblem(cli, o(at([" 0: user:alex inherited allow write", " 1: group:everyone deny write"])))).toBeNull();
  });
});

describe("decision 5: credential-redirect settings stripped from credentialed launches", () => {
  const env = {
    PATH: "/usr/bin", HOME: "/h", LANG: "C",
    ANTHROPIC_BASE_URL: "https://evil", ANTHROPIC_BEDROCK_BASE_URL: "https://evil", CLAUDE_CODE_API_BASE_URL: "https://evil",
    HTTPS_PROXY: "http://p:1", http_proxy: "http://p:1", ALL_PROXY: "socks5://p", NO_PROXY: "localhost",
    NODE_EXTRA_CA_CERTS: "/x.pem", NODE_TLS_REJECT_UNAUTHORIZED: "0", SSL_CERT_FILE: "/x", SSL_CERT_DIR: "/d", REQUESTS_CA_BUNDLE: "/r",
    CLAUDE_CODE_REMOTE: "1", OPENAI_BASE_URL: "https://evil", NODE_OPTIONS: "--require /x.js", DYLD_INSERT_LIBRARIES: "/x.dylib",
  };
  test("removed by default; `allow-proxy` keeps only the proxy variables", () => {
    const out = credentialEnv(env, false);
    expect(Object.keys(out).sort()).toEqual(["HOME", "LANG", "NO_PROXY", "PATH"]);
    const withProxy = credentialEnv(env, true);
    expect(Object.keys(withProxy).sort()).toEqual(["ALL_PROXY", "HOME", "HTTPS_PROXY", "LANG", "NO_PROXY", "PATH", "http_proxy"]);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://evil"); // the input is not changed
  });

  test("allow-proxy is read from the person's config", () => {
    const w = tree();
    expect(proxyAllowed(w)).toBe(false);
    setConfigField(w, "allow_proxy", true);
    expect(proxyAllowed(w)).toBe(true);
    setConfigField(w, "allow_proxy", false);
    expect(proxyAllowed(w)).toBe(false);
  });
});

describe("decision 6 (Codex 5): the key store is create-only", () => {
  test("file store: a second put never replaces the key", async () => {
    const w = tree();
    const ks = fileKeyStore(w);
    const k1 = randomBytes(32);
    expect(await ks.put("v", k1)).toBe("created");
    expect(await ks.put("v", randomBytes(32))).toBe("exists");
    expect((await ks.get("v"))?.equals(k1)).toBe(true);
  });

  test("macOS Keychain (fake security tool): no -U; an existing item is reported, never updated", async () => {
    const d = tree();
    const tool = join(d, "security");
    const store = join(d, "store.txt");
    writeFileSync(tool, `#!/bin/sh
if [ "$1" = "-i" ]; then cat > ${join(d, "stdin.txt")}; grep -q -- ' -U ' ${join(d, "stdin.txt")} && echo U >> ${join(d, "saw-U")}; [ -s ${store} ] && exit 45; sed -n 's/.* -w \\([0-9a-f]*\\).*/\\1/p' ${join(d, "stdin.txt")} > ${store}; exit 0; fi
if [ "$1" = "find-generic-password" ]; then [ -s ${store} ] || exit 44; cat ${store}; exit 0; fi
exit 1
`);
    chmodSync(tool, 0o755);
    const ks = macKeychain(d, tool);
    const k1 = randomBytes(32);
    expect(await ks.put("vaultid", k1)).toBe("created");
    expect(await ks.put("vaultid", randomBytes(32))).toBe("exists");
    expect((await ks.get("vaultid"))?.equals(k1)).toBe(true);
    expect(() => readFileSync(join(d, "saw-U"))).toThrow(); // -U never sent
  });
});

describe("decision 8 (Codex 7): an unreachable own account is not an exhausted one", () => {
  const NOW = Date.now();
  test("an own account whose vault machine is offline is listed unavailable; it is never picked and blocks borrowing", () => {
    const own: AccountView = {
      key: "kira:a", id: "a".repeat(24), provider: "claude", label: "mine", plan: null, owners: ["kira"], claimed_by: [], usage: null, usage_host: null, last_seen: 1,
      machines: [{ node_id: "n-kmini", hostname: "kira-mini", handle: "kira", online: false, self: false, agents: [], usage: null, vault: { policy: "own" } }],
      vault: { policy: "own" }, leases: [],
    };
    const shared: AccountView = {
      key: "alex:b", id: "b".repeat(24), provider: "claude", label: "alex's", plan: null, owners: ["alex"], claimed_by: [], usage: null, usage_host: null, last_seen: 1,
      machines: [{ node_id: "n-mac", hostname: "alex-mac", handle: "alex", online: true, self: false, agents: [], usage: null, vault: { policy: "shared", share_with: ["kira"] } }],
      vault: { policy: "shared", share_with: ["kira"] }, leases: [],
    };
    const cands = candidatesFrom({ provider: "claude", entries: [], saved: new Map(), marks: {}, localLeases: new Map(), borrow: true, pooled: { accounts: [own, shared], me: "kira" } });
    expect(cands.map((c) => [c.label, c.own, !!c.unavailable])).toEqual([["mine", true, true], ["alex's", false, false]]);
    const sel = selectOwnFirst(cands, { provider: "claude", now: NOW });
    expect(sel.pick).toBeNull(); // not borrowed: the own account may well have room
    expect(sel.excluded.find((e) => e.label === "mine")?.why).toBe("unreachable right now");
    // With the own account affirmatively at its limit instead, borrowing happens.
    const atLimit: Candidate = { ...(cands[0] as Candidate), unavailable: false, source: "peer", node: "n-kmini", mark: { state: "exhausted", until: NOW + 60_000, at: NOW, reason: "five_hour" } };
    expect(selectOwnFirst([atLimit, cands[1] as Candidate], { provider: "claude", now: NOW }).pick?.label).toBe("alex's");
  });
});

describe("decision 10 (Codex 9): `accounts exec` leases carry the hand-out's grant", () => {
  test("a borrowed hand-out's lease names its grant and the lending machine; an own local one names neither", () => {
    const w = tree();
    const peer = execLease("claude", { id: "b".repeat(24), own: false, owner: "alex", source: "peer", node: "n-mac" }, { grant: "f".repeat(16) }, process.pid, "cc-exec01");
    const lease = writeLease(w, peer);
    expect(lease).toMatchObject({ account: "b".repeat(24), owner: "alex", from_node: "n-mac", grant: "f".repeat(16), agent: "cc-exec01" });
    expect(activeLeases(w)[0]?.grant).toBe("f".repeat(16));
    const local = execLease("claude", { id: "a".repeat(24), own: true, owner: "kira", source: "local" }, {}, process.pid, "Bad Agent!");
    expect(local).toEqual({ provider: "claude", account: "a".repeat(24), pid: process.pid });
  });
});

describe("decisions 1 + 9: background work and prompts after the limit, from the transcript", () => {
  function claude() {
    const d = tree();
    const events = join(d, "ev.jsonl");
    writeFileSync(events, "");
    const tp = join(d, "t.jsonl");
    writeFileSync(tp, "");
    const since = Date.now();
    const sid = "3f9a2b7c-1111-4222-8333-944455556666";
    const w = new ClaudeWatcher({ eventsFile: events, configDir: d, cwd: d, session: null, since });
    writeFileSync(events, JSON.stringify({ ev: "SessionStart", sid, tp, ts: since }) + "\n");
    const ts = (o: number) => new Date(since + o).toISOString();
    const t = (o: number, e: Record<string, unknown>) => writeFileSync(tp, JSON.stringify({ timestamp: ts(o), ...e }) + "\n", { flag: "a" });
    const call = (o: number, id: string, input: Record<string, unknown>, name = "Bash") => t(o, { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
    const result = (o: number, id: string, r: Record<string, unknown> | undefined, isError = false) => t(o, { type: "user", ...(r ? { toolUseResult: r } : {}), message: { content: [{ type: "tool_result", tool_use_id: id, content: "x", ...(isError ? { is_error: true } : {}) }] } });
    const notify = (o: number, task: string, status = "completed") => t(o, { type: "queue-operation", operation: "enqueue", content: `<task-notification>\n<task-id>${task}</task-id>\n<status>${status}</status>\n</task-notification>` });
    const limit = (o: number) => t(o, { type: "assistant", isApiErrorMessage: true, error: "rate_limit", quotaLimits: { status: "rejected", resetsAt: 1_790_421_000, rateLimitType: "five_hour" } });
    return { w, since, call, result, notify, limit, t };
  }

  test("a shell backgrounded by the call, by Ctrl+B or a timeout (backgroundTaskId), until its task-notification", () => {
    const c = claude();
    c.call(10, "tu1", { command: "npm test" }); // not run_in_background: backgrounded mid-run (Ctrl+B / timeout)
    c.result(11, "tu1", { stdout: "", backgroundTaskId: "b7x" });
    expect(c.w.poll(c.since + 20).background).toEqual(["b7x"]);
    c.notify(30, "b7x");
    expect(c.w.poll(c.since + 40).background).toEqual([]);
  });

  test("an async agent: run_in_background as the STRING \"true\", status async_launched; failed / killed count as done", () => {
    const c = claude();
    c.call(10, "tu2", { prompt: "x", run_in_background: "true" }, "Agent");
    expect(c.w.poll(c.since + 15).background).toEqual(["?tu2"]); // started, no task named yet: conservative
    c.result(16, "tu2", { status: "async_launched", agentId: "ag9" });
    expect(c.w.poll(c.since + 20).background).toEqual(["ag9"]);
    c.notify(30, "ag9", "killed");
    expect(c.w.poll(c.since + 40).background).toEqual([]);
  });

  test("a run_in_background call that failed started nothing", () => {
    const c = claude();
    c.call(10, "tu3", { command: "x", run_in_background: true });
    c.result(11, "tu3", undefined, true);
    expect(c.w.poll(c.since + 20).background).toEqual([]);
  });

  test("a prompt typed after the limit (no hook event needed); tool output, meta and notifications are not prompts", () => {
    const c = claude();
    c.limit(10);
    c.t(11, { type: "user", isMeta: true, message: { content: "Caveat: meta" } });
    c.t(12, { type: "user", message: { content: "<task-notification><task-id>z</task-id></task-notification>" } });
    c.result(13, "tu4", { stdout: "" });
    expect(c.w.poll(c.since + 20)).toMatchObject({ limit: { window: "five_hour" }, promptAfterLimit: false });
    c.t(30, { type: "user", message: { content: [{ type: "text", text: "and the docs?" }] } });
    expect(c.w.poll(c.since + 40).promptAfterLimit).toBe(true);
  });

  test("Codex: an exec session reported running (JSON session_id, no exit_code) until it reports an exit; a prompt after the limit", async () => {
    const d = tree();
    const f = join(d, "rollout-2026-09-26T10-00-00-35a3fc06-a27b-7106-8fd8-f2bb6d700e29.jsonl");
    const since = Date.now();
    const ts = (o: number) => new Date(since + o).toISOString();
    const put = (o: number, e: Record<string, unknown>) => writeFileSync(f, JSON.stringify({ timestamp: ts(o), ...e }) + "\n", { flag: "a" });
    put(1, { type: "session_meta", payload: { id: "35a3fc06-a27b-7106-8fd8-f2bb6d700e29", cwd: d } });
    put(2, { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: JSON.stringify({ session_id: 7, output: "" }) } });
    put(3, { type: "response_item", payload: { type: "function_call_output", call_id: "c2", output: JSON.stringify({ session_id: 8, output: "", exit_code: 0 }) } });
    const w = new CodexWatcher({ sessionsDir: d, cwd: d, session: null, since, openRollout: async () => f });
    expect((await w.refresh(since + 10)).background).toEqual(["exec:7"]);
    put(20, { type: "event_msg", payload: { type: "task_complete", error: { message: "You've hit your usage limit.", codex_error_info: "usage_limit_exceeded" } } });
    put(21, { type: "response_item", payload: { type: "function_call_output", call_id: "c3", output: JSON.stringify({ session_id: 7, exit_code: 1 }) } });
    let s = w.poll(since + 30);
    expect(s).toMatchObject({ background: [], limit: { window: "usage" }, promptAfterLimit: false });
    put(40, { type: "event_msg", payload: { type: "task_started" } });
    s = w.poll(since + 50);
    expect(s.promptAfterLimit).toBe(true);
  });
});
