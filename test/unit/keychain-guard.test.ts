// The test run's Keychain guard (test/helpers/keychain-guard.ts, loaded by bunfig.toml): Walkie's real readers refuse under
// `bun test`, an injected reader never reaches it, and a test that touched the Keychain fails even when the code under
// test swallowed the refusal. The real /usr/bin/security is never started: that is what is being proved.
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEYCHAIN_SERVICE as CLAUDE_SERVICE, makeSystemKeychain } from "../../src/accounts/adapters/claude.ts";
import { macKeychain } from "../../src/accounts/vault/keystore.ts";
import { runProcess } from "../../src/daemon/procs.ts";
import { keychainHas } from "../../src/daemon/orchestrator/logins.ts";
import { shellTextStartsSecurity, takeKeychainRefusals, wouldStartSecurity } from "../helpers/keychain-guard.ts";

const REAL = "/usr/bin/security";
/** The bare name `security` finds the real program only where it is installed (macOS); a test that needs that is skipped elsewhere, not failed. */
const REAL_PRESENT = existsSync(REAL);
const ROOT = join(import.meta.dir, "../..");

describe("the refusal", () => {
  test("Bun.spawn and Bun.spawnSync refuse the real security tool, in both call shapes, and record who asked", () => {
    const argv = [REAL, "find-generic-password", "-s", CLAUDE_SERVICE, "-w"];
    expect(() => Bun.spawn(argv, { stdout: "ignore" })).toThrow("tests never touch the real login Keychain");
    expect(() => Bun.spawn({ cmd: argv, stdout: "ignore" })).toThrow("refused");
    expect(() => Bun.spawnSync(argv)).toThrow("refused");
    expect(() => Bun.spawnSync({ cmd: argv })).toThrow("refused");
    const found = takeKeychainRefusals();
    expect(found).toHaveLength(4);
    expect(found[0]).toContain(`${REAL} find-generic-password -s ${CLAUDE_SERVICE} -w`);
    expect(found[0]).toContain("keychain-guard.test.ts"); // the code that asked
  });

  test("Walkie's three real readers are refused and say unavailable, never a Keychain answer", async () => {
    expect(await makeSystemKeychain(runProcess, "darwin")(CLAUDE_SERVICE)).toBe("unavailable");
    expect(await keychainHas(CLAUDE_SERVICE)).toBe(false);
    await expect(macKeychain(mkdtempSync(join(tmpdir(), "kc-guard-"))).get("a-vault")).rejects.toThrow("refused");
    const found = takeKeychainRefusals();
    expect(found).toHaveLength(3);
    expect(found.every((line) => line.startsWith(`${REAL} find-generic-password -s `))).toBe(true);
  });

  test("anything else still runs, including a stand-in named security at another path (what the vault tests use)", async () => {
    const echoed = Bun.spawnSync(["/bin/echo", "ok"]);
    expect(echoed.stdout.toString().trim()).toBe("ok");
    const dir = mkdtempSync(join(tmpdir(), "kc-guard-tool-"));
    try {
      const tool = join(dir, "security");
      writeFileSync(tool, "#!/bin/sh\necho stand-in\n");
      chmodSync(tool, 0o755);
      expect(Bun.spawnSync([tool, "find-generic-password"]).stdout.toString().trim()).toBe("stand-in");
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(takeKeychainRefusals()).toEqual([]);
  });

  test("an injected reader never reaches the guard", async () => {
    const reader = makeSystemKeychain(async () => ({ kind: "ok", stdout: '{"claudeAiOauth":{}}\n', code: 0 }), "darwin");
    expect(await reader(CLAUDE_SERVICE)).toBe('{"claudeAiOauth":{}}');
    expect(takeKeychainRefusals()).toEqual([]);
  });
});

describe("the failure", () => {
  test("a test that touched the Keychain fails even though the code under test swallowed the refusal; one with an injected reader passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kc-guard-run-"));
    try {
      const file = join(dir, "touches-keychain.test.ts");
      writeFileSync(file, [
        'import { expect, test } from "bun:test";',
        `import { makeSystemKeychain } from ${JSON.stringify(join(ROOT, "src/accounts/adapters/claude.ts"))};`,
        `import { runProcess } from ${JSON.stringify(join(ROOT, "src/daemon/procs.ts"))};`,
        // What the product does with the refused spawn: it becomes "unavailable", and the test below would pass on that alone.
        'test("touches the real Keychain", async () => { expect(await makeSystemKeychain(runProcess, "darwin")("Claude Code-credentials")).toBe("unavailable"); });',
        'test("injects its own reader", async () => { expect(await makeSystemKeychain(async () => ({ kind: "ok", stdout: "x", code: 0 }), "darwin")("Claude Code-credentials")).toBe("x"); });',
        "",
      ].join("\n"));
      const run = Bun.spawnSync([process.execPath, "test", file], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: dir } });
      const out = `${run.stdout.toString()}${run.stderr.toString()}`;
      expect(run.exitCode).toBe(1);
      expect(out).toContain("this test tried to read the real macOS Keychain 1 time(s)");
      expect(out).toContain("(fail) touches the real Keychain");
      expect(out).toContain("(pass) injects its own reader");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});


