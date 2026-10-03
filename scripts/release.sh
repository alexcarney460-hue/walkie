#!/bin/sh
# Cut a release locally (CI-equivalent gates → build all targets → checksums → GitHub release).
#   scripts/release.sh v0.1.0
set -eu
tag="${1:?usage: scripts/release.sh vX.Y.Z}"
ver="${tag#v}"
cd "$(dirname "$0")/.."

# --untracked-files=normal: a user's status.showUntrackedFiles=no must not hide a stray file from either clean check.
[ -z "$(git status --porcelain --untracked-files=normal)" ] || { echo "working tree not clean" >&2; exit 1; }
# The commit everything below is built from, and the commit the source tag goes on (never "whatever HEAD is by then").
head_sha=$(git rev-parse HEAD)
pkgver=$(bun -e 'console.log((await Bun.file("package.json").json()).version)')
[ "$pkgver" = "$ver" ] || { echo "package.json version $pkgver != $ver" >&2; exit 1; }
# Heading policy: exact "## <tag>" or "## <tag> (unreleased)" only.
# Require exactly one section (including across both forms); buffer before emitting.
notes=$(awk -v t="## $tag" '
  /^## / {
    selected = ($0 == t || $0 == t " (unreleased)")
    if (selected) count++
  }
  selected { notes = notes $0 "\n" }
  END { if (count != 1) exit 1; printf "%s", notes }
' CHANGELOG.md) || { echo "CHANGELOG.md must contain exactly one section for $tag (optional ' (unreleased)' suffix)" >&2; exit 1; }
rel_repo="${WALKIE_RELEASE_REPO:-alexcarney460-hue/walkie-releases}"

# Refuse before anything is published when the tag already exists, here or on origin. The release is created before the tag
# is pushed, so without this check a stale tag would not stop it: binaries built from HEAD could go out for a different commit
# than the tag names, and the later `git tag` / `git push` could never succeed. An unreachable origin also refuses, because the
# tag push after a live release would fail the same way. The script never moves a tag.
refuse_if_tagged() {
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    echo "tag $tag already exists in this repo (at $(git rev-parse --short "$tag^{commit}"), HEAD is $(git rev-parse --short HEAD)); nothing was published. Pick the next version, or remove the stale tag yourself first if no release was cut from it" >&2
    exit 1
  fi
  ls_rc=0
  git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1 || ls_rc=$?
  case "$ls_rc" in
    0) echo "tag $tag already exists on origin; nothing was published. Pick the next version, or remove the stale tag from origin yourself first if no release was cut from it" >&2; exit 1 ;;
    2) ;;
    *) echo "could not ask origin whether tag $tag exists (git ls-remote exit $ls_rc); nothing was published. Fix the connection and run again" >&2; exit 1 ;;
  esac
}

# The gates and the build take a long time. Right before publishing, refuse (nothing published) unless the build still matches
# the commit it was started from: HEAD unmoved and the tree clean (dist/, web/dist/ and the *.gen.ts files are gitignored, so
# build outputs do not count). Otherwise binaries could go out from a dirty tree, or for a commit the tag does not name. The
# tag step also needs a committer identity, and finding that out after the release is live would leave a release with no tag.
refuse_if_changed() {
  if [ "$(git rev-parse HEAD)" != "$head_sha" ]; then
    echo "HEAD moved while the gates and build ran (built from $head_sha, HEAD is now $(git rev-parse HEAD)); nothing was published. Check out $head_sha, or run again from the commit you mean to release" >&2
    exit 1
  fi
  if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
    echo "the working tree changed while the gates and build ran (git status is not clean); the binaries are not exactly commit $head_sha, so nothing was published. Restore the tree and run again" >&2
    exit 1
  fi
  git var GIT_COMMITTER_IDENT >/dev/null 2>&1 \
    || { echo "git has no committer identity, so the source tag could not be created after the release; nothing was published. Set user.name and user.email, then run again" >&2; exit 1; }
}
refuse_if_tagged

