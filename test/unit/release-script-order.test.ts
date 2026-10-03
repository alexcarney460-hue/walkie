// scripts/release.sh publishes the GitHub release BEFORE it pushes the source tag, so a failed upload leaves no published tag.
// Because of that order it must refuse an existing tag (local or on origin) before it calls gh at all, refuse a build whose
// commit or tree changed meanwhile, and put the tag on the commit that was built.
// The script runs for real in a throwaway git repo with a local bare "origin"; only the slow or networked tools it calls are
// stand-ins (bun, gh, shasum, timeout, the smoke script). The stand-in gh records which tags origin held when it was called;
// the stand-in timeout and bun test record each test shard they were asked to run, in order, and the stand-in bun prints the
// lines bun prints for a shard (its share of the files, then "Ran N tests across M files").
import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../scripts/release.sh");
const TAG = "v0.0.1";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const BUN = `#!/bin/sh
case "$1" in
  -e) echo 0.0.1 ;;
  test) echo "$*" >> "$FIXTURE_TESTS"
    # The agent and Walkie variables this shard's bun was handed (names only).
    env | sed -nE 's/^((WALKIE|CODEX|GROK|KIMI|HERMES)_[A-Za-z0-9_]*|CLAUDE[A-Za-z0-9_]*|AI_AGENT|GEMINI_CLI|CURSOR_AGENT|OPENCODE)=.*/\\1/p' | sort >> "$FIXTURE_TESTS.env"
    # ON_TEST runs once per shard; the *_SHARD switches decide how a shard ends and what it reports.
    if [ -n "\${ON_TEST:-}" ]; then sh -c "$ON_TEST" || true; fi
    shard=; for a in "$@"; do case "$a" in --shard=*) shard=\${a#--shard=} ;; esac; done
    i=\${shard%/*}; n=\${shard#*/}
    # Shard 1 holds SHARD1_FILES files (2) and every other shard one; TOTAL_EXTRA makes bun's total disagree with that, and
    # OTHER_TOTAL_SHARD makes one shard name a different total. bun says "test file" for a total of one.
    share=1; [ "$i" = 1 ] && share=\${SHARD1_FILES:-2}
    total=$((n - 1 + \${SHARD1_FILES:-2} + \${TOTAL_EXTRA:-0}))
    [ "$i" = "\${OTHER_TOTAL_SHARD:-none}" ] && total=$((total + 1))
    unit=files; [ "$total" = 1 ] && unit=file
    # Like bun, colour the share line when FORCE_COLOR asks for it, even into a file.
    dim=; reset=; case "\${FORCE_COLOR:-}" in ''|0) ;; *) dim=$(printf '\\033[2m'); reset=$(printf '\\033[0m') ;; esac
    echo "$dim--shard=$shard:$reset running $share/$total test $unit" >&2
    [ "$i" = "\${EXIT0_SHARD:-none}" ] && exit 0
    # A test that prints a share line and a summary of its own, then ends the process before bun's summary.
    if [ "$i" = "\${FAKE_SHARE_SHARD:-none}" ]; then echo "--shard=$shard: running 0/$total test files"; echo "Ran 0 tests across 0 files."; exit 0; fi
    # A test that leaves a process running, holding the shard's output open.
    if [ "$i" = "\${LEAK_SHARD:-none}" ]; then sleep 20 & echo $! > "$FIXTURE_TESTS.leak"; fi
    ran=$share; [ "$i" = "\${SHORT_SHARD:-none}" ] && ran=$((share - 1))
    if [ "$ran" = 1 ]; then echo "Ran 1 test across 1 file. [1.00ms]" >&2; else echo "Ran 3 tests across $ran files. [1.00ms]" >&2; fi
    # A failing test: bun still prints its complete summary, then exits 1.
    [ "$i" = "\${FAIL_SHARD:-none}" ] && exit 1
    exit 0 ;;
  install) echo "$(basename "$PWD") $*" >> "$FIXTURE_INSTALLS" ;;
  run) ;;
  scripts/build.ts) mkdir -p dist; printf '#!/bin/sh\\necho "walkie 0.0.1"\\n' > dist/walkie-darwin-arm64; chmod +x dist/walkie-darwin-arm64
    if [ -n "\${ON_BUILD:-}" ]; then sh -c "$ON_BUILD"; fi ;;
  scripts/discovery-package-check.ts) ;;
  scripts/sign-release.ts) echo "version $3" >> "$2"; : > "$2.sig" ;;
  *) echo "unexpected bun call: $*" >&2; exit 97 ;;
esac
`;
const GH = `#!/bin/sh
echo "gh $*" >> "$FIXTURE_LOG"
echo "origin tags at gh time: [$(git -C "$FIXTURE_ORIGIN" tag -l | tr '\\n' ' ')]" >> "$FIXTURE_LOG"
case "$1 $2" in
  "release view")
    [ "\${GH_RELEASE_EXISTS:-0}" = 1 ] && exit 0
    [ "\${GH_VIEW_BROKEN:-0}" = 1 ] && { echo "error connecting to api.github.com" >&2; exit 1; }
    echo "release not found" >&2; exit 1 ;;
esac
if [ -n "\${ON_GH:-}" ]; then sh -c "$ON_GH"; fi
[ "\${GH_FAIL:-0}" = 1 ] && { echo "gh: simulated upload failure" >&2; exit 1; }
exit 0
`;

