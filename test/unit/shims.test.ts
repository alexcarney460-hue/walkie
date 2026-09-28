// ACCOUNTS-2 shims: `claude` / `codex` in ~/.walkie/bin exec `walkie claude|codex` when a vault exists, else the real
// CLI; they never run themselves (no recursion) and the Walkie side never resolves a shim as the real CLI.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installShims, isShim, realCli, shimDir, shimsFirst, uninstallShims } from "../../src/switch/shims.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

function setup() {
  const d = mkdtempSync("/tmp/walkie-shims-");
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  const walkie = join(d, "walkiehome");
  const realDir = join(d, "realbin");
  mkdirSync(realDir, { recursive: true });
  for (const name of ["claude", "codex"]) {
    writeFileSync(join(realDir, name), `#!/bin/sh\necho "REAL ${name} $*"\n`);
    chmodSync(join(realDir, name), 0o755);
  }
  // A stand-in for the walkie binary: prints what it was asked to run.
  const fakeWalkie = join(d, "fake-walkie");
  writeFileSync(fakeWalkie, `#!/bin/sh\necho "WALKIE $* shim=$WALKIE_SHIM_ACTIVE"\n`);
  chmodSync(fakeWalkie, 0o755);
  const r = installShims(walkie, { walkie: [fakeWalkie] });
  const PATH = `${shimDir(walkie)}:${realDir}:/usr/bin:/bin`;
  return { d, walkie, realDir, r, PATH };
}

function run(cmd: string, env: Record<string, string>): { out: string; code: number } {
  const p = Bun.spawnSync(["/bin/sh", "-c", cmd], { env, stdout: "pipe", stderr: "pipe", timeout: 5_000 });
  return { out: (p.stdout.toString() + p.stderr.toString()).trim(), code: p.exitCode ?? -1 };
}

describe("shims", () => {
  test("switching not set up (no trusted CLI recorded) → the real CLI, unchanged arguments", () => {
    const s = setup();
    expect(run(`claude --model opus "two words"`, { PATH: s.PATH }).out).toBe("REAL claude --model opus two words");
  });

  test("set up (a trusted CLI recorded, with or without a local vault) → walkie claude (marked active); WALKIE_NO_SWITCH=1 → the real CLI", () => {
    const s = setup();
    writeFileSync(join(s.walkie, "trusted-cli.json"), "{}");
    expect(run(`claude -p hi`, { PATH: s.PATH }).out).toBe("WALKIE claude -p hi shim=1");
    expect(run(`codex resume`, { PATH: s.PATH }).out).toBe("WALKIE codex resume shim=1");
    expect(run(`claude -p hi`, { PATH: s.PATH, WALKIE_NO_SWITCH: "1" }).out).toBe("REAL claude -p hi");
    // Already inside a shim: straight to the real CLI (no loop even if walkie called the shim again).
    expect(run(`claude x`, { PATH: s.PATH, WALKIE_SHIM_ACTIVE: "1" }).out).toBe("REAL claude x");
  });

  test("no real CLI anywhere: exit 127 with a message, never a loop", () => {
    const s = setup();
    rmSync(join(s.realDir, "claude"));
    // A second copy of a shim elsewhere on PATH is recognised by its mark and skipped too.
    const other = join(s.d, "otherbin");
    mkdirSync(other);
    writeFileSync(join(other, "claude"), readFileSync(join(shimDir(s.walkie), "claude")));
    chmodSync(join(other, "claude"), 0o755);
    const r = run(`claude hi`, { PATH: `${shimDir(s.walkie)}:${other}:/usr/bin:/bin`, WALKIE_NO_SWITCH: "1" });
    expect(r.code).toBe(127);
    expect(r.out).toContain("no real claude found");
  });

  test("realCli skips the shim directory and any shim; WALKIE_REAL_* overrides", () => {
    const s = setup();
    expect(realCli("claude", s.walkie, { PATH: s.PATH })).toBe(join(s.realDir, "claude"));
    expect(realCli("claude", s.walkie, { PATH: `${shimDir(s.walkie)}:/usr/bin` })).toBeNull();
    expect(isShim(join(shimDir(s.walkie), "codex"))).toBe(true);
    expect(isShim(join(s.realDir, "codex"))).toBe(false);
    expect(realCli("codex", s.walkie, { PATH: "", WALKIE_REAL_CODEX: join(s.realDir, "codex") })).toBe(join(s.realDir, "codex"));
    expect(realCli("codex", s.walkie, { PATH: "", WALKIE_REAL_CODEX: join(shimDir(s.walkie), "codex") })).toBeNull();
    expect(shimsFirst(s.walkie, { PATH: s.PATH })).toBe(true);
    expect(shimsFirst(s.walkie, { PATH: `${s.realDir}:${shimDir(s.walkie)}` })).toBe(false);
  });

  test("the profile line is added once and removed on uninstall; a foreign file is never overwritten", () => {
    const s = setup();
    const profile = join(s.d, ".zshrc");
    writeFileSync(profile, "export FOO=1\n");
    installShims(s.walkie, { profile, walkie: ["/bin/true"] });
    installShims(s.walkie, { profile, walkie: ["/bin/true"] });
    const text = readFileSync(profile, "utf8");
    expect(text.match(/walkie-managed: account switching/g)?.length).toBe(1);
    expect(text).toContain(`export PATH=`);
    const u = uninstallShims(s.walkie, { profile });
    expect(u.removed.length).toBe(2);
    expect(readFileSync(profile, "utf8")).toBe("export FOO=1\n");
    writeFileSync(join(shimDir(s.walkie), "claude"), "#!/bin/sh\necho mine\n");
    expect(() => installShims(s.walkie, { walkie: ["/bin/true"] })).toThrow(/not a Walkie shim/);
  });
});

test("a shim whose walkie binary is gone falls back to the real CLI (claude never breaks)", () => {
  const d = mkdtempSync("/tmp/walkie-shims-");
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  const walkie = join(d, "w");
  const realDir = join(d, "realbin");
  mkdirSync(realDir, { recursive: true });
  writeFileSync(join(realDir, "claude"), "#!/bin/sh\necho \"REAL claude $*\"\n");
  chmodSync(join(realDir, "claude"), 0o755);
  installShims(walkie, { walkie: [join(d, "moved-away-walkie")] });
  writeFileSync(join(walkie, "trusted-cli.json"), "{}");
  const p = Bun.spawnSync(["/bin/sh", "-c", "claude hi"], { env: { PATH: `${shimDir(walkie)}:${realDir}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe", timeout: 5_000 });
  expect(p.stdout.toString().trim()).toBe("REAL claude hi");
  expect(p.stderr.toString()).toContain("is gone");
});