# The test suite (test/, src/, web/test and site/test) runs in this many processes; WALKIE_TEST_SHARDS (1 to 999) overrides it,
# checked before anything runs (more digits would break the shell's number test, and the loop would then run no shard at all).
# In one process a crash in any file ends the run with every later file unrun (Bun 1.3.14 segfaults in
# test/unit/machine-stats-hardening.test.ts on Linux arm64 with 263 files still to run), the run nears the 2400 s cap and the
# process grows past 3.8 GB.
shards="${WALKIE_TEST_SHARDS:-6}"
case "$shards" in ''|*[!0-9]*|0*|????*) echo "WALKIE_TEST_SHARDS must be a whole number from 1 to 999 (got '$shards'); nothing was run" >&2; exit 1 ;; esac

echo "== gates"
# One install per line: in an AND-list a failed root install would not stop the script under set -e.
bun install --frozen-lockfile >/dev/null
(cd web && bun install --frozen-lockfile >/dev/null)
# site/test is part of the suite and imports site's own dependencies (stripe, postgres).
(cd site && bun install --frozen-lockfile >/dev/null)
bun run typecheck
# bun's --shard deals the sorted test files out round-robin, so every file belongs to exactly one shard. Each shard has a
# 1800 s cap (the slowest of six took 572 s on a loaded Spark) and each test its 30 s hang guard; --foreground lets Ctrl-C reach
# bun at once (otherwise the shell waits out the shard), and -k 30 kills a bun that ignores the cap's TERM. Every shard runs, so
# one run reports the failures of every shard. A crash, or a test that exits the process, still ends its own shard early, so a
# shard passes only when bun exits 0 and its closing "Ran ... across M files" counts exactly the files bun said the shard would
# run, every shard names the same total, and the shards' files add up to it. Each shard's output is kept outside the tree when
# the gate fails.
# The tests run without the agent and session variables of the terminal the release was started from. A release started from
# an agent's shell handed every test its CLAUDE_CODE_SESSION_ID (the CLI under test then wrote as that agent) and its
# CLAUDECODE (bun then printed only failures): every WALKIE_* variable except the test knobs (WALKIE_TEST_*,
# WALKIE_PLAYWRIGHT_MODULE, and the suites a maintainer opts into: WALKIE_RECS_BROWSER, WALKIE_RECS_BROWSER_URL,
# WALKIE_RECS_EVIDENCE, WALKIE_SUDO_CONTAINERS, WALKIE_FP_CORPUS) goes, and so does every variable an agent runtime sets
# (CLAUDE*, CODEX_*, GROK_*, KIMI_*, HERMES_*, AI_AGENT, GEMINI_CLI, CURSOR_AGENT, OPENCODE). Their names are printed, never
# their values.
test_env_unset=$(env | sed -nE 's/^((WALKIE|CODEX|GROK|KIMI|HERMES)_[A-Za-z0-9_]*|CLAUDE[A-Za-z0-9_]*|AI_AGENT|GEMINI_CLI|CURSOR_AGENT|OPENCODE)=.*/\1/p' \
  | grep -v -e '^WALKIE_TEST_' -e '^WALKIE_PLAYWRIGHT_MODULE$' -e '^WALKIE_RECS_BROWSER$' -e '^WALKIE_RECS_BROWSER_URL$' \
    -e '^WALKIE_RECS_EVIDENCE$' -e '^WALKIE_SUDO_CONTAINERS$' -e '^WALKIE_FP_CORPUS$' | sort -u)
