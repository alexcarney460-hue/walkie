// ACCOUNTS-2 integration: `walkie claude` / `walkie codex` (runWrapped) over FAKE CLIs (test/fixtures/switch) that
// simulate usage climbing, a limit message, turn boundaries, resume by id and a refused cross-account resume. Real
// processes, real hooks (`walkie hook switch` via the injected --settings), a real vault (file key store), no daemon
// and no network. The driver pipes each turn to the fake's stdin instead of a terminal.
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { identifyCodex } from "../../src/accounts/adapters/codex.ts";
import { activeLeases, readMarks } from "../../src/accounts/leases.ts";
import { fileKeyStore } from "../../src/accounts/vault/keystore.ts";
import { Vault } from "../../src/accounts/vault/vault.ts";
import { defaultSource } from "../../src/switch/accounts.ts";
import type { Child, Spawner } from "../../src/switch/launch.ts";
import { ANSWER_PROMPT, CONTINUE_PROMPT } from "../../src/switch/summary.ts";
import { codexPinArgs } from "../../src/switch/codex-routing.ts";
import { EXIT_ALL_EXHAUSTED, refusalMarksAccount, runWrapped } from "../../src/switch/wrapper.ts";
import type { AccountSource } from "../../src/switch/accounts.ts";
import type { AccountUsage } from "../../src/protocol/accounts.ts";

