// The test run's throwaway home (test/helpers/test-home.ts, the first preload in bunfig.toml): every default path a code
// path takes lands inside it, never in the developer's home. Nothing here is created outside the throwaway home.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os, { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { defaultHome } from "../../src/daemon/paths.ts";
import { runAsPerson } from "../helpers/person-cli.ts";
import { testHome } from "../helpers/test-home.ts";

const { home, realHome } = testHome();
const inside = (path: string): boolean => path === home || path.startsWith(`${home}/`);
const spawnOut = (args: string[], options: Record<string, unknown> = {}): string => Bun.spawnSync(args, { stderr: "pipe", ...options }).stdout.toString().trim();
const MAIN = join(import.meta.dir, "../../src/cli/main.ts");

describe("the throwaway home", () => {
  test("is a fresh directory that is not the developer's home", () => {
    expect(home).toMatch(/^\/tmp\/walkie-th-/);
    expect(statSync(home).isDirectory()).toBe(true);
    expect(realHome).not.toBe(home);
    expect(realHome.length).toBeGreaterThan(1);
    expect(inside(realHome)).toBe(false);
  });

  test("is what os.homedir() answers, by every way a module gets it, and what userInfo() reports", async () => {
    expect(homedir()).toBe(home);
    expect(os.homedir()).toBe(home);
    expect((await import("node:os")).homedir()).toBe(home);
    expect(userInfo().homedir).toBe(home);
    expect(userInfo().username.length).toBeGreaterThan(0); // everything else about the user is still the real answer
  });

  test("is what the environment says, and the variables that name a real directory are unset", () => {
    expect(process.env.HOME).toBe(home);
    expect(process.env.USERPROFILE).toBe(home);
    for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) expect(inside(process.env[name] ?? "")).toBe(true);
    for (const name of ["WALKIE_HOME", "WALKIE_SOCKET", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "KIMI_CODE_HOME", "HERMES_HOME"]) expect(process.env[name]).toBeUndefined();
    expect(process.env.WALKIE_TEST_HOME).toBe(home);
  });

  test("is where every default path lands: Walkie's home, and the Claude, Codex, Grok, Hermes and SSH directories", () => {
    expect(defaultHome()).toBe(join(home, ".walkie"));
    for (const dir of [".walkie", ".claude", ".codex", ".grok", ".hermes", ".ssh"]) {
      const path = join(homedir(), dir);
      expect(inside(path)).toBe(true);
      expect(existsSync(path)).toBe(false); // a fresh machine: nothing of the developer's is there
    }
    mkdirSync(join(defaultHome(), "agents"), { recursive: true });
    writeFileSync(join(defaultHome(), "agents", "probe.json"), "{}");
    expect(existsSync(join(realHome, ".walkie", "agents", "probe.json"))).toBe(false);
  });
});

describe("a child process", () => {
  test("started without an environment gets the throwaway home, not the one the test process started with", () => {
    expect(spawnOut(["sh", "-c", "echo $HOME"])).toBe(home);
    expect(spawnOut([process.execPath, "-e", "console.log(require('node:os').homedir())"])).toBe(home);
    expect(spawnOut(["sh", "-c", "echo ${WALKIE_HOME-unset} ${CODEX_HOME-unset}"])).toBe("unset unset");
  });

  test("given an environment of its own gets exactly that (some tests assert a child's environment is empty)", () => {
    expect(spawnOut(["sh", "-c", "echo ${HOME-nohome}"], { env: { PATH: "/usr/bin:/bin" } })).toBe("nohome");
    expect(Bun.spawnSync({ cmd: ["sh", "-c", "echo ${HOME-nohome}"], env: {} }).stdout.toString().trim()).toBe("nohome");
    expect(spawnOut(["sh", "-c", "echo $HOME"], { env: { PATH: "/usr/bin:/bin", HOME: "/tmp/a-test-owns-this" } })).toBe("/tmp/a-test-owns-this");
  });
});

