#!/bin/sh
# Cut a release locally (CI-equivalent gates → build all targets → checksums → GitHub release).
#   scripts/release.sh v0.1.0
set -eu
tag="${1:?usage: scripts/release.sh vX.Y.Z}"
ver="${tag#v}"
cd "$(dirname "$0")/.."

[ -z "$(git status --porcelain)" ] || { echo "working tree not clean" >&2; exit 1; }
pkgver=$(bun -e 'console.log((await Bun.file("package.json").json()).version)')
[ "$pkgver" = "$ver" ] || { echo "package.json version $pkgver != $ver" >&2; exit 1; }
grep -q "^## $tag" CHANGELOG.md || { echo "CHANGELOG.md has no '## $tag' section" >&2; exit 1; }

echo "== gates"
bun install --frozen-lockfile >/dev/null && (cd web && bun install --frozen-lockfile >/dev/null)
bun run typecheck
timeout 1500 bun test --timeout 30000   # generous per-test timeout: the gate judges correctness, not machine load
echo "== build"
rm -rf dist
bun run web:build >/dev/null
# A prerelease tag (vX.Y.Z-pre.N) builds the targets whose iroh module n0 prebuilds (no Intel-Mac cargo compile;
# WALKIE_PRE_TARGETS overrides the list) and is published as a GitHub prerelease, so it never becomes "latest" for
# install.sh or `walkie update`; installers pin it with WALKIE_VERSION. A real release builds --all.
case "$tag" in *-*) pre=1 ;; *) pre=0 ;; esac
if [ "$pre" = 1 ]; then bun scripts/build.ts --targets "${WALKIE_PRE_TARGETS:-darwin-arm64,linux-x64,linux-arm64}"; else bun scripts/build.ts --all; fi
(cd dist && shasum -a 256 walkie-* > SHA256SUMS)
# SHA256SUMS gets its signed `version <tag>` line and SHA256SUMS.sig (ECDSA P-256, ~/keys/walkie-release-signing-p256.pem,
# 0600); both are verified by install.sh and `walkie update`, which also refuse a release named otherwise.
bun scripts/sign-release.ts dist/SHA256SUMS "$tag"
cat dist/SHA256SUMS
for f in dist/walkie-*; do case "$f" in *darwin-arm64) [ "$("$f" version)" = "walkie $ver" ] || { echo "$f reports $("$f" version), not walkie $ver" >&2; exit 1; } ;; esac; done

echo "== notes"
awk -v t="## $tag" '$0 ~ "^## " { p = ($0 ~ "^"t) } p' CHANGELOG.md > dist/NOTES.md

echo "== tag + release"
git tag -a "$tag" -m "$tag"
git push origin "$tag"
# Binaries go to the public, releases-only repo (the source repo stays private).
gh release create "$tag" -R "${WALKIE_RELEASE_REPO:-alexcarney460-hue/walkie-releases}" \
  dist/walkie-* dist/SHA256SUMS dist/SHA256SUMS.sig --title "Walkie $tag" --notes-file dist/NOTES.md \
  $( [ "$pre" = 1 ] && echo --prerelease --latest=false )
echo "released $tag"