const FAKES = join(import.meta.dir, "..", "fixtures", "switch");
const TOK = { a: ("sk" + "-ant-oat01-FAKESWITCHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), b: ("sk" + "-ant-oat01-FAKESWITCHBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB") };
const fp = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const IDS = { a: "a".repeat(24), b: "b".repeat(24) };

beforeAll(() => { process.env.WALKIE_VAULT_KEYSTORE = "file"; });
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

interface Driven { child: Child; out: string[]; write(line: string): void; end(): void }

/** Kept alive for the whole run: Bun closes a finalized Subprocess's stdio[3] again (see launch.ts keepAlive). */
const keepAlive: unknown[] = [];

/** Spawns like spawnInherit but with piped stdio, so the test types the turns and reads the screen. */
function pipeSpawner(launched: Driven[]): Spawner {
  return (o) => {
    const proc = Bun.spawn(o.argv, {
      cwd: o.cwd, env: o.env,
      stdio: (o.fd3 !== undefined ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"]) as ["pipe", "pipe", "pipe"],
    });
    if (o.fd3 !== undefined) {
      keepAlive.push(proc);
      const fd = (proc as unknown as { stdio: unknown[] }).stdio[3];
      if (typeof fd === "number") { const fs = require("node:fs") as typeof import("node:fs"); fs.writeSync(fd, o.fd3); fs.closeSync(fd); }
    }
    const out: string[] = [];
    const raw: Uint8Array[] = [];
    // (Under a loaded full-suite run Bun has handed back a process without pipes: then only the log is checked.)
    const stdoutStream = proc.stdout as ReadableStream<Uint8Array> | undefined;
    const stderrStream = proc.stderr as ReadableStream<Uint8Array> | undefined;
    const drained = (async () => { if (stdoutStream) for await (const c of stdoutStream) { raw.push(c); out.push(new TextDecoder().decode(c)); } })().catch(() => undefined);
    void (async () => { if (stderrStream) for await (const c of stderrStream) out.push(`[stderr] ${new TextDecoder().decode(c)}`); })().catch(() => undefined);
    const exited = Promise.all([proc.exited, drained]).then(() => proc.exitCode ?? 128 + 15);
    const child: Child = {
      pid: proc.pid, exited,
      kill: (sig) => { try { proc.kill(sig); } catch { /* gone */ } },
      async stop() { try { proc.kill("SIGTERM"); } catch { /* gone */ } return exited; },
      ...(o.captureStdout ? { output: () => Buffer.concat(raw) } : {}),
    };
    const stdin = proc.stdin as import("bun").FileSink | undefined;
    launched.push({ child, out, write: (line) => { stdin?.write(`${line}\n`); stdin?.flush(); }, end: () => { void stdin?.end(); } });
    return child;
  };
}

function env(d: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: d, WALKIE_HOME: join(d, "w"), WALKIE_SOCKET: join(d, "w", "none.sock"), WALKIE_VAULT_KEYSTORE: "file",
    WALKIE_REAL_CLAUDE: join(FAKES, "fake-claude"), WALKIE_REAL_CODEX: join(FAKES, "fake-codex"), CLAUDE_CONFIG_DIR: join(d, "cfg"),
    FAKE_LOG: join(d, "log.jsonl"), ...extra,
  };
}

async function claudeVault(d: string): Promise<void> {
  const home = join(d, "w");
  const v = Vault.open(home, { keystore: fileKeyStore(home) });
  await v.addClaude({ id: IDS.a, label: "al***@ex***.com", plan: "Max", token: TOK.a, linked: false });
  await v.addClaude({ id: IDS.b, label: "bo***@ex***.com", plan: "Pro", token: TOK.b, linked: false });
  v.close();
}

/** The credential generation of each vault account (marks bind to it). */
function genOf(d: string): Record<string, string> {
  const v = Vault.open(join(d, "w"), { keystore: fileKeyStore(join(d, "w")) });
  const out = Object.fromEntries(v.list().map((e) => [e.id, e.gen]));
  v.close();
  return out;
}

function logOf(d: string): Record<string, unknown>[] {
  const p = join(d, "log.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
}

async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting; says=${JSON.stringify(says)}; launched=${lastLaunched.map((l) => l.out.join("")).join(" || ")}; log=${lastDir ? JSON.stringify(logOf(lastDir)) : ""}; exits=${JSON.stringify(await Promise.all(lastLaunched.map((l) => Promise.race([l.child.exited, Bun.sleep(10).then(() => "running")]))))}`);
    await Bun.sleep(50);
  }
}

function tmp(): string {
  const d = mkdtempSync("/tmp/walkie-switch-");
  mkdirSync(join(d, "cfg"), { recursive: true });
  mkdirSync(join(d, "work"), { recursive: true });
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

const says: string[] = [];
let lastLaunched: Driven[] = [];
let lastDir = "";
/** The fakes live in this repository, which the real trust check rightly refuses: the tests trust them explicitly. */
const trustFakes = (_p: "claude" | "codex", resolved: string) => ({ ok: true as const, argv: [resolved], ids: [], refreshed: false });

/** Process → rollout association for the fake codex (what lsof gives for the real one): the path it logged. */
function rolloutOf(d: string) {
  return async (pid: number) => (logOf(d).find((l) => l.pid === pid && l.start)?.rollout as string | undefined) ?? null;
}

const outs: Uint8Array[] = [];
function opts(d: string, provider: "claude" | "codex", args: string[], launched: Driven[], extra: NodeJS.ProcessEnv = {}) {
  const e = env(d, extra as Record<string, string>);
  says.length = 0;
  outs.length = 0;
  lastLaunched = launched;
  lastDir = d;
  return {
    provider, args, walkieHome: join(d, "w"), env: e, cwd: join(d, "work"), source: defaultSource(join(d, "w"), e),
    spawn: pipeSpawner(launched), say: (l: string) => { says.push(l); }, tickMs: 100, settleMs: 300,
    backgroundWaitMs: 20_000, trust: trustFakes, stdout: (b: Uint8Array) => { outs.push(b); },
    ...(provider === "codex" ? { openRollout: rolloutOf(d) } : {}),
  };
}

describe("walkie claude (fake Claude Code)", () => {
  test("usage climbs past 95 %: the running session is NOT moved; the next launch starts on the account with the most room", async () => {
    const d = tmp();
    await claudeVault(d);
    const launched: Driven[] = [];
    const run = runWrapped(opts(d, "claude", ["--model", "opus", "first"], launched, { FAKE_METER: join(d, "w", "accounts.json"), FAKE_STEP: "48" }));
    await until(() => launched.length === 1 && logOf(d).some((l) => l.turn === "first"));
    launched[0]?.write("second"); // 48 % → 96 %
    await until(() => logOf(d).some((l) => l.turn === "second"));
    launched[0]?.write("third"); // 100 % on the meter, but no limit answered: the session stays
    await until(() => logOf(d).some((l) => l.turn === "third"));
    await Bun.sleep(1_000);
    expect(launched.length).toBe(1);
    expect(logOf(d).some((l) => l.sigterm)).toBe(false);
    expect(says).toEqual([]);
    launched[0]?.write("/exit");
    expect(await run).toBe(0);
    expect(activeLeases(join(d, "w"))).toEqual([]); // lease released
    expect(existsSync(join(d, "w", "run", `switch-${process.pid}.jsonl`))).toBe(false);
    // A new launch picks the account with the most room (b), with the token on fd 3.
    const next: Driven[] = [];
    const run2 = runWrapped(opts(d, "claude", ["hello"], next));
    await until(() => logOf(d).some((l) => l.turn === "hello"));
    next[0]?.write("/exit");
    expect(await run2).toBe(0);
    const starts = logOf(d).filter((l) => l.start);
    expect(starts.map((x) => x.fp)).toEqual([fp(TOK.a), fp(TOK.b)]);
    expect(starts.map((x) => x.via)).toEqual(["fd", "fd"]);
  }, 30_000);

  test("a limit message cuts a turn short: marked exhausted until its reset, resumed on the next account with a continuation", async () => {
    const d = tmp();
    await claudeVault(d);
    const launched: Driven[] = [];
    const run = runWrapped(opts(d, "claude", [], launched));
    await until(() => launched.length === 1 && logOf(d).some((l) => l.start));
    launched[0]?.write("limit");
    await until(() => launched.length === 2 && logOf(d).some((l) => l.turn === CONTINUE_PROMPT));
    launched[1]?.write("/exit");
    expect(await run).toBe(0);
    const starts = logOf(d).filter((l) => l.start);
    expect(starts[1]?.prompt).toBe(CONTINUE_PROMPT);
    expect(starts[1]?.session).toBe(starts[0]?.session);
    const marks = readMarks(join(d, "w"));
    expect(marks[IDS.a]?.state).toBe("exhausted");
    expect(marks[IDS.a]?.reason).toBe("five_hour");
    expect((marks[IDS.a]?.until ?? 0) - Date.now()).toBeGreaterThan(50 * 60_000);
    expect(says[0]).toMatch(/^walkie: switched to bo\*\*\*@ex\*\*\*\.com: al\*\*\*@ex\*\*\*\.com reached its five-hour limit/);
  }, 30_000);

  test("the other account refuses the resumed conversation (signed thinking): a new session pointed at a redacted summary FILE, once", async () => {
    const d = tmp();
    await claudeVault(d);
    const launched: Driven[] = [];
    const run = runWrapped(opts(d, "claude", [], launched, { FAKE_REFUSE_RESUME: fp(TOK.b) }));
    await until(() => launched.length === 1 && logOf(d).some((l) => l.start));
    const secret = ("AK" + "IAABCDEFGHIJKLMNOP");
    launched[0]?.write(`build the parser, the key is ${secret}`);
    await until(() => logOf(d).some((l) => typeof l.turn === "string" && (l.turn as string).startsWith("build the parser")));
    launched[0]?.write("limit");
    await until(() => launched.length === 3 && logOf(d).filter((l) => l.start).length === 3 && logOf(d).some((l) => typeof l.turn === "string" && (l.turn as string).startsWith("Walkie moved this session")));
    const starts = logOf(d).filter((l) => l.start);
    // Round 1 (Codex 3 / Opus 9): the conversation is not on the command line — only a pointer to a 0600 file.
    const argv = JSON.stringify(starts[2]?.argv);
    expect(argv).not.toContain("build the parser");
    expect(argv).not.toContain(secret);
    const file = /Read the file (\S+) /.exec(String(starts[2]?.prompt))?.[1] as string;
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const summary = readFileSync(file, "utf8");
    expect(summary).toContain("User: build the parser, the key is [REDACTED:aws_access_key]");
    expect(summary).toContain("Assistant: done: build the parser");
    expect(summary).not.toContain(secret);
    expect(summary).not.toContain(CONTINUE_PROMPT);
    launched[2]?.write("/exit");
    expect(await run).toBe(0);
    expect(existsSync(file)).toBe(false); // removed when the wrapper exits
    expect(starts.map((x) => x.fp)).toEqual([fp(TOK.a), fp(TOK.b), fp(TOK.b)]);
    expect(starts[2]?.resumed).toBe(false);
    expect(starts[2]?.session).not.toBe(starts[0]?.session);
    expect(says.some((x) => x.includes("could not resume this conversation"))).toBe(true);
  }, 30_000);

  test("headless (-p): every account out → exit 75 with the earliest reset; a subcommand passes straight through", async () => {
    const d = tmp();
    await claudeVault(d);
    const now = Date.now();
    const gens = genOf(d);
    writeFileSync(join(d, "w", "account-marks.json"), JSON.stringify({ v: 1, marks: {
      // Named resets (not exactly mark + 60 min, the signature of an older switcher's placeholder guess).
      [IDS.a]: { state: "exhausted", until: now + 3_600_000, at: now - 1_000, reason: "five_hour", gen: gens[IDS.a] },
      [IDS.b]: { state: "exhausted", until: now + 7_200_000, at: now, reason: "seven_day", gen: gens[IDS.b] },
    } }));
    const launched: Driven[] = [];
    expect(await runWrapped(opts(d, "claude", ["-p", "hi"], launched))).toBe(EXIT_ALL_EXHAUSTED);
    expect(launched.length).toBe(0);
    // RESET-CLOCK-1: plus the account that frees first, machine-readable, for an orchestrator to schedule on.
    expect(JSON.parse(says[0] as string)).toMatchObject({ walkie: "all_accounts_exhausted", waiting_until: now + 3_600_000, next_free: { at: now + 3_600_000, account: IDS.a, provider: "claude" } });
    const pass: Driven[] = [];
    const running = runWrapped(opts(d, "claude", ["mcp", "list"], pass));
    await until(() => pass.length === 1);
    pass[0]?.end();
    expect(await running).toBe(0);
    const start = logOf(d).find((l) => l.start);
    expect(start?.fp).toBe("none"); // no account injected into a subcommand
    expect(start?.argv).toEqual(["mcp", "list"]);
  }, 30_000);

  test("WALKIE_NO_SWITCH=1 or an empty vault: the real CLI untouched", async () => {
    const d = tmp();
    const launched: Driven[] = [];
    const run = runWrapped(opts(d, "claude", ["hello"], launched));
    await until(() => logOf(d).some((l) => l.turn === "hello"));
    launched[0]?.write("/exit");
    expect(await run).toBe(0);
    expect(logOf(d).find((l) => l.start)?.fp).toBe("none");
    expect(logOf(d).find((l) => l.start)?.argv).toEqual(["hello"]);
  }, 30_000);
});

describe("stepping aside", () => {
  test("a command that brings its own token keeps it (no account is injected)", async () => {
    const d = tmp();
    await claudeVault(d);
    const own = ("sk" + "-ant-oat01-CALLERSOWNTOKEN0000000000000000000000");
    const launched: Driven[] = [];
    const run = runWrapped(opts(d, "claude", ["hi"], launched, { CLAUDE_CODE_OAUTH_TOKEN: own }));
    await until(() => logOf(d).some((l) => l.turn === "hi"));
    launched[0]?.write("/exit");
    expect(await run).toBe(0);
    expect(logOf(d).find((l) => l.start)).toMatchObject({ fp: fp(own), via: "env", argv: ["hi"] });
  }, 30_000);
});

describe("walkie codex (fake Codex)", () => {
  async function codexVault(d: string): Promise<string[]> {
    const home = join(d, "w");
    const base = join(d, "codexbase");
    mkdirSync(join(base, "sessions"), { recursive: true });
    writeFileSync(join(base, "config.toml"), "model = \"fake\"\n");
    const v = Vault.open(home, { keystore: fileKeyStore(home) });
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const ids: string[] = [];
    for (const [acct, email] of [["acct-one", "carol@example.com"], ["acct-two", "dave@example.com"]] as const) {
      const dir = join(home, "vault", "codex", `pending-${acct}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const idt = `${b64({ alg: "none" })}.${b64({ email, "https://api.openai.com/auth": { chatgpt_user_id: `user-${acct}`, chatgpt_plan_type: "pro" } })}.x`;
      writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: idt, access_token: `${b64({})}.${b64({ exp: 9_999_999_999 })}.x`, account_id: acct } }), { mode: 0o600 });
      const ident = identifyCodex({ provider: "codex", dir, isDefault: false });
      if (!ident) throw new Error("fixture login not identified");
      const final = join(home, "vault", "codex", ident.id);
      renameSync(dir, final);
      v.addCodex({ id: ident.id, label: ident.label, plan: ident.plan, home: final });
      ids.push(ident.id);
    }
    v.close();
    return ids;
  }

  test("the session hits its usage limit: `codex resume <id>` on the next account; login stays per account", async () => {
    const d = tmp();
    const ids = await codexVault(d);
    const launched: Driven[] = [];
    const o = opts(d, "codex", ["-m", "gpt-fake", "start"], launched, { CODEX_HOME: join(d, "codexbase"), FAKE_METER: join(d, "meter.json"), FAKE_STEP: "48" });
    const run = runWrapped(o);
    await until(() => logOf(d).some((l) => l.turn === "start"));
    launched[0]?.write("more"); // 96 %: still no switch
    await until(() => logOf(d).some((l) => l.turn === "more"));
    await Bun.sleep(800);
    expect(launched.length).toBe(1);
    launched[0]?.write("limit");
    await until(() => launched.length === 2 && logOf(d).filter((l) => l.start).length === 2);
    launched[1]?.write("after");
    await until(() => logOf(d).some((l) => l.turn === "after"));
    launched[1]?.write("/exit");
    expect(await run).toBe(0);
    const starts = logOf(d).filter((l) => l.start);
    expect(starts[0]?.fp).not.toBe(starts[1]?.fp);
    expect(starts[1]?.resumed).toBe(true);
    expect(starts[1]?.session).toBe(starts[0]?.session);
    // Rounds 5 and 7: pins at the root and right after the subcommand (a subcommand's own -c list replaces the root one).
    const pins = codexPinArgs();
    expect((starts[0]?.argv as string[]).slice(0, pins.length)).toEqual(pins);
    // Round 10 (Opus r8): the id and prompt come after `--` (an image list among the options cannot swallow them).
    expect((starts[1]?.argv as string[])).toEqual([...pins, "resume", ...pins, "-m", "gpt-fake", ...pins, "--", String(starts[0]?.session), CONTINUE_PROMPT]);
    expect(starts[1]?.argv).toContain(CONTINUE_PROMPT);
    expect(says).toEqual([expect.stringMatching(/^walkie: switched to (ca|da)\*\*\*@ex\*\*\*\.com: (ca|da)\*\*\*@ex\*\*\*\.com reached its usage limit/)]);
    // One rollout file (resumed in place, through the shared sessions/ link); the user's own CODEX_HOME has no auth.json.
    const day = readdirSync(join(d, "codexbase", "sessions"));
    expect(day.length).toBe(1);
    expect(existsSync(join(d, "codexbase", "auth.json"))).toBe(false);
    expect(ids.length).toBe(2);
    // The session's reading was recorded for the selector and the daemon.
    const readings = JSON.parse(readFileSync(join(d, "w", "session-readings.json"), "utf8")) as { readings: Record<string, { windows: { used_pct: number }[] }> };
    expect(Object.values(readings.readings).some((r) => r.windows.some((w) => w.used_pct === 96 || w.used_pct === 100))).toBe(true);
  }, 30_000);

  test("an exec session still running at the limit (JSON session_id, no exit_code): the move waits for its exit", async () => {
    const d = tmp();
    await codexVault(d);
    const launched: Driven[] = [];
    const run = runWrapped(opts(d, "codex", ["start"], launched, { CODEX_HOME: join(d, "codexbase") }));
    await until(() => logOf(d).some((l) => l.turn === "start"));
    launched[0]?.write("execbg:2500");
    await until(() => logOf(d).some((l) => l.turn === "execbg:2500"));
    launched[0]?.write("limit");
    await until(() => says.some((x) => x.includes("waiting for 1 background task")));
    expect(launched.length).toBe(1);
    await until(() => launched.length === 2, 20_000);
    const log = logOf(d);
    expect(log.findIndex((l) => l.sigterm)).toBeGreaterThan(log.findIndex((l) => l.execDone === 3)); // ended after the exec exited
    launched[1]?.write("/exit");
    expect(await run).toBe(0);
  }, 40_000);
});

