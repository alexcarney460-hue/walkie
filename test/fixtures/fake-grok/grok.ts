#!/usr/bin/env bun
// Fake documented streaming-json producer for seat tests. Never connects to xAI.
import { appendFileSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const value = (flag: string) => argv[argv.indexOf(flag) + 1];
const file = value("--prompt-file");
if (!file || argv.includes("-p") || !argv.includes("streaming-json")) process.exit(2);
const brief = readFileSync(join(process.cwd(), file), "utf8");
const emit = (event: object) => process.stdout.write(JSON.stringify(event) + "\n");
const child = brief.includes("slow") ? Bun.spawn(["/bin/sleep", "30"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }) : null;
const log = process.env.FAKE_GROK_LOG;
const grokHome = process.env.GROK_HOME;
if (log) appendFileSync(log, JSON.stringify({ argv, brief, pid: process.pid, child_pid: child?.pid ?? null,
  grok_home: grokHome ?? null,
  auth_link: !!grokHome && existsSync(join(grokHome, "auth.json")) && lstatSync(join(grokHome, "auth.json")).isSymbolicLink(),
  config_has_api_key: !!grokHome && readFileSync(join(grokHome, "config.toml"), "utf8").includes("api_key"),
  env: Object.keys(process.env).filter((k) => k.endsWith("_API_KEY") || k === "XAI_BASE_URL" || k === "GROK_BASE_URL") }) + "\n");
emit({ type: "tool_call", toolCallId: "call_1", title: "Read", kind: "read", status: "in_progress", toolName: "read_file", rawInput: { path: "src/main.ts" }, content: [], locations: [] });
emit({ type: "tool_call_update", toolCallId: "call_1", status: "completed", content: [], rawOutput: { lines: 42 }, locations: [] });
if (brief.includes("split leak")) {
  emit({ type: "text", data: '{"refresh_token":"fixture-session-token-123' });
  await Bun.sleep(120);
  emit({ type: "text", data: '4567890"}' });
} else if (brief.includes("partial jwt")) {
  emit({ type: "text", data: "safe before eyJ12345678.eyJ123" });
} else if (brief.includes("leak")) emit({ type: "text", data: '{"refresh_token":"fixture-session-token-1234567890"}' });
if (!brief.includes("partial jwt")) emit({ type: "text", data: "fake grok finished" });
if (child) await child.exited;
if (brief.includes("long partial fail")) {
  emit({ type: "error", message: `fixture failure ${"a".repeat(300)} eyJ12345678.eyJ123` });
  process.exit(1);
}
if (brief.includes("fail")) { emit({ type: "error", message: "fixture failure" }); process.exit(1); }
if (brief.includes("partial jwt without final")) process.exit(0);
emit({ type: "end", stopReason: "end_turn", sessionId: "fixture" });
