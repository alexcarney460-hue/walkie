import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import pnpmLock from "./locks/pnpm/package-lock.json";
import claudeLock from "./locks/claude-code/package-lock.json";
import codexLock from "./locks/codex/package-lock.json";
import type { Guard, StepExecutor } from "./runner.ts";
import type { Step } from "./profiles.ts";
import { writePrivate } from "./files.ts";
import { processIdentity, type InstallerProcess } from "./process.ts";
import { ProvisionInterrupted } from "./interrupt.ts";

const NODE_VERSION = "22.20.0";
/** Official nodejs.org v22.20.0 SHASUMS256 entries, frozen in the signed Walkie release. */
const NODE_SHA256: Readonly<Record<string, string>> = {
  "darwin-arm64": "f2ed1fbdfb79afb9343dfbb609efde657b41e7efcd5215264ce78f8906356b4d",
  "darwin-x64": "2a291f0a9555f5d6685d96ce9429da3d0ea3cd896c012702c6ee0015f818684e",
  "linux-arm64": "06907b9c088ce62305bc1530e5c1ae1510245114645768f7750c349c5b6fe667",
  "linux-x64": "00bbd05e306ea68b6e13e17360d0e2f680b493ef95f2fea1c4296ff7437530bc",
};
const LOCKS = { pnpm: pnpmLock, "claude-code": claudeLock, codex: codexLock } as const;
type LockId = keyof typeof LOCKS;
const deniedBy = (guard?: Guard): string | null => {
  try { return guard?.() ?? null; } catch { return "authorization_changed"; }
};

/** Refuse a lock with a changed package, registry host or missing integrity. npm ci ignores lifecycle scripts. */
export function lockProblem(lock: unknown, packageName: string, version: string): string | null {
  if (!lock || typeof lock !== "object") return "invalid_lock";
  const l = lock as { lockfileVersion?: number; packages?: Record<string, { dependencies?: Record<string, string>; resolved?: string; integrity?: string }> };
  if (l.lockfileVersion !== 3 || !l.packages || l.packages[""]?.dependencies?.[packageName] !== version) return "wrong_lock_version";
  for (const [name, entry] of Object.entries(l.packages)) {
    if (!name) continue;
    if (!entry.resolved?.startsWith("https://registry.npmjs.org/") || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? "")) return "unverified_package";
  }
  return null;
}

const root = (home: string) => join(home, "provision-tools");
const nodeRoot = (home: string) => join(root(home), `node-${NODE_VERSION}`);
const nodeBin = (home: string) => join(nodeRoot(home), "bin", "node");
const packageRoot = (home: string, id: LockId) => join(root(home), id);
const program = (home: string, s: Step) => s.kind === "node_archive" ? nodeBin(home)
  : s.kind === "npm_locked" ? join(packageRoot(home, s.id as LockId), "node_modules", ".bin", s.command as string)
  : s.command as string;

function environment(home: string): Record<string, string> {
  const path = [join(nodeRoot(home), "bin"), join(homedir(), ".bun", "bin"), join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin", "/snap/bin"].join(":");
  return { PATH: path, HOME: root(home),
    npm_config_cache: join(root(home), "npm-cache"), npm_config_userconfig: join(root(home), "npm-user.conf"),
    npm_config_globalconfig: join(root(home), "npm-global.conf"), npm_config_registry: "https://registry.npmjs.org/",
    npm_config_update_notifier: "false", CI: "1", NO_COLOR: "1" };
}

export async function inspectVersion(argv: string[], home: string): Promise<string | null> {
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: environment(home) });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
    }, 10_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (timedOut || code !== 0) return null;
      return stdout.slice(0, 256).trim() || stderr.slice(0, 256).trim();
    } finally { clearTimeout(timer); }
  } catch { return null; }
}