// Final review B (MEDIUM): a child a test gave an environment of its own, with no HOME in it, asked the passwd entry for its
// home, which is the real one (the repo's usual CLI-test shape is `{ PATH, NO_COLOR, WALKIE_HOME, WALKIE_SOCKET }`). Measured: a
// HOME-less `walkie hooks install grok --dry-run` child named /Users/<person>/.claude/settings.json.
describe("a bun child, and the helper that runs the CLI, never resolve the real home through the passwd entry", () => {
  const probe = "console.log(require('node:os').homedir())";
  const bareEnv = { PATH: "/usr/bin:/bin" };
  const asyncOut = async (child: { stdout: unknown }): Promise<string> => (await new Response(child.stdout as ReadableStream).text()).trim();

  test("a bun child with an environment of its own and no HOME gets the throwaway home, by every spawn form", async () => {
    expect(spawnOut([process.execPath, "-e", probe], { env: bareEnv })).toBe(home);
    expect(spawnOut([process.execPath, "-e", probe], { env: {} })).toBe(home);
    expect(Bun.spawnSync({ cmd: [process.execPath, "-e", probe], env: bareEnv }).stdout.toString().trim()).toBe(home);
    expect(await asyncOut(Bun.spawn([process.execPath, "-e", probe], { env: bareEnv, stdout: "pipe" }))).toBe(home);
    expect(await asyncOut(Bun.spawn({ cmd: [process.execPath, "-e", probe], env: bareEnv, stdout: "pipe" }))).toBe(home);
    expect(spawnOut(["bun", "-e", probe], { env: { PATH: `${join(process.execPath, "..")}:/usr/bin:/bin` } })).toBe(home); // by name
  });
  test("what the child's own environment names still wins: its HOME, and the rest of what it set", () => {
    expect(spawnOut([process.execPath, "-e", probe], { env: { ...bareEnv, HOME: "/tmp/a-test-owns-this" } })).toBe("/tmp/a-test-owns-this");
    expect(spawnOut([process.execPath, "-e", "console.log(process.env.XDG_CONFIG_HOME)"], { env: { ...bareEnv, XDG_CONFIG_HOME: "/tmp/theirs" } })).toBe("/tmp/theirs");
    expect(spawnOut([process.execPath, "-e", "console.log(process.env.WALKIE_HOME ?? 'unset')"], { env: bareEnv })).toBe("unset"); // nothing else is added
  });
  test("a shell child still gets exactly its own environment (some tests assert it is empty)", () => {
    expect(spawnOut(["sh", "-c", "echo ${HOME-nohome}"], { env: bareEnv })).toBe("nohome");
  });
  test("runAsPerson hands its child the throwaway home when the test names none, and never replaces one it names", async () => {
    const none = await runAsPerson(["/bin/sh", "-c", 'echo "${HOME-nohome}"'], bareEnv);
    expect(none.out.trim()).toBe(home);
    const own = await runAsPerson(["/bin/sh", "-c", 'echo "${HOME-nohome}"'], { ...bareEnv, HOME: "/tmp/a-test-owns-this" });
    expect(own.out.trim()).toBe("/tmp/a-test-owns-this");
    const bun = await runAsPerson([process.execPath, "-e", probe], bareEnv);
    expect(bun.out.trim()).toBe(home);
  }, 60_000);
  test("a HOME-less `walkie hooks install grok --dry-run` child names the throwaway settings path, never the real one", async () => {
    const env = { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: join(home, "wh"), WALKIE_SOCKET: join(home, "wh", "none.sock") };
    expect("HOME" in env).toBe(false);
    const named = (text: string): void => {
      expect(text).toContain(`${home}/.claude/settings.json`);
      expect(text).toContain(`${home}/.grok/hooks/walkie.json`);
      expect(text).not.toContain(realHome);
      expect(text).toContain("would update");
    };
    const viaPerson = await runAsPerson([process.execPath, MAIN, "hooks", "install", "grok", "--dry-run"], env);
    expect(viaPerson.code).toBe(0);
    named(viaPerson.out);
    const direct = Bun.spawnSync([process.execPath, MAIN, "hooks", "install", "grok", "--dry-run"], { env, stdout: "pipe", stderr: "pipe" });
    expect(direct.exitCode).toBe(0);
    named(direct.stdout.toString());
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false); // a dry run: nothing was written, anywhere
  }, 60_000);
});

describe("git", () => {
  const git = (...args: string[]) => spawnOut(["git", ...args], { cwd: home });

  test("reads only the throwaway home's global config, which holds a default identity and nothing else", () => {
    expect(git("config", "--global", "--list")).toBe("user.name=Walkie Test\nuser.email=test@example.com");
    expect(git("config", "--show-origin", "--list")).not.toContain("osxkeychain"); // the system config's credential helper is not read
    expect(readFileSync(process.env.GIT_CONFIG_GLOBAL as string, "utf8").trim().split("\n")).toHaveLength(3);
    expect(inside(process.env.GIT_CONFIG_GLOBAL as string)).toBe(true);
  });

  test("gives a commit an identity without the developer's, and a test's own identity still wins", () => {
    expect(git("var", "GIT_AUTHOR_IDENT")).toMatch(/^Walkie Test <test@example\.com> /);
    expect(git("-c", "user.name=Own", "-c", "user.email=own@example.com", "var", "GIT_AUTHOR_IDENT")).toMatch(/^Own <own@example\.com> /);
  });
});
