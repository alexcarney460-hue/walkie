import { afterEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeatRun, SeatRunV2, SEAT_TASK_FILE } from "../../protocol/seats.ts";
import { dropFromSeat, grokCredentialOutput, grokGuardOutput, grokLoginPresent, grokSeatArgs, grokSeatHome, grokSeatParser, loginEnv } from "./runtime.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "walkie-grok-seat-")); dirs.push(dir); return dir; }

test("Grok is v2 only and argv references the brief file without carrying its text", () => {
  const run = { op: "run", v: 2, runtime: "grok", brief: "a".repeat(64), timeout_s: 60, max_concurrent: 1 };
  expect(SeatRunV2.safeParse(run).success).toBe(true);
  expect(SeatRun.safeParse({ ...run, v: 1, prompt: "secret brief" }).success).toBe(false);
  const args = grokSeatArgs({ taskFile: SEAT_TASK_FILE, cwd: "/tmp/seat", session: "11111111-1111-4111-8111-111111111111", mode: "default", home: "/fixture/home", seatHome: "/fixture/seat/grok-home" });
  expect(args).toContain("--prompt-file");
  expect(args[args.indexOf("--prompt-file") + 1]).toBe(SEAT_TASK_FILE);
  expect(args).toContain("streaming-json");
  expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "dontAsk"]);
  expect(JSON.stringify(args)).not.toContain("secret brief");
  expect(grokSeatArgs({ taskFile: ".walkie/TASK.md", cwd: "/tmp/seat", session: "11111111-1111-4111-8111-111111111111", mode: "acceptEdits", home: "/fixture/home", seatHome: "/fixture/seat/grok-home" })).toContain("acceptEdits");
  expect(grokSeatArgs({ taskFile: SEAT_TASK_FILE, cwd: "/tmp/seat", session: "11111111-1111-4111-8111-111111111111", mode: "bypassPermissions", home: "/fixture/home", seatHome: "/fixture/seat/grok-home" })).toContain("bypassPermissions");
});

test("documented streaming-json text, tool, end and error events become seat signals", () => {
  const parse = grokSeatParser();
  expect(parse('{"type":"thought","data":"private"}')).toBeNull();
  expect(parse('{"type":"tool_call","toolCallId":"call_1","title":"Read","kind":"read","status":"in_progress","toolName":"read_file","rawInput":{"path":"src/main.rs"},"content":[],"locations":[]}')).toEqual([{ kind: "tool", text: "Read" }]);
  expect(parse('{"type":"tool_call_update","toolCallId":"call_1","status":"completed","content":[],"rawOutput":{"lines":42},"locations":[]}')).toEqual([{ kind: "tool", text: "Read completed" }]);
  expect(parse('{"type":"text","data":"Here is a summary"}')).toEqual([{ kind: "text", text: "Here is a summary" }]);
  expect(parse('{"type":"usage","stopReason":"end_turn"}')).toBeNull();
  expect(parse('{"type":"end","stopReason":"end_turn","sessionId":"abc123"}')).toEqual([{ kind: "final", ok: true, text: "" }]);
  expect(parse('{"type":"end","stopReason":"max_tokens"}')).toEqual([{ kind: "final", ok: false, text: "Grok stopped: max_tokens" }]);
  expect(parse('{"type":"error","message":"Could not start session"}')).toEqual([{ kind: "final", ok: false, text: "Could not start session" }]);
  expect(parse('{"type":"end","stopReason":"end_turn"}')).toEqual([{ kind: "final", ok: false, text: "Could not start session" }]);
  expect(parse('{bad')).toBeNull();
});

test("subscription login presence is checked by metadata and provider API keys cannot enter seat env", async () => {
  const home = temp();
  expect(grokLoginPresent(home)).toBe(false);
  mkdirSync(join(home, ".grok"));
  writeFileSync(join(home, ".grok", "auth.json"), "fixture", { mode: 0o600 });
  expect(grokLoginPresent(home)).toBe(true);
  chmodSync(join(home, ".grok", "auth.json"), 0o644);
  expect(grokLoginPresent(home)).toBe(false);
  for (const name of ["XAI_API_KEY", "GROK_API_KEY", "OPENAI_API_KEY", "XAI_BASE_URL", "GROK_BASE_URL"]) expect(dropFromSeat(name)).toBe(true);
  const result = await loginEnv({ HOME: home, XAI_API_KEY: "fixture", GROK_API_KEY: "fixture", XAI_BASE_URL: "https://example.test" }, home, join(home, "absent"), ["XAI_API_KEY", "GROK_API_KEY", "XAI_BASE_URL"]);
  expect(result.env).not.toHaveProperty("XAI_API_KEY");
  expect(result.env).not.toHaveProperty("GROK_API_KEY");
  expect(result.env).not.toHaveProperty("XAI_BASE_URL");
});

