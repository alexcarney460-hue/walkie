import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "../../scripts/install.sh"), "utf8");
const cliSource = readFileSync(join(import.meta.dir, "../../src/cli/commands/update.ts"), "utf8");
// Load only the pure CLI checksum function: no updater imports or runtime side effects.
const cliFunction = cliSource.match(/export function checksumFor\(sums: string, asset: string\): string \| null \{([\s\S]*?)\n\}/)![1]!;
const cliChecksum = new Function("sums", "asset", cliFunction) as (sums: string, asset: string) => string | null;
const hash = "a".repeat(64);
const pinned = source.match(/^DEFAULT_VERSION="([^"]+)"/m)![1]!;
const listing = '[\n{"tag_name": "v0.2.0-pre.12"},\n{"tag_name": "v0.2.0"},\n{"tag_name": "v0.1.0"}\n]';

function sliceBetween(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error(`missing installer boundary: ${start}`);
  return source.slice(from, to);
}

function selection(arch: string, sums: string, extra: Record<string, string> = {}) {
  const root = mkdtempSync("/tmp/walkie-selection-");
  try {
    for (const dir of ["home", "walkie", "codex", "tmp"]) mkdirSync(join(root, dir));
    writeFileSync(join(root, "SHA256SUMS"), sums);
    // Execute only selection and checksum fragments. curl is a shell fixture, never a network client.
    const script = `
      curl() {
        case "$*" in
          *'/releases?per_page=100') printf '%s\\n' "$FIXTURE_LISTING" ;;
          *'/releases/latest') printf '%s\\n' 'https://fixture.invalid/releases/tag/v0.2.0' ;;
          *) echo 'unexpected curl fixture call' >&2; exit 90 ;;
        esac
      }
      uname() { case "$1" in -s) printf '%s\\n' "$FIXTURE_OS" ;; -m) printf '%s\\n' "$FIXTURE_ARCH" ;; esac; }
      ${source.slice(0, source.indexOf('tmp=$(mktemp -d)'))}
      tmp="$FIXTURE_ROOT"
      ${sliceBetween('# A release with no build', 'curl -fsSL "$base/$asset"')}
      ${sliceBetween('sum_expected=$(', 'if command -v shasum')}
      printf '%s|%s|%s|%s\\n' "$VERSION" "$expected" "$asset" "$sum_expected"
    `;
    const result = Bun.spawnSync(["/bin/sh", "-c", script], {
      env: { PATH: "/usr/bin:/bin", HOME: join(root, "home"), WALKIE_HOME: join(root, "walkie"),
        CODEX_HOME: join(root, "codex"), TMPDIR: join(root, "tmp"), FIXTURE_ROOT: root,
        FIXTURE_OS: "Darwin", FIXTURE_ARCH: arch, FIXTURE_LISTING: listing, ...extra },
    });
    return { code: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString() };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const arch of ["x86_64", "arm64"]) {
  const asset = `walkie-darwin-${arch}`;
  for (const [mode, env, version] of [
    ["default", {}, pinned],
    ["minimum listing", { WALKIE_MIN_VERSION: "v0.2.0-pre.12" }, "v0.2.0"],
    ["explicit", { WALKIE_VERSION: "v0.2.0-pre.12" }, "v0.2.0-pre.12"],
    ["latest", { WALKIE_VERSION: "latest" }, "v0.2.0"],
  ] as const) {
    for (const marker of [" ", "*"]) {
      test(`${arch} ${mode}: ${marker === "*" ? "binary" : "text"} checksum`, () => {
        const sums = `version ${version}\n${hash} ${marker}${asset}\n`;
        const r = selection(arch, sums, env);
        expect(r.code).toBe(0);
        expect(r.err).toBe("");
        expect(r.out).toBe(`${version}|${version}|${asset}|${cliChecksum(sums, asset)}`);
      });
    }
    test(`${arch} ${mode}: absent asset refuses resolved release`, () => {
      const r = selection(arch, `${hash}  walkie-linux-arm64\n`, env);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`${version} has no ${arch === "x86_64" ? "Intel Mac build" : "build for this machine"}`);
    });
  }
}

test("listing with no qualifying release refuses", () => {
  const r = selection("arm64", "", { WALKIE_MIN_VERSION: "v9.0.0" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("no release meets minimum v9.0.0");
});

test("copies match and all verification gates precede replacement", () => {
  expect(readFileSync(join(import.meta.dir, "../../site/install.sh"), "utf8")).toBe(source);
  const replacement = source.indexOf('install -m 755');
  for (const gate of ['openssl dgst -sha256 -verify', '[ "$signed" = "$expected" ]',
    '[ "$sum_expected" = "$actual" ]', 'refusing to downgrade', "below the team's minimum", '[ "$reported" = "walkie ${signed#v}" ]']) {
    expect(source.indexOf(gate)).toBeGreaterThan(0);
    expect(source.indexOf(gate)).toBeLessThan(replacement);
  }
});
