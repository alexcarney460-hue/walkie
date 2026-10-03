// walkie update [--check] [--allow-downgrade] — self-update a compiled install from GitHub Releases:
// the release to move to → platform binary + SHA256SUMS + SHA256SUMS.sig → verify the signature with the embedded
// release key (ECDSA P-256), require the signed `version <tag>` line to name that release and to be newer
// than this binary (FINAL-2 Codex 5 + Fable 2: a signed older release can't be served back as the newer
// one), then the checksum → atomic swap with a kept copy of the old binary → the new binary must report
// the signed version or the old one comes back → restart the service if installed and wait (up to 30 s) until the
// restarted daemon answers healthz as the new version; an update whose daemon doesn't come back exits non-zero.
// Which release that is: a stable install takes GitHub's latest release; a pre-release install takes the release the
// site's installer offers (the DEFAULT_VERSION line of <site>/install.sh, the version the team is meant to run), because
// releases/latest never lists a pre-release and told every pre-release machine it was up to date. The site only
// NAMES the release: the download is checked exactly the same either way.
// Env: WALKIE_REPO (owner/name), WALKIE_BASE_URL (mirror serving <asset>, SHA256SUMS and SHA256SUMS.sig; the
// signed version line then rules, still never a downgrade without --allow-downgrade).
import { chmodSync, copyFileSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { defaultHome, pathsFor } from "../../daemon/paths.ts";
import { planService, type ServicePlan } from "../../daemon/service.ts";
import { WalkieClient } from "../../client/index.ts";
import { VERSION } from "../../daemon/version.ts";
import { INSTALL_URL, RELEASE_TAG_RE } from "../../protocol/add-machine.ts";
import { signedVersion, verifyRelease } from "../../release/sign.ts";
import { bool } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { c, safeTerm } from "../format.ts";

const DEFAULT_REPO = "alexcarney460-hue/walkie-releases"; // public, binaries only

export function assetName(platform = process.platform, arch = process.arch): string {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x86_64" : null;
  if (!os || !cpu) throw new Error(`no release build for ${platform}/${arch}`);
  return `walkie-${os}-${cpu}`;
}

interface Semver { core: number[]; pre: string[] }

function parseSemver(v: string): Semver {
  const s = v.replace(/^v/, "").split("+")[0]!; // build metadata carries no precedence
  const dash = s.indexOf("-");
  const core = (dash < 0 ? s : s.slice(0, dash)).split(".").map((n) => Number(n) || 0);
  return { core, pre: dash < 0 ? [] : s.slice(dash + 1).split(".") };
}

/** Semver §11 precedence of two prerelease identifiers: numeric ones numerically and before alphanumeric ones, else ASCII order. */
function comparePreId(p: string, q: string): -1 | 0 | 1 {
  const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
  if (pn && qn) return Number(p) === Number(q) ? 0 : Number(p) < Number(q) ? -1 : 1;
  if (pn !== qn) return pn ? -1 : 1;
  return p === q ? 0 : p < q ? -1 : 1;
}

/**
 * Semver order (release gate 2026-09-26, Codex 3 / Fable 3): -1, 0 or 1 for a < b, a = b, a > b. A leading
 * "v" and build metadata are ignored; a prerelease sorts before its release (0.2.0-rc.1 < 0.2.0).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const [x, y] = [parseSemver(a), parseSemver(b)];
  for (let i = 0; i < 3; i++) {
    const [p, q] = [x.core[i] ?? 0, y.core[i] ?? 0];
    if (p !== q) return p < q ? -1 : 1;
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const r = comparePreId(p, q);
    if (r !== 0) return r;
  }
  return 0;
}

/** true when a is a newer version than b (prereleases sort before their release). */
export function newer(a: string, b: string): boolean { return compareVersions(a, b) > 0; }

/** Exact version identity (a leading "v" aside): a signed prerelease never stands in for the advertised release. */
export function sameVersion(a: string, b: string): boolean { return a.replace(/^v/, "") === b.replace(/^v/, ""); }

/** true for a pre-release (a "-" part before any "+build" metadata): those follow the release the site's installer offers. */
export function isPreRelease(version: string): boolean { return parseSemver(version).pre.length > 0; }

export function checksumFor(sums: string, asset: string): string | null {
  const line = sums.split("\n").find((l) => l.trim().endsWith(` ${asset}`) || l.trim().endsWith(`*${asset}`));
  const hex = line?.trim().split(/\s+/)[0];
  return hex && /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/**
 * The signed version line against the release asked for (`tag`, null for a mirror) and the installed
 * version: it must exist, match the tag, and not be a downgrade unless `allowDowngrade`.
 */
export function checkSignedVersion(sums: string, opts: { tag: string | null; installed: string; allowDowngrade: boolean }): { ok: true; version: string } | { ok: false; reason: string } {
  const version = signedVersion(sums);
  if (!version) return { ok: false, reason: "SHA256SUMS carries no single signed version line" };
  if (opts.tag !== null && !sameVersion(version, opts.tag)) return { ok: false, reason: `SHA256SUMS is signed for release ${version}, not ${opts.tag} (an older or pre-release build served back?)` };
  if (sameVersion(version, opts.installed)) return { ok: false, reason: "up_to_date" };
  if (!newer(version, opts.installed) && !opts.allowDowngrade) return { ok: false, reason: `release ${version} is older than the installed ${opts.installed}: a downgrade needs --allow-downgrade` };
  return { ok: true, version };
}

async function reportedVersion(bin: string): Promise<string> {
  let process: ReturnType<typeof Bun.spawn> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completed = false;
  try {
    const p = Bun.spawn([bin, "version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    process = p;
    reader = p.stdout.getReader();
    const stream = reader;
    const output = (async () => {
      const decoder = new TextDecoder();
      let text = "";
      try {
        for (;;) {
          const { done, value } = await stream.read();
          if (done) return text + decoder.decode();
          text += decoder.decode(value, { stream: true });
        }
      } finally { stream.releaseLock(); }
    })();
    // One deadline covers both EOF and exit: either can lag behind the other.
    const [out, code] = await Promise.race([
      Promise.all([output, p.exited]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("version probe timed out")), 10_000);
      }),
    ]);
    if (code !== 0) return "";
    completed = true;
    return out.trim();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
    if (!completed) {
      try { process?.kill("SIGKILL"); } catch { /* already exited */ }
      // Cleanup must not extend the deadline if the stream or child never settles.
      void reader?.cancel().catch(() => {});
    }
  }
}

/**
 * Replaces `target` with `bin` atomically, keeping a copy of the old binary next to it; then runs
 * `<target> version` and, unless it reports `walkie <version>`, puts the old binary back. The kept copy
 * is removed either way.
 */
export async function swapBinary(target: string, bin: Uint8Array, version: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const dir = dirname(target);
  const tmp = join(dir, `.walkie-update-${process.pid}`);
  const prev = join(dir, ".walkie-prev");
  try {
    copyFileSync(target, prev);
    writeFileSync(tmp, bin, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, target); // atomic on the same filesystem; running processes keep the old inode
  } catch (err) {
    rmSync(tmp, { force: true });
    rmSync(prev, { force: true });
    return { ok: false, error: `could not replace ${target}: ${(err as Error).message}` };
  }
  const expected = `walkie ${version.replace(/^v/, "")}`;
  const reported = await reportedVersion(target);
  if (reported === expected) { rmSync(prev, { force: true }); return { ok: true }; }
  try {
    renameSync(prev, target);
    chmodSync(target, 0o755);
    return { ok: false, error: `the new binary reports '${reported}', not '${expected}': restored the previous binary` };
  } catch (err) {
    return { ok: false, error: `the new binary reports '${reported}', not '${expected}', and restoring the previous binary failed: ${(err as Error).message} (copy kept at ${prev})` };
  }
}

/** The HTTP client `walkie update` uses: tests hand in a stand-in; production looks the global fetch up when it is called. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const globalFetch: Fetcher = (url, init) => fetch(url, init);

/** `text` for a terminal: no control characters, at most `max` characters, "…" where it was cut (only its start is looked at: a line can be a megabyte). */
function excerpt(text: string, max: number): string {
  const clean = safeTerm(text.slice(0, max + 1));
  return text.length > max ? `${clean.slice(0, max)}…` : clean;
}

async function fetchOk(doFetch: Fetcher, url: string, what: string): Promise<Response> {
  const res = await doFetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} from ${excerpt(url, 200)}`);
  return res;
}

async function latestTag(doFetch: Fetcher, repo: string): Promise<string> {
  const res = await fetchOk(doFetch, `https://api.github.com/repos/${repo}/releases/latest`, "release lookup");
  const tag = ((await res.json()) as { tag_name?: string }).tag_name;
  if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) throw new Error("release lookup returned no release tag");
  return tag;
}

