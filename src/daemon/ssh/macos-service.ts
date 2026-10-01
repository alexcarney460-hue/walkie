// The macOS half of owner-SSH enrollment: Walkie's own SSH service, so the person is never asked to turn on Remote Login
// (Remote Login answers on the whole network with password and PAM login; the consent they gave is for an SSH door that
// opens onto this Mac only and only for the owner's key). It is a launchd SYSTEM daemon, `dev.walkie.sshd`, running
// /usr/sbin/sshd -D with a config of its own: loopback only (127.0.0.1 and ::1, port 22022, src/daemon/ssh/server.ts), no
// passwords, no root, no PAM, one login name (the person who ran sudo), the person's own ~/.ssh/authorized_keys (where the
// tagged owner key goes), and its own host key and pid file in a root-only directory.
//
// It runs as root inside the enrollment's ONE root batch (`walkie provision root-marker install <home> ssh-macos`, after
// the marker; the terminal's sudo or the app's one administrator prompt). It touches only Walkie's own files (the plist
// and that directory) and never Apple's com.openssh.sshd, /etc/ssh, `systemsetup` or the Remote Login setting. Every
// system command is an absolute path and goes through `io.spawn`, so tests stub them; nothing is staged under TMPDIR.
import { chmodSync, chownSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { MACOS_SSH_PORT, realServerProbe, sshServerStatus } from "./server.ts";

export const MAC_SSH_LABEL = "dev.walkie.sshd";
/** Walkie's root-only directory for this service (0700): its config, host key and pid file. */
export const MAC_SSH_DIR = "/Library/Application Support/Walkie/ssh";
export const MAC_SSH_PLIST = `/Library/LaunchDaemons/${MAC_SSH_LABEL}.plist`;

const CONFIG = "sshd_config";
const HOST_KEY = "ssh_host_ed25519_key";
const PID = "sshd.pid";
/** A login name sshd's AllowUsers reads as one literal name: no wildcard, negation, host part, space or control character. */
const LOGIN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
/** A directory that can sit inside a double-quoted sshd_config argument and an XML string without anything to escape in it. */
const SAFE_DIR = /^\/[^"\\\u0000-\u001f]+$/;
const WAIT_MS = 500;
const WAIT_TRIES = 20;
const BOOTSTRAP_TRIES = 3;

export type SshInstallResult = { ok: true } | { ok: false; why: string };
const fail = (why: string): SshInstallResult => ({ ok: false, why });

function safeLogin(user: string): string {
  if (!LOGIN.test(user)) throw new Error("this account's login name cannot be written into the SSH service's configuration safely");
  return user;
}
function safeDir(dir: string): string {
  if (!SAFE_DIR.test(dir)) throw new Error("the SSH service's directory has a character that sshd's configuration cannot carry");
  return dir;
}

/** The whole sshd_config. Every directive is pinned by test/unit/ssh-macos-service.test.ts. */
export function macSshdConfig(user: string, dir: string = MAC_SSH_DIR): string {
  safeLogin(user);
  safeDir(dir);
  return [
    "# Walkie's SSH service for the owner's key (launchd: dev.walkie.sshd). Written by walkie: a reinstall replaces this file.",
    "# It listens only on this Mac and accepts only key logins (the keys in the enrolled person's own authorized_keys). It is not Remote Login and never changes it.",
    `Port ${MACOS_SSH_PORT}`,
    "ListenAddress 127.0.0.1",
    "ListenAddress ::1",
    `HostKey "${dir}/${HOST_KEY}"`,
    `PidFile "${dir}/${PID}"`,
    "PubkeyAuthentication yes",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "AuthenticationMethods publickey",
    "PermitRootLogin no",
    "UsePAM no",
    "StrictModes yes",
    `AllowUsers ${user}`,
    "AuthorizedKeysFile .ssh/authorized_keys",
    "Subsystem sftp internal-sftp",
    "",
  ].join("\n");
}

const xml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The launchd job: sshd in the foreground (launchd supervises it) on Walkie's config, started at boot, restarted if it dies. */
export function macSshdPlist(dir: string = MAC_SSH_DIR): string {
  safeDir(dir);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${MAC_SSH_LABEL}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    "\t\t<string>/usr/sbin/sshd</string>",
    "\t\t<string>-D</string>",
    "\t\t<string>-f</string>",
    `\t\t<string>${xml(`${dir}/${CONFIG}`)}</string>`,
    "\t</array>",
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** What the installer touches and runs, injectable so a test needs no root, launchd or sshd. */
export interface MacSshIo {
  platform: NodeJS.Platform;
  euid: number | undefined;
  /** The uid that must own what is written and that things are chowned to (0: root). */
  owner: number;
  dir: string;
  plist: string;
  spawn: typeof Bun.spawnSync;
  /** The login name of a uid, or null. */
  userName(uid: number): string | null;
  chown(path: string, uid: number, gid: number): void;
  sleep(ms: number): Promise<void>;
  /** Whether an SSH server speaking its banner answers on 127.0.0.1:22022 right now. */
  answers(): Promise<boolean>;
}

function loginOf(uid: number): string | null {
  const child = Bun.spawnSync(["/usr/bin/id", "-un", String(uid)], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const name = child.exitCode === 0 ? child.stdout.toString("utf8").trim() : "";
  return name || null;
}

export function realMacSshIo(): MacSshIo {
  return {
    platform: process.platform, euid: process.geteuid?.(), owner: 0, dir: MAC_SSH_DIR, plist: MAC_SSH_PLIST, spawn: Bun.spawnSync,
    userName: loginOf, chown: (path, uid, gid) => chownSync(path, uid, gid),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    answers: async () => (await sshServerStatus(MACOS_SSH_PORT, { ...realServerProbe, platform: "darwin" })).enabled,
  };
}

interface Ran { code: number; out: string; err: string }
function run(io: MacSshIo, argv: string[]): Ran {
  const child = io.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const text = (bytes: unknown): string => (bytes == null ? "" : Buffer.from(bytes as Uint8Array).toString("utf8"));
  return { code: child.exitCode ?? 1, out: text(child.stdout), err: text(child.stderr) };
}
/** The first line a command said, for a message a person reads. */
const said = (ran: Ran): string => (`${ran.err}\n${ran.out}`.split("\n").map((l) => l.trim()).find(Boolean) ?? "").slice(0, 300);

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** The directory the marker lives in: created 0755 when absent, and only ever used if root owns it and nobody else can write to it. */
function ensureRootDir(io: MacSshIo, dir: string): void {
  if (!lstatOrNull(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== io.owner || (st.mode & 0o022) !== 0) throw new Error(`${dir} is not a root-owned directory that others cannot write to`);
}

/** Walkie's own directory: root-only (0700), a plain directory, never a link. A looser mode of our own directory is repaired. */
function ensurePrivateDir(io: MacSshIo, dir: string): void {
  if (!lstatOrNull(dir)) mkdirSync(dir, { mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a plain directory`);
  if (st.uid !== io.owner) throw new Error(`${dir} is not owned by root`);
  chmodSync(dir, 0o700);
  io.chown(dir, io.owner, 0);
}

/** The people an existing Walkie config of ours allows (its AllowUsers line), or none when there is no config. */
function existingUsers(io: MacSshIo): string[] {
  const path = join(io.dir, CONFIG);
  const st = lstatOrNull(path);
  if (!st) return [];
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  const line = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).find((l) => /^AllowUsers\s/i.test(l));
  return line ? line.split(/\s+/).slice(1) : [];
}

/**
 * Whose service this is, for the un-enroll's ownership guard: the names on every AllowUsers line of Walkie's config. No directory
 * or no config at all means nothing is configured to serve anyone. Anything else that does not plainly say whose it is (the
 * directory or the config is a link or not a plain file, it cannot be read, no line names anybody) is "unknown", with the reason:
 * the guard must never read "I could not tell" as "it is not anyone else's".
 */
function serviceOwners(io: MacSshIo): { users: string[] } | { unknown: string } {
  const path = join(io.dir, CONFIG);
  try {
    const dir = lstatOrNull(io.dir);
    if (!dir) return { users: [] };
    if (dir.isSymbolicLink() || !dir.isDirectory() || dir.uid !== io.owner) return { unknown: `${io.dir} is not a plain directory owned by root` };
    const config = lstatOrNull(path);
    if (!config) return { users: [] };
    if (!config.isFile()) return { unknown: `${path} is not a regular file` };
    const lines = readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter((l) => /^AllowUsers\s/i.test(l));
    if (!lines.length) return { unknown: `${path} has no AllowUsers line` };
    return { users: lines.flatMap((line) => line.split(/\s+/).slice(1)) };
  } catch (error) {
    return { unknown: `${path} cannot be read: ${(error as Error).message}` };
  }
}

/** Writes `content` next to `finalPath` under a staging name (never one launchd would scan) with its mode set before it is renamed. */
function stage(io: MacSshIo, finalPath: string, content: string, mode: number, staged: string[]): string {
  const tmp = join(dirname(finalPath), `.${basename(finalPath)}.tmp-${randomBytes(6).toString("hex")}`);
  staged.push(tmp);
  writeFileSync(tmp, content, { flag: "wx", mode });
  chmodSync(tmp, mode);
  io.chown(tmp, io.owner, 0);
  const fd = openSync(tmp, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return tmp;
}

function commit(tmp: string, finalPath: string, staged: string[]): void {
  renameSync(tmp, finalPath);
  staged.splice(staged.indexOf(tmp), 1);
  syncDir(dirname(finalPath));
}

/** The host key is generated once and kept: the owner's known_hosts entry for this machine stays valid across reinstalls. */
function ensureHostKey(io: MacSshIo, staged: string[]): string | null {
  const key = join(io.dir, HOST_KEY);
  const st = lstatOrNull(key);
  if (st) {
    if (!st.isFile() || st.uid !== io.owner) throw new Error(`${key} is not a regular file owned by root`);
    chmodSync(key, 0o600);
    if (lstatOrNull(`${key}.pub`)) chmodSync(`${key}.pub`, 0o600);
    return null;
  }
  const tmp = join(io.dir, `.${HOST_KEY}.tmp-${randomBytes(6).toString("hex")}`);
  staged.push(tmp, `${tmp}.pub`);
  const made = run(io, ["/usr/bin/ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "walkie-sshd", "-f", tmp]);
  if (made.code !== 0) return `ssh-keygen could not make the host key: ${said(made) || `exit ${made.code}`}`;
  for (const file of [tmp, `${tmp}.pub`]) {
    const made1 = lstatOrNull(file);
    if (!made1?.isFile()) return "ssh-keygen reported success but left no host key";
    chmodSync(file, 0o600);
    io.chown(file, io.owner, 0);
  }
  commit(tmp, key, staged);
  commit(`${tmp}.pub`, `${key}.pub`, staged);
  return null;
}

/** Takes the service out of launchd again and removes its plist, so a service that cannot work does not come back at every boot. */
function undoActivation(io: MacSshIo): void {
  run(io, ["/bin/launchctl", "bootout", `system/${MAC_SSH_LABEL}`]);
  rmSync(io.plist, { force: true });
}

/**
 * Installs (or reinstalls) the service for the person whose uid ran sudo, then waits until it answers an SSH banner on
 * 127.0.0.1:22022. A failure before the service is loaded changes nothing a running service depends on; a failure after
 * it undoes the load. Refuses a service already installed for a different person rather than quietly cutting them off.
 */
export async function installMacSshService(sudoUid: number, io: MacSshIo = realMacSshIo()): Promise<SshInstallResult> {
  if (io.platform !== "darwin") return fail("Walkie's SSH service is installed on macOS by this step; Linux and WSL have their own");
  if (io.euid !== 0) return fail("the SSH service install must run inside the administrator step (as root)");
  if (!Number.isInteger(sudoUid) || sudoUid <= 0) return fail("the SSH service is installed for an ordinary account, never for root");
  const user = io.userName(sudoUid);
  if (!user || !LOGIN.test(user)) return fail("this account's login name cannot be written into the SSH service's configuration safely");
  const staged: string[] = [];
  try {
    ensureRootDir(io, dirname(io.dir));
    ensurePrivateDir(io, io.dir);
    const others = existingUsers(io).filter((name) => name !== user);
    if (others.length) {
      return fail(`this Mac's Walkie SSH service is already installed for ${others.join(", ")}: they must un-enroll (walkie provision unenroll) before anyone else can enroll SSH here`);
    }
    const hostKeyProblem = ensureHostKey(io, staged);
    if (hostKeyProblem) return fail(hostKeyProblem);
    const config = stage(io, join(io.dir, CONFIG), macSshdConfig(user, io.dir), 0o600, staged);
    const checked = run(io, ["/usr/sbin/sshd", "-t", "-f", config]);
    if (checked.code !== 0) return fail(`sshd rejected the SSH service's configuration: ${said(checked) || `exit ${checked.code}`}`);
    const job = stage(io, io.plist, macSshdPlist(io.dir), 0o644, staged);
    const linted = run(io, ["/usr/bin/plutil", "-lint", job]);
    if (linted.code !== 0) return fail(`the SSH service's launchd plist did not pass plutil: ${said(linted) || `exit ${linted.code}`}`);
    commit(config, join(io.dir, CONFIG), staged);
    commit(job, io.plist, staged);
  } catch (error) {
    return fail(`the SSH service install stopped: ${(error as Error).message}`);
  } finally {
    for (const leftover of staged) rmSync(leftover, { force: true });
  }
  // Activation. `enable` clears a disable flag an administrator may have set; a copy loaded before is unloaded first.
  run(io, ["/bin/launchctl", "enable", `system/${MAC_SSH_LABEL}`]);
  run(io, ["/bin/launchctl", "bootout", `system/${MAC_SSH_LABEL}`]);
  // A copy that was just unloaded can still be tearing down: a failed bootstrap is retried a couple of times before it is final.
  let loaded = run(io, ["/bin/launchctl", "bootstrap", "system", io.plist]);
  for (let attempt = 1; loaded.code !== 0 && attempt < BOOTSTRAP_TRIES; attempt++) {
    await io.sleep(WAIT_MS);
    loaded = run(io, ["/bin/launchctl", "bootstrap", "system", io.plist]);
  }
  if (loaded.code !== 0) {
    undoActivation(io);
    return fail(`launchd would not load the SSH service: ${said(loaded) || `exit ${loaded.code}`}`);
  }
  for (let attempt = 0; attempt < WAIT_TRIES; attempt++) {
    if (await io.answers()) return { ok: true };
    await io.sleep(WAIT_MS);
  }
  undoActivation(io);
  return fail(`the SSH service loaded but nothing answered on 127.0.0.1:${MACOS_SSH_PORT} within ${(WAIT_MS * WAIT_TRIES) / 1000} seconds; sudo launchctl print system/${MAC_SSH_LABEL} shows why`);
}

export interface MacSshRemoval {
  removed: boolean;
  /** Something was left in place that should have gone (could not stop, not a plain directory): the reason. */
  why?: string;
  /** The service is not this person's, so it was left alone on purpose: whom it serves. */
  kept?: string;
}

/**
 * Un-enroll: stops dev.walkie.sshd and removes its plist and its directory (config, host key). Nothing else is touched.
 * Given the uid of the person un-enrolling, a service installed for ANOTHER person is left alone: one person's un-enroll must
 * never cut off another's SSH. So is one whose owner cannot be established from its config (`why` says so, and the caller
 * prints the commands that remove it by hand). `removed` is false with no `why` or `kept` when there was nothing to remove.
 */
export function removeMacSshService(io: MacSshIo = realMacSshIo(), forUid?: number): MacSshRemoval {
  if (io.platform !== "darwin") return { removed: false, why: "Walkie's macOS SSH service exists on macOS only" };
  if (io.euid !== 0) return { removed: false, why: "removing the SSH service needs the administrator step (root)" };
  if (forUid !== undefined) {
    const me = io.userName(forUid);
    const owners = serviceOwners(io);
    if ("unknown" in owners) return { removed: false, why: `it was left in place because its configuration cannot be read to confirm it is yours (${owners.unknown})` };
    const others = owners.users.filter((name) => name !== me);
    if (others.length) return { removed: false, kept: `it serves ${others.join(", ")}, not you` };
  }
  const stop = run(io, ["/bin/launchctl", "bootout", `system/${MAC_SSH_LABEL}`]);
  if (run(io, ["/bin/launchctl", "print", `system/${MAC_SSH_LABEL}`]).code === 0) {
    return { removed: false, why: `could not stop the SSH service: ${said(stop) || "launchctl still lists it"}` };
  }
  let removed = false;
  if (lstatOrNull(io.plist)) { rmSync(io.plist, { force: true }); removed = true; }
  const st = lstatOrNull(io.dir);
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== io.owner) return { removed, why: `${io.dir} is not a plain directory owned by root; left alone` };
    rmSync(io.dir, { recursive: true, force: true });
    removed = true;
  }
  return { removed };
}
