// Not a test of its own (no .test.ts suffix): test/unit/keychain-guard.test.ts copies it into a scratch directory as
// spellings.test.ts and runs it with `bun test` under a COPY of test/helpers/keychain-guard.ts whose protected program is a
// stand-in, STAND_DIR/bin/security, that records being run in STAND_DIR/reached.log. Every spelling of that stand-in must be
// refused before anything starts; a second stand-in of the same name elsewhere must still run. The real /usr/bin/security is
// never started: every bare name below is looked up on a PATH that has the stand-in's directory first.
import { expect, test } from "bun:test";
import * as cp from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.STAND_DIR as string;
// The guard COPY in the scratch directory (typed as the real one: it is the same file with one constant changed).
const { takeKeychainRefusals } = await import(join(DIR, "guard.ts")) as typeof import("../helpers/keychain-guard.ts");
const TOOL = join(DIR, "bin", "security");
const OTHER = join(DIR, "other", "security");
const LOG = join(DIR, "reached.log");
const PATH = `${join(DIR, "bin")}:/usr/bin:/bin`;
const OTHER_PATH = `${join(DIR, "other")}:/usr/bin:/bin`;
const SPELLINGS = [TOOL, `${DIR}/bin//security`, `${DIR}/bin/./security`, `${DIR}/bin/../bin/security`, `${DIR}//bin/security`];

mkdirSync(join(DIR, "links"), { recursive: true });
symlinkSync(TOOL, join(DIR, "links", "creds"));
symlinkSync(TOOL, join(DIR, "links", "security"));

/** The call must be refused (thrown) and recorded. */
function refused(fn: () => unknown, what: string): void {
  expect(fn, what).toThrow("tests never touch the real login Keychain");
  expect(takeKeychainRefusals(), what).toHaveLength(1);
}
/** node's wrappers may swallow the throw; the guard still records it and nothing starts. */
function recorded(fn: () => unknown, what: string): void {
  try { fn(); } catch { /* thrown or swallowed */ }
  expect(takeKeychainRefusals(), what).toHaveLength(1);
}

test("a path that normalizes to it, and a link to it under any name, by both spawn forms", () => {
  for (const path of [...SPELLINGS, join(DIR, "links", "creds"), join(DIR, "links", "security")]) {
    refused(() => Bun.spawnSync([path, "x"]), `spawnSync ${path}`);
    refused(() => Bun.spawn({ cmd: [path, "x"], stdout: "ignore" }), `spawn ${path}`);
  }
});

test("the bare name on a PATH that finds it, and a link named by itself on a PATH", () => {
  refused(() => Bun.spawnSync(["security", "x"], { env: { PATH } }), "bare name");
  refused(() => Bun.spawn(["security", "x"], { env: { PATH }, stdout: "ignore" }), "bare name, async");
  refused(() => Bun.spawnSync(["creds", "x"], { env: { PATH: `${join(DIR, "links")}:/usr/bin:/bin` } }), "a link found on PATH");
});

test("through a shell string, in sh, bash and zsh", () => {
  for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh"]) {
    for (const text of [`${TOOL} x`, `${DIR}/bin//security x`, `echo hi; ${TOOL} x`, `true && ${TOOL} x`, `(${TOOL} x)`, `FOO=1 ${TOOL} x`, `exec ${TOOL} x`,
      `env -i ${TOOL} x`, `echo $(${TOOL} x)`, `echo hi | ${TOOL} x`, `"${TOOL}" x`, "security x", "echo hi; security x"]) {
      refused(() => Bun.spawnSync([shell, "-c", text], { env: { PATH } }), `${shell} -c ${text}`);
    }
  }
  refused(() => Bun.spawnSync({ cmd: ["/bin/sh", "-c", `${TOOL} x`], env: { PATH } }), "object form");
});

test("through /usr/bin/env", () => {
  for (const argv of [["/usr/bin/env", TOOL, "x"], ["/usr/bin/env", "-i", TOOL, "x"], ["/usr/bin/env", "FOO=1", "BAR=2", TOOL, "x"], ["/usr/bin/env", "-u", "FOO", TOOL, "x"],
    ["/usr/bin/env", "-S", `${TOOL} x`], ["/usr/bin/env", "security", "x"], ["env", `${DIR}/bin//security`, "x"], ["/usr/bin/env", "/usr/bin/env", TOOL, "x"]]) {
    refused(() => Bun.spawnSync(argv, { env: { PATH } }), argv.join(" "));
  }
});

test("through Bun.$, every chained form, and the named import", async () => {
  const { $ } = await import("bun");
  refused(() => Bun.$`${TOOL} x`, "Bun.$");
  refused(() => Bun.$`${DIR}/bin//security x`, "Bun.$ spelled");
  refused(() => Bun.$`echo hi && ${TOOL} x`, "Bun.$ list");
  refused(() => Bun.$.nothrow()`${TOOL} x`, "nothrow");
  refused(() => Bun.$.cwd(DIR)`${TOOL} x`, "cwd");
  refused(() => Bun.$.env({ PATH })`security x`, "env");
  refused(() => $`${TOOL} x`, "named import");
});

test("through node:child_process (a string starts a shell)", () => {
  recorded(() => cp.execSync(`${TOOL} x`, { env: { PATH } }), "execSync");
  recorded(() => cp.execSync(`${DIR}/bin//security x`, { env: { PATH } }), "execSync spelled");
  recorded(() => cp.spawnSync("/bin/sh", ["-c", `${TOOL} x`], { env: { PATH } }), "spawnSync sh -c");
  recorded(() => cp.execFileSync("/usr/bin/env", [TOOL, "x"], { env: { PATH } }), "execFileSync env");
  recorded(() => cp.spawnSync(TOOL, ["x"]), "spawnSync");
});

test("a stand-in of the same name at another path still runs: by its path, through env, in a shell string, on its own PATH, in Bun.$", async () => {
  const run = (argv: string[], env: Record<string, string> = { PATH }): string => Bun.spawnSync(argv, { env }).stdout.toString().trim();
  expect(run([OTHER, "a"])).toBe("other a");
  expect(run(["/usr/bin/env", OTHER, "b"])).toBe("other b");
  expect(run(["/bin/sh", "-c", `${OTHER} c`])).toBe("other c");
  expect(run(["security", "d"], { PATH: OTHER_PATH })).toBe("other d");
  expect(run(["/bin/sh", "-c", "security e"], { PATH: OTHER_PATH })).toBe("other e");
  expect(run(["/usr/bin/env", `PATH=${join(DIR, "other")}`, "security", "f"])).toBe("other f");
  expect(run(["/bin/sh", "-c", `PATH=${join(DIR, "other")} security g`])).toBe("other g");
  expect(run(["/bin/sh", "-c", "echo security; echo /usr/bin/security-is-a-word"])).toBe("security\n/usr/bin/security-is-a-word");
  expect((await Bun.$`${OTHER} h`.text()).trim()).toBe("other h");
  expect((await Bun.$`echo security`.text()).trim()).toBe("security");
  expect(takeKeychainRefusals()).toEqual([]);
});

test("the protected stand-in was never started", () => {
  expect(existsSync(LOG)).toBe(false);
});