export function systemVersionAtLeast(output: string, minimum: string): boolean {
  const found = output.match(/\d+(?:\.\d+)+/)?.[0];
  if (!found) return false;
  const actual = found.split(".").map(Number);
  const required = minimum.split(".").map(Number);
  return actual.some((part, i) => part !== (required[i] ?? 0)
    ? part > (required[i] ?? 0) && actual.slice(0, i).every((n, j) => n === (required[j] ?? 0)) : false) ||
    actual.every((n, i) => n === (required[i] ?? 0)) && required.slice(actual.length).every((n) => n === 0);
}

async function installed(home: string, s: Step): Promise<boolean> {
  if (s.id === "walkie-daemon") return true; // this route runs in the admitted daemon
  if (s.id === "bun") return systemVersionAtLeast(Bun.version, s.version);
  if (!s.command) return false;
  const versionFlag = s.id === "openssh" ? "-V" : s.id === "openssl" ? "version" : s.id === "unzip" ? "-v" : "--version";
  const text = await inspectVersion([program(home, s), versionFlag], home);
  if (!text) return false;
  if (s.kind === "installer_elevation" || s.kind === "check") return systemVersionAtLeast(text, s.version);
  return text.includes(s.version);
}

export async function runInstaller(argv: string[], cwd: string, env: Record<string, string>,
  onProcess?: (identity: InstallerProcess) => void, guard?: Guard): Promise<void> {
  const beforeSpawn = deniedBy(guard);
  if (beforeSpawn) throw new ProvisionInterrupted(beforeSpawn);
  const child = Bun.spawn(argv, { cwd, env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  let killed = false;
  let escalation: ReturnType<typeof setTimeout> | null = null;
  const signal = (sig: "SIGTERM" | "SIGKILL") => {
    try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* already exited */ } }
  };
  const stop = () => {
    if (killed) return;
    killed = true;
    signal("SIGTERM");
    escalation = setTimeout(() => signal("SIGKILL"), 2_000);
    escalation.unref?.();
  };
  let denied: string | null = null;
  const poll = guard ? setInterval(() => {
    denied ??= deniedBy(guard);
    if (denied) stop();
  }, 250) : null;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stop(); }, 1_500_000);
  try {
    const identity = await processIdentity(child.pid);
    if (identity) onProcess?.(identity);
    denied ??= deniedBy(guard);
    if (denied) stop();
    const code = await child.exited;
    if (denied) throw new ProvisionInterrupted(denied);
    if (timedOut) throw new Error("installer_timeout");
    if (code !== 0) throw new Error("verified_installer_failed");
  } catch (err) {
    if (!killed) { stop(); await child.exited; }
    throw err;
  } finally {
    clearTimeout(timer);
    if (poll) clearInterval(poll);
    // Keep escalation armed for children in the process group after the direct child exits.
  }
}

