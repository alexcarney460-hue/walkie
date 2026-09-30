// The OFFICIAL standalone Codex release (github.com/openai/codex), as an alternative to the Homebrew/npm `codex`
// nativeRuntime finds on PATH (cli/commands/seat-user.ts): resolve the release asset for this os/arch, verify its
// checksum against the release's own published checksums, stage it as a plain file, smoke-test `codex --version`.
// Behind a flag (codexReleaseEnabled): off by default, so `nativeRuntime("codex")` keeps deciding the runtime seat
// users get. No sudo anywhere here — this only produces a source *file*; the root-owned copy into RUNTIMES_DIR is
// the existing `install -o root …` step in seatUserPlan (seat-user.ts), unchanged and still run under the person's
// own sudo by `seats setup-user --apply`.
//
// `fetchJson`/`download` are always passed in (never a bare `fetch` call baked in here): tests use a fake download,
// never the network; production wires fetchJsonReal/downloadReal.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CODEX_RELEASE_REPO = "openai/codex";

export interface GithubAsset { name: string; browser_download_url: string }
export interface GithubRelease { tag_name: string; assets: GithubAsset[] }

/** Reads JSON from a GitHub API URL. Injectable: real code passes fetchJsonReal, tests pass a fake. */
export type FetchJson = (url: string) => Promise<unknown>;
/** Downloads a URL's raw bytes. Injectable: real code passes downloadReal, tests pass a fake. */
export type Download = (url: string) => Promise<Uint8Array>;

/** Whether to stage the official Codex release instead of the nativeRuntime found on PATH: --codex-release or WALKIE_CODEX_RELEASE=1. */
export function codexReleaseEnabled(env: NodeJS.ProcessEnv = process.env, flag = false): boolean {
  return flag || env.WALKIE_CODEX_RELEASE === "1";
}

function asRelease(v: unknown): GithubRelease | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.tag_name !== "string" || !Array.isArray(o.assets)) return null;
  const assets: GithubAsset[] = [];
  for (const a of o.assets) {
    if (typeof a !== "object" || a === null) return null;
    const ao = a as Record<string, unknown>;
    if (typeof ao.name !== "string" || typeof ao.browser_download_url !== "string") return null;
    assets.push({ name: ao.name, browser_download_url: ao.browser_download_url });
  }
  return { tag_name: o.tag_name, assets };
}

/** The named release (`tag`) or the latest one, from the GitHub API (`fetchJson` injected: never a real call in tests). */
export async function resolveCodexRelease(o: { fetchJson: FetchJson; repo?: string; tag?: string }): Promise<GithubRelease> {
  const repo = o.repo ?? CODEX_RELEASE_REPO;
  const url = o.tag ? `https://api.github.com/repos/${repo}/releases/tags/${o.tag}` : `https://api.github.com/repos/${repo}/releases/latest`;
  const release = asRelease(await o.fetchJson(url));
  if (!release) throw new Error(`${url}: not a release (no tag_name/assets in the response)`);
  return release;
}

// Rust target-triple tokens (Codex's CLI is a Rust binary): matched as substrings of the asset name, case-insensitive,
// so this survives naming variations without hard-coding one exact filename. Linux prefers a musl build (static,
// no glibc version to match on an arbitrary seat machine) over a gnu one when both are offered.
const OS_TOKENS: Record<"darwin" | "linux", string[]> = {
  darwin: ["apple-darwin", "darwin", "macos"],
  linux: ["unknown-linux-musl", "musl", "unknown-linux-gnu", "linux"],
};
const ARCH_TOKENS: Record<"arm64" | "x64", string[]> = {
  arm64: ["aarch64", "arm64"],
  x64: ["x86_64", "x64", "amd64"],
};
/** Asset names that are never the runtime itself: a checksum, signature, manifest or provenance sidecar. */
const NOT_RUNTIME_ASSET = /\.(sha256|sha256sum|sig|asc|sbom|intoto\.jsonl)$/i;
const NOT_RUNTIME_NAME = /(^|[._-])(checksums?|sha256sums?|sbom)([._-]|$)/i;

/**
 * The one release asset for this os/arch (a tar.gz/zip archive or a raw binary), by target-triple tokens in its
 * name; throws with the full asset list when nothing (or nothing unambiguous) matches, so a naming change on the
 * release is a clear error, not a silent wrong pick.
 */
export function pickCodexAsset(assets: readonly GithubAsset[], platform: NodeJS.Platform, arch: string): GithubAsset {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!os || !cpu) throw new Error(`no official Codex release build for ${platform}/${arch}`);
  const candidates = assets.filter((a) => !NOT_RUNTIME_ASSET.test(a.name) && !NOT_RUNTIME_NAME.test(a.name));
  const archMatch = candidates.filter((a) => ARCH_TOKENS[cpu].some((t) => a.name.toLowerCase().includes(t)));
  for (const osToken of OS_TOKENS[os]) {
    const match = archMatch.filter((a) => a.name.toLowerCase().includes(osToken));
    if (match.length === 1) return match[0] as GithubAsset;
    if (match.length > 1) throw new Error(`more than one Codex release asset matches ${platform}/${arch} (${osToken}): ${match.map((a) => a.name).join(", ")}`);
  }
  throw new Error(`no Codex release asset matches ${platform}/${arch} among: ${assets.map((a) => a.name).join(", ") || "(no assets)"}`);
}

