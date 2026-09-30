// FINAL-2 Fable 1 (HIGH) + Codex 5: scripts/install.sh end to end against a local mirror, run the way a fresh
// machine runs it — `env -i` with only the system PATH, so on macOS the verifier is the stock LibreSSL
// /usr/bin/openssl (which has no ed25519 raw verification: the previous installer refused every valid release
// there). A copy of the script gets the test key's public half in place of the release key; nothing else changes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assetName } from "../../src/cli/commands/update.ts";
import { RELEASE_PUBLIC_KEY_PEM, signRelease } from "../../src/release/sign.ts";

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const haveTools = ["curl", "openssl", "sh"].every((t) => existsSync(`/usr/bin/${t}`) || existsSync(`/bin/${t}`));

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const keyPem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
const pubPem = publicKey.export({ format: "pem", type: "spki" }) as string;

const asset = assetName();
const fakeBinary = (v: string) => `#!/bin/sh\ncase "$1" in version) echo "walkie ${v}" ;; setup) echo "setup ran: $*" ;; esac\n`;
const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

interface Release { binary: string; sums: string; sig: Uint8Array | null }
function release(opts: { version?: string; binaryVersion?: string; tamperSums?: boolean; noSig?: boolean; noVersionLine?: boolean } = {}): Release {
  const version = opts.version ?? "v0.1.0";
  const binary = fakeBinary(opts.binaryVersion ?? version.replace(/^v/, ""));
  const sums = `${opts.noVersionLine ? "" : `version ${version}\n`}${sha256(binary)}  ${asset}\n`;
  const sig = signRelease(new TextEncoder().encode(sums), keyPem);
  return { binary, sums: opts.tamperSums ? sums.replace(/^version v0\.1\.0/, "version v9.9.9") : sums, sig: opts.noSig ? null : sig };
}

let server: ReturnType<typeof Bun.serve> | null = null;
let current: Release = release();
let root = "";
let script = "";

beforeAll(() => {
  root = mkdtempSync("/tmp/walkie-install-");
  // The installer under test: the repo's script with the test key's public half in place of the release key.
  const src = readFileSync(join(import.meta.dir, "..", "..", "scripts", "install.sh"), "utf8");
  expect(src).toContain(RELEASE_PUBLIC_KEY_PEM.trim());
  script = join(root, "install.sh");
  writeFileSync(script, src.replace(RELEASE_PUBLIC_KEY_PEM.trim(), pubPem.trim()));
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === `/${asset}`) return new Response(current.binary);
      if (path === "/SHA256SUMS") return new Response(current.sums);
      if (path === "/SHA256SUMS.sig") return current.sig ? new Response(current.sig.slice().buffer as ArrayBuffer) : new Response("not found", { status: 404 });
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => { server?.stop(true); if (root) rmSync(root, { recursive: true, force: true }); });

async function install(extraEnv: Record<string, string> = {}, opts: { existing?: string } = {}): Promise<{ code: number; out: string; err: string; bin: string }> {
  const home = mkdtempSync(join(root, "home-"));
  const bin = join(home, "bin", "walkie");
  mkdirSync(join(home, "bin"), { recursive: true });
  // A machine that already has walkie <existing> installed.
  if (opts.existing) { writeFileSync(bin, fakeBinary(opts.existing), { mode: 0o755 }); chmodSync(bin, 0o755); }
  const env = { HOME: home, PATH: SYSTEM_PATH, WALKIE_BASE_URL: `http://127.0.0.1:${server!.port}`, WALKIE_BIN_DIR: join(home, "bin"), ...extraEnv };
  const args = ["/usr/bin/env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "/bin/sh", script];
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err, bin };
}

