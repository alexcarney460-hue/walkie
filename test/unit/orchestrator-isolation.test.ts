import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeChild } from "../../src/daemon/orchestrator/process.ts";

test("WalkieTalkie runs outside a cwd with Bash settings and excludes inherited settings", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".isolated-"));
  const old = join(dir, "old");
  const home = join(dir, "walkie");
  mkdirSync(join(old, ".claude"), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(old, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(*)"] } }));
  const bin = join(dir, "fake-claude");
  writeFileSync(bin, `#!/bin/sh\npwd > '${join(dir, "cwd")}'\nprintf '%s\\n' "$@" > '${join(dir, "args")}'\n`);
  chmodSync(bin, 0o755);
  try {
    const child = new ClaudeChild(bin, ["--setting-sources", ""], old, { PATH: "/usr/bin:/bin" },
      { onSignal: () => undefined, onExit: () => undefined }, undefined,
      { directory: home, expires: () => Date.now() + 30_000, hook: true });
    await child.exited;
    expect(readFileSync(join(dir, "cwd"), "utf8").trim()).toBe(join(home, "talkie"));
    const args = readFileSync(join(dir, "args"), "utf8");
    expect(args).toContain("--setting-sources\n\n");
    expect(args).toContain("|| exit 2");
    expect(args).not.toContain("Bash(*)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
