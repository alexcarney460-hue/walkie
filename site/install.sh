#!/bin/sh
# Walkie installer: downloads the right walkie binary from GitHub Releases, verifies the release
# signature over the checksums, the release version and the binary's checksum, puts it on PATH and
# runs `walkie setup`.
#   curl -fsSL https://getwalkie.vercel.app/install.sh | sh
#   … | sh -s -- --invite wk1…                 (extra args go to walkie setup: a teammate's invite code)
#   … | sh -s -- --join <teammate-machine>     (a Tailscale team: join through a teammate's machine)
#   … | sh -s -- --invite wk1… --allow-team-agents   (and let the team start agents here: walkie seats enable)
# Env: WALKIE_VERSION (default: DEFAULT_VERSION below; "latest" = GitHub's latest release), WALKIE_REPO (default below),
#      WALKIE_BIN_DIR (default ~/.local/bin),
#      WALKIE_BASE_URL (download from a mirror instead of GitHub Releases),
#      WALKIE_ALLOW_DOWNGRADE=1 (replace a newer installed walkie with the older signed release)
#
# What is verified, in this order, with nothing but curl, openssl and shasum/sha256sum, all of it in a
# temporary directory: the installed binary (if any) is only replaced, atomically, after every check passed.
#   1. SHA256SUMS.sig is an ECDSA P-256 / SHA-256 signature by the Walkie RELEASE key (below) over
#      SHA256SUMS, checked with `openssl dgst -sha256 -verify` (works with the LibreSSL that macOS ships
#      as /usr/bin/openssl and with OpenSSL 1.0+). Without openssl the installer refuses.
#   2. The signed `version <tag>` line names the release asked for (WALKIE_VERSION, or the tag GitHub's
#      "latest" resolves to), so a signed older release can't be served back as the latest one.
#   3. The binary's SHA-256 matches the (now authenticated) SHA256SUMS.
#   4. The signed release is not older than the walkie already installed (a mirror replaying an older
#      signed release can't roll a machine back), unless WALKIE_ALLOW_DOWNGRADE=1.
#   5. The downloaded binary reports the signed version (`walkie version`) before it replaces anything.
set -eu

REPO="${WALKIE_REPO:-alexcarney460-hue/walkie-releases}"
BIN_DIR="${WALKIE_BIN_DIR:-$HOME/.local/bin}"
# The release a plain `curl … | sh` installs. Bump this one line when a new release should be what new machines get;
# site/build.py reads it for the landing page's footer, so the page and the installer can't drift apart.
DEFAULT_VERSION="v0.2.0-pre.8"
VERSION="${WALKIE_VERSION:-$DEFAULT_VERSION}"
# The Walkie release-signing public key (EC P-256). Not the license key. Rotated only by a new installer.
RELEASE_PUBKEY_PEM='-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEgkx2EdLfMqWSGF8WsQZH3Gtu2spE
oaH2+rvI0pAS8YP+YMv/PtLnx0Vuuqvl1DA5gIeotdirB6ixuE90qd3lfw==
-----END PUBLIC KEY-----'

say() { printf '%s\n' "$*"; }
die() { printf 'walkie install: %s\n' "$*" >&2; exit 1; }

# semver_lt A B: succeeds when version A orders before B (major.minor.patch numerically, then semver §11
# prerelease rules: a prerelease sorts before its release, numeric identifiers before alphanumeric ones).
# A leading "v" and build metadata (+…) are ignored. Plain awk, so it runs on a stock macOS or Linux.
semver_lt() {
  awk -v a="${1#v}" -v b="${2#v}" '
    function cmpid(x, y,   nx, ny) {
      nx = (x ~ /^[0-9]+$/); ny = (y ~ /^[0-9]+$/)
      if (nx && ny) return (x + 0 < y + 0) ? -1 : (x + 0 > y + 0) ? 1 : 0
      if (nx != ny) return nx ? -1 : 1
      return (x < y) ? -1 : (x > y) ? 1 : 0
    }
    function cmp(p, q,   pc, qc, pp, qp, pn, qn, pi, qi, i, n, m, r) {
      sub(/\+.*/, "", p); sub(/\+.*/, "", q)
      pp = index(p, "-") ? substr(p, index(p, "-") + 1) : ""; pc = p; sub(/-.*/, "", pc)
      qp = index(q, "-") ? substr(q, index(q, "-") + 1) : ""; qc = q; sub(/-.*/, "", qc)
      split(pc, pn, "."); split(qc, qn, ".")
      for (i = 1; i <= 3; i++) if (pn[i] + 0 != qn[i] + 0) return (pn[i] + 0 < qn[i] + 0) ? -1 : 1
      if (pp == "" && qp == "") return 0
      if (pp == "") return 1
      if (qp == "") return -1
      n = split(pp, pi, "."); m = split(qp, qi, ".")
      for (i = 1; i <= n && i <= m; i++) { r = cmpid(pi[i], qi[i]); if (r) return r }
      return (n < m) ? -1 : (n > m) ? 1 : 0
    }
    BEGIN { exit !(cmp(a, b) < 0) }'
}