/** The checksum file for `asset`: a `<asset>.sha256` sidecar first, else a combined checksums file; null if neither is published. */
export function pickChecksumAsset(assets: readonly GithubAsset[], asset: GithubAsset): GithubAsset | null {
  const sidecar = assets.find((a) => a.name === `${asset.name}.sha256` || a.name === `${asset.name}.sha256sum`);
  if (sidecar) return sidecar;
  return assets.find((a) => /^(sha256sums|checksums)(\.txt)?$/i.test(a.name)) ?? null;
}

/** The hex sha256 for `assetName` in a checksums file's text: a bare 64-hex sidecar, or a `<hex>  <name>` line. */
export function extractChecksum(text: string, assetName: string): string | null {
  const bare = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(bare)) return bare.toLowerCase();
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.endsWith(` ${assetName}`) || l.endsWith(`*${assetName}`));
  const hex = line?.split(/\s+/)[0];
  return hex && /^[0-9a-fA-F]{64}$/.test(hex) ? hex.toLowerCase() : null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function findCodexBinary(dir: string): string | null {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { const found = findCodexBinary(p); if (found) return found; continue; }
    if (/^codex(\.exe)?$/i.test(name) && st.isFile()) return p;
  }
  return null;
}

/**
 * `archive` (already checksum-verified) written under `destDir` as a plain file named `codex`, 0755: extracted
 * first when it's a tar.gz/zip, used directly when the asset itself is the raw binary. Returns its path.
 */
export function extractCodexBinary(archive: Uint8Array, assetName: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, "codex");
  const lower = assetName.toLowerCase();
  if (!/\.(tar\.gz|tgz|zip)$/i.test(lower)) {
    // a raw binary asset: nothing to extract
    writeFileSync(dest, archive);
    chmodSync(dest, 0o755);
    return dest;
  }
  const work = mkdtempSync(join(destDir, ".codex-archive-"));
  try {
    const archivePath = join(work, assetName);
    writeFileSync(archivePath, archive);
    const argv = /\.zip$/i.test(lower) ? ["unzip", "-o", archivePath, "-d", work] : ["tar", "-xzf", archivePath, "-C", work];
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`${argv[0]} failed on ${assetName}: ${r.stderr.toString().trim().slice(0, 300)}`);
    const found = findCodexBinary(work);
    if (!found) throw new Error(`no codex binary found after extracting ${assetName}`);
    writeFileSync(dest, readFileSync(found));
    chmodSync(dest, 0o755);
    return dest;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** `path --version` runs and prints something: proof the staged file is a working codex before it's ever handed to a seat. */
export function smokeTestCodexVersion(path: string): { ok: true; version: string } | { ok: false; error: string } {
  try {
    const r = Bun.spawnSync([path, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } });
    if (r.exitCode !== 0) return { ok: false, error: `${path} --version exited ${r.exitCode}: ${(r.stderr?.toString().trim() || "(no output)").slice(0, 300)}` };
    const out = r.stdout?.toString().trim() ?? "";
    if (!out) return { ok: false, error: `${path} --version printed nothing` };
    return { ok: true, version: out };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export interface StageCodexRuntimeOptions {
  /** Where the verified binary is written (created if missing): a plain file `codex` under it, no root needed. */
  destDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  repo?: string;
  /** A specific release tag; the latest one otherwise. */
  tag?: string;
  fetchJson: FetchJson;
  download: Download;
}

export interface StagedCodexRuntime { path: string; version: string; tag: string; asset: string }

/**
 * Resolve → download → checksum-verify → extract → smoke-test, end to end. Throws (never installs anything half
 * checked) when: no asset matches this os/arch, the release publishes no checksum for it, the downloaded bytes
 * don't match it, or the staged file fails `codex --version`.
 */
export async function stageCodexRuntime(o: StageCodexRuntimeOptions): Promise<StagedCodexRuntime> {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const release = await resolveCodexRelease({ fetchJson: o.fetchJson, repo: o.repo, tag: o.tag });
  const asset = pickCodexAsset(release.assets, platform, arch);
  const checksumAsset = pickChecksumAsset(release.assets, asset);
  if (!checksumAsset) throw new Error(`${release.tag_name} publishes no checksum for ${asset.name}: refusing to install it unverified`);
  const bytes = await o.download(asset.browser_download_url);
  const sumsText = new TextDecoder().decode(await o.download(checksumAsset.browser_download_url));
  const expected = extractChecksum(sumsText, asset.name);
  if (!expected) throw new Error(`${checksumAsset.name} carries no checksum for ${asset.name}`);
  const actual = sha256Hex(bytes);
  if (actual !== expected) throw new Error(`${asset.name}: checksum mismatch (release says ${expected}, downloaded bytes hash to ${actual}): refusing to install it`);
  const path = extractCodexBinary(bytes, asset.name, o.destDir);
  const smoke = smokeTestCodexVersion(path);
  if (!smoke.ok) throw new Error(`the downloaded codex (${release.tag_name}, ${asset.name}) failed its smoke test: ${smoke.error}`);
  return { path, version: smoke.version, tag: release.tag_name, asset: asset.name };
}

/** Production FetchJson: the GitHub API, followed redirects, a 30s timeout. */
export async function fetchJsonReal(url: string): Promise<unknown> {
  const res = await fetch(url, { redirect: "follow", headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** Production Download: raw bytes, followed redirects, a 3-minute timeout (release assets can be tens of MB). */
export async function downloadReal(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