// Records the options and the cap it was given, then runs the command.
const TIMEOUT = `#!/bin/sh
opts=
while :; do case "$1" in --foreground) opts="$opts $1"; shift ;; -k) opts="$opts $1 $2"; shift 2 ;; *) break ;; esac; done
echo "timeout$opts $1" >> "$FIXTURE_TESTS"
shift
exec "$@"
`;

function write(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

function sh(cwd: string, env: Record<string, string>, args: string[]): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode ?? -1, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

function fixture(): { repo: string; origin: string; log: string; env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "release-order-"));
  roots.push(root);
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, "home"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    FIXTURE_LOG: log, FIXTURE_ORIGIN: origin, FIXTURE_TESTS: join(root, "tests.log"),
    FIXTURE_INSTALLS: join(root, "installs.log"), TMPDIR: join(root, "tmp"),
  };
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  write(join(bin, "bun"), BUN, 0o755);
  write(join(bin, "gh"), GH, 0o755);
  write(join(bin, "shasum"), "#!/bin/sh\necho \"0000  fixture\"\n", 0o755);
  write(join(bin, "timeout"), TIMEOUT, 0o755);
  write(join(repo, "package.json"), '{"version":"0.0.1"}\n');
  write(join(repo, "src.txt"), "v1\n"); // a tracked file the tests edit "while the gates run"
  write(join(repo, ".gitignore"), "dist/\nweb/dist/\n"); // build outputs are ignored, as in the repo
  write(join(repo, "CHANGELOG.md"), `# Changelog\n\n## ${TAG}\n\n- fixture\n`);
  mkdirSync(join(repo, "web"), { recursive: true });
  mkdirSync(join(repo, "site"), { recursive: true });
  write(join(repo, "scripts/smoke-binary.sh"), "#!/bin/sh\nexit 0\n", 0o755);
  for (const f of ["scripts/windows/bootstrap.ps1", "scripts/windows/stage0.ps1", "scripts/install.sh"]) write(join(repo, f), "x\n");
  copyFileSync(SCRIPT, join(repo, "scripts/release.sh"));
  chmodSync(join(repo, "scripts/release.sh"), 0o755);
  expect(sh(root, env, ["git", "init", "--bare", "-q", origin]).code).toBe(0);
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "fixture"], ["remote", "add", "origin", origin]]) {
    expect(sh(repo, env, ["git", ...args]).code).toBe(0);
  }
  return { repo, origin, log, env };
}

const head = (f: { repo: string; env: Record<string, string> }, rev = "HEAD"): string => sh(f.repo, f.env, ["git", "rev-parse", rev]).out.trim();
const tags = (cwd: string, env: Record<string, string>, git: string[] = []): string => sh(cwd, env, ["git", ...git, "tag", "-l"]).out.trim();

test("the release is created before the source tag is pushed", () => {
  const f = fixture();
  const run = sh(f.repo, f.env, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).toBe(0);
  expect(run.out).toContain(`released ${TAG}`);
  const log = readFileSync(f.log, "utf8");
  expect(log).toContain("origin tags at gh time: []");
  expect(log).toContain(`gh release create ${TAG} `);
  expect(tags(f.origin, f.env, ["--git-dir", f.origin])).toBe(TAG);
  expect(tags(f.repo, f.env)).toBe(TAG);
});