test("Grok seat home projects only subscription auth, never the person's model API config", () => {
  const home = temp();
  const seatDir = temp();
  mkdirSync(join(home, ".grok"));
  const auth = join(home, ".grok", "auth.json");
  writeFileSync(auth, "fixture-session", { mode: 0o600 });
  writeFileSync(join(home, ".grok", "config.toml"), '[model.grok-build]\napi_key = "fixture-api-key"\n');
  const isolated = grokSeatHome(seatDir, home);
  expect(isolated).toBe(join(seatDir, "grok-home"));
  expect(lstatSync(join(isolated, "auth.json")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(isolated, "auth.json"))).toBe(auth);
  const config = Bun.TOML.parse(readFileSync(join(isolated, "config.toml"), "utf8"));
  expect(JSON.stringify(config)).not.toContain("api_key");
  expect(config).toMatchObject({ features: { managed_config: false }, session: { load_envrc: false } });
});

test("Grok seat refuses a system-managed config without reading its contents", () => {
  const home = temp();
  const seatDir = temp();
  const managed = temp();
  mkdirSync(join(home, ".grok"));
  writeFileSync(join(home, ".grok", "auth.json"), "fixture-session", { mode: 0o600 });
  writeFileSync(join(managed, "managed_config.toml"), '[model.grok-build]\napi_key = "fixture-only"\n');
  expect(() => grokSeatHome(seatDir, home, managed)).toThrow("subscription-only auth cannot be proven");
  expect(() => lstatSync(join(seatDir, "grok-home"))).toThrow();
});

test("Grok seat refuses macOS managed preferences before creating a home", () => {
  const home = temp();
  const seatDir = temp();
  mkdirSync(join(home, ".grok"));
  writeFileSync(join(home, ".grok", "auth.json"), "fixture-session", { mode: 0o600 });
  const emptySystem = temp();
  expect(() => grokSeatHome(seatDir, home, emptySystem, () => true)).toThrow("subscription-only auth cannot be proven");
  expect(() => lstatSync(join(seatDir, "grok-home"))).toThrow();
  expect(grokSeatHome(seatDir, home, emptySystem, () => false)).toBe(join(seatDir, "grok-home"));
});

test("read-only Grok seat hard-denies shell and writes even with project allow rules", () => {
  const repo = temp();
  mkdirSync(join(repo, ".grok"));
  writeFileSync(join(repo, ".grok", "config.toml"), '[permission]\nallow = ["Bash", "Edit", "Write"]\n');
  const config = Bun.TOML.parse(readFileSync(join(repo, ".grok", "config.toml"), "utf8"));
  expect(config).toMatchObject({ permission: { allow: ["Bash", "Edit", "Write"] } });
  const args = grokSeatArgs({ taskFile: SEAT_TASK_FILE, cwd: repo, session: "11111111-1111-4111-8111-111111111111", mode: "default", home: "/fixture/home", seatHome: "/fixture/seat/grok-home" });
  const denies = args.flatMap((arg, i) => arg === "--deny" ? [args[i + 1]] : []);
  expect(denies).toContain("Bash");
  expect(denies).toContain("Edit");
  expect(denies).toContain("MCPTool");
  expect(args).toContain("--no-subagents");
  expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", "read_file,grep,list_dir"]);
  expect(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2)).toEqual(["--sandbox", "read-only"]);
  const full = grokSeatArgs({ taskFile: SEAT_TASK_FILE, cwd: repo, session: "11111111-1111-4111-8111-111111111111", mode: "bypassPermissions", home: "/fixture/home", seatHome: "/fixture/seat/grok-home" });
  expect(full).not.toContain("--sandbox");
  expect(full).toContain("--deny");
});

