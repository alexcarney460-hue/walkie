// A gated seat-user run (Codex pre.12 audit MUST 1, SHOULD 1): the spec carries no login; the runner prepares the run,
// says `prepared`, and starts the runtime only on the host's `go`, which carries the login. An abort or a malformed
// `go` stops it with nothing started. And a seat carries only its own runtime's login (MUST 2). Fictional values only.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUNNER_PROTOCOL, parseGo, validSpec } from "../../src/daemon/seats/runner.ts";
import { RunnerChild } from "../../src/daemon/seats/runner-child.ts";
import { ownLoginOnly } from "../../src/daemon/seats/runtime.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const TOKEN = "sk-ant-oat01-FAKEGATETOKEN0123456789abcdefghijk";
const CREDS = JSON.stringify({ claudeAiOauth: { accessToken: "fake-access", expiresAt: 4_102_444_800_000, scopes: ["user:inference"] } });
const base = { rv: RUNNER_PROTOCOL, dir_name: "20261002-230000-gate01-1", bin: "/bin/echo", args: [], env: {}, token: "cd".repeat(32), socket: "/tmp/walkie-no-such.sock", bundle_len: 0, prompt_len: 1 };

describe("the gated spec and its go line", () => {
  test("a gated spec carries no login; gate must be a boolean", () => {
    expect(validSpec({ ...base, gate: true })).not.toBeNull();
    expect(validSpec({ ...base, gate: "yes" })).toBeNull();
    expect(validSpec({ ...base, gate: true, claude_credentials: CREDS })).toBeNull();
    expect(validSpec({ ...base, gate: true, codex_auth: "{}" })).toBeNull();
    expect(validSpec({ ...base, gate: true, env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } })).toBeNull();
    expect(validSpec({ ...base, claude_credentials: CREDS })).not.toBeNull(); // ungated (an older host): unchanged
  });

  test("go takes only the three ways a login comes in, each bounded", () => {
    expect(parseGo(JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } }))).toEqual({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } });
    expect(parseGo(JSON.stringify({ claude_credentials: CREDS, codex_auth: "{}" }))).not.toBeNull();
    expect(parseGo("{}")).toEqual({});
    expect(parseGo(JSON.stringify({ env: { PATH: "/tmp/evil" } }))).toBeNull();
    expect(parseGo(JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, LD_PRELOAD: "/x" } }))).toBeNull();
    expect(parseGo(JSON.stringify({ bin: "/bin/sh" }))).toBeNull();
    expect(parseGo(JSON.stringify({ claude_credentials: "" }))).toBeNull();
    expect(parseGo(JSON.stringify({ codex_auth: "x".repeat(64 * 1024 + 1) }))).toBeNull();
    expect(parseGo("[]")).toBeNull();
    expect(parseGo("not json")).toBeNull();
  });

  test("a Codex, Kimi or Grok seat never carries the machine's Claude token; a Claude seat keeps it", () => {
    const env = { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: TOKEN, CODEX_HOME: "/h/.codex" };
    for (const rt of ["codex", "kimi", "grok"] as const) expect(ownLoginOnly(env, rt)).toEqual({ PATH: "/usr/bin", CODEX_HOME: "/h/.codex" });
    expect(ownLoginOnly(env, "claude")).toEqual(env);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN); // the input is left as it was
  });
});