test("a failed release upload leaves no tag, locally or on origin, and says so", () => {
  const f = fixture();
  const run = sh(f.repo, { ...f.env, GH_FAIL: "1" }, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).not.toBe(0);
  expect(run.err).toContain(`release upload failed and no release ${TAG} exists in alexcarney460-hue/walkie-releases; nothing was tagged or pushed in the source repo`);
  expect(run.err).toContain("Fix the cause and run again");
  expect(run.out).not.toContain(`released ${TAG}`);
  expect(tags(f.origin, f.env, ["--git-dir", f.origin])).toBe("");
  expect(tags(f.repo, f.env)).toBe("");
});

test("a tag push that fails after the release is live is reported with the command to finish it", () => {
  const f = fixture();
  // Only the push URL is broken: the pre-release tag check reads origin through the fetch URL and must still pass.
  expect(sh(f.repo, f.env, ["git", "remote", "set-url", "--push", "origin", join(f.repo, "no-such-origin.git")]).code).toBe(0);
  const built = head(f);
  const run = sh(f.repo, f.env, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).not.toBe(0);
  expect(run.err).toContain(`RELEASE ${TAG} IS LIVE (built from commit ${built}), but pushing the source tag failed`);
  expect(run.err).toContain(`finish by hand: git push origin ${TAG} (the local tag points at ${built})`);
  expect(run.out).not.toContain(`released ${TAG}`);
  expect(existsSync(f.log)).toBe(true);
  expect(readFileSync(f.log, "utf8")).toContain(`gh release create ${TAG} `);
});

test("a release that fails because one already exists says what state exists, not 'run again'", () => {
  const f = fixture();
  const run = sh(f.repo, { ...f.env, GH_FAIL: "1", GH_RELEASE_EXISTS: "1" }, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).not.toBe(0);
  expect(run.err).toContain(`a release ${TAG} already exists in alexcarney460-hue/walkie-releases`);
  expect(run.err).toContain(`gh release view ${TAG} -R alexcarney460-hue/walkie-releases`);
  expect(run.err).toContain(`was built from ${head(f)}, finish by hand: git tag -a ${TAG} ${head(f)} -m ${TAG} && git push origin ${TAG}`);
  expect(run.err).not.toContain("Fix the cause and run again");
  expect(tags(f.origin, f.env, ["--git-dir", f.origin])).toBe("");
  expect(tags(f.repo, f.env)).toBe("");
});

test("a release whose state gh cannot report says so instead of claiming none exists", () => {
  const f = fixture();
  const run = sh(f.repo, { ...f.env, GH_FAIL: "1", GH_VIEW_BROKEN: "1" }, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).not.toBe(0);
  expect(run.err).toContain(`gh could not say whether a release ${TAG} exists`);
  expect(run.err).not.toContain("no release");
  expect(run.err).not.toContain("Fix the cause and run again");
  expect(tags(f.repo, f.env)).toBe("");
});

test("a tag that appears while the gates run is caught before gh is called", () => {
  const f = fixture();
  const run = sh(f.repo, { ...f.env, ON_TEST: `git tag ${TAG}` }, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).not.toBe(0);
  expect(run.err).toContain(`tag ${TAG} already exists in this repo`);
  expect(run.err).toContain("nothing was published");
  expect(run.out).toContain("== gates"); // it got past the first check: the tag was made later
  expect(existsSync(f.log)).toBe(false);
  expect(tags(f.origin, f.env, ["--git-dir", f.origin])).toBe("");
});

function expectRefusedBeforeGh(f: ReturnType<typeof fixture>, run: { code: number; out: string; err: string }): void {
  expect(run.code).not.toBe(0);
  expect(run.out).not.toContain(`released ${TAG}`);
  expect(run.err).toContain("nothing was published");
  expect(existsSync(f.log)).toBe(false); // the stand-in gh appends to the log on every call: it was never called
  expect(existsSync(join(f.repo, "dist/SHA256SUMS"))).toBe(false); // refused before the gates and the build
}

