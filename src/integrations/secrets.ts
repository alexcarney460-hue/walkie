// Connector API keys: ~/.walkie/secrets/<connector> (0600, dir 0700) or a user file named by key_path.
// Keys are never replicated, logged or returned by any API; error messages never include file content.
// Every key file is checked on the opened descriptor (fstat): a regular file, owned by this user, with
// no group/other permission bits, at most 4 KB, and (#9) no ACL entry granting anyone but the owner
// access: macOS ACLs are read with `ls -le` (the path as an argv, never a shell), Linux POSIX ACLs
// with `getfacl` when it is installed. The ACL verdict is cached per (device, inode, ctime): any
// chmod, chown or ACL change moves ctime, so a changed file is always re-checked.
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ConnectorId } from "./config.ts";
import { scrubMessage } from "./scrub.ts";

/** A key is one printable token (no spaces or newlines inside). */
const KEY_RE = /^[\x21-\x7e]{8,512}$/;
const MAX_KEY_FILE_BYTES = 4096;
const ACL_TOOL_TIMEOUT_MS = 3_000;
const ACL_CACHE_MAX = 64;

export class SecretError extends Error {}

/** ACL verdicts by (dev, ino, ctime): null = clean, else the refusal message (without the label). */
const aclVerdicts = new Map<string, string | null>();

function runTool(cmd: string[]): { ok: boolean; out: string } {
  try {
    const r = Bun.spawnSync(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: ACL_TOOL_TIMEOUT_MS });
    return { ok: r.exitCode === 0, out: r.stdout.toString("utf8") };
  } catch {
    return { ok: false, out: "" };
  }
}

/**
 * macOS: `ls -le` lists the file, then one line per ACE: ` N: user:NAME allow perms` / ` N: group:NAME
 * deny perms`. Any `allow` entry for a principal other than the owning user grants access to others.
 * Returns the refusal, or null when the ACL grants nothing.
 */
export function macAclRefusal(lsOutput: string): string | null {
  const lines = lsOutput.split("\n");
  const owner = (lines[0] ?? "").trim().split(/\s+/)[2] ?? "";
  for (const line of lines.slice(1)) {
    const m = /^\s*\d+:\s+(user|group):(.+?)\s+(allow|deny)\b/.exec(line);
    if (!m || m[3] !== "allow") continue;
    if (m[1] === "user" && m[2] === owner) continue; // the owner granting themself: nothing new
    return `key file has an ACL granting ${m[1]} ${m[2]} access`;
  }
  return null;
}

/**
 * Linux: `getfacl -c -p` lines `user:NAME:perms` / `group:NAME:perms`; a NAMED user or group with any
 * permission bit set grants access beyond the mode bits (the unnamed `user::`, `group::`, `other::`
 * entries ARE the mode bits, checked already; `mask::` only limits).
 */
export function posixAclRefusal(getfaclOutput: string): string | null {
  for (const line of getfaclOutput.split("\n")) {
    const m = /^(user|group):([^:]+):([rwx-]+)$/.exec(line.trim());
    if (!m || !/[rwx]/.test(m[3] ?? "")) continue;
    return `key file has an ACL granting ${m[1]} ${m[2]} access`;
  }
  return null;
}

function aclRefusal(abs: string, st: Stats): { message: string; fix: string } | null {
  const key = `${st.dev}:${st.ino}:${st.ctimeMs}`;
  const cached = aclVerdicts.get(key);
  let verdict: string | null;
  let fix = "";
  if (cached !== undefined) {
    verdict = cached;
    fix = process.platform === "darwin" ? `chmod -N ${abs}` : `setfacl -b ${abs}`;
  } else if (process.platform === "darwin") {
    const r = runTool(["/bin/ls", "-le", "--", abs]);
    verdict = r.ok ? macAclRefusal(r.out) : "key file ACL could not be checked (ls -le failed)";
    fix = `chmod -N ${abs}`;
  } else if (process.platform === "linux") {
    const getfacl = Bun.which("getfacl");
    if (!getfacl) return null; // no ACL tooling: the mode bits are the check
    const r = runTool([getfacl, "-c", "-p", "--", abs]);
    verdict = r.ok ? posixAclRefusal(r.out) : null; // a filesystem without ACL support answers non-zero
    fix = `setfacl -b ${abs}`;
  } else {
    return null;
  }
  if (aclVerdicts.size >= ACL_CACHE_MAX) aclVerdicts.delete(aclVerdicts.keys().next().value as string);
  aclVerdicts.set(key, verdict);
  return verdict === null ? null : { message: verdict, fix };
}