// Final review B (LOW): the guard compared one literal string, so the same program under another spelling, or started by a
// shell, `env` or Bun.$, reached the real tool. It now matches the FILE (normalized path, PATH lookup, links followed) and reads
// what a shell string, `env` and a Bun.$ template would start. Nothing below starts the real program: the spellings are judged
// by the guard's pure matcher, and the end-to-end refusals run in a nested `bun test` whose guard is a copy aimed at a stand-in.
describe("every spelling of the real program is matched (final review B)", () => {
  const hit = (argv: string[], path: string | undefined = "/usr/bin:/bin"): boolean => wouldStartSecurity(argv, path) !== null;

  test("a path that normalizes to it: a doubled slash, `/./`, and `..`", () => {
    for (const path of [REAL, "/usr/bin//security", "/usr/bin/./security", "/usr/bin/../bin/security", "/usr/lib/../bin/security", "//usr/bin/security"]) {
      expect([path, hit([path, "help"])]).toEqual([path, true]);
    }
    expect(wouldStartSecurity([REAL, "find-generic-password", "-w"])).toBe(`${REAL} find-generic-password -w`); // the line a refusal records
  });
  test.skipIf(!REAL_PRESENT)("the bare name on a PATH that finds it (or none at all), and a symlink to it under any name", () => {
    expect(hit(["security", "help"], "/usr/bin:/bin")).toBe(true);
    expect(hit(["security", "help"], undefined)).toBe(true); // an environment with no PATH: the default search finds it
    const dir = mkdtempSync(join(tmpdir(), "kc-guard-link-"));
    try {
      symlinkSync(REAL, join(dir, "creds"));
      symlinkSync(REAL, join(dir, "security"));
      expect(hit([join(dir, "creds"), "help"])).toBe(true);
      expect(hit([join(dir, "security"), "help"])).toBe(true); // named like the tool, and it IS the tool
      expect(hit(["creds", "help"], dir)).toBe(true);
      expect(hit(["security", "help"], `${dir}:/bin`)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("through a shell string: any shell, -c or -lc, a list, a subshell, an assignment, exec, env, a pipe", () => {
    for (const [shell, flag] of [["/bin/sh", "-c"], ["/bin/bash", "-c"], ["/bin/zsh", "-lc"], ["sh", "-c"], ["/usr/bin/env", "bash"]] as const) {
      const args = shell === "/usr/bin/env" ? [flag, "-c"] : [flag];
      for (const text of [`${REAL} help`, `/usr/bin//security help`, `echo hi; ${REAL} help`, `true && ${REAL} help`, `(${REAL} help)`, `FOO=1 ${REAL} help`,
        `exec ${REAL} help`, `env -i ${REAL} help`, `echo $(${REAL} help)`, `echo hi | ${REAL} help`, `"${REAL}" help`, `'/usr/bin//security' help`, `if true; then ${REAL} help; fi`]) {
        expect([shell, flag, text, hit([shell, ...args, text])]).toEqual([shell, flag, text, true]);
      }
    }
    expect(shellTextStartsSecurity(`echo hi && ${REAL} help`)).toBe(true);
  });
  test("through /usr/bin/env: options, assignments, -S, env inside env", () => {
    for (const argv of [["/usr/bin/env", REAL, "help"], ["/usr/bin/env", "-i", REAL, "help"], ["/usr/bin/env", "FOO=1", "BAR=2", REAL, "help"], ["/usr/bin/env", "-u", "FOO", REAL, "help"],
      ["/usr/bin/env", "-S", `${REAL} help`], ["env", "/usr/bin//security", "help"], ["/usr/bin/env", "/usr/bin/env", REAL, "help"]]) {
      expect([argv.join(" "), hit(argv)]).toEqual([argv.join(" "), true]);
    }
  });
  // Final review C, F2: these three name the program WITHOUT a path, so they match only where the real program is on the PATH (macOS).
  // On Linux (the repo's CI also runs there) there is nothing for the bare name to find: skipped, the same as the symlink case above.
  test.skipIf(!REAL_PRESENT)("a bare name in a shell string, or through env, on a PATH that finds it (or none at all)", () => {
    expect(hit(["/bin/sh", "-c", "security help"], "/usr/bin:/bin")).toBe(true);
    expect(hit(["/bin/sh", "-c", "security help"], undefined)).toBe(true);
    expect(hit(["/usr/bin/env", "security", "help"])).toBe(true);
  });

  test("what is NOT it: stand-ins named security (alone, through env, in a shell string, on their own PATH), and words that only mention it", () => {
    const dir = mkdtempSync(join(tmpdir(), "kc-guard-standin-"));
    try {
      const tool = join(dir, "security");
      writeFileSync(tool, "#!/bin/sh\necho stand-in $1\n");
      chmodSync(tool, 0o755);
      for (const [label, argv, path] of [
        ["the stand-in by its path", [tool, "a"], "/usr/bin:/bin"],
        ["through env", ["/usr/bin/env", tool, "b"], "/usr/bin:/bin"],
        ["in a shell string", ["/bin/sh", "-c", `${tool} c`], "/usr/bin:/bin"],
        ["a bare name on a PATH that finds the stand-in first", ["security", "d"], `${dir}:/usr/bin:/bin`],
        ["a shell string on that PATH", ["/bin/sh", "-c", "security e"], `${dir}:/usr/bin:/bin`],
        ["env's own PATH assignment", ["/usr/bin/env", `PATH=${dir}`, "security", "f"], "/usr/bin:/bin"],
        ["a shell string's own PATH assignment", ["/bin/sh", "-c", `PATH=${dir} security g`], "/usr/bin:/bin"],
        ["a word that only mentions it", ["/bin/sh", "-c", "echo security; echo /usr/bin/security-is-a-word; cat /tmp/security.txt"], "/usr/bin:/bin"],
        ["an argument, not a program", ["/bin/echo", REAL], "/usr/bin:/bin"],
        ["another program entirely", ["/usr/bin/git", "--version"], "/usr/bin:/bin"],
        ["a program that is not there", ["/nonexistent/security", "help"], "/usr/bin:/bin"],
      ] as const) {
        expect([label, wouldStartSecurity(argv, path)]).toEqual([label, null]);
      }
      expect(shellTextStartsSecurity(`echo security && ls ${dir}`)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// The wrappers themselves (Bun.spawn, Bun.spawnSync, Bun.$, and what node:child_process reaches through them), end to end, in a
// nested `bun test` whose guard is a COPY of test/helpers/keychain-guard.ts aimed at a stand-in program that records being run.
describe("the guard refuses every spelling before anything starts (nested run against a stand-in)", () => {
  test("a stand-in that records being run is never run, by any spelling; another stand-in with the same name still is", () => {
    const dir = mkdtempSync(join(tmpdir(), "kc-guard-e2e-"));
    try {
      mkdirSync(join(dir, "bin"));
      mkdirSync(join(dir, "other"));
      const protectedTool = join(dir, "bin", "security");
      writeFileSync(protectedTool, `#!/bin/sh\necho reached >> '${join(dir, "reached.log")}'\necho protected "$1"\n`, { mode: 0o755 });
      writeFileSync(join(dir, "other", "security"), "#!/bin/sh\necho other \"$1\"\n", { mode: 0o755 });
      const guard = readFileSync(join(ROOT, "test/helpers/keychain-guard.ts"), "utf8");
      const aimed = guard.replace(`const REAL_SECURITY = "/usr/bin/security";`, `const REAL_SECURITY = ${JSON.stringify(protectedTool)};`);
      expect(aimed).not.toBe(guard); // the constant was found and replaced
      writeFileSync(join(dir, "guard.ts"), aimed);
      writeFileSync(join(dir, "bunfig.toml"), '[test]\npreload = ["./guard.ts"]\n');
      copyFileSync(join(ROOT, "test/fixtures/keychain-guard-spellings.fixture.ts"), join(dir, "spellings.test.ts"));
      const run = Bun.spawnSync([process.execPath, "test", "./spellings.test.ts"], { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 60_000,
        // The stand-in's directory comes first on the nested process's own PATH: no bare `security` in there can find the real program.
        env: { PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`, HOME: dir, STAND_DIR: dir } });
      const out = `${run.stdout.toString()}${run.stderr.toString()}`;
      expect(out).toMatch(/\d+ pass/);
      expect(out).not.toMatch(/\(fail\)/);
      expect(run.exitCode).toBe(0);
      expect(existsSync(join(dir, "reached.log")), "the protected stand-in was started").toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 90_000);
});