test("a tag that already exists locally at another commit refuses before gh is called", () => {
  const f = fixture();
  expect(sh(f.repo, f.env, ["git", "tag", "-a", TAG, "-m", "old"]).code).toBe(0);
  const tagged = sh(f.repo, f.env, ["git", "rev-parse", "--short", "HEAD"]).out.trim();
  expect(sh(f.repo, f.env, ["git", "commit", "-q", "--allow-empty", "-m", "later"]).code).toBe(0);
  const run = sh(f.repo, f.env, ["sh", "scripts/release.sh", TAG]);
  expectRefusedBeforeGh(f, run);
  expect(run.err).toContain(`tag ${TAG} already exists in this repo (at ${tagged}`);
  expect(tags(f.origin, f.env, ["--git-dir", f.origin])).toBe("");
});

test("a tag that exists only on origin refuses before gh is called", () => {
  const f = fixture();
  expect(sh(f.repo, f.env, ["git", "tag", "-a", TAG, "-m", "old"]).code).toBe(0);
  expect(sh(f.repo, f.env, ["git", "push", "-q", "origin", TAG]).code).toBe(0);
  expect(sh(f.repo, f.env, ["git", "tag", "-d", TAG]).code).toBe(0);
  expect(sh(f.repo, f.env, ["git", "commit", "-q", "--allow-empty", "-m", "later"]).code).toBe(0);
  const run = sh(f.repo, f.env, ["sh", "scripts/release.sh", TAG]);
  expectRefusedBeforeGh(f, run);
  expect(run.err).toContain(`tag ${TAG} already exists on origin`);
  expect(tags(f.repo, f.env)).toBe(""); // still no local tag: nothing was created
  expect(tags(f.origin, f.env, ["--git-dir", f.origin])).toBe(TAG);
});

test("an origin that cannot be asked about the tag refuses before gh is called", () => {
  const f = fixture();
  expect(sh(f.repo, f.env, ["git", "remote", "set-url", "origin", join(f.repo, "no-such-origin.git")]).code).toBe(0);
  const run = sh(f.repo, f.env, ["sh", "scripts/release.sh", TAG]);
  expectRefusedBeforeGh(f, run);
  expect(run.err).toContain(`could not ask origin whether tag ${TAG} exists`);
});

function expectRefusedAfterBuild(f: ReturnType<typeof fixture>, run: { code: number; out: string; err: string }): void {
  expect(run.code).not.toBe(0);
  expect(run.out).toContain("== gates");
  expect(run.out).not.toContain(`released ${TAG}`);
  expect(run.err).toContain("nothing was published");
  expect(existsSync(f.log)).toBe(false); // gh was never called
  expect(tags(f.repo, f.env)).toBe("");
  expect(tags(f.origin, f.env, ["--git-dir", f.origin])).toBe("");
}

test("a tracked file edited while the gates run refuses before gh: the binaries would not be the commit", () => {
  const f = fixture();
  const run = sh(f.repo, { ...f.env, ON_TEST: "echo edited >> src.txt" }, ["sh", "scripts/release.sh", TAG]);
  expectRefusedAfterBuild(f, run);
  expect(run.err).toContain("the working tree changed while the gates and build ran");
  expect(run.err).toContain(head(f));
});

test("a stray untracked file left by the build refuses before gh; gitignored build output does not", () => {
  const f = fixture();
  const run = sh(f.repo, { ...f.env, ON_BUILD: "echo x > stray.txt" }, ["sh", "scripts/release.sh", TAG]);
  expectRefusedAfterBuild(f, run);
  expect(run.err).toContain("the working tree changed while the gates and build ran");
  // The control is the first test in this file: dist/ is written by the build and the release still goes out.
});

test("a commit that lands after the build refuses before gh, naming the built commit and the new HEAD", () => {
  const f = fixture();
  const built = head(f);
  const run = sh(f.repo, { ...f.env, ON_BUILD: "git commit -q --allow-empty -m late" }, ["sh", "scripts/release.sh", TAG]);
  expectRefusedAfterBuild(f, run);
  expect(run.err).toContain(`HEAD moved while the gates and build ran (built from ${built}, HEAD is now ${head(f)})`);
  expect(head(f)).not.toBe(built);
});

test("a commit that lands during the upload does not move the tag: it goes on the commit that was built", () => {
  const f = fixture();
  const built = head(f);
  const run = sh(f.repo, { ...f.env, ON_GH: "git commit -q --allow-empty -m during-upload" }, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).toBe(0);
  expect(run.out).toContain(`released ${TAG}`);
  expect(head(f)).not.toBe(built); // HEAD did move
  expect(head(f, `${TAG}^{commit}`)).toBe(built);
  expect(sh(f.origin, f.env, ["git", "--git-dir", f.origin, "rev-parse", `${TAG}^{commit}`]).out.trim()).toBe(built);
});