/**
 * The line of the site's installer that names the release a plain install gets: exactly the pattern site/build.py reads
 * for the landing page (one contract for both), applied to one line at a time (build.py's MULTILINE splits on "\n" only).
 */
export const DEFAULT_VERSION_LINE = /^DEFAULT_VERSION="(v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)"$/;

export type Advertised = { ok: true; tag: string } | { ok: false; reason: string };

/** The longest tag worth a download: site/build.py's pattern lets a version number of any number of digits through. */
const MAX_TAG_LENGTH = 64;

/**
 * A tag `walkie update` will download: the form add-machine.ts accepts as a release tag (RELEASE_TAG_RE: a pre-release part of
 * at most 40 characters), short overall, and with no empty dot-separated pre-release identifier ("v1.0.0-.." has three).
 */
function downloadableTag(tag: string): boolean {
  if (tag.length > MAX_TAG_LENGTH || !RELEASE_TAG_RE.test(tag)) return false;
  const dash = tag.indexOf("-");
  return dash < 0 || tag.slice(dash + 1).split(".").every((identifier) => identifier.length > 0);
}

/** The one release tag the installer's text names, or why it names none: no line, a line that is no release tag, or several. */
export function parseAdvertisedTag(script: string): Advertised {
  const lines = script.split("\n");
  const tags = lines.map((l) => DEFAULT_VERSION_LINE.exec(l)?.[1]).filter((t): t is string => t !== undefined);
  const notATag = (shown: string): Advertised => ({ ok: false, reason: `has a DEFAULT_VERSION line that is not a release tag (${JSON.stringify(excerpt(shown, 60))})` });
  if (tags.length === 1) return downloadableTag(tags[0] as string) ? { ok: true, tag: tags[0] as string } : notATag(tags[0] as string);
  if (tags.length > 1) return { ok: false, reason: `has ${tags.length} DEFAULT_VERSION lines (it must name exactly one release)` };
  const odd = lines.find((l) => l.startsWith("DEFAULT_VERSION="));
  if (odd !== undefined) return notATag(odd);
  return { ok: false, reason: 'has no DEFAULT_VERSION="vX.Y.Z" line' };
}