test_env=
for name in $test_env_unset; do test_env="$test_env -u $name"; done
[ -z "$test_env_unset" ] || echo "-- tests run without:" $test_env_unset
logs=$(mktemp -d "${TMPDIR:-/tmp}/walkie-release-tests.XXXXXX")
failed=
files=0
total=
i=1
while [ "$i" -le "$shards" ]; do
  out="$logs/shard-$i"
  echo "-- tests: shard $i of $shards (live: tail -f $out)"
  # Straight to a file, not through a pipe: a process a test leaves running would hold a pipe open after bun exits, past the
  # cap. FORCE_COLOR=0: a colour setting in the environment would colour bun's lines (even into a file) and hide them below.
  rc=0
  # shellcheck disable=SC2086 # $test_env is a list of `-u NAME` words
  FORCE_COLOR=0 timeout --foreground -k 30 1800 env $test_env bun test --timeout 30000 --shard="$i/$shards" > "$out" 2>&1 || rc=$?
  cat "$out"
  # bun prints the shard's share before any test runs, so the first such line is bun's own; its summary comes last.
  share=$(sed -n "s#^--shard=$i/$shards: running \([0-9][0-9]*\)/\([0-9][0-9]*\) test files\{0,1\}\$#\1/\2#p" "$out" | head -n 1)
  ran=$(sed -n 's/^Ran [0-9][0-9]* tests\{0,1\} across \([0-9][0-9]*\) files\{0,1\}\..*$/\1/p' "$out" | tail -n 1)
  if [ "$rc" = 0 ] && [ -n "$share" ] && [ "$ran" = "${share%/*}" ] && { [ -z "$total" ] || [ "$total" = "${share#*/}" ]; }; then
    files=$((files + ran)); total=${share#*/}
  else
    failed="$failed $i"
  fi
  i=$((i + 1))
done
[ -z "$failed" ] || { echo "tests failed, or did not run every file, in shard(s)$failed of $shards; nothing was built or published (output: $logs)" >&2; exit 1; }
[ -n "$total" ] && [ "$total" != 0 ] && [ "$files" = "$total" ] \
  || { echo "the shards ran $files test files but bun counted ${total:-none}; nothing was built or published (output: $logs)" >&2; exit 1; }
rm -rf "$logs"
echo "== build"
rm -rf dist
bun run web:build >/dev/null
# A prerelease tag (vX.Y.Z-pre.N) builds the targets whose iroh module n0 prebuilds (no Intel-Mac cargo compile;
# WALKIE_PRE_TARGETS overrides the list) and is published as a GitHub prerelease, so it never becomes GitHub's "latest":
# the stable `walkie update` path (releases/latest) and WALKIE_VERSION=latest never see it. A pre-release install's
# `walkie update`, like a plain `curl ... | sh`, takes the DEFAULT_VERSION line of the site's install.sh, so publish the GitHub
# release BEFORE deploying the site with that line bumped (the other way round, those downloads get an HTTP 404 until the
# release exists). Installers can also pin a pre-release with WALKIE_VERSION. A real release builds --all.
case "$tag" in *-*) pre=1 ;; *) pre=0 ;; esac
if [ "$pre" = 1 ]; then bun scripts/build.ts --targets "${WALKIE_PRE_TARGETS:-darwin-arm64,linux-x64,linux-arm64}"; else bun scripts/build.ts --all; fi
[ -x dist/walkie-darwin-arm64 ] || { echo "darwin-arm64 binary missing from release build" >&2; exit 1; }
scripts/smoke-binary.sh dist/walkie-darwin-arm64 "$ver"
bun scripts/discovery-package-check.ts
cp scripts/windows/bootstrap.ps1 dist/walkie-windows-bootstrap.ps1
cp scripts/windows/stage0.ps1 dist/walkie-windows-stage0.ps1
cp scripts/install.sh dist/install.sh
(cd dist && shasum -a 256 walkie-* install.sh > SHA256SUMS)
# SHA256SUMS gets its signed `version <tag>` line and SHA256SUMS.sig (ECDSA P-256, ~/keys/walkie-release-signing-p256.pem,
# 0600); both are verified by install.sh and `walkie update`, which also refuse a release named otherwise.
bun scripts/sign-release.ts dist/SHA256SUMS "$tag"
cat dist/SHA256SUMS
for f in dist/walkie-*; do case "$f" in *darwin-arm64) [ "$("$f" version)" = "walkie $ver" ] || { echo "$f reports $("$f" version), not walkie $ver" >&2; exit 1; } ;; esac; done