test("a local tag that appears during the upload and already names the built commit is called correct: only the push remains", () => {
  const f = fixture();
  const built = head(f);
  const run = sh(f.repo, { ...f.env, ON_GH: `git tag ${TAG}` }, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).not.toBe(0);
  expect(run.err).toContain(`RELEASE ${TAG} IS LIVE (built from commit ${built}), and a tag ${TAG} already exists here naming that commit, so the tag is correct`);
  expect(run.err).toContain(`the remaining step is: git push origin ${TAG}`);
  expect(run.err).not.toContain("must name");
  expect(run.err).not.toContain("git tag -a");
  expect(run.out).not.toContain(`released ${TAG}`);
  expect(tags(f.origin, f.env, ["--git-dir", f.origin])).toBe("");
});

test("a local tag that appears during the upload at another commit is not advised for pushing: the built commit replaces it", () => {
  const f = fixture();
  expect(sh(f.repo, f.env, ["git", "commit", "-q", "--allow-empty", "-m", "second"]).code).toBe(0);
  const built = head(f);
  const other = head(f, "HEAD~1");
  const run = sh(f.repo, { ...f.env, ON_GH: `git tag ${TAG} HEAD~1` }, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).not.toBe(0);
  expect(run.err).toContain(`RELEASE ${TAG} IS LIVE (built from commit ${built}), but a tag ${TAG} already exists here at another commit (${other}), which does not match the release; do not push it`);
  expect(run.err).toContain(`git tag -d ${TAG} && git tag -a ${TAG} ${built} -m ${TAG} && git push origin ${TAG}`);
  expect(run.err).not.toContain("so the tag is correct");
  expect(tags(f.origin, f.env, ["--git-dir", f.origin])).toBe("");
});