// ---- round 1 (Codex + Opus audits) ------------------------------------------------------------------------

/** Sets an account's pooled reading in the file the switcher falls back to (accounts.json). */
function setUsage(d: string, id: string, used: number, state: "ok" | "exhausted" = "ok", until: number | null = null): void {
  const path = join(d, "w", "accounts.json");
  const data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as { version: 1; records: Record<string, unknown>[]; kimi_aliases: object } : { version: 1 as const, records: [], kimi_aliases: {} };
  const now = Date.now();
  const rec = { id, provider: "claude", label: "Claude account", plan: null, dir: `vault:${id}`, is_default: false, last_seen: now, vault: true,
    reading: { at: now, state, reason: state === "exhausted" ? "limit_reached" : null, source: "api", until, windows: [{ kind: "session", used_pct: used, resets_at: until, window_s: 18000, scope: null }] } };
  writeFileSync(path, JSON.stringify({ ...data, records: [...data.records.filter((r) => r.id !== id), rec] }));
}

describe("round 3: hard-limit switching waits for background work, bounded; a prompt after the limit is answered", () => {
  test("a background shell (backgroundTaskId): a one-line notice, then the move once its <task-notification> reports it done", async () => {
    const d = tmp();
    await claudeVault(d);
    const launched: Driven[] = [];
    const run = runWrapped(opts(d, "claude", [], launched));
    await until(() => launched.length === 1 && logOf(d).some((l) => l.start));
    launched[0]?.write("bg:2500");
    await until(() => logOf(d).some((l) => l.turn === "bg:2500"));
    launched[0]?.write("limit");
    await until(() => says.some((x) => x.includes("waiting for 1 background task")));
    expect(launched.length).toBe(1);
    expect(logOf(d).some((l) => l.sigterm)).toBe(false);
    await until(() => launched.length === 2 && logOf(d).filter((l) => l.start).length === 2, 20_000);
    const log = logOf(d);
    expect(log.findIndex((l) => l.sigterm)).toBeGreaterThan(log.findIndex((l) => l.backgroundDone === "bash1"));
    expect(says.filter((x) => x.includes("waiting for"))).toHaveLength(1); // one line, not a stream
    expect(logOf(d).filter((l) => l.start)[1]?.prompt).toBe(CONTINUE_PROMPT);
    launched[1]?.write("/exit");
    expect(await run).toBe(0);
  }, 40_000);

  test("an async agent (run_in_background logged as the STRING \"true\", status async_launched) that never reports: the wait is bounded", async () => {
    const d = tmp();
    await claudeVault(d);
    const launched: Driven[] = [];
    const run = runWrapped({ ...opts(d, "claude", [], launched), backgroundWaitMs: 1_500 });
    await until(() => launched.length === 1 && logOf(d).some((l) => l.start));
    launched[0]?.write("agent");
    await until(() => logOf(d).some((l) => l.turn === "agent"));
    const limitAt = Date.now();
    launched[0]?.write("limit");
    await until(() => says.some((x) => x.includes("waiting for 1 background task")));
    await until(() => launched.length === 2, 20_000);
    expect(Date.now() - limitAt).toBeGreaterThanOrEqual(1_500);
    expect(logOf(d).some((l) => l.backgroundDone)).toBe(false); // it never finished: moved at the bound
    launched[1]?.write("/exit");
    expect(await run).toBe(0);
  }, 40_000);

  test("a prompt typed after the limit (while the move waits): the resumed session is asked to answer it", async () => {
    const d = tmp();
    await claudeVault(d);
    const launched: Driven[] = [];
    const run = runWrapped(opts(d, "claude", [], launched));
    await until(() => launched.length === 1 && logOf(d).some((l) => l.start));
    launched[0]?.write("bg:3000");
    await until(() => logOf(d).some((l) => l.turn === "bg:3000"));
    launched[0]?.write("limit");
    await until(() => says.some((x) => x.includes("waiting for")));
    launched[0]?.write("what about the tests?");
    await until(() => launched.length === 2 && logOf(d).filter((l) => l.start).length === 2, 20_000);
    const starts = logOf(d).filter((l) => l.start);
    expect(starts[1]).toMatchObject({ prompt: ANSWER_PROMPT, resumed: true, session: starts[0]?.session, fp: fp(TOK.b) });
    launched[1]?.write("/exit");
    expect(await run).toBe(0);
  }, 40_000);
});