echo "== notes"
printf '%s\n' "$notes" > dist/NOTES.md

echo "== release, then tag"
# The release goes first. The upload is the step that can fail (network, auth, a large asset), and a failed upload then leaves
# nothing published and nothing to undo: gh creates the tag in the releases repo itself. The source tag is pushed only once the
# release exists. If that push fails the release is already live, so the message says what to finish by hand (a tag pushed first
# and a release that then failed used to leave a published tag with no release). The tag check runs again here because the
# gates above take a long time and the tag may have appeared meanwhile, or the commit or the tree may have changed.
# Binaries go to the public, releases-only repo (the source repo stays private).
refuse_if_tagged
refuse_if_changed
if ! gh release create "$tag" -R "$rel_repo" \
  dist/walkie-* dist/install.sh dist/SHA256SUMS dist/SHA256SUMS.sig --title "Walkie $tag" --notes-file dist/NOTES.md \
  $( [ "$pre" = 1 ] && echo --prerelease --latest=false ); then
  # Say which state exists: a release left behind by an earlier or partial run must not be answered with "run again".
  view_rc=0
  view_out=$(gh release view "$tag" -R "$rel_repo" 2>&1) || view_rc=$?
  if [ "$view_rc" = 0 ]; then
    echo "release upload failed and a release $tag already exists in $rel_repo (published earlier, or left partly uploaded); nothing was tagged or pushed in the source repo. Look at it: gh release view $tag -R $rel_repo. If it is incomplete, delete it (gh release delete $tag -R $rel_repo --cleanup-tag --yes) and run again; if it is complete and was built from $head_sha, finish by hand: git tag -a $tag $head_sha -m $tag && git push origin $tag" >&2
  elif printf '%s' "$view_out" | grep -qi "release not found"; then
    echo "release upload failed and no release $tag exists in $rel_repo; nothing was tagged or pushed in the source repo. Fix the cause and run again" >&2
  else
    echo "release upload failed and gh could not say whether a release $tag exists in $rel_repo; nothing was tagged or pushed in the source repo. Check first: gh release view $tag -R $rel_repo (delete a partly uploaded release with gh release delete $tag -R $rel_repo --cleanup-tag --yes), then run again" >&2
  fi
  exit 1
fi
# Everything below runs with the release already live. The tag goes on the commit that was built, not on HEAD, and each failure
# says so and names that commit, because a rerun from a moved HEAD would otherwise suggest tagging the wrong one.
live="RELEASE $tag IS LIVE (built from commit $head_sha)"
if ! git tag -a "$tag" "$head_sha" -m "$tag"; then
  # Say what the failure left: a tag that already names the built commit is correct and only needs pushing.
  existing=$(git rev-parse -q --verify "refs/tags/$tag^{commit}" 2>/dev/null || true)
  if [ "$existing" = "$head_sha" ]; then
    echo "$live, and a tag $tag already exists here naming that commit, so the tag is correct (the git error is above); the remaining step is: git push origin $tag" >&2
  elif [ -n "$existing" ]; then
    echo "$live, but a tag $tag already exists here at another commit ($existing), which does not match the release; do not push it. Replace it with the built commit: git tag -d $tag && git tag -a $tag $head_sha -m $tag && git push origin $tag" >&2
  else
    echo "$live, but creating the source tag failed (the git error is above); finish by hand: git tag -a $tag $head_sha -m $tag && git push origin $tag" >&2
  fi
  exit 1
fi
git push origin "$tag" \
  || { echo "$live, but pushing the source tag failed (the git error is above). If origin already has $tag at another commit, that tag does not match the release: the commit it names is the refs/tags/$tag^{} line (or the refs/tags/$tag line for a lightweight tag) of git ls-remote origin 'refs/tags/$tag' 'refs/tags/$tag^{}'; compare it with $head_sha (if it is $head_sha, origin already has the right tag and no push is needed). Otherwise finish by hand: git push origin $tag (the local tag points at $head_sha)" >&2; exit 1; }
echo "released $tag"