test("a tag step that fails with no tag in the way says to create it on the built commit", () => {
  const f = fixture();
  const built = head(f);
  // Identity comes from the repo config; the stand-in gh removes it during the upload, and useConfigOnly stops git inventing one.
  const env = { ...Object.fromEntries(Object.entries(f.env).filter(([key]) => !key.startsWith("GIT_AUTHOR") && !key.startsWith("GIT_COMMITTER"))),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true" };
  expect(sh(f.repo, env, ["git", "config", "user.name", "t"]).code).toBe(0);
  expect(sh(f.repo, env, ["git", "config", "user.email", "t@example.com"]).code).toBe(0);
  const run = sh(f.repo, { ...env, ON_GH: "git config --unset user.email" }, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).not.toBe(0);
  expect(run.err).toContain(`RELEASE ${TAG} IS LIVE (built from commit ${built}), but creating the source tag failed (the git error is above)`);
  expect(run.err).toContain(`finish by hand: git tag -a ${TAG} ${built} -m ${TAG} && git push origin ${TAG}`);
  expect(tags(f.repo, f.env)).toBe("");
});

test.each([["an annotated", ["-a", "-m", "old"]], ["a lightweight", []]])(
  "%s origin tag at another commit that appears during the upload is reported with a command that shows the commit it names", (_kind, tagArgs) => {
  const f = fixture();
  expect(sh(f.repo, f.env, ["git", "commit", "-q", "--allow-empty", "-m", "second"]).code).toBe(0);
  const built = head(f);
  const other = head(f, "HEAD~1");
  const hook = `git tag ${tagArgs.map((a) => (a === "old" ? "'old'" : a)).join(" ")} ${TAG} HEAD~1 && git push -q origin ${TAG} && git tag -d ${TAG} >/dev/null`;
  const run = sh(f.repo, { ...f.env, ON_GH: hook }, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).not.toBe(0);
  expect(run.err).toContain(`RELEASE ${TAG} IS LIVE (built from commit ${built}), but pushing the source tag failed`);
  expect(run.err).toContain(`If origin already has ${TAG} at another commit, that tag does not match the release`);
  const advised = `git ls-remote origin 'refs/tags/${TAG}' 'refs/tags/${TAG}^{}'`;
  expect(run.err).toContain(advised);
  expect(run.err).toContain(`the refs/tags/${TAG}^{} line (or the refs/tags/${TAG} line for a lightweight tag)`);
  expect(run.err).toContain(`(if it is ${built}, origin already has the right tag and no push is needed)`);
  // The advised command, run as written: the commit the origin tag names is in its output, and it is not the built commit.
  const shown = sh(f.repo, f.env, ["git", "ls-remote", "origin", `refs/tags/${TAG}`, `refs/tags/${TAG}^{}`]).out;
  const commitLine = shown.split("\n").find((line) => line.endsWith(`refs/tags/${TAG}^{}`)) ?? shown.split("\n").find((line) => line.endsWith(`refs/tags/${TAG}`));
  expect(commitLine?.split("\t")[0]).toBe(other);
  expect(commitLine?.split("\t")[0]).not.toBe(built);
});

test("status.showUntrackedFiles=no cannot hide a stray file from either clean check", () => {
  const before = fixture();
  expect(sh(before.repo, before.env, ["git", "config", "status.showUntrackedFiles", "no"]).code).toBe(0);
  writeFileSync(join(before.repo, "stray-before.txt"), "x\n");
  const first = sh(before.repo, before.env, ["sh", "scripts/release.sh", TAG]);
  expect(first.code).not.toBe(0);
  expect(first.err).toContain("working tree not clean");
  expect(existsSync(before.log)).toBe(false);
  const during = fixture();
  expect(sh(during.repo, during.env, ["git", "config", "status.showUntrackedFiles", "no"]).code).toBe(0);
  const second = sh(during.repo, { ...during.env, ON_BUILD: "echo x > stray-during.txt" }, ["sh", "scripts/release.sh", TAG]);
  expectRefusedAfterBuild(during, second);
  expect(second.err).toContain("the working tree changed while the gates and build ran");
});

test("no committer identity refuses before gh: the tag step after a live release could not succeed", () => {
  const f = fixture();
  const bare = Object.fromEntries(Object.entries(f.env).filter(([key]) => !key.startsWith("GIT_AUTHOR") && !key.startsWith("GIT_COMMITTER")));
  // useConfigOnly stops git from inventing an identity out of the user and host names, so the run is the same on every machine.
  const env = { ...bare, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true" };
  const run = sh(f.repo, env, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).not.toBe(0);
  expect(run.err).toContain("git has no committer identity");
  expect(run.err).toContain("nothing was published");
  expect(existsSync(f.log)).toBe(false);
  expect(tags(f.repo, f.env)).toBe("");
});

// The suite runs in shards: in one Bun process a crash in one file (Bun 1.3.14 on Linux arm64) left every later file unrun.
const shardCalls = (f: ReturnType<typeof fixture>): string[] => {
  const calls = join(dirname(f.repo), "tests.log"); // FIXTURE_TESTS
  return existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
};
const shardLines = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => [`timeout --foreground -k 30 1800`, `test --timeout 30000 --shard=${i + 1}/${n}`]).flat();
const shardLogs = (f: ReturnType<typeof fixture>): string[] => readdirSync(join(dirname(f.repo), "tmp"));

function expectGateStopped(f: ReturnType<typeof fixture>, run: { code: number; out: string; err: string }): void {
  expect(run.code).not.toBe(0);
  expect(shardCalls(f)).toEqual(shardLines(3)); // every shard ran, also the ones after the bad one
  expect(run.out).not.toContain("== build");
  expect(existsSync(join(f.repo, "dist"))).toBe(false);
  expect(existsSync(f.log)).toBe(false); // gh was never called
  expect(tags(f.repo, f.env)).toBe("");
  expect(tags(f.origin, f.env, ["--git-dir", f.origin])).toBe("");
  // The shards' output is kept for a look, outside the tree.
  const kept = shardLogs(f);
  expect(kept).toHaveLength(1);
  expect(kept[0]).toStartWith("walkie-release-tests.");
  expect(run.err).toContain(`(output: ${join(dirname(f.repo), "tmp", kept[0]!)})`);
  expect(readdirSync(join(dirname(f.repo), "tmp", kept[0]!)).sort()).toEqual(["shard-1", "shard-2", "shard-3"]);
  expect(sh(f.repo, f.env, ["git", "status", "--porcelain", "--untracked-files=normal"]).out).toBe("");
}

test("the suite runs as six shards by default, each under the 1800 s cap (Ctrl-C reaches bun, a kill 30 s after the cap) and the 30 s test guard, before the build", () => {
  const f = fixture();
  const run = sh(f.repo, f.env, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).toBe(0);
  expect(run.out).toContain(`released ${TAG}`);
  expect(shardCalls(f)).toEqual(shardLines(6));
  expect(run.out).toContain("--shard=6/6: running 1/7 test files"); // bun's own lines reach the operator
  expect(shardLogs(f)).toEqual([]); // a passing gate leaves no output behind
  expect(run.out.indexOf("-- tests: shard 6 of 6")).toBeGreaterThan(-1);
  expect(run.out.indexOf("-- tests: shard 6 of 6")).toBeLessThan(run.out.indexOf("== build"));
});

test("the root, web and site dependencies are installed before the suite: site/test imports site's own packages", () => {
  const f = fixture();
  const run = sh(f.repo, f.env, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).toBe(0);
  expect(readFileSync(join(dirname(f.repo), "installs.log"), "utf8").trim().split("\n"))
    .toEqual(["repo install --frozen-lockfile", "web install --frozen-lockfile", "site install --frozen-lockfile"]);
});

test("WALKIE_TEST_SHARDS sets how many shards run, and every shard runs once", () => {
  const f = fixture();
  const run = sh(f.repo, { ...f.env, WALKIE_TEST_SHARDS: "3" }, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).toBe(0);
  expect(shardCalls(f)).toEqual(shardLines(3));
});

// The stand-in prints a complete summary before it exits 1, as bun does when a test fails: only the exit code can stop it.
test.each(["1", "3"])("a failing shard (of 3, shard %s) stops the release after every shard ran: nothing is built or published", (bad) => {
  const f = fixture();
  const run = sh(f.repo, { ...f.env, WALKIE_TEST_SHARDS: "3", FAIL_SHARD: bad }, ["sh", "scripts/release.sh", TAG]);
  expectGateStopped(f, run);
  expect(run.err).toContain(`tests failed, or did not run every file, in shard(s) ${bad} of 3; nothing was built or published`);
});

test("a shard that exits 0 before bun's closing summary (a test that calls process.exit) stops the release", () => {
  const f = fixture();
  const run = sh(f.repo, { ...f.env, WALKIE_TEST_SHARDS: "3", EXIT0_SHARD: "2" }, ["sh", "scripts/release.sh", TAG]);
  expectGateStopped(f, run);
  expect(run.err).toContain("tests failed, or did not run every file, in shard(s) 2 of 3; nothing was built or published");
});

test("a shard whose summary counts fewer files than bun gave it stops the release", () => {
  const f = fixture();
  const run = sh(f.repo, { ...f.env, WALKIE_TEST_SHARDS: "3", SHORT_SHARD: "1" }, ["sh", "scripts/release.sh", TAG]);
  expectGateStopped(f, run);
  expect(run.err).toContain("tests failed, or did not run every file, in shard(s) 1 of 3; nothing was built or published");
});

test("shards whose files do not add up to bun's total stop the release", () => {
  const f = fixture();
  const run = sh(f.repo, { ...f.env, WALKIE_TEST_SHARDS: "3", TOTAL_EXTRA: "1" }, ["sh", "scripts/release.sh", TAG]);
  expectGateStopped(f, run);
  expect(run.err).toContain("the shards ran 4 test files but bun counted 5; nothing was built or published");
});

test("a shard that names a different total than the others stops the release", () => {
  const f = fixture();
  const run = sh(f.repo, { ...f.env, WALKIE_TEST_SHARDS: "3", OTHER_TOTAL_SHARD: "2" }, ["sh", "scripts/release.sh", TAG]);
  expectGateStopped(f, run);
  expect(run.err).toContain("tests failed, or did not run every file, in shard(s) 2 of 3; nothing was built or published");
});

test("bun's own share line is the first one: a test that prints a share line and a summary, then exits, stops the release", () => {
  const f = fixture();
  const run = sh(f.repo, { ...f.env, WALKIE_TEST_SHARDS: "3", FAKE_SHARE_SHARD: "2" }, ["sh", "scripts/release.sh", TAG]);
  expectGateStopped(f, run);
  expect(run.err).toContain("tests failed, or did not run every file, in shard(s) 2 of 3; nothing was built or published");
});

test("a colour setting in the environment (FORCE_COLOR=1) does not hide bun's lines from the checks", () => {
  const f = fixture();
  const run = sh(f.repo, { ...f.env, WALKIE_TEST_SHARDS: "3", FORCE_COLOR: "1" }, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).toBe(0);
  expect(run.out).toContain(`released ${TAG}`);
});

test("bun's singular wording for one file in all ('running 1/1 test file', 'across 1 file') passes", () => {
  const f = fixture();
  const run = sh(f.repo, { ...f.env, WALKIE_TEST_SHARDS: "1", SHARD1_FILES: "1" }, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).toBe(0);
  expect(run.out).toContain("--shard=1/1: running 1/1 test file\n");
  expect(run.out).toContain(`released ${TAG}`);
});

test("the tests run without the agent and session variables of the terminal that started the release; test knobs stay", () => {
  const f = fixture();
  const secret = "seat-token-value-never-printed";
  const leaked = {
    CLAUDECODE: "1", AI_AGENT: "claude-code_2.1.0_agent", CLAUDE_CODE_SESSION_ID: "00000000-0000-4000-8000-000000000000",
    CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PROJECT_DIR: "/somewhere", WALKIE_AGENT: "cc-release", WALKIE_SEAT_TOKEN: secret,
    CODEX_THREAD_ID: "thread", GROK_SESSION_ID: "grok", KIMI_SESSION_ID: "kimi",
  };
  const kept = { WALKIE_TEST_SSH_HOME: "/keep", WALKIE_PLAYWRIGHT_MODULE: "/keep/index.mjs", WALKIE_RECS_BROWSER: "1" };
  const run = sh(f.repo, { ...f.env, ...leaked, ...kept, WALKIE_TEST_SHARDS: "2" }, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).toBe(0);
  expect(run.out).toContain(`released ${TAG}`);
  // What each shard's bun saw, one sorted block per shard: the test knobs only (WALKIE_TEST_SHARDS is the release script's
  // own knob).
  const knobs = ["WALKIE_PLAYWRIGHT_MODULE", "WALKIE_RECS_BROWSER", "WALKIE_TEST_SHARDS", "WALKIE_TEST_SSH_HOME"];
  expect(readFileSync(join(dirname(f.repo), "tests.log.env"), "utf8").trim().split("\n")).toEqual([...knobs, ...knobs]);
  expect(run.out).toContain(`-- tests run without: ${Object.keys(leaked).sort().join(" ")}`);
  expect(run.out + run.err).not.toContain(secret);
});

test("a release started from a clean terminal names nothing it removed", () => {
  const f = fixture();
  const run = sh(f.repo, f.env, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).toBe(0);
  expect(run.out).not.toContain("-- tests run without");
  expect(readFileSync(join(dirname(f.repo), "tests.log.env"), "utf8").trim()).toBe("");
});

test("a process a test leaves running does not hold its shard (and the release) open after bun exits", () => {
  const f = fixture();
  const leak = join(dirname(f.repo), "tests.log.leak");
  try {
    const started = Date.now();
    const run = sh(f.repo, { ...f.env, WALKIE_TEST_SHARDS: "3", LEAK_SHARD: "2" }, ["sh", "scripts/release.sh", TAG]);
    const took = Date.now() - started;
    expect(run.code).toBe(0);
    expect(run.out).toContain(`released ${TAG}`);
    expect(existsSync(leak)).toBe(true); // the stand-in did leave its 20 s child behind
    expect(took).toBeLessThan(10_000); // a pipe the child holds open would keep the release waiting for all 20 s
  } finally {
    if (existsSync(leak)) { try { process.kill(Number(readFileSync(leak, "utf8").trim())); } catch { /* already gone */ } }
  }
}, 60_000);

// A number too long for the shell's -le made the loop run no shard at all, and the release went out (Opus review MUST).
test.each(["0", "two", "-1", "2.5", "03", "1000", "99999999999999999999"])("WALKIE_TEST_SHARDS=%p is refused before anything is installed or run", (value) => {
  const f = fixture();
  const run = sh(f.repo, { ...f.env, WALKIE_TEST_SHARDS: value }, ["sh", "scripts/release.sh", TAG]);
  expect(run.code).not.toBe(0);
  expect(run.err).toContain(`WALKIE_TEST_SHARDS must be a whole number from 1 to 999 (got '${value}'); nothing was run`);
  expect(run.out).not.toContain("== gates");
  expect(shardCalls(f)).toEqual([]);
  expect(existsSync(f.log)).toBe(false);
});