describe("round 1: trust, binding, exhaustion, failures, headless output", () => {
  test("a CLI that is not the recorded trusted binary gets no credentials (one line says why)", async () => {
    const d = tmp();
    await claudeVault(d);
    const launched: Driven[] = [];
    const run = runWrapped({ ...opts(d, "claude", ["hi"], launched), trust: () => ({ ok: false, why: "/repo/node_modules/.bin/claude is in a node_modules/.bin \u001b[31mX" }) });
    await until(() => logOf(d).some((l) => l.turn === "hi"));
    launched[0]?.write("/exit");
    expect(await run).toBe(0);
    expect(logOf(d).find((l) => l.start)?.fp).toBe("none");
    expect(says[0]).toContain("running claude without Walkie accounts");
    expect(says[0]).not.toContain("\u001b"); // escape sequences stripped
  }, 30_000);

  test("Codex whose rollout cannot be tied to the process: no switching (never a guessed session)", async () => {
    const d = tmp();
    const base = join(d, "codexbase");
    const home = join(d, "w");
    const v = Vault.open(home, { keystore: fileKeyStore(home) });
    const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
    for (const acct of ["acct-one", "acct-two"]) {
      const dir = join(home, "vault", "codex", `pending-${acct}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: `${b64({})}.${b64({ email: `${acct}@example.com` })}.x`, access_token: `${b64({})}.${b64({ exp: 9_999_999_999 })}.x`, account_id: acct } }), { mode: 0o600 });
      const ident = identifyCodex({ provider: "codex", dir, isDefault: false });
      if (!ident) throw new Error("fixture");
      renameSync(dir, join(home, "vault", "codex", ident.id));
      v.addCodex({ id: ident.id, label: ident.label, plan: null, home: join(home, "vault", "codex", ident.id) });
    }
    v.close();
    const launched: Driven[] = [];
    const o = opts(d, "codex", ["start"], launched, { CODEX_HOME: base, FAKE_METER: join(d, "meter.json"), FAKE_STEP: "97" });
    const { openRollout: _drop, ...noAssociation } = o;
    const run = runWrapped(noAssociation);
    await until(() => logOf(d).some((l) => l.turn === "start"));
    launched[0]?.write("limit");
    await until(() => logOf(d).some((l) => l.fp && l.turn === undefined && l.start === undefined) || true);
    await Bun.sleep(1_500);
    // Unbound: the wrapper reads nothing of this session, so it never ends or resumes it (the CLI shows its limit).
    expect(launched.length).toBe(1);
    expect(logOf(d).some((l) => l.sigterm)).toBe(false);
    expect(says).toEqual([]);
    // The shared entries were created in the base CODEX_HOME before linking (Opus 1).
    expect(existsSync(join(base, "sessions"))).toBe(true);
    launched[0]?.write("/exit");
    expect(await run).toBe(0);
  }, 30_000);

  test("every account known exhausted with no reset time: headless exits 75, interactive waits — never the own login", async () => {
    const d = tmp();
    await claudeVault(d);
    setUsage(d, IDS.a, 100, "exhausted", null);
    setUsage(d, IDS.b, 100, "exhausted", null);
    const launched: Driven[] = [];
    expect(await runWrapped(opts(d, "claude", ["-p", "hi"], launched))).toBe(EXIT_ALL_EXHAUSTED);
    expect(JSON.parse(says[0] as string)).toEqual({ walkie: "all_accounts_exhausted", waiting_until: null, next_free: null });
    const inter: Driven[] = [];
    const code = await runWrapped({ ...opts(d, "claude", [], inter), sleep: async () => { process.emit("SIGINT"); } });
    expect(code).toBe(130); // stopped while waiting (Ctrl-C)
    expect(inter.length).toBe(0);
    expect(says[0]).toContain("no reset time is known");
  }, 30_000);

  test("a relaunch whose account fails continues the SAME session on the CLI's own login", async () => {
    const d = tmp();
    await claudeVault(d);
    const launched: Driven[] = [];
    const o = opts(d, "claude", [], launched);
    let calls = 0;
    const source = { ...o.source, credentials: async (c: Parameters<typeof o.source.credentials>[0], a: string | null) => {
      if (++calls > 1) throw new Error("vault read failed \u001b]0;evil\u0007");
      return o.source.credentials(c, a);
    } };
    const run = runWrapped({ ...o, source });
    await until(() => launched.length === 1 && logOf(d).some((l) => l.start));
    launched[0]?.write("limit");
    await until(() => launched.length === 2 && logOf(d).filter((l) => l.start).length === 2);
    const starts = logOf(d).filter((l) => l.start);
    expect(starts[1]).toMatchObject({ fp: "none", resumed: true, session: starts[0]?.session });
    expect(says.some((x) => x.includes("continuing on claude's own login"))).toBe(true);
    expect(says.join("\n")).not.toContain("\u001b");
    launched[1]?.write("/exit");
    expect(await run).toBe(0);
  }, 30_000);

  test("headless -p --output-format json hitting a limit and retried on the next account prints ONE result", async () => {
    const d = tmp();
    await claudeVault(d);
    // Account a hits its limit on this prompt; the retry (--resume, continuation prompt) on b answers.
    const launched: Driven[] = [];
    const code = await runWrapped(opts(d, "claude", ["-p", "--output-format", "json", "limit"], launched));
    const text = Buffer.concat(outs).toString("utf8").trim();
    const results = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { is_error: boolean; result: string });
    expect({ n: results.length, code, says, log: logOf(d), out: launched.map((l) => l.out.join("")) }).toMatchObject({ n: 1 });
    expect(results[0]?.is_error).toBe(false);
    expect(code).toBe(0);
    expect(logOf(d).filter((l) => l.start).map((l) => l.fp)).toEqual([fp(TOK.a), fp(TOK.b)]);
  }, 30_000);
});

// ---- round 2 (Codex + Opus re-audits) ---------------------------------------------------------------------

describe("round 2: recovery", () => {
  test("a failed token hand-over: the child is ended and the session continues on the CLI's own login", async () => {
    const d = tmp();
    await claudeVault(d);
    const launched: Driven[] = [];
    const o = opts(d, "claude", ["hi"], launched);
    let first = true;
    const spawn: Spawner = (so) => {
      const c = o.spawn(so);
      if (first && so.fd3 !== undefined) { first = false; return { ...c, handoffError: "EPIPE" }; }
      return c;
    };
    const run = runWrapped({ ...o, spawn });
    // (The first child is ended at once — it may not even get to log its start.)
    await until(() => launched.length === 2 && logOf(d).some((l) => l.start && l.fp === "none"));
    expect(await Promise.race([launched[0]?.child.exited, Bun.sleep(5_000).then(() => "running")])).not.toBe("running");
    const own = logOf(d).filter((l) => l.start).at(-1);
    expect(own?.fp).toBe("none"); // own login, no Walkie credential
    expect(says.some((x) => x.includes("could not be handed over"))).toBe(true);
    await until(() => logOf(d).some((l) => l.turn === "hi" && l.pid === own?.pid));
    launched[1]?.write("/exit");
    expect(await run).toBe(0);
  }, 40_000);
});

// ---- round 4 (Codex r4 + Opus r4) -------------------------------------------------------------------------

describe("round 4: routing pinned in --settings, transient throttles, stopped watches", () => {
  test("a caller's --settings trying to redirect the endpoint: ONE merged --settings with the official endpoint, its own hook kept", async () => {
    const d = tmp();
    await claudeVault(d);
    const launched: Driven[] = [];
    const user = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1/collector", HTTPS_PROXY: "http://127.0.0.1:2", MY_VAR: "kept" }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "true # mine" }] }] } });
    const run = runWrapped(opts(d, "claude", ["--settings", user, "hi"], launched));
    await until(() => logOf(d).some((l) => l.turn === "hi"));
    launched[0]?.write("limit");
    await until(() => launched.length === 2 && logOf(d).filter((l) => l.start).length === 2);
    launched[1]?.write("/exit");
    expect(await run).toBe(0);
    for (const s of logOf(d).filter((l) => l.start)) {
      expect(s.fp).not.toBe("none");
      expect(s.settingsCount).toBe(1);
      expect(s.settingsEnv).toEqual({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", HTTPS_PROXY: "", MY_VAR: "kept" });
      expect((s.sessionStartHooks as string[])[0]).toBe("true # mine");
      expect((s.sessionStartHooks as string[])[1]).toContain("hook switch");
    }
  }, 30_000);

  test("a --settings file that cannot be read: the run gets no Walkie credentials (one line says why)", async () => {
    const d = tmp();
    await claudeVault(d);
    const launched: Driven[] = [];
    const run = runWrapped(opts(d, "claude", ["--settings", "missing-settings.json", "hi"], launched));
    await until(() => logOf(d).some((l) => l.turn === "hi"));
    launched[0]?.write("/exit");
    expect(await run).toBe(0);
    expect(logOf(d).find((l) => l.start)?.fp).toBe("none");
    expect(says[0]).toContain("your --settings could not be read");
  }, 30_000);

  test("a transient per-minute rate limit never moves the session", async () => {
    const d = tmp();
    await claudeVault(d);
    const launched: Driven[] = [];
    const run = runWrapped(opts(d, "claude", [], launched));
    await until(() => launched.length === 1 && logOf(d).some((l) => l.start));
    launched[0]?.write("ratelimit");
    await until(() => logOf(d).some((l) => l.turn === "ratelimit"));
    await Bun.sleep(1_200);
    expect(launched.length).toBe(1);
    expect(logOf(d).some((l) => l.sigterm)).toBe(false);
    expect(readMarks(join(d, "w"))[IDS.a]).toBeUndefined();
    launched[0]?.write("/exit");
    expect(await run).toBe(0);
  }, 30_000);

  test("a Monitor still watching at the bound: moved, and the resumed session is told the watch was stopped", async () => {
    const d = tmp();
    await claudeVault(d);
    const launched: Driven[] = [];
    const run = runWrapped({ ...opts(d, "claude", [], launched), backgroundWaitMs: 1_000 });
    await until(() => launched.length === 1 && logOf(d).some((l) => l.start));
    launched[0]?.write("monitor");
    await until(() => logOf(d).some((l) => l.turn === "monitor"));
    launched[0]?.write("limit");
    await until(() => says.some((x) => x.includes("waiting for 1 background task")));
    await until(() => launched.length === 2 && logOf(d).filter((l) => l.start).length === 2, 20_000);
    const prompt = String(logOf(d).filter((l) => l.start)[1]?.prompt);
    expect(prompt.startsWith(CONTINUE_PROMPT)).toBe(true);
    expect(prompt).toContain("stopped by the move: Monitor: deploy watch (monitor1)");
    launched[1]?.write("/exit");
    expect(await run).toBe(0);
  }, 40_000);
});

// ---- round 5 (Codex r5 + Opus r5) -------------------------------------------------------------------------

describe("round 5: Codex routing, refused tokens", () => {
  test("a caller's -c that re-routes Codex: no Walkie credentials for that run", async () => {
    const d = tmp();
    const base = join(d, "codexbase");
    mkdirSync(join(base, "sessions"), { recursive: true });
    const home = join(d, "w");
    const v = Vault.open(home, { keystore: fileKeyStore(home) });
    const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
    const dir = join(home, "vault", "codex", "pending-one");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: `${b64({})}.${b64({ email: "one@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } })}.x`, access_token: `${b64({})}.${b64({ exp: 9_999_999_999 })}.x`, account_id: "acct-one" } }), { mode: 0o600 });
    const ident = identifyCodex({ provider: "codex", dir, isDefault: false });
    if (!ident) throw new Error("fixture");
    renameSync(dir, join(home, "vault", "codex", ident.id));
    v.addCodex({ id: ident.id, label: ident.label, plan: null, home: join(home, "vault", "codex", ident.id) });
    v.close();
    const launched: Driven[] = [];
    const run = runWrapped(opts(d, "codex", ["-c", 'model_provider="collector"', "hi"], launched, { CODEX_HOME: base }));
    await until(() => logOf(d).some((l) => l.turn === "hi"));
    launched[0]?.write("/exit");
    expect(await run).toBe(0);
    expect(logOf(d).find((l) => l.start)?.fp).toBe(createHash("sha256").update("none").digest("hex").slice(0, 12)); // the base home: no account login
    expect(says[0]).toContain("your model_provider would send the account's requests elsewhere");
  }, 30_000);

  test("round 8: a codex line that cannot be read with certainty (an unknown option): no Walkie credentials", async () => {
    const d = tmp();
    const base = join(d, "codexbase");
    mkdirSync(join(base, "sessions"), { recursive: true });
    const home = join(d, "w");
    const v = Vault.open(home, { keystore: fileKeyStore(home) });
    const b64 = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url");
    const dir = join(home, "vault", "codex", "pending-one");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: `${b64({})}.${b64({ email: "one@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } })}.x`, access_token: `${b64({})}.${b64({ exp: 9_999_999_999 })}.x`, account_id: "acct-one" } }), { mode: 0o600 });
    const ident = identifyCodex({ provider: "codex", dir, isDefault: false });
    if (!ident) throw new Error("fixture");
    renameSync(dir, join(home, "vault", "codex", ident.id));
    v.addCodex({ id: ident.id, label: ident.label, plan: null, home: join(home, "vault", "codex", ident.id) });
    v.close();
    const launched: Driven[] = [];
    const run = runWrapped(opts(d, "codex", ["--not-a-codex-option", "hi"], launched, { CODEX_HOME: base }));
    await until(() => logOf(d).some((l) => l.turn === "hi"));
    launched[0]?.write("/exit");
    expect(await run).toBe(0);
    expect(logOf(d).find((l) => l.start)?.fp).toBe(createHash("sha256").update("none").digest("hex").slice(0, 12)); // the base home: no account login
    expect(says[0]).toContain("this codex command line could not be read with certainty (--not-a-codex-option is not an option of `codex`");
  }, 30_000);

  test("one refused token moves the session but excludes nothing; a second refusal confirms re-login", async () => {
    const d = tmp();
    await claudeVault(d);
    const once = async () => {
      const before = logOf(d).filter((l) => l.start).length;
      const launched: Driven[] = [];
      const run = runWrapped(opts(d, "claude", [], launched));
      await until(() => launched.length === 1 && logOf(d).filter((l) => l.start).length === before + 1);
      const first = logOf(d).filter((l) => l.start).at(-1)?.fp;
      launched[0]?.write("refused");
      await until(() => launched.length === 2 && logOf(d).filter((l) => l.start).length === before + 2);
      expect(logOf(d).filter((l) => l.start).at(-1)?.fp).toBe(fp(TOK.b)); // moved to the other account
      launched[1]?.write("/exit");
      expect(await run).toBe(0);
      return first;
    };
    expect(await once()).toBe(fp(TOK.a));
    expect(readMarks(join(d, "w"))[IDS.a]).toMatchObject({ state: "relogin", strikes: 1 });
    expect(await once()).toBe(fp(TOK.a)); // one strike excluded nothing: a is picked again
    expect(readMarks(join(d, "w"))[IDS.a]).toMatchObject({ state: "relogin", strikes: 2 });
    const launched: Driven[] = [];
    const run = runWrapped(opts(d, "claude", ["hi"], launched));
    await until(() => logOf(d).filter((l) => l.turn === "hi").length >= 1);
    launched[0]?.write("/exit");
    expect(await run).toBe(0);
    expect(logOf(d).filter((l) => l.start).at(-1)?.fp).toBe(fp(TOK.b)); // confirmed: a is out
  }, 60_000);

  test("round 7 (Codex r6 3): one headless refusal is ONE strike (supervision and exit handling see the same event)", async () => {
    const d = tmp();
    await claudeVault(d);
    const launched: Driven[] = [];
    await runWrapped(opts(d, "claude", ["-p", "refused"], launched));
    expect(readMarks(join(d, "w"))[IDS.a]).toMatchObject({ state: "relogin", strikes: 1 });
  }, 30_000);
});

describe("COMPANY POOL: the personal reserve during a borrowed session (Codex p8 HIGH 2)", () => {
  test("a pooled teammate login whose room falls to the last 10 % is left like at a limit — resumed elsewhere, no mark on it", async () => {
    const d = tmp();
    const state = { aOut: true, bLeft: 50 };
    const at = (now: number, left: number): AccountUsage => ({ at: now, state: "ok", reason: null, source: "api", until: null, windows: [{ kind: "session", used_pct: 100 - left, resets_at: now + 3_600_000, window_s: 18_000, scope: null }] });
    const source: AccountSource = {
      hasAccounts: () => true,
      available: async () => true,
      gather: async (_p, now) => [
        { id: IDS.a, provider: "claude", label: "al***@ex***.com", owner: null, own: true, source: "local", leases: 0,
          usage: state.aOut ? { at: now, state: "exhausted", reason: "limit_reached", source: "api", windows: [], until: now + 3_600_000 } : at(now, 80) },
        { id: IDS.b, provider: "claude", label: "bo***@ex***.com", owner: "kira", own: false, pooled: true, source: "peer", node: "n-kira", leases: 0, usage: at(now, state.bLeft) },
      ],
      credentials: async (c) => ({ token: c.id === IDS.a ? TOK.a : TOK.b, grant: "00000000000000aa" }),
    };
    const launched: Driven[] = [];
    const run = runWrapped({ ...opts(d, "claude", [], launched), source, reserveCheckMs: 100 });
    await until(() => launched.length === 1 && logOf(d).some((l) => l.start));
    expect(logOf(d).filter((l) => l.start).at(-1)?.fp).toBe(fp(TOK.b)); // own account out: the pooled one
    state.bLeft = 6; // its person's last 10 % reached
    state.aOut = false;
    await until(() => launched.length === 2 && logOf(d).filter((l) => l.start).length === 2);
    expect(logOf(d).filter((l) => l.start).at(-1)?.fp).toBe(fp(TOK.a));
    expect(says.some((x) => x.includes("bo***@ex***.com reached the last 10% kept for @kira"))).toBe(true);
    launched[1]?.write("/exit");
    expect(await run).toBe(0);
    expect(readMarks(join(d, "w"))).toEqual({}); // the login is not out for its person: nothing marked
  }, 30_000);

  test("a leased Codex copy that is refused has expired: avoided for the run, never a lasting re-login mark (Codex p8 MEDIUM 3)", () => {
    expect(refusalMarksAccount({ source: "peer", provider: "codex" })).toBe(false);
    expect(refusalMarksAccount({ source: "peer", provider: "claude" })).toBe(true); // a setup-token does not expire so
    expect(refusalMarksAccount({ source: "local", provider: "codex" })).toBe(true);
  });
});