/** How long the site's installer may take to answer. */
export const SITE_LOOKUP_MS = 20_000;
/** The most of its answer that is read: the installer is about 12 KB. */
const MAX_INSTALLER_BYTES = 1 << 20;
/** What a person runs instead when this command cannot learn which release to move to. */
const INSTALLER_COMMAND = `curl -fsSL ${INSTALL_URL} | sh`;

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error(`more than ${maxBytes} bytes`); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** The release the site's installer offers (its DEFAULT_VERSION line), or why it could not be learned; nothing is downloaded. */
export async function advertisedTag(doFetch: Fetcher, timeoutMs = SITE_LOOKUP_MS): Promise<Advertised> {
  let text: string;
  try {
    const res = await doFetch(INSTALL_URL, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await readCapped(res, MAX_INSTALLER_BYTES);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `could not read the version the site's installer offers (${INSTALL_URL}: ${excerpt(why, 120)})` };
  }
  const found = parseAdvertisedTag(text);
  return found.ok ? found : { ok: false, reason: `the site's installer ${found.reason}` };
}

/** How long `walkie update` waits for the restarted daemon to answer healthz as the new version (v0.1.3). */
export const RESTART_WAIT_MS = 30_000;

export type HealthProbe = () => Promise<{ ok: boolean; version: string }>;