/** A fake runtime that records, per call, whether a login was visible to it (its --help probe included). */
function world(): { root: string; bin: string; log: string; rows: () => Array<Record<string, unknown>> } {
  const root = mkdtempSync("/tmp/walkie-runner-gate-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, "rt.jsonl");
  const bin = join(root, "fake-rt");
  writeFileSync(bin, [
    "#!/bin/sh",
    'h=0; [ "$1" = "--help" ] && h=1',
    'f=0; [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ] && f=1',
    't=0; [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && t=1',
    'echo "{\\"help\\":$h,\\"cred_file\\":$f,\\"token\\":$t}" >> "$GATE_LOG"',
    '[ $h = 1 ] && { echo "usage"; exit 0; }',
    "cat > /dev/null", ""].join("\n"));
  chmodSync(bin, 0o755);
  return { root, bin, log, rows: () => !existsSync(log) ? [] : readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
}

/** Starts the real runner (fake seat-user scope) with a gated spec; returns its stdout lines as they arrive. */
function startRunner(w: ReturnType<typeof world>): { p: ReturnType<typeof Bun.spawn>; lines: string[]; send: (line: string) => void } {
  const spec = { ...base, bin: w.bin, args: [], env: { PATH: "/usr/bin:/bin", GATE_LOG: w.log }, probe_permission_prompts: true, gate: true };
  const p = Bun.spawn([process.execPath, CLI, "seat-runner"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", WALKIE_SEAT_RUNNER_HOME: w.root, WALKIE_SEAT_FAKE_UID: `gate-${process.pid}-${Math.random().toString(16).slice(2)}` },
  });
  cleanups.push(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } });
  const sink = p.stdin as import("bun").FileSink;
  sink.write(`${JSON.stringify(spec)}\n`);
  sink.write("\n"); // the one-byte prompt
  sink.flush();
  const lines: string[] = [];
  void (async () => {
    const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const r = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (r.done || !r.value) break;
      buf += dec.decode(r.value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
  })();
  return { p, lines, send: (line) => { sink.write(`${line}\n`); sink.flush(); } };
}

async function until(fn: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

describe("the gated runner", () => {
  test("prepares with no login anywhere, then starts the runtime with the login that came with go", async () => {
    const w = world();
    const r = startRunner(w);
    await until(() => r.lines.includes('r {"prepared":true}'), "prepared");
    // Prepared: the help probe has run, and nothing of a login is on disk.
    expect(w.rows()).toEqual([{ help: 1, cred_file: 0, token: 0 }]);
    expect(r.lines.some((l) => l.startsWith('r {"ready"'))).toBe(false);
    r.send(`go ${JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, claude_credentials: CREDS })}`);
    await until(() => r.lines.some((l) => l.startsWith('r {"exit"')), "the runtime's exit");
    expect(w.rows()).toEqual([{ help: 1, cred_file: 0, token: 0 }, { help: 0, cred_file: 1, token: 1 }]);
  }, 30_000);

  test("an abort while it waits stops it: the runtime never starts", async () => {
    const w = world();
    const r = startRunner(w);
    await until(() => r.lines.includes('r {"prepared":true}'), "prepared");
    r.send("abort");
    await r.p.exited;
    expect(r.lines.some((l) => l.startsWith('r {"ready"'))).toBe(false);
    expect(r.lines.some((l) => l.includes('"error":"stopped"'))).toBe(true);
    expect(w.rows().filter((x) => x.help === 0)).toEqual([]);
  }, 30_000);

  test("a malformed go stops it, and so does the end of its stdin", async () => {
    for (const end of ["bad-go", "eof"] as const) {
      const w = world();
      const r = startRunner(w);
      await until(() => r.lines.includes('r {"prepared":true}'), "prepared");
      if (end === "bad-go") r.send(`go ${JSON.stringify({ env: { PATH: "/tmp/evil" } })}`);
      else (r.p.stdin as import("bun").FileSink).end();
      await r.p.exited;
      expect(r.lines.some((l) => l.startsWith('r {"ready"'))).toBe(false);
      expect(w.rows().filter((x) => x.help === 0)).toEqual([]);
    }
  }, 40_000);
});

describe("the host's side of the gate", () => {
  /** A stand-in runner (as a script) that says what `say` lists, then records each control line it gets in `seen`. */
  function fakeRunner(say: string[], seen = "/dev/null"): string[] {
    const script = [
      'const fs = require("node:fs");',
      'const out = (s) => process.stdout.write(s + "\\n");',
      `for (const s of ${JSON.stringify(say)}) out(s);`,
      'let buf = ""; let head = false;',
      'process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1);',
      // The prompt's bytes (no newline of their own) run into the first control line: what follows them is the line.
      `  if (!head) { head = true; continue; } const k = l.indexOf("go "); if (k >= 0) fs.appendFileSync(${JSON.stringify(seen)}, l.slice(k) + "\\n"); } });`,
      "setTimeout(() => process.exit(0), 1500);",
    ].join("\n");
    return [process.execPath, "-e", script];
  }
  const spec = { rv: RUNNER_PROTOCOL, dir_name: base.dir_name, bin: "/bin/echo", args: [], env: {}, token: base.token, socket: base.socket, gate: true };

  test("prepared resolves true on the runner's word, and go sends the login as one line", async () => {
    const dir = mkdtempSync("/tmp/walkie-runner-gate-host-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const seen = join(dir, "seen.txt");
    const rc = new RunnerChild<string>(fakeRunner(['r {"prepared":true}'], seen), spec, null, "p", () => undefined, () => null);
    expect(await rc.prepared).toBe(true);
    rc.go({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } });
    await rc.done;
    expect(rc.ungated).toBe(false);
    expect(readFileSync(seen, "utf8")).toBe(`go ${JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN } })}\n`);
  }, 10_000);

  test("a runner that starts its runtime without saying prepared (an older copy) is flagged, and prepared is false", async () => {
    const rc = new RunnerChild<string>(fakeRunner(['r {"ready":{"dir":"/tmp/x","cwd":"/tmp/x","base":null,"pid":12345}}']), spec, null, "p", () => undefined, () => null);
    expect(await rc.prepared).toBe(false);
    expect(rc.ungated).toBe(true);
    await rc.done;
  }, 10_000);

  test("a runner that fails first resolves prepared false, not ungated", async () => {
    const rc = new RunnerChild<string>(fakeRunner(['r {"error":"the seat request ended early"}']), spec, null, "p", () => undefined, () => null);
    expect(await rc.prepared).toBe(false);
    expect(rc.ungated).toBe(false);
    await rc.done;
  }, 10_000);
});

describe("the credential a seat bound (Codex pre.12 audit r2)", () => {
  test("the same lending machine, or this machine's entry of the same generation, is the same source; anything else is not", async () => {
    const { sameAccountSource } = await import("../../src/daemon/seats/account.ts");
    const peer = (node: string) => ({ kind: "peer" as const, id: "a".repeat(24), owner: "bea", node, provider: "claude" as const });
    const local = (gen: string) => ({ kind: "local" as const, entry: { id: "a".repeat(24), provider: "claude", gen } as never });
    expect(sameAccountSource(peer("n1"), peer("n1"))).toBe(true);
    expect(sameAccountSource(peer("n1"), peer("n2"))).toBe(false);
    expect(sameAccountSource(local("g1"), local("g1"))).toBe(true);
    expect(sameAccountSource(local("g1"), local("g2"))).toBe(false);
    expect(sameAccountSource(local("g1"), peer("n1"))).toBe(false);
  });
});

test("a hand-out's generation counts when both sides report one (Codex pre.12 audit r3)", async () => {
  const { sameAccountSource } = await import("../../src/daemon/seats/account.ts");
  const peer = (gen?: string) => ({ kind: "peer" as const, id: "a".repeat(24), owner: "bea", node: "n1", provider: "claude" as const, ...(gen ? { gen } : {}) });
  expect(sameAccountSource(peer("g1"), peer("g1"))).toBe(true);
  expect(sameAccountSource(peer("g2"), peer("g1"))).toBe(false); // removed and added again on the same lending machine
  expect(sameAccountSource(peer(), peer("g1"))).toBe(true); // an older lender or view that reports none
});
