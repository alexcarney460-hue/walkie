// PRE4 RC (Codex 3, Opus 2): the vault's admin commands use the shared agent detection. A real process whose
// environment carries no agent marker, started by a parent that looks like Claude Code (a script named `claude`), is
// an agent by the ancestor walk (no terminal is asked): refused while agent admin is off (AGENT-ADMIN-1), else audited.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
let dir = "";

beforeAll(() => {
  dir = mkdtempSync("/tmp/walkie-vault-anc-");
  // The parent: `/bin/sh <dir>/claude`, which agent-detect.ts reads as the claude runtime (interpreters looked through).
  // It waits for the CLI (no exec), so the CLI's parent process is this "claude".
  writeFileSync(join(dir, "claude"), `#!/bin/sh\n"${process.execPath}" "${CLI}" "$@"\nexit $?\n`);
  chmodSync(join(dir, "claude"), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function underFakeClaude(args: string[]) {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, WALKIE_HOME: join(dir, "walkie"), NO_COLOR: "1" };
  const p = Bun.spawn(["/bin/sh", join(dir, "claude"), ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

// AGENT-ADMIN-1: the same detection now marks the caller as its person's agent: refused only while agent admin is off.
for (const args of [["accounts", "trust-cli"], ["accounts", "shims", "install"], ["accounts", "policy", "aaaaaaaa", "own"]]) {
  test(`walkie ${args.join(" ")} with no agent marker, under a parent named claude: an agent, refused while agent admin is off`, async () => {
    mkdirSync(join(dir, "walkie"), { recursive: true });
    writeFileSync(join(dir, "walkie", "config.json"), JSON.stringify({ agent_admin: false }));
    const r = await underFakeClaude(args);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/agents can't change the vault here, agent admin is off/);
    expect(existsSync(join(dir, "walkie", "bin", "claude"))).toBe(false);
    expect(existsSync(join(dir, "walkie", "trusted-cli.json"))).toBe(false);
  });
}

test("with agent admin on (the default), the agent installs the shims itself, and the change is in the audit log", async () => {
  writeFileSync(join(dir, "walkie", "config.json"), JSON.stringify({}));
  const r = await underFakeClaude(["accounts", "shims", "install"]);
  expect([r.code, r.err]).toEqual([0, r.err]);
  expect(existsSync(join(dir, "walkie", "bin", "claude"))).toBe(true);
  expect(readFileSync(join(dir, "walkie", "admin-audit.jsonl"), "utf8")).toContain("walkie accounts shims install");
});