/** Polls healthz until the daemon answers as `version`, or `timeoutMs` pass; a failure says what it saw last. */
export async function waitForDaemon(
  version: string, probe: HealthProbe = () => new WalkieClient().healthz(), timeoutMs = RESTART_WAIT_MS, intervalMs = 250,
): Promise<{ ok: true; ms: number } | { ok: false; last: string }> {
  const start = Date.now();
  let last = "no answer";
  for (;;) {
    try {
      const h = await probe();
      if (h.ok && sameVersion(h.version, version)) return { ok: true, ms: Date.now() - start };
      last = h.ok ? `answering as ${h.version}, not ${version.replace(/^v/, "")}` : `answering unhealthy as ${h.version}`;
    } catch (err) {
      last = `no answer (${(err as Error).message})`;
    }
    if (Date.now() - start >= timeoutMs) return { ok: false, last };
    await Bun.sleep(intervalMs);
  }
}

export interface RestartDeps { plan?: ServicePlan; probe?: HealthProbe; timeoutMs?: number; intervalMs?: number }

/**
 * Restarts the installed service, then waits for the daemon to answer healthz as `version`. false (with the reason
 * printed) when the restart command fails or the daemon doesn't answer in time; true when there is no service.
 */
export async function restartService(ctx: Ctx, version: string, deps: RestartDeps = {}): Promise<boolean> {
  let plan = deps.plan;
  if (!plan) {
    try { plan = planService(defaultHome()); } catch { return true; }
  }
  if (!existsSync(plan.path)) { ctx.out(c.dim("   no service installed; restart the daemon yourself (walkie daemon stop && walkie daemon start)")); return true; }
  const cmd = [...plan.restart];
  const code = await Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore", timeout: 30_000 }).exited;
  if (code !== 0) { ctx.err(c.red(`   could not restart the service: ${cmd.join(" ")} exited ${code}`)); return false; }
  const limit = deps.timeoutMs ?? RESTART_WAIT_MS;
  ctx.out(`   ${c.green("restarted")} the background service; waiting for the daemon to answer (up to ${limit / 1000} s)…`);
  const up = await waitForDaemon(version, deps.probe, limit, deps.intervalMs);
  if (up.ok) { ctx.out(`   ${c.green("daemon answering")} as ${version.replace(/^v/, "")} after ${(up.ms / 1000).toFixed(1)} s`); return true; }
  ctx.err(c.red(`   the restarted daemon did not answer healthz within ${limit / 1000} s (last: ${up.last}).`));
  ctx.err(`   The binary is updated. See ${pathsFor(defaultHome()).out} and run walkie doctor; to restart it: ${cmd.join(" ")}`);
  return false;
}

/** What `walkie update` reads from outside itself. Everything defaults to the real thing; tests substitute each. */
export interface UpdateDeps {
  fetch?: Fetcher;
  /** The version this binary is (default: this build's). */
  installed?: string;
  /** The file to replace (default: this executable). */
  target?: string;
  /** Whether this is a compiled binary, which can replace itself (default: it runs from the embedded filesystem). */
  compiled?: boolean;
  /** The release-signing public key a download must verify against (default: the embedded one). */
  releaseKeyPem?: string;
  /** WALKIE_REPO and WALKIE_BASE_URL (default: the process environment). */
  env?: { WALKIE_REPO?: string | undefined; WALKIE_BASE_URL?: string | undefined };
  restart?: RestartDeps;
  /** How long the site's installer may take to answer (default: SITE_LOOKUP_MS). */
  siteTimeoutMs?: number;
}