os=$(uname -s)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "unsupported OS: $os (macOS and Linux only for now)" ;;
esac
arch=$(uname -m)
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x86_64 ;;
  *) die "unsupported CPU: $arch" ;;
esac
asset="walkie-$os-$arch"

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v openssl >/dev/null 2>&1 || die "openssl is required to verify the release signature: refusing to install unverified binaries"
case "$VERSION" in
  latest|v[0-9]*) ;;
  *) die "WALKIE_VERSION must be a release tag like v0.1.0 (or latest)" ;;
esac
# Pre-releases are built for Apple Silicon Macs and Linux only: say so instead of failing the download.
no_intel_build() {
  die "$1 has no Intel Mac build. Set WALKIE_VERSION=latest to install the latest full release instead (Tailscale teams only), or build from source."
}
if [ -z "${WALKIE_VERSION:-}" ] && [ -z "${WALKIE_BASE_URL:-}" ] && [ "$asset" = walkie-darwin-x86_64 ]; then
  no_intel_build "$DEFAULT_VERSION"
fi

# The release asked for. With GitHub, "latest" is resolved to its tag first so the download and the
# signed version line are bound to the same release; DEFAULT_VERSION is a tag and binds the same way. A mirror
# without WALKIE_VERSION installs whatever release it signs for (the version is still checked against the installed
# binary).
expected=""
if [ -n "${WALKIE_BASE_URL:-}" ]; then
  base="$WALKIE_BASE_URL"                       # mirrors / testing
  case "${WALKIE_VERSION:-latest}" in latest) ;; *) expected="$VERSION" ;; esac
else
  if [ "$VERSION" = latest ]; then
    final=$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") \
      || die "could not resolve the latest release of $REPO (set WALKIE_VERSION=vX.Y.Z to pin one)"
    VERSION="${final##*/}"
    case "$VERSION" in v[0-9]*) ;; *) die "could not resolve the latest release tag (got '$VERSION'); set WALKIE_VERSION=vX.Y.Z" ;; esac
  fi
  expected="$VERSION"
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

tmp=$(mktemp -d)
staged=""
cleanup() { rm -rf "$tmp"; [ -n "$staged" ] && rm -f "$staged"; return 0; }
trap cleanup EXIT INT TERM
say "Downloading $asset ($VERSION)…"
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || die "checksum download failed"
# A release with no build for this machine says so before the binary download (the file is verified below; this
# only refuses early).
if ! grep -q " $asset\$" "$tmp/SHA256SUMS"; then
  [ "$asset" = walkie-darwin-x86_64 ] && no_intel_build "$VERSION"
  die "$VERSION has no build for this machine ($asset)"
fi
curl -fsSL "$base/$asset" -o "$tmp/walkie" || die "download failed: $base/$asset"
curl -fsSL "$base/SHA256SUMS.sig" -o "$tmp/SHA256SUMS.sig" || die "signature download failed (SHA256SUMS.sig)"

# 1. The checksums must be the vendor's: verify the release signature.
printf '%s\n' "$RELEASE_PUBKEY_PEM" > "$tmp/release.pub"
openssl dgst -sha256 -verify "$tmp/release.pub" -signature "$tmp/SHA256SUMS.sig" "$tmp/SHA256SUMS" >/dev/null 2>&1 \
  || die "release signature does not verify for SHA256SUMS: refusing to install (the download may be tampered with)"

# 2. The signed checksums must be those of the release asked for.
signed=$(grep '^version ' "$tmp/SHA256SUMS" | awk '{print $2}')
[ "$(printf '%s\n' "$signed" | grep -c .)" = 1 ] || die "SHA256SUMS carries no single signed 'version' line: refusing to install"
case "$signed" in v[0-9]*.[0-9]*.[0-9]*) ;; *) die "SHA256SUMS names an invalid version '$signed'" ;; esac
if [ -n "$expected" ]; then
  [ "$signed" = "$expected" ] || die "SHA256SUMS is signed for release $signed, not $expected: refusing to install (the download may be an older release served back)"
