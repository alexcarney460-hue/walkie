// FLEET-LINK-1: the command an owner's `walkie team link` prints, run on fresh machines through the real
// scripts/install.sh against a local mirror (the release signed with a test key: the only change to the script).
// Two machines run the SAME command: one with no terminal at all, one on a pseudo-terminal (the installer hands the
// terminal to setup, so a question would show and wait): neither is asked anything, both join as the owner's machines.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assetName } from "../../src/cli/commands/update.ts";
import { VERSION } from "../../src/daemon/version.ts";
import { INSTALL_URL, releaseTag } from "../../src/protocol/add-machine.ts";
import { RELEASE_PUBLIC_KEY_PEM, signRelease } from "../../src/release/sign.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson, runConfirmed } from "../helpers/person-cli.ts";

setDefaultTimeout(120_000);
const CLI = join(import.meta.dir, "../../src/cli/main.ts");
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const TAG = releaseTag(VERSION) as string;
const haveTools = ["curl", "openssl", "sh", "python3"].every((t) => existsSync(`/usr/bin/${t}`) || existsSync(`/bin/${t}`));

let c: Cluster;
let alex: TestNode, fresh1: TestNode, fresh2: TestNode;
let root = "";
let server: ReturnType<typeof Bun.serve> | null = null;

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "-", hostname: "alex-mbp", direct: true });
  // Two new machines whose daemons are already running (the service step finds them), both named "build-box".
  fresh1 = await c.add({ name: "fresh1", login: "-", hostname: "build-box", direct: true });
  fresh2 = await c.add({ name: "fresh2", login: "-", hostname: "build-box", direct: true });
  await alex.client().init("acme", "alex");
  root = mkdtempSync("/tmp/walkie-fl-");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const src = readFileSync(join(import.meta.dir, "..", "..", "scripts", "install.sh"), "utf8");
  expect(src).toContain(RELEASE_PUBLIC_KEY_PEM.trim());
  const script = src.replace(RELEASE_PUBLIC_KEY_PEM.trim(), (publicKey.export({ format: "pem", type: "spki" }) as string).trim());
  const binary = `#!/bin/sh\ncase "$1" in version) echo "walkie ${VERSION}" ;; *) exec "${process.execPath}" "${CLI}" "$@" ;; esac\n`;
  const sums = `version ${TAG}\n${new Bun.CryptoHasher("sha256").update(binary).digest("hex")}  ${assetName()}\n`;
  const sig = signRelease(new TextEncoder().encode(sums), privateKey.export({ format: "pem", type: "pkcs8" }) as string);
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/install.sh") return new Response(script);
      if (path === `/${TAG}/${assetName()}`) return new Response(binary);
      if (path === `/${TAG}/SHA256SUMS`) return new Response(sums);
      if (path === `/${TAG}/SHA256SUMS.sig`) return new Response(sig.slice().buffer as ArrayBuffer);
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(async () => { server?.stop(true); await c.close(); if (root) rmSync(root, { recursive: true, force: true }); });

/** A fresh machine's environment: its own HOME and bin dir, the system PATH, a stand-in `claude` that records calls. */
function machineEnv(node: TestNode, name: string): Record<string, string> {
  const home = join(root, name);
  const shim = join(root, `${name}-shim`);
  mkdirSync(join(home, "bin"), { recursive: true });
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, "claude"), `#!/bin/sh\necho "$*" >> "${join(root, `${name}-claude.log`)}"\n`, { mode: 0o755 });
  return {
    HOME: home, PATH: `${shim}:${SYSTEM_PATH}`, NO_COLOR: "1", WALKIE_BIN_DIR: join(home, "bin"),
    WALKIE_BASE_URL: `http://127.0.0.1:${server?.port}/${TAG}`, WALKIE_HOME: node.home, WALKIE_SOCKET: node.socket,
  };
}

describe.skipIf(!haveTools)("the printed fleet link command, on fresh machines", () => {
  test("no terminal, and a terminal: both install, join without a single question, and appear as @alex's machines", async () => {
    const minted = await runConfirmed([process.execPath, CLI, "team", "link", "--owner-machines", "--uses", "2"],
      { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: alex.home, WALKIE_SOCKET: alex.socket }, "alex");
    expect(minted.code).toBe(0);
    expect(minted.out).toMatch(/fleet link [0-9a-f]{8} · up to 2 machines join as @alex's \(owner\) · expires in 7 days/);
    const printed = minted.out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("curl ")) as string;
    expect(printed.startsWith(`curl -fsSL ${INSTALL_URL} | WALKIE_VERSION=${TAG} sh -s -- --join-link wl1`)).toBe(true);
    expect(minted.out).toContain(`wsl -- sh -c "${printed}"`);
    const cmd = printed.replace(INSTALL_URL, `http://127.0.0.1:${server?.port}/install.sh`);

    // 1. No terminal at all (a provisioning script, ssh without -t).
    const env1 = machineEnv(fresh1, "m1");
    const p = Bun.spawn(["/usr/bin/env", "-i", ...Object.entries(env1).map(([k, v]) => `${k}=${v}`), "/bin/sh", "-c", cmd], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out1, err1, code1] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    console.log(`[run] no terminal:\n${out1}${err1 ? `\n[stderr]\n${err1}` : ""}`);
    expect(code1).toBe(0);
    expect(out1).toContain(`Verified: release signature (openssl), version ${TAG} and SHA-256.`);
    expect(out1).toContain("joined acme as @alex on build-box (fleet link, Sqwakie Direct)");

    // 2. On a terminal: the installer hands it to setup, which still asks nothing (a question would print and wait).
    const env2 = machineEnv(fresh2, "m2");
    const t0 = Date.now();
    const r2 = await runAsPerson(["/bin/sh", "-c", cmd], { ...env2, WALKIE_PROMPT_TIMEOUT_S: "60" }, { tty: true, timeoutMs: 90_000 });
    console.log(`[run] on a terminal:\n${r2.out}`);
    expect(r2.code).toBe(0);
    expect(r2.out).toContain("joined acme as @alex on build-box-2 (fleet link, Sqwakie Direct)"); // de-duplicated name
    for (const q of ["(y/N)", "(create/join)", "Team name:", "handle", "Paste"]) expect([q, r2.out.includes(q)]).toEqual([q, false]);
    expect(r2.out).toContain("a fleet link's setup asks nothing");
    expect(Date.now() - t0).toBeLessThan(60_000); // no question waited for its timeout
    expect(existsSync(join(env2.HOME as string, ".claude", "settings.json"))).toBe(true); // the temporary HOME, never this Mac's

    // Both are @alex's machines, live on the owner's side.
    await waitFor(async () => (await alex.client().team()).nodes.filter((x) => x.handle === "alex").length === 3, { what: "three machines for @alex" });
    const names = (await alex.client().team()).nodes.filter((x) => x.handle === "alex").map((x) => x.hostname).sort();
    expect(names).toEqual(["alex-mbp", "build-box", "build-box-2"]);
    // The link was for 2 machines: it is used up now.
    const token = printed.split("--join-link ")[1] as string;
    const extra = await c.add({ name: "extra", login: "-", hostname: "extra", direct: true });
    expect((await extra.client().joinLink(token)).reason).toBe("link_used_up");
  });
});