export async function update(ctx: Ctx, deps: UpdateDeps = {}): Promise<number> {
  const compiled = deps.compiled ?? import.meta.dir.startsWith("/$bunfs");
  const env = deps.env ?? process.env;
  const installed = deps.installed ?? VERSION;
  const doFetch = deps.fetch ?? globalFetch;
  const repo = env.WALKIE_REPO ?? DEFAULT_REPO;
  const mirror = env.WALKIE_BASE_URL;
  const allowDowngrade = bool(ctx.args, "allow-downgrade");
  const asset = assetName();
  // The release to move to: a mirror serves one signed release (no tag to name); otherwise a pre-release install follows
  // the release the site's installer offers (releases/latest never lists a pre-release) and a stable one the latest release.
  const fromSite = !mirror && isPreRelease(installed);
  let tag: string | null = null;
  if (fromSite) {
    const advertised = await advertisedTag(doFetch, deps.siteTimeoutMs);
    if (!advertised.ok) {
      ctx.err(c.red(`${advertised.reason}; nothing changed`));
      ctx.err(`   update with the installer instead: ${INSTALLER_COMMAND}`);
      return EXIT.error;
    }
    tag = advertised.tag;
  } else if (!mirror) {
    tag = await latestTag(doFetch, repo);
  }
  if (tag !== null && !allowDowngrade && !newer(tag, installed)) { ctx.out(`walkie ${installed} is up to date (${fromSite ? "the site advertises" : "latest release"} ${tag})`); return EXIT.ok; }
  if (bool(ctx.args, "check")) { ctx.out(`update available: ${installed} → ${tag ?? "the mirror's signed release"}${fromSite ? " (the version the site's installer offers)" : ""}`); return EXIT.ok; }
  if (!compiled) { ctx.err("running from source: update with git pull && bun install instead"); return EXIT.error; }

  const base = mirror ?? `https://github.com/${repo}/releases/download/${tag}`;
  ctx.out(`downloading ${asset} (${tag ?? "mirror"})…`);
  const [bin, sumsBytes, sig] = await Promise.all([
    fetchOk(doFetch, `${base}/${asset}`, "binary download").then((r) => r.arrayBuffer()),
    fetchOk(doFetch, `${base}/SHA256SUMS`, "checksum download").then((r) => r.arrayBuffer()),
    fetchOk(doFetch, `${base}/SHA256SUMS.sig`, "signature download").then((r) => r.arrayBuffer()),
  ]);
  if (!verifyRelease(new Uint8Array(sumsBytes), new Uint8Array(sig), deps.releaseKeyPem)) { ctx.err(c.red("SHA256SUMS is not signed by the Walkie release key; nothing changed")); return EXIT.error; }
  const sums = new TextDecoder().decode(sumsBytes);
  const bound = checkSignedVersion(sums, { tag, installed, allowDowngrade });
  if (!bound.ok) {
    if (bound.reason === "up_to_date") { ctx.out(`walkie ${installed} is up to date (the release is signed for the same version)`); return EXIT.ok; }
    ctx.err(c.red(`${bound.reason}; nothing changed`));
    return EXIT.error;
  }
  const expected = checksumFor(sums, asset);
  const actual = createHash("sha256").update(new Uint8Array(bin)).digest("hex");
  if (!expected || expected !== actual) { ctx.err(c.red(`checksum mismatch for ${asset}; nothing changed`)); return EXIT.error; }

  const target = deps.target ?? process.execPath;
  const swapped = await swapBinary(target, new Uint8Array(bin), bound.version);
  if (!swapped.ok) { ctx.err(c.red(swapped.error)); return EXIT.error; }
  ctx.out(`${c.green("updated")} ${target} → ${bound.version}`);
  return (await restartService(ctx, bound.version, deps.restart)) ? EXIT.ok : EXIT.error;
}