async function installNode(home: string, onProcess?: (identity: InstallerProcess) => void, guard?: Guard): Promise<void> {
  const platform = `${process.platform}-${process.arch}`;
  const expected = NODE_SHA256[platform];
  if (!expected) throw new Error("unsupported platform for pinned Node archive");
  const filename = `node-v${NODE_VERSION}-${platform}.tar.xz`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${filename}`;
  const abort = new AbortController();
  const poll = guard ? setInterval(() => { if (deniedBy(guard)) abort.abort(); }, 250) : null;
  const timeout = setTimeout(() => abort.abort(), 120_000);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    const res = await fetch(url, { signal: abort.signal, redirect: "error" });
    if (!res.ok || !res.body) throw new Error("Node archive unavailable");
    for await (const chunk of res.body) {
      const denied = deniedBy(guard);
      if (denied) throw new ProvisionInterrupted(denied);
      bytes += chunk.byteLength;
      if (bytes > 100_000_000) throw new Error("Node archive too large");
      hash.update(chunk);
      chunks.push(chunk);
    }
  } catch (err) {
    const denied = deniedBy(guard);
    if (denied) throw new ProvisionInterrupted(denied);
    if (err instanceof Error && (err.message === "Node archive too large" || err.message === "Node archive unavailable")) throw err;
    throw new Error("Node archive unavailable");
  } finally { clearTimeout(timeout); if (poll) clearInterval(poll); }
  const beforeWrite = deniedBy(guard);
  if (beforeWrite) throw new ProvisionInterrupted(beforeWrite);
  if (hash.digest("hex") !== expected) throw new Error("Node archive checksum mismatch");
  mkdirSync(root(home), { recursive: true, mode: 0o700 });
  const tmp = join(root(home), `.node-${randomBytes(8).toString("hex")}`);
  mkdirSync(tmp, { mode: 0o700 });
  const archive = join(tmp, filename);
  writeFileSync(archive, Buffer.concat(chunks), { mode: 0o600 });
  const dest = join(tmp, "unpacked");
  mkdirSync(dest, { mode: 0o700 });
  try {
    await runInstaller(["/usr/bin/tar", "-xJf", archive, "--strip-components=1", "-C", dest], tmp, environment(home), onProcess, guard);
    const denied = deniedBy(guard);
    if (denied) throw new ProvisionInterrupted(denied);
    if (await inspectVersion([join(dest, "bin", "node"), "--version"], home) !== `v${NODE_VERSION}`) throw new Error("Node archive version mismatch");
    const target = nodeRoot(home);
    const backup = join(root(home), `.node-previous-${randomBytes(8).toString("hex")}`);
    const hadOld = existsSync(target);
    if (hadOld) renameSync(target, backup);
    try { renameSync(dest, target); }
    catch (err) { if (hadOld) renameSync(backup, target); throw err; }
    if (hadOld) rmSync(backup, { recursive: true, force: true });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

async function installNpm(home: string, s: Step, onProcess?: (identity: InstallerProcess) => void, guard?: Guard): Promise<void> {
  const beforeWrite = deniedBy(guard);
  if (beforeWrite) throw new ProvisionInterrupted(beforeWrite);
  const id = s.id as LockId;
  if (!(id in LOCKS) || !s.package) throw new Error("unknown locked package");
  const lock = LOCKS[id];
  const problem = lockProblem(lock, s.package, s.version);
  if (problem) throw new Error(problem);
  const dir = packageRoot(home, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory() || (lstatSync(dir).mode & 0o077)) throw new Error("provision package directory is not private");
  writePrivate(join(dir, "package.json"), { name: `walkie-provision-${id}`, version: "1.0.0", private: true, dependencies: { [s.package]: s.version } });
  writePrivate(join(dir, "package-lock.json"), lock);
  const npm = join(nodeRoot(home), "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npm)) throw new Error("pinned Node/npm is not installed");
  await runInstaller([nodeBin(home), npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"], dir, environment(home), onProcess, guard);
  const denied = deniedBy(guard);
  if (denied) throw new ProvisionInterrupted(denied);
  if (id === "claude-code") placeClaudeNative(dir);
}

/** The pinned Claude wrapper's postinstall only copies its pinned optional binary. Do that fixed action ourselves. */
function placeClaudeNative(dir: string): void {
  const platform = `${process.platform}-${process.arch}`;
  if (!NODE_SHA256[platform]) throw new Error("unsupported platform for pinned Claude binary");
  const src = join(dir, "node_modules", "@anthropic-ai", `claude-code-${platform}`, "claude");
  const dest = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  if (!lstatSync(src).isFile() || !lstatSync(dest).isFile()) throw new Error("pinned Claude binary missing");
  unlinkSync(dest);
  try { linkSync(src, dest); } catch { copyFileSync(src, dest); }
}

/** No caller-controlled command, URL, path, package or environment reaches these actions. */
export function executorFor(home: string): StepExecutor {
  return {
    inspect: async (s) => await installed(home, s) ? "installed" : "missing",
    execute: async (s, onProcess, guard) => {
      if (s.kind === "installer_elevation" || s.kind === "check") return "needs_installer_elevation";
      if (s.kind === "node_archive") { await installNode(home, onProcess, guard); return; }
      if (s.kind === "npm_locked") { await installNpm(home, s, onProcess, guard); return; }
      throw new Error("unknown built-in step kind");
    },
  };
}
