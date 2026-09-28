// PRE4 RC (Codex 4): `walkie seats setup-user` copies the native claude / codex for seat users. With the account shims
// installed first on PATH (ACCOUNTS-2), the search passes over Walkie's own shims and finds the native binary behind them.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeRuntime } from "../../src/cli/commands/seat-user.ts";
import { installShims, shimDir } from "../../src/switch/shims.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });

function world() {
  const root = mkdtempSync("/tmp/walkie-native-");
  dirs.push(root);
  const walkieHome = join(root, "walkie");
  const native = join(root, "native");
  const scripts = join(root, "scripts");
  mkdirSync(native, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  for (const name of ["claude", "codex"]) {
    writeFileSync(join(native, name), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0])); // a binary, not a script
    chmodSync(join(native, name), 0o755);
    writeFileSync(join(scripts, name), "#!/bin/sh\nexec node cli.js \"$@\"\n"); // an npm-style launcher
    chmodSync(join(scripts, name), 0o755);
  }
  installShims(walkieHome, { walkie: ["/usr/local/bin/walkie"], profile: null });
  return { walkieHome, native, scripts, shims: shimDir(walkieHome) };
}

test("the account shims first on PATH: the native binary behind them is found", () => {
  const w = world();
  for (const name of ["claude", "codex"]) {
    expect(nativeRuntime(name, { PATH: `${w.shims}:${w.native}` })).toBe(realpathSync(join(w.native, name)));
  }
});

test("only the shims on PATH: none; a script that is not a Walkie shim still means no copyable runtime", () => {
  const w = world();
  expect(nativeRuntime("claude", { PATH: w.shims })).toBeNull();
  expect(nativeRuntime("claude", { PATH: `${w.shims}:${w.scripts}:${w.native}` })).toBeNull();
  expect(nativeRuntime("claude", { PATH: w.native })).toBe(realpathSync(join(w.native, "claude")));
});