export function secretsDir(home: string): string { return join(home, "secrets"); }
function secretFile(home: string, id: ConnectorId): string { return join(secretsDir(home), id); }

export function validKey(key: string): boolean { return KEY_RE.test(key); }

/** "~/keys/x.txt" → absolute path. Relative paths are refused (the daemon's cwd is not the user's). */
export function expandKeyPath(p: string): string {
  const expanded = p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
  if (!isAbsolute(expanded)) throw new SecretError("key_path must be absolute or start with ~/");
  return resolve(expanded);
}

function openKey(abs: string, label: string): number {
  try {
    // O_NONBLOCK: opening a FIFO never waits for a writer; fstat below refuses it.
    return openSync(abs, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new SecretError(`key file not found: ${label}`);
    if (code === "EACCES") throw new SecretError(`key file is not readable by you: ${label}`);
    throw new SecretError(`key file can't be opened (${code ?? "error"}): ${label}`);
  }
}

/** Reads and validates one key file by path. Throws SecretError whose message never holds file content. */
function readKeyAt(abs: string, label: string): string {
  const fd = openKey(abs, label);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SecretError(`key_path is not a regular file: ${label}`);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null && st.uid !== uid) throw new SecretError(`key file is owned by another user: ${label} (it must be yours; chown it, then chmod 600 ${label})`);
    if ((st.mode & 0o077) !== 0) {
      const mode = (st.mode & 0o777).toString(8).padStart(3, "0");
      throw new SecretError(`key file is accessible to other users (mode ${mode}): ${label}. Fix it with: chmod 600 ${label}`);
    }
    if (st.size > MAX_KEY_FILE_BYTES) throw new SecretError(`key file is larger than ${MAX_KEY_FILE_BYTES} bytes: ${label}`);
    // The ACL tools take a path: it must be the file that was actually opened (symlinks resolved), and
    // still the same inode, or a symlink could point the check at a clean file (FINAL Fable 6).
    let real: string;
    try {
      real = realpathSync.native(abs);
      const rst = lstatSync(real);
      if (rst.dev !== st.dev || rst.ino !== st.ino) throw new SecretError(`key file changed while it was being checked: ${label}`);
    } catch (err) {
      if (err instanceof SecretError) throw err;
      throw new SecretError(`key file's real path could not be resolved: ${label}`);
    }
    const acl = aclRefusal(real, st);
    if (acl) throw new SecretError(`${acl.message}: ${label}. Remove the ACL with: ${acl.fix}`);
    const buf = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n > MAX_KEY_FILE_BYTES) throw new SecretError(`key file is larger than ${MAX_KEY_FILE_BYTES} bytes: ${label}`);
    const key = buf.subarray(0, n).toString("utf8").trim();
    buf.fill(0);
    if (!validKey(key)) throw new SecretError(`key file does not hold a single API key token: ${label}`);
    return key;
  } finally {
    closeSync(fd);
  }
}

/** Reads and validates a key file named by key_path. */
export function readKeyFile(path: string): string {
  return readKeyAt(expandKeyPath(path), path);
}

export function storeSecret(home: string, id: ConnectorId, key: string): void {
  if (!validKey(key)) throw new SecretError("key must be a single printable token of 8 to 512 characters");
  const dir = secretsDir(home);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = secretFile(home, id);
  writeFileSync(file, key + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function hasSecret(home: string, id: ConnectorId): boolean {
  const f = secretFile(home, id);
  return existsSync(f) && lstatSync(f).isFile();
}

export function deleteSecret(home: string, id: ConnectorId): void {
  rmSync(secretFile(home, id), { force: true });
}

/** The key for a connector: the stored secret, else key_path. null when neither is set. */
export function resolveKey(home: string, id: ConnectorId, keyPath: string | undefined): string | null {
  if (hasSecret(home, id)) {
    try {
      return readKeyAt(secretFile(home, id), `~/.walkie/secrets/${id}`);
    } catch (err) {
      if (err instanceof SecretError && err.message.includes("single API key token")) throw new SecretError(`stored ${id} secret is malformed; set the key again`);
      throw err;
    }
  }
  if (keyPath) return readKeyFile(keyPath);
  return null;
}

/** Removes a known key (and anything shaped like a secret) from a message before it is logged or returned. */
export function scrub(message: string, key: string | null): string {
  return scrubMessage(message, [key]);
}
