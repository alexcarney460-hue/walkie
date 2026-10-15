import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
const helper = fileURLToPath(new URL("./postgres-binaries.ts", import.meta.url));
function fixture(): string {
  const path = mkdtempSync(join(tmpdir(), "walkie-pg-locator-"));
  fixtures.push(path);
  return path;
}
function executable(path: string, body = "#!/bin/sh\nexit 0\n"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o755 });
}
function pair(path: string): { initdb: string; pgctl: string } {
  executable(join(path, "initdb"));
  executable(join(path, "pg_ctl"));
  return { initdb: join(path, "initdb"), pgctl: join(path, "pg_ctl") };
}
function resolve(root: string, search = root): { exit: number; result: { initdb: string; pgctl: string } | null; error: string } {
  // Each mock lives only in this child. Host Homebrew fallback is excluded from the fixture.
  const runner = join(root, "resolve.ts");
  writeFileSync(runner, `import { mock } from "bun:test";
import * as fs from "node:fs";
const which = Bun.which.bind(Bun);
Bun.which = (name) => which(name, { PATH: process.env.FIXTURE_PATH });
const access = fs.accessSync;
const replacement = { ...fs, accessSync: (path, mode) => {
  if (String(path).startsWith("/opt/homebrew/bin/")) throw Error("host fallback excluded");
  return access(path, mode);
} };
mock.module("node:fs", () => ({ ...replacement, default: replacement }));
const { postgresBinaries } = await import(${JSON.stringify(helper)});
try { console.log(JSON.stringify(postgresBinaries())); }
catch (error) { console.error(error.message); process.exitCode = 1; }
`);
  const child = Bun.spawnSync([process.execPath, runner], {
    env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, FIXTURE_PATH: search },
    stdout: "pipe", stderr: "pipe", timeout: 5000,
  });
  const stdout = new TextDecoder().decode(child.stdout).trim();
  return { exit: child.exitCode, result: child.exitCode === 0 ? JSON.parse(stdout) : null, error: new TextDecoder().decode(child.stderr) };
}
function rejects(root: string, search = root): void {
  const got = resolve(root, search);
  expect(got.exit).toBe(1);
  expect(got.error).toContain("Postgres fixture requires matching initdb");
}

test("Postgres locator selects a regular executable PATH pair", () => {
  const root = fixture(), expected = pair(root);
  expect(resolve(root)).toMatchObject({ exit: 0, result: expected });
});
test("Postgres locator accepts symlinks to one canonical installation", () => {
  const root = fixture(), install = join(root, "install");
  pair(install);
  for (const name of ["initdb", "pg_ctl"]) symlinkSync(join(install, name), join(root, name));
  const got = resolve(root);
  expect(got.exit).toBe(0);
  expect(dirname(realpathSync(got.result!.initdb))).toBe(dirname(realpathSync(got.result!.pgctl)));
});
test("Postgres locator rejects searchable directories as tools", () => {
  const root = fixture(), install = join(root, "directories");
  for (const name of ["initdb", "pg_ctl"]) mkdirSync(join(install, name), { recursive: true });
  executable(join(root, "pg_config"), `#!/bin/sh\nprintf '%s\n' '${install}'\n`);
  rejects(root);
});
test("Postgres locator rejects mixed installations behind PATH symlinks", () => {
  const root = fixture(), a = join(root, "a"), b = join(root, "b");
  pair(a); pair(b);
  symlinkSync(join(a, "initdb"), join(root, "initdb"));
  symlinkSync(join(b, "pg_ctl"), join(root, "pg_ctl"));
  rejects(root);
});
test("Postgres locator falls back from an incomplete PATH pair to pg_config with spaces", () => {
  const root = fixture(), install = join(root, "installation with spaces");
  executable(join(root, "initdb"));
  const expected = pair(install);
  executable(join(root, "pg_config"), `#!/bin/sh\nprintf '%s\n' '${install}'\n`);
  expect(resolve(root)).toMatchObject({ exit: 0, result: expected });
});
test("Postgres locator rejects a nonexecutable companion", () => {
  const root = fixture(); pair(root); chmodSync(join(root, "pg_ctl"), 0o644);
  rejects(root);
});
test("Postgres locator does not mix separate PATH directories", () => {
  const root = fixture(), other = join(root, "other");
  executable(join(root, "initdb")); executable(join(other, "pg_ctl"));
  rejects(root, `${root}:${other}`);
});