describe.skipIf(!haveTools)("install.sh on a stock system (env -i, system PATH only)", () => {
  test("a good release installs, verifies with the system openssl, checks the version and runs setup", async () => {
    current = release();
    const r = await install({ WALKIE_VERSION: "v0.1.0" });
    expect([r.code, r.err]).toEqual([0, ""]);
    expect(r.out).toContain("Verified: release signature (openssl), version v0.1.0 and SHA-256.");
    expect(r.out).toContain("Installed");
    expect(r.out).toContain("setup ran:");
    expect(existsSync(r.bin)).toBe(true);
    expect((readFileSync(r.bin).length)).toBe(current.binary.length);
    chmodSync(r.bin, 0o755);
  });

  test("desktop install-only verifies and installs without running setup", async () => {
    current = release();
    const r = await install({ WALKIE_VERSION: "v0.1.0", WALKIE_INSTALL_ONLY: "1" });
    expect([r.code, r.err]).toEqual([0, ""]);
    expect(r.out).toContain("Verified: release signature");
    expect(r.out).toContain("Installed");
    expect(r.out).not.toContain("setup ran:");
    expect(existsSync(r.bin)).toBe(true);
  });

  test("a newer Walkie elsewhere on PATH blocks replacing the local destination", async () => {
    current = release({ version: "v0.2.0-pre.8" });
    const other = mkdtempSync(join(root, "brew-like-"));
    writeFileSync(join(other, "walkie"), fakeBinary("0.2.0-pre.9"), { mode: 0o755 });
    const r = await install({ PATH: `${other}:${SYSTEM_PATH}`, WALKIE_INSTALL_ONLY: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${other}/walkie (0.2.0-pre.9)`);
    expect(existsSync(r.bin)).toBe(false);
  });

  test("a signed release below the link minimum is refused", async () => {
    current = release({ version: "v0.2.0-pre.8" });
    const r = await install({ WALKIE_VERSION: "v0.2.0-pre.8", WALKIE_MIN_VERSION: "v0.2.0-pre.9", WALKIE_INSTALL_ONLY: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("below the team's minimum");
    expect(existsSync(r.bin)).toBe(false);
  });

  test("a mirror without WALKIE_VERSION installs the signed release; a wrong WALKIE_VERSION is refused", async () => {
    current = release();
    expect((await install()).code).toBe(0);
    const r = await install({ WALKIE_VERSION: "v0.2.0" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("signed for release v0.1.0, not v0.2.0");
    expect(existsSync(r.bin)).toBe(false);
  });

  test("tampered SHA256SUMS: refused (signature), nothing installed", async () => {
    current = release({ tamperSums: true });
    const r = await install({ WALKIE_VERSION: "v0.1.0" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("release signature does not verify");
    expect(existsSync(r.bin)).toBe(false);
  });

  test("missing SHA256SUMS.sig: refused, nothing installed", async () => {
    current = release({ noSig: true });
    const r = await install({ WALKIE_VERSION: "v0.1.0" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("signature download failed");
    expect(existsSync(r.bin)).toBe(false);
  });

  test("a signed file without a version line is refused (a pre-binding release can't be replayed)", async () => {
    current = release({ noVersionLine: true });
    const r = await install({ WALKIE_VERSION: "v0.1.0" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("no single signed 'version' line");
  });

  test("a binary that reports another version than the signed one is never installed", async () => {
    current = release({ binaryVersion: "0.0.9" });
    const r = await install({ WALKIE_VERSION: "v0.1.0" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("reports 'walkie 0.0.9', not 'walkie 0.1.0'");
    expect(existsSync(r.bin)).toBe(false);
  });

  // Release gate 2026-09-26 (Codex 2 / Fable 2): the installer never rolls an installation back silently, and the
  // existing binary is only replaced after every check passed.
  describe("an existing installation", () => {
    test("a mirror serving an older signed release is refused; the installed binary is untouched", async () => {
      current = release({ version: "v0.0.9" });
      const r = await install({}, { existing: "0.1.0" });
      expect(r.code).toBe(1);
      expect(r.err).toContain("(0.1.0): refusing to downgrade");
      expect(r.err).toContain("WALKIE_ALLOW_DOWNGRADE=1");
      expect(r.out).not.toContain("Installed");
      expect(readFileSync(r.bin, "utf8")).toBe(fakeBinary("0.1.0"));
    });

    test("WALKIE_ALLOW_DOWNGRADE=1 installs the older release", async () => {
      current = release({ version: "v0.0.9" });
      const r = await install({ WALKIE_ALLOW_DOWNGRADE: "1" }, { existing: "0.1.0" });
      expect([r.code, r.err]).toEqual([0, ""]);
      expect(r.out).toContain("Installed");
      expect(readFileSync(r.bin, "utf8")).toBe(fakeBinary("0.0.9"));
    });

    test("a newer release replaces the installed binary; the same release reinstalls", async () => {
      current = release({ version: "v0.2.0" });
      const up = await install({}, { existing: "0.1.0" });
      expect([up.code, up.err]).toEqual([0, ""]);
      expect(readFileSync(up.bin, "utf8")).toBe(fakeBinary("0.2.0"));
      current = release();
      const same = await install({}, { existing: "0.1.0" });
      expect([same.code, same.err]).toEqual([0, ""]);
      expect(readFileSync(same.bin, "utf8")).toBe(fakeBinary("0.1.0"));
    });

    test("prereleases order below their release: 0.2.0-rc.1 → 0.2.0 installs, 0.2.0 → 0.2.0-rc.1 is a downgrade", async () => {
      current = release({ version: "v0.2.0" });
      const up = await install({}, { existing: "0.2.0-rc.1" });
      expect([up.code, up.err]).toEqual([0, ""]);
      expect(readFileSync(up.bin, "utf8")).toBe(fakeBinary("0.2.0"));
      current = release({ version: "v0.2.0-rc.1" });
      const down = await install({}, { existing: "0.2.0" });
      expect(down.code).toBe(1);
      expect(down.err).toContain("(0.2.0): refusing to downgrade");
      expect(readFileSync(down.bin, "utf8")).toBe(fakeBinary("0.2.0"));
    });

    test("a downloaded binary that reports another version than the signed one leaves the installed binary intact", async () => {
      current = release({ version: "v0.2.0", binaryVersion: "0.0.9" });
      const r = await install({}, { existing: "0.1.0" });
      expect(r.code).toBe(1);
      expect(r.err).toContain("reports 'walkie 0.0.9', not 'walkie 0.2.0'");
      expect(readFileSync(r.bin, "utf8")).toBe(fakeBinary("0.1.0"));
    });

    test("a bad signature with an existing installation leaves it intact", async () => {
      current = release({ tamperSums: true }); // signed v0.1.0, an upgrade for 0.0.5, but the checksums were altered
      const r = await install({}, { existing: "0.0.5" });
      expect(r.code).toBe(1);
      expect(r.err).toContain("release signature does not verify");
      expect(readFileSync(r.bin, "utf8")).toBe(fakeBinary("0.0.5"));
    });
  });

  // SITE-2: the installer defaults to one pinned release (DEFAULT_VERSION), which pre-release builds don't cover
  // on Intel Macs. A fake `uname` stands in for an Intel Mac; the refusal comes before any network request.
  test("the default release on an Intel Mac is refused with the way out, before any download", async () => {
    const shim = mkdtempSync(join(root, "uname-"));
    writeFileSync(join(shim, "uname"), '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo x86_64 ;; esac\n', { mode: 0o755 });
    const home = mkdtempSync(join(root, "home-"));
    const env = { HOME: home, PATH: `${shim}:${SYSTEM_PATH}`, WALKIE_BIN_DIR: join(home, "bin") };
    const p = Bun.spawn(["/usr/bin/env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "/bin/sh", script], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(await p.exited).toBe(1);
    expect(err).toContain("has no Intel Mac build");
    expect(err).toContain("WALKIE_VERSION=latest");
    expect(out).not.toContain("Downloading");
  });

  test("an explicit release without an Intel Mac build is refused from its checksums, before the binary download", async () => {
    current = release({ version: "v0.2.0" }); // SHA256SUMS lists only this machine's asset, never walkie-darwin-x86_64 here
    const shim = mkdtempSync(join(root, "uname-"));
    writeFileSync(join(shim, "uname"), '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo x86_64 ;; esac\n', { mode: 0o755 });
    if (asset === "walkie-darwin-x86_64") return; // on a real Intel Mac the fixture has the asset; nothing to prove
    const r = await install({ WALKIE_VERSION: "v0.2.0", PATH: `${shim}:${SYSTEM_PATH}` });
    expect(r.code).toBe(1);
    expect(r.err).toContain("v0.2.0 has no Intel Mac build");
    expect(existsSync(r.bin)).toBe(false);
  });

  test("DEFAULT_VERSION is one release tag with a CHANGELOG section", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "scripts", "install.sh"), "utf8");
    const found = [...src.matchAll(/^DEFAULT_VERSION="(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)"$/gm)].map((m) => m[1]);
    expect(found.length).toBe(1);
    expect(src).toContain('VERSION="${WALKIE_VERSION:-$DEFAULT_VERSION}"');
    const changelog = readFileSync(join(import.meta.dir, "..", "..", "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(`\n## ${found[0]}\n`);
  });

  test("without openssl on PATH the installer refuses rather than trusting the download", async () => {
    current = release();
    const r = await install({ WALKIE_VERSION: "v0.1.0", PATH: "/nonexistent" });
    expect(r.code).not.toBe(0);
  });
});
