// WALK-50 (OCJ-D): the OFFICIAL standalone Codex release, staged behind a flag, with its checksum verified against
// the release's own published checksums — never the network in tests: fetchJson/download are always fakes here.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexReleaseEnabled, extractChecksum, extractCodexBinary, pickChecksumAsset, pickCodexAsset, resolveCodexRelease,
  sha256Hex, smokeTestCodexVersion, stageCodexRuntime, type GithubAsset,
} from "../../src/daemon/seats/codex-release.ts";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "codex-release-test-"));
  dirs.push(d);
  return d;
}

/** A real tar.gz (system tar, no network) holding one file `codex` with `content`, 0755. */
function tarGzWithCodex(content: string): Uint8Array {
  const d = scratch();
  const bin = join(d, "codex");
  writeFileSync(bin, content, { mode: 0o755 });
  chmodSync(bin, 0o755);
  const out = join(d, "out.tar.gz");
  const r = Bun.spawnSync(["tar", "-czf", out, "-C", d, "codex"], { stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  return readFileSync(out);
}

function zipWithCodex(content: string): Uint8Array {
  const d = scratch();
  const bin = join(d, "codex");
  writeFileSync(bin, content, { mode: 0o755 });
  chmodSync(bin, 0o755);
  const out = join(d, "out.zip");
  const r = Bun.spawnSync(["zip", "-j", out, bin], { stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  return readFileSync(out);
}

const VERSION_SCRIPT = "#!/bin/sh\necho 'codex-cli 0.99.0'\n";

// ---- pickCodexAsset ------------------------------------------------------------------------------------------

test("pickCodexAsset matches by target-triple tokens and prefers musl over gnu on Linux", () => {
  const assets: GithubAsset[] = [
    { name: "codex-aarch64-apple-darwin.tar.gz", browser_download_url: "u1" },
    { name: "codex-x86_64-apple-darwin.tar.gz", browser_download_url: "u2" },
    { name: "codex-x86_64-unknown-linux-musl.tar.gz", browser_download_url: "u3" },
    { name: "codex-x86_64-unknown-linux-gnu.tar.gz", browser_download_url: "u4" },
    { name: "codex-aarch64-unknown-linux-musl.tar.gz", browser_download_url: "u5" },
  ];
  expect(pickCodexAsset(assets, "darwin", "arm64").name).toBe("codex-aarch64-apple-darwin.tar.gz");
  expect(pickCodexAsset(assets, "darwin", "x64").name).toBe("codex-x86_64-apple-darwin.tar.gz");
  expect(pickCodexAsset(assets, "linux", "x64").name).toBe("codex-x86_64-unknown-linux-musl.tar.gz"); // musl over gnu
  expect(pickCodexAsset(assets, "linux", "arm64").name).toBe("codex-aarch64-unknown-linux-musl.tar.gz");
});

test("pickCodexAsset ignores checksum/signature/manifest siblings", () => {
  const assets: GithubAsset[] = [
    { name: "codex-aarch64-apple-darwin.tar.gz", browser_download_url: "u1" },
    { name: "codex-aarch64-apple-darwin.tar.gz.sha256", browser_download_url: "u2" },
    { name: "codex-aarch64-apple-darwin.tar.gz.sig", browser_download_url: "u3" },
    { name: "checksums.txt", browser_download_url: "u4" },
  ];
  expect(pickCodexAsset(assets, "darwin", "arm64").name).toBe("codex-aarch64-apple-darwin.tar.gz");
});

test("pickCodexAsset throws with the asset list when nothing matches, and when more than one does", () => {
  expect(() => pickCodexAsset([{ name: "codex-x86_64-pc-windows-msvc.zip", browser_download_url: "u" }], "darwin", "arm64"))
    .toThrow(/no Codex release asset matches darwin\/arm64/);
  const ambiguous: GithubAsset[] = [
    { name: "codex-aarch64-apple-darwin.tar.gz", browser_download_url: "u1" },
    { name: "codex-aarch64-apple-darwin-2.tar.gz", browser_download_url: "u2" },
  ];
  expect(() => pickCodexAsset(ambiguous, "darwin", "arm64")).toThrow(/more than one/);
  expect(() => pickCodexAsset([{ name: "codex-x86_64-apple-darwin.tar.gz", browser_download_url: "u" }], "win32" as NodeJS.Platform, "x64"))
    .toThrow(/no official Codex release build/);
});

// ---- checksums -------------------------------------------------------------------------------------------------

test("pickChecksumAsset: a sidecar first, else a combined checksums file, else null", () => {
  const asset: GithubAsset = { name: "codex-aarch64-apple-darwin.tar.gz", browser_download_url: "u" };
  const sidecar: GithubAsset = { name: "codex-aarch64-apple-darwin.tar.gz.sha256", browser_download_url: "s" };
  const combined: GithubAsset = { name: "checksums.txt", browser_download_url: "c" };
  expect(pickChecksumAsset([asset, sidecar, combined], asset)).toEqual(sidecar);
  expect(pickChecksumAsset([asset, combined], asset)).toEqual(combined);
  expect(pickChecksumAsset([asset], asset)).toBeNull();
});

test("extractChecksum reads a bare-hex sidecar and a `<hex>  <name>` line from a combined file", () => {
  const hex = "a".repeat(64);
  expect(extractChecksum(`${hex}\n`, "codex-aarch64-apple-darwin.tar.gz")).toBe(hex);
  expect(extractChecksum(`${hex}  codex-aarch64-apple-darwin.tar.gz`, "codex-aarch64-apple-darwin.tar.gz")).toBe(hex);
  expect(extractChecksum(`${"b".repeat(64)}  other-asset\n${hex}  codex-aarch64-apple-darwin.tar.gz\n`, "codex-aarch64-apple-darwin.tar.gz")).toBe(hex);
  expect(extractChecksum("not a checksum file", "codex-aarch64-apple-darwin.tar.gz")).toBeNull();
});

test("sha256Hex matches a known digest", () => {
  expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

// ---- extraction and the smoke test -----------------------------------------------------------------------------

test("extractCodexBinary: a raw binary asset is written as is", () => {
  const dest = scratch();
  const bytes = new TextEncoder().encode(VERSION_SCRIPT);
  const path = extractCodexBinary(bytes, "codex", dest);
  expect(readFileSync(path, "utf8")).toBe(VERSION_SCRIPT);
  const smoke = smokeTestCodexVersion(path);
  expect(smoke).toEqual({ ok: true, version: "codex-cli 0.99.0" });
});

test("extractCodexBinary: a tar.gz is extracted and the codex binary inside it found", () => {
  const dest = scratch();
  const archive = tarGzWithCodex(VERSION_SCRIPT);
  const path = extractCodexBinary(archive, "codex-aarch64-apple-darwin.tar.gz", dest);
  expect(smokeTestCodexVersion(path)).toEqual({ ok: true, version: "codex-cli 0.99.0" });
});

test("extractCodexBinary: a zip is extracted the same way", () => {
  const dest = scratch();
  const archive = zipWithCodex(VERSION_SCRIPT);
  const path = extractCodexBinary(archive, "codex-x86_64-pc-windows-msvc.zip", dest);
  expect(smokeTestCodexVersion(path)).toEqual({ ok: true, version: "codex-cli 0.99.0" });
});

test("smokeTestCodexVersion fails closed: a missing binary, a nonzero exit, empty output", () => {
  expect(smokeTestCodexVersion(join(scratch(), "does-not-exist")).ok).toBe(false);
  const dest = scratch();
  const failing = join(dest, "codex");
  writeFileSync(failing, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  chmodSync(failing, 0o755);
  expect(smokeTestCodexVersion(failing)).toMatchObject({ ok: false, error: expect.stringContaining("exited 1") });
  const silent = join(dest, "codex-silent");
  writeFileSync(silent, "#!/bin/sh\ntrue\n", { mode: 0o755 });
  chmodSync(silent, 0o755);
  expect(smokeTestCodexVersion(silent)).toMatchObject({ ok: false, error: expect.stringContaining("printed nothing") });
});

// ---- resolveCodexRelease (a fake fetchJson: never the network) --------------------------------------------------

test("resolveCodexRelease reads tag_name and assets from a fake fetchJson, latest or a named tag", async () => {
  const calls: string[] = [];
  const fetchJson = async (url: string) => { calls.push(url); return { tag_name: "rust-v0.42.0", assets: [{ name: "a", browser_download_url: "u" }] }; };
  const rel = await resolveCodexRelease({ fetchJson });
  expect(rel).toEqual({ tag_name: "rust-v0.42.0", assets: [{ name: "a", browser_download_url: "u" }] });
  expect(calls[0]).toBe("https://api.github.com/repos/openai/codex/releases/latest");
  await resolveCodexRelease({ fetchJson, tag: "rust-v0.41.0" });
  expect(calls[1]).toBe("https://api.github.com/repos/openai/codex/releases/tags/rust-v0.41.0");
});

test("resolveCodexRelease throws on a response with no tag_name/assets", async () => {
  await expect(resolveCodexRelease({ fetchJson: async () => ({ nope: true }) })).rejects.toThrow(/not a release/);
});

// ---- stageCodexRuntime end to end, with a fake download (no network) --------------------------------------------

function fakeRelease(archive: Uint8Array, assetName: string) {
  const hex = sha256Hex(archive);
  const assets: GithubAsset[] = [
    { name: assetName, browser_download_url: `https://fake/${assetName}` },
    { name: `${assetName}.sha256`, browser_download_url: `https://fake/${assetName}.sha256` },
  ];
  const fetchJson = async () => ({ tag_name: "rust-v0.42.0", assets });
  const bytesByUrl = new Map<string, Uint8Array>([
    [`https://fake/${assetName}`, archive],
    [`https://fake/${assetName}.sha256`, new TextEncoder().encode(hex)],
  ]);
  const download = async (url: string) => {
    const b = bytesByUrl.get(url);
    if (!b) throw new Error(`unexpected download: ${url}`);
    return b;
  };
  return { fetchJson, download, hex };
}

test("stageCodexRuntime: resolve, download, checksum-verify, extract and smoke-test, end to end", async () => {
  const assetName = "codex-aarch64-apple-darwin.tar.gz";
  const archive = tarGzWithCodex(VERSION_SCRIPT);
  const { fetchJson, download } = fakeRelease(archive, assetName);
  const dest = scratch();
  const staged = await stageCodexRuntime({ destDir: dest, platform: "darwin", arch: "arm64", fetchJson, download });
  expect(staged).toEqual({ path: join(dest, "codex"), version: "codex-cli 0.99.0", tag: "rust-v0.42.0", asset: assetName });
});

test("stageCodexRuntime refuses a checksum mismatch (a tampered or truncated download)", async () => {
  const assetName = "codex-aarch64-apple-darwin.tar.gz";
  const archive = tarGzWithCodex(VERSION_SCRIPT);
  const { fetchJson, download } = fakeRelease(archive, assetName);
  const tamperedDownload = async (url: string) => (url.endsWith(assetName) ? new Uint8Array([...await download(url), 0]) : download(url));
  await expect(stageCodexRuntime({ destDir: scratch(), platform: "darwin", arch: "arm64", fetchJson, download: tamperedDownload }))
    .rejects.toThrow(/checksum mismatch/);
});

test("stageCodexRuntime refuses a release that publishes no checksum for the matched asset", async () => {
  const assetName = "codex-aarch64-apple-darwin.tar.gz";
  const fetchJson = async () => ({ tag_name: "rust-v0.42.0", assets: [{ name: assetName, browser_download_url: `https://fake/${assetName}` }] });
  await expect(stageCodexRuntime({ destDir: scratch(), platform: "darwin", arch: "arm64", fetchJson, download: async () => new Uint8Array() }))
    .rejects.toThrow(/publishes no checksum/);
});

test("stageCodexRuntime surfaces a failing smoke test rather than staging a broken binary", async () => {
  const assetName = "codex-aarch64-apple-darwin.tar.gz";
  const archive = tarGzWithCodex("#!/bin/sh\nexit 3\n");
  const { fetchJson, download } = fakeRelease(archive, assetName);
  await expect(stageCodexRuntime({ destDir: scratch(), platform: "darwin", arch: "arm64", fetchJson, download }))
    .rejects.toThrow(/failed its smoke test/);
});

// ---- the flag -------------------------------------------------------------------------------------------------

test("codexReleaseEnabled: off unless the CLI flag or WALKIE_CODEX_RELEASE=1 says so", () => {
  expect(codexReleaseEnabled({}, false)).toBe(false);
  expect(codexReleaseEnabled({}, true)).toBe(true);
  expect(codexReleaseEnabled({ WALKIE_CODEX_RELEASE: "1" }, false)).toBe(true);
  expect(codexReleaseEnabled({ WALKIE_CODEX_RELEASE: "0" }, false)).toBe(false);
});
