import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeBinaryIdentity, ClaudeChild, withoutUnsupportedClaudeFlag } from "../../src/daemon/orchestrator/process.ts";
import { validChildLease } from "../../src/daemon/orchestrator/supervisor.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync("/tmp/walkie-crashloop-"); dirs.push(dir); return dir; };

test("the capability cache identity changes when a Claude binary is replaced at the same path", () => {
  const dir = temp(), bin = join(dir, "claude"), next = join(dir, "next");
  writeFileSync(bin, "#!/bin/sh\necho --permission-prompts\n");
  chmodSync(bin, 0o755);
  const first = claudeBinaryIdentity(bin);
  writeFileSync(next, "#!/bin/sh\necho old version\nexit 1\n");
  chmodSync(next, 0o755);
  renameSync(next, bin);
  expect(claudeBinaryIdentity(bin)).not.toBe(first);
});

test("only an unsupported permission-prompts option is removed with its value for one retry", () => {
  const args = ["-p", "--permission-prompts", "none", "--model", "opus", "--mcp-config={}"];
  expect(withoutUnsupportedClaudeFlag(args, "error: unknown option '--permission-prompts'")).toEqual(["-p", "--model", "opus", "--mcp-config={}"]);
  for (const flag of ["--setting-sources", "--allowedTools", "--mcp-config", "--settings", "--another-option"]) {
    expect(withoutUnsupportedClaudeFlag([...args, flag], `error: unknown option '${flag}'`)).toBeNull();
  }
  expect(withoutUnsupportedClaudeFlag(args, "authentication failed")).toBeNull();
  expect(withoutUnsupportedClaudeFlag(args, "error: unknown option '--dangerous'")).toBeNull();
});

test("Claude stderr is drained before the exit callback reports the error", async () => {
  const dir = temp(), bin = join(dir, "claude");
  writeFileSync(bin, "#!/bin/sh\necho \"error: unknown option '--permission-prompts'\" >&2\nexit 1\n");
  chmodSync(bin, 0o755);
  let diagnostic = "";
  const child = new ClaudeChild(bin, [], dir, { PATH: "/usr/bin:/bin" }, { onSignal: () => undefined, onExit: (_code, stderr) => { diagnostic = stderr; } });
  expect(await child.exited).toBe(1);
  expect(diagnostic).toContain("unknown option '--permission-prompts'");
  await child.reaped;
});

test("delayed renewals and atomic lease-file rewrites remain valid until the authority deadline", () => {
  const dir = temp(), file = join(dir, "lease.json"), run = `7.${crypto.randomUUID()}`;
  let now = 1_000_000;
  const save = (serial: number) => {
    writeFileSync(`${file}.tmp`, JSON.stringify({ expires: 1_029_000, renewed: now, serial, epoch: 7, run }));
    renameSync(`${file}.tmp`, file);
  };
  save(0);
  now += 3_000; // a loaded daemon missed twelve 250-ms heartbeat slots
  expect(validChildLease(file, run, now)).toBe(true);
  save(1); // same run and epoch, new serial and inode
  now += 15_000;
  expect(validChildLease(file, run, now)).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8")).serial).toBe(1);
  expect(validChildLease(file, run, 1_029_000)).toBe(false);
});
