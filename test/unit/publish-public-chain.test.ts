import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const temp = mkdtempSync(join(tmpdir(), "walkie-publish-chain-"));
const source = join(temp, "source");
const publicRepo = join(temp, "public");
const remote = join(temp, "remote.git");
const script = join(source, "scripts/publish-public.sh");

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function versionCommit(version: string) {
  writeFileSync(join(source, "package.json"), `${JSON.stringify({ name: "walkie", version }, null, 2)}\n`);
  git(source, "add", "package.json");
  git(source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", `source ${version}`);
  git(source, "tag", `v${version}`);
}

beforeAll(() => {
  const clone = Bun.spawnSync(["git", "clone", "--quiet", "--local", root, source]);
  if (clone.exitCode !== 0) throw new Error(clone.stderr.toString());
  for (const file of ["publish-public.sh", "public-manifest.txt", "public-terms.txt", "public-gitleaks.toml", "public-scan.py"])
    cpSync(join(root, "scripts", file), join(source, "scripts", file));
  git(source, "config", "user.name", "Test");
  git(source, "config", "user.email", "test@example.com");
  versionCommit("0.0.1");
  versionCommit("0.0.2");
  const init = Bun.spawnSync(["git", "init", "--bare", "--quiet", remote]);
  if (init.exitCode !== 0) throw new Error(init.stderr.toString());
});

afterAll(() => rmSync(temp, { recursive: true, force: true }));

test("pushes successive public exports as linear commits whose trees match the exports", () => {
  for (const version of ["0.0.1", "0.0.2"]) {
    const result = Bun.spawnSync([script, version, publicRepo, "--push", remote], {
      env: { ...process.env, WALKIE_PUBLIC_AUTHOR: "Test Publisher <publisher@example.com>" },
      stdout: "pipe", stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString() + result.stdout.toString());
    expect(git(publicRepo, "show", "-s", "--format=%s", `v${version}`)).toBe(`Walkie ${version}`);
    expect(git(publicRepo, "show", "-s", "--format=%an <%ae>|%cn <%ce>", `v${version}`)).toBe(
      "Test Publisher <publisher@example.com>|Test Publisher <publisher@example.com>",
    );
    expect(git(publicRepo, "write-tree")).toBe(git(publicRepo, "rev-parse", `v${version}^{tree}`));
  }
  const first = git(publicRepo, "rev-parse", "v0.0.1^{tree}");
  const second = git(publicRepo, "rev-parse", "v0.0.2^{tree}");
  expect(first).not.toBe(second);
  expect(git(publicRepo, "rev-parse", "v0.0.2^" )).toBe(git(publicRepo, "rev-parse", "v0.0.1"));
  expect(git(publicRepo, "rev-list", "--count", "main")).toBe("2");
  expect(git(publicRepo, "ls-remote", remote, "refs/heads/main").split("\t")[0]).toBe(git(publicRepo, "rev-parse", "main"));
  expect(readFileSync(join(publicRepo, "package.json"), "utf8")).toContain('"version": "0.0.2"');
}, 60_000);
