import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeChild } from "../../src/daemon/orchestrator/process.ts";
import { OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";

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

test("shell-capable Claude runs through the dedicated-user runner with its own HOME", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".os-user-"));
  const userHome = join(dir, "user");
  mkdirSync(userHome);
  const runner = join(dir, "walkie-runner");
  writeFileSync(runner, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "../../src/cli/main.ts")}' "$@"\n`);
  chmodSync(runner, 0o755);
  const bin = join(dir, "fake-claude");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$HOME" > '${join(dir, "child-home")}'\nif [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then echo yes > '${join(dir, "has-login")}'; fi\n`);
  chmodSync(bin, 0o755);
  try {
    const child = new ClaudeChild(bin, [], dir, { PATH: "/usr/bin:/bin", HOME: dir, CLAUDE_CODE_OAUTH_TOKEN: "fake-test-token" },
      { onSignal: () => undefined, onExit: () => undefined }, undefined,
      { directory: dir, expires: () => Date.now() + 30_000, osUser: { name: "walkie-talkie", home: userHome, runner,
        switch: [process.execPath, join(import.meta.dir, "../fixtures/fake-talkie-runner.ts")] } });
    expect(await child.exited).toBe(0);
    expect(readFileSync(join(dir, "child-home"), "utf8").trim()).toBe(userHome);
    expect(readFileSync(join(dir, "has-login"), "utf8").trim()).toBe("yes");
    expect(existsSync(join(userHome, ".claude", ".credentials.json"))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a symlinked Claude config cannot make runner cleanup remove another credential file", async () => {
  const dir = mkdtempSync(join(import.meta.dir, ".os-user-"));
  try {
    const home = join(dir, "user"); const outside = join(dir, "outside");
    mkdirSync(home); mkdirSync(outside);
    const credentials = join(outside, ".credentials.json");
    writeFileSync(credentials, "keep");
    symlinkSync(outside, join(home, ".claude"));
    const runner = join(dir, "walkie-runner");
    writeFileSync(runner, `#!/bin/sh\nexec '${process.execPath}' '${join(import.meta.dir, "../../src/cli/main.ts")}' "$@"\n`);
    chmodSync(runner, 0o755);
    const child = new ClaudeChild("/bin/true", [], dir, { PATH: "/usr/bin:/bin", CLAUDE_CODE_OAUTH_TOKEN: "fake" },
      { onSignal: () => undefined, onExit: () => undefined }, undefined,
      { directory: dir, expires: () => Date.now() + 30_000, osUser: { name: "walkie-talkie", home, runner,
        switch: [process.execPath, join(import.meta.dir, "../fixtures/fake-talkie-runner.ts")] } });
    expect(await child.exited).toBe(2);
    expect(readFileSync(credentials, "utf8")).toBe("keep");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("shell mode clears the binary probe cache and platform mode probes again", async () => {
  const { claudeBinaryIdentity } = await import("../../src/daemon/orchestrator/process.ts");
  const host: any = Object.create(OrchestratorHost.prototype);
  const bin = join(import.meta.dir, "../fixtures/fake-claude/claude");
  host.state = { claude: bin, access: "full", permission_mode: "bypassPermissions" };
  host.opts = { env: { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin` } };
  host.permissionPrompts = true;
  host.probedBinary = claudeBinaryIdentity(bin);
  await host.probePermissionPrompts();
  expect(host.permissionPrompts).toBe(false);
  expect(host.probedBinary).toBeNull();
  host.state = { ...host.state, access: "platform", permission_mode: "default" };
  await host.probePermissionPrompts();
  expect(host.permissionPrompts).toBe(true);
  expect(host.probedBinary).toBe(claudeBinaryIdentity(bin));
});
