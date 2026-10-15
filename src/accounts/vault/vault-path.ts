import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export function tightenVaultDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`vault path is not a regular directory: ${path}`);
  if ((stat.mode & 0o077) === 0) return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error(`vault directory changed during setup: ${path}`);
    fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
}

/** Check each directory without following links. Missing components are made one at a time, then checked again. */
export function checkVaultDirectories(walkieHome: string, through: string, options: { create?: boolean; missingOk?: boolean } = {}): boolean {
  const base = resolve(walkieHome);
  const rel = relative(base, resolve(through));
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("vault path is outside the Sqwakie home");
  const parts = rel ? rel.split(sep) : [];
  let current = base;
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = join(current, parts[i] as string);
    let stat;
    try { stat = lstatSync(current); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (options.missingOk) return false;
      if (!options.create) throw new Error(`vault directory is missing: ${current}`);
      mkdirSync(current, { mode: 0o700 });
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink()) throw new Error(`vault path contains a symlink: ${current}`);
    if (!stat.isDirectory()) throw new Error(`vault path is not a directory: ${current}`);
    if (options.create && i >= 0) tightenVaultDirectory(current);
  }
  return true;
}

/** An account home must be a direct child of its provider root, and resolve inside that root. */
export function checkVaultHome(walkieHome: string, provider: "kimi" | "codex", home: string, options: { missingOk?: boolean } = {}): boolean {
  const root = resolve(walkieHome, "vault", provider);
  const child = relative(root, resolve(home));
  if (!child || child === ".." || child.startsWith(`..${sep}`) || child.includes(sep)) {
    throw new Error(`refusing to use a directory outside the ${provider} vault`);
  }
  if (!checkVaultDirectories(walkieHome, root, options)) return false;
  if (!checkVaultDirectories(walkieHome, home, options)) return false;
  const actualRoot = realpathSync(root);
  const actualHome = realpathSync(home);
  if (actualRoot !== join(realpathSync(walkieHome), "vault", provider) || actualHome !== join(actualRoot, child)) {
    throw new Error(`${provider} home resolves outside its vault root`);
  }
  return true;
}

/** A provider may loosen its pending home during login. Sqwakie owns this home and repairs it once. */
export function secureVaultHomeAfterLogin(walkieHome: string, provider: "kimi" | "codex", home: string): void {
  checkVaultHome(walkieHome, provider, home);
  const fd = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    const current = lstatSync(home);
    if (!opened.isDirectory() || opened.ino !== current.ino || opened.dev !== current.dev) throw new Error(`${provider} vault home changed during login`);
    if (opened.uid !== process.getuid?.()) throw new Error(`${provider} vault home owner is unsafe; fix the owner to the current user`);
    if ((opened.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700);
    const secured = fstatSync(fd);
    if ((secured.mode & 0o777) !== 0o700 || secured.uid !== process.getuid?.()) throw new Error(`${provider} vault home must be owned by the current user with mode 0700`);
  } finally { closeSync(fd); }
  verifyPrivateVaultHome(walkieHome, provider, home);
}

/** Reads never repair a home; they give the caller a reason to refuse it. */
export function verifyPrivateVaultHome(walkieHome: string, provider: "kimi" | "codex", home: string): void {
  checkVaultHome(walkieHome, provider, home);
  const stat = lstatSync(home);
  if (stat.uid !== process.getuid?.()) throw new Error(`${provider} vault home owner is unsafe; fix the owner to the current user`);
  if ((stat.mode & 0o777) !== 0o700) throw new Error(`${provider} vault home permissions are unsafe; fix the mode to 0700`);
}

/** A failed add owns this newly created home; discard even extra files the provider wrote during login. */
export function discardFailedVaultHome(walkieHome: string, provider: "kimi" | "codex", home: string): void {
  const root = resolve(walkieHome, "vault", provider);
  if (resolve(dirname(home)) !== root || !/^(?:pending-[0-9a-f]{12}|[0-9a-f]{24})$/.test(basename(home))) {
    throw new Error("invalid failed-login vault home");
  }
  checkVaultDirectories(walkieHome, root);
  let stat;
  try { stat = lstatSync(home); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return; throw err; }
  if (!stat.isDirectory()) { unlinkSync(home); return; }
  checkVaultHome(walkieHome, provider, home);
  rmSync(home, { recursive: true });
}

/** Read one vault-owned credential through a no-follow descriptor after checking its home and inode. */
export function readVaultCredential(walkieHome: string, provider: "kimi" | "codex", home: string, name: string, maxBytes = 64 * 1024, refusal: (reason: string) => void = () => undefined): string | null {
  let fd: number | null = null;
  try {
    if (provider === "codex" ? name !== "auth.json" : !/^credentials\/kimi-code(?:-env-[0-9a-fA-F]{16})?\.json$/.test(name)) {
      throw new Error("invalid vault credential name");
    }
    verifyPrivateVaultHome(walkieHome, provider, home);
    const file = join(home, name);
    checkVaultDirectories(home, dirname(file));
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    const current = lstatSync(file);
    if (!opened.isFile() || opened.ino !== current.ino || opened.dev !== current.dev || opened.size > maxBytes) {
      refusal(`${provider} vault credential changed or is not a regular file`); return null;
    }
    if (opened.uid !== process.getuid?.()) { refusal(`${provider} vault credential owner is unsafe; it must be the current user`); return null; }
    if ((opened.mode & 0o777) !== 0o600) { refusal(`${provider} vault credential permissions are unsafe; fix the mode to 0600`); return null; }
    verifyPrivateVaultHome(walkieHome, provider, home);
    checkVaultDirectories(home, dirname(file));
    return readFileSync(fd, "utf8");
  } catch (err) { refusal(`${provider} vault credential path is unsafe: ${(err as Error).message}`); return null; }
  finally { if (fd !== null) closeSync(fd); }
}

/** Detect a vault home even when the caller selected it through an alias. */
export function vaultCodexHomePath(walkieHome: string, home: string): string | null {
  const root = resolve(walkieHome, "vault", "codex");
  const vaultChild = (path: string) => {
    const rel = relative(root, path);
    return rel !== ".." && !rel.startsWith(`..${sep}`);
  };
  let checkedHome = resolve(home);
  if (!vaultChild(checkedHome)) {
    try { checkedHome = realpathSync(checkedHome); } catch { /* missing ordinary home */ }
  }
  return vaultChild(checkedHome) ? checkedHome : null;
}

/** Recognize a provider vault home selected through a CLI path, including an alias into that home. */
export function inferredVaultHome(provider: "kimi" | "codex", home: string): { walkieHome: string; home: string } | null {
  const selected = resolve(home);
  const candidates = [selected];
  try { candidates.push(realpathSync(selected)); } catch { /* a missing home cannot supply a credential */ }
  const marker = `${sep}vault${sep}${provider}${sep}`;
  for (const candidate of candidates) {
    const at = candidate.lastIndexOf(marker);
    if (at >= 0) return { walkieHome: candidate.slice(0, at) || sep, home: candidate };
  }
  return null;
}

/** A selected Codex home may be ordinary or vaulted; only the latter requires the private vault reader. */
export function readCodexAuthFromHome(walkieHome: string, home: string): string | null {
  const vaultHome = vaultCodexHomePath(walkieHome, home);
  if (vaultHome) return readVaultCredential(walkieHome, "codex", vaultHome, "auth.json");
  try {
    const file = join(home, "auth.json");
    const stat = lstatSync(file);
    return stat.isFile() && stat.size <= 64 * 1024 ? readFileSync(file, "utf8") : null;
  } catch { return null; }
}