test("Grok denies credential paths in every mode and spots fixture session output", () => {
  for (const mode of ["default", "acceptEdits", "bypassPermissions"] as const) {
    const args = grokSeatArgs({ taskFile: SEAT_TASK_FILE, cwd: "/tmp/seat", session: "11111111-1111-4111-8111-111111111111", mode,
      home: "/fixture/person", seatHome: "/fixture/seat/grok-home" });
    const denies = args.flatMap((arg, i) => arg === "--deny" ? [args[i + 1]] : []);
    for (const path of ["/fixture/seat/grok-home/**", "/fixture/person/.grok/**", "~/.grok/**", "/fixture/person/.claude/**",
      "/fixture/person/.codex/**", "/fixture/person/.kimi-code/**", "/fixture/person/.hermes/**"]) {
      expect(denies).toContain(`Read(${path})`);
      expect(denies).toContain(`Edit(${path})`);
    }
  }
  expect(grokCredentialOutput('{"refresh_token":"fixture-session-token-1234567890"}')).toBe(true);
  expect(grokCredentialOutput("xai-fixture-session-token-1234567890")).toBe(true);
  expect(grokCredentialOutput("normal Grok answer")).toBe(false);
});

test("Grok credential tripwire ignores auth settings but detects a token-shaped value", () => {
  expect(grokCredentialOutput('{"auth_mode":"oauth"}')).toBe(false);
  expect(grokCredentialOutput('{"refresh_token":"oauth"}')).toBe(false);
  expect(grokCredentialOutput('{"refresh_token":"fixture-session-token-1234567890"}')).toBe(true);
});

test("Grok holds every split of a token and its JSON key before a timed flush", async () => {
  const token = "fixture-session-token-1234567890";
  const output = `before {"refresh_token":"${token}"} after`;
  for (let split = 1; split < output.length; split++) {
    const first = grokGuardOutput("", output.slice(0, split));
    expect(first.safe).not.toContain("fixture-");
    // Model a flush timer firing while the provider pauses between output records.
    await Bun.sleep(1);
    if (first.credential) continue;
    const second = grokGuardOutput(first.pending, output.slice(split));
    expect(second.credential).toBe(true);
    expect(first.safe + second.safe).not.toContain("fixture-");
  }
});

test("Grok releases harmless partial keys and holds other credential prefixes", () => {
  const first = grokGuardOutput("", 'safe {"refresh_token":"oauth"} x');
  expect(first.safe).toContain('"refresh_token":"oauth"');
  expect(first.credential).toBe(false);
  const second = grokGuardOutput(first.pending, "ai-123456789012");
  expect(second.credential).toBe(true);
  for (const prefix of ["xai-123", "eyJ12345678.eyJ123", '{"access_token" : "abc']) {
    const result = grokGuardOutput("", `safe ${prefix}`);
    expect(result.safe).toBe(prefix.startsWith("{") ? "safe {" : "safe ");
    expect(result.pending).toBe(prefix.startsWith("{") ? prefix.slice(1) : prefix);
  }
});

test("Grok output scan reports bounded work for repeated prefix starters", () => {
  const input = "e".repeat(1_048_576);
  const result = grokGuardOutput("", input);
  expect(result.work).toBeLessThanOrEqual(input.length * 4);
  expect(result.safe).toBe(input.slice(0, -1));
  expect(result.pending).toBe("e");
});

test("Grok JWT scan examines overlapping eyJ starters a bounded number of times", () => {
  // The short case fails quickly on a scanner that rescans each suffix.
  const short = "eyJ".repeat(90) + "!";
  expect(grokGuardOutput("", short).work).toBeLessThanOrEqual(short.length * 8);
  const block = "eyJ".repeat(90) + "!";
  const input = block.repeat(Math.ceil(1_048_576 / block.length)).slice(0, 1_048_576);
  const result = grokGuardOutput("", input);
  expect(result.credential).toBe(false);
  expect(result.work).toBeLessThanOrEqual(input.length * 8);
  expect(result.pending.length).toBeLessThanOrEqual(8_192);
});

test("Grok denies configured credential homes from the effective seat environment", () => {
  const args = grokSeatArgs({ taskFile: SEAT_TASK_FILE, cwd: "/tmp/seat", session: "11111111-1111-4111-8111-111111111111",
    mode: "bypassPermissions", home: "/fixture/person", seatHome: "/fixture/seat/grok-home",
    env: { CLAUDE_CONFIG_DIR: "/fixture/worker-claude", CODEX_HOME: "worker-codex",
      KIMI_CODE_HOME: "~/worker-kimi", HERMES_HOME: "/fixture/worker-hermes" } });
  const denies = args.flatMap((arg, i) => arg === "--deny" ? [args[i + 1]] : []);
  for (const path of ["/fixture/worker-claude/**", "/fixture/person/worker-codex/**",
    "/fixture/person/worker-kimi/**", "/fixture/worker-hermes/**"]) {
    expect(denies).toContain(`Read(${path})`);
    expect(denies).toContain(`Edit(${path})`);
  }
});