fi

# 3. The binary must match the (now authenticated) checksums.
sum_expected=$(grep " $asset\$" "$tmp/SHA256SUMS" | awk '{print $1}')
[ -n "$sum_expected" ] || die "no checksum for $asset"
if command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$tmp/walkie" | awk '{print $1}')
else actual=$(sha256sum "$tmp/walkie" | awk '{print $1}'); fi
[ "$sum_expected" = "$actual" ] || die "checksum mismatch for $asset"
say "Verified: release signature (openssl), version $signed and SHA-256."

# 4. Never a silent rollback: a walkie already installed that is newer than the signed release stays,
#    unless asked (WALKIE_ALLOW_DOWNGRADE=1). Its version comes from the binary itself.
existing=""
if [ -x "$BIN_DIR/walkie" ]; then
  existing=$("$BIN_DIR/walkie" version 2>/dev/null | awk '$1 == "walkie" { print $2; exit }' || true)
fi
if [ -n "$existing" ] && semver_lt "${signed#v}" "$existing"; then
  [ "${WALKIE_ALLOW_DOWNGRADE:-}" = 1 ] \
    || die "release $signed is older than the installed walkie $existing: refusing to downgrade (the installed binary is unchanged; set WALKIE_ALLOW_DOWNGRADE=1 to replace it anyway)"
  say "Downgrading walkie $existing → ${signed#v} (WALKIE_ALLOW_DOWNGRADE=1)."
fi

# 5. The downloaded binary must report the signed version, checked before anything on PATH changes.
chmod 755 "$tmp/walkie"
reported=$("$tmp/walkie" version 2>/dev/null || true)
[ "$reported" = "walkie ${signed#v}" ] \
  || die "the downloaded binary reports '$reported', not 'walkie ${signed#v}': nothing installed${existing:+ (the installed walkie $existing is unchanged)}"

# Only now replace the binary: a staged copy next to it, then one atomic rename.
mkdir -p "$BIN_DIR"
staged="$BIN_DIR/.walkie-install.$$"
install -m 755 "$tmp/walkie" "$staged" || die "could not write to $BIN_DIR${existing:+ (the installed walkie $existing is unchanged)}"
mv -f "$staged" "$BIN_DIR/walkie" || die "could not replace $BIN_DIR/walkie${existing:+ (the installed walkie $existing is unchanged)}"
staged=""
say "Installed $BIN_DIR/walkie ($reported)"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) say "Note: add $BIN_DIR to your PATH." ;; esac

# Tailscale is optional: Walkie Direct connects machines without it.
command -v tailscale >/dev/null 2>&1 || [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] \
  || say "Walkie connects with Walkie Direct (nothing else to install). Tailscale is optional: a team on a tailnet can use it instead."

# AGENT-ADMIN-1: said plainly before anything joins.
say "Once this machine is on the team, your own agents and the team's owners can set Walkie up on it for you (seats,"
say "accounts, hooks, pool), over Walkie, never a shell. Every such action is posted to the team and names who did it."
say "Turn it off any time on this machine: walkie admin remote off (owners, remotely) and walkie agents admin off (agents)."

# Hand the terminal to setup so it can prompt: by its own device (/dev/ttys003, /dev/pts/2) when ps names it, not
# /dev/tty itself. On macOS a Bun program whose stdin is /dev/tty never sees a keystroke (kqueue rejects /dev/tty), so
# walkie 0.2.0-pre.4 and earlier froze at setup's first question (SETUP-TTY); newer builds read it either way.
if [ -t 1 ] && [ -r /dev/tty ]; then
  term=/dev/tty
  dev=$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ') || dev=""
  case "$dev" in
    ""|"?"*|*[!A-Za-z0-9/]*|*..*) ;;
    *) if [ -c "/dev/$dev" ] && [ -r "/dev/$dev" ]; then term="/dev/$dev"; fi ;;
  esac
  WALKIE_SETUP_REEXEC=1 "$BIN_DIR/walkie" setup "$@" < "$term"
else
  WALKIE_SETUP_REEXEC=1 "$BIN_DIR/walkie" setup "$@"
fi
