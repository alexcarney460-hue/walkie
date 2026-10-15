// A Kimi login belongs to one private home. Its rotating credential never leaves this machine.
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { privateDir } from "./vault.ts";
import { checkVaultDirectories, checkVaultHome, discardFailedVaultHome, verifyPrivateVaultHome } from "./vault-path.ts";

export const vaultKimiRoot = (walkieHome: string): string => join(walkieHome, "vault", "kimi");
export function kimiBaseHome(walkieHome: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const chosen = env.KIMI_CODE_HOME?.startsWith("/") ? resolve(env.KIMI_CODE_HOME) : null;
  return chosen && !chosen.startsWith(resolve(vaultKimiRoot(walkieHome)) + sep) ? chosen : join(home, ".kimi-code");
}

export function pendingKimiHome(walkieHome: string): string {
  const root = vaultKimiRoot(walkieHome);
  checkVaultDirectories(walkieHome, root, { create: true });
  const path = join(root, `pending-${randomBytes(6).toString("hex")}`);
  mkdirSync(path, { mode: 0o700 });
  checkVaultHome(walkieHome, "kimi", path);
  return path;
}

export function finalKimiHome(pending: string, walkieHome: string, id: string): string {
  if (!/^[0-9a-f]{24}$/.test(id) || resolve(dirname(pending)) !== resolve(vaultKimiRoot(walkieHome)) || !/^pending-[0-9a-f]{12}$/.test(basename(pending))) throw new Error("invalid Kimi vault home");
  verifyPrivateVaultHome(walkieHome, "kimi", pending);
  const dest = join(vaultKimiRoot(walkieHome), id);
  try { lstatSync(dest); throw new Error("that account is already in the vault"); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  renameSync(pending, dest);
  try { verifyPrivateVaultHome(walkieHome, "kimi", dest); }
  catch (err) { discardFailedVaultHome(walkieHome, "kimi", dest); throw err; }
  return dest;
}

const credentialName = (name: string) => name === "kimi-code.json" || /^kimi-code-env-[0-9a-fA-F]{16}\.json$/.test(name);

/** Delete only recognized regular credentials. Other CLI files need --move into the person's own Kimi home. */
export function removeKimiHome(dir: string, walkieHome: string, opts: { move?: boolean; baseHome?: string } = {}): { moved: string[] } {
  if (resolve(dirname(dir)) !== resolve(vaultKimiRoot(walkieHome)) || !/^(?:[0-9a-f]{24}|pending-[0-9a-f]{12})$/.test(basename(dir))) throw new Error("refusing to delete a directory outside the Kimi vault");
  if (!checkVaultHome(walkieHome, "kimi", dir, { missingOk: true })) return { moved: [] };
  const names = readdirSync(dir);
  const credentials = join(dir, "credentials");
  let auth: string[] = [];
  let extraCredentials: string[] = [];
  if (names.includes("credentials")) {
    checkVaultDirectories(walkieHome, credentials);
    const contents = readdirSync(credentials);
    for (const name of contents) {
      const stat = lstatSync(join(credentials, name));
      if (stat.isSymbolicLink()) throw new Error("Kimi credentials contain a symlink");
      if (credentialName(name) && !stat.isFile()) throw new Error("Kimi credential is not a regular file");
    }
    auth = contents.filter(credentialName);
    extraCredentials = contents.filter((name) => !auth.includes(name));
  }
  const other = names.filter((name) => name !== "credentials");
  if (other.some((name) => lstatSync(join(dir, name)).isSymbolicLink())) throw new Error("Kimi home contains a symlink");
  const base = opts.baseHome;
  if ((other.length || extraCredentials.length) && (!opts.move || !base)) throw new Error(`${dir} holds other Kimi files. Run again with --move, or move them yourself first.`);
  if ((other.length || extraCredentials.length) && base) {
    privateDir(base, true);
    const clash = other.filter((name) => existsSync(join(base, name)));
    if (clash.length) throw new Error(`cannot move ${clash.join(", ")}: already in your Kimi home`);
    if (extraCredentials.length) {
      const baseCredentials = join(base, "credentials");
      if (existsSync(baseCredentials) && !lstatSync(baseCredentials).isDirectory()) throw new Error("your Kimi credentials directory is not a regular directory");
      privateDir(baseCredentials, true);
      const credClash = extraCredentials.filter((name) => existsSync(join(baseCredentials, name)));
      if (credClash.length) throw new Error(`cannot move ${credClash.join(", ")}: already in your Kimi credentials directory`);
    }
  }
  for (const name of other) { checkVaultHome(walkieHome, "kimi", dir); renameSync(join(dir, name), join(base as string, name)); }
  for (const name of extraCredentials) { checkVaultHome(walkieHome, "kimi", dir); checkVaultDirectories(walkieHome, credentials); renameSync(join(credentials, name), join(base as string, "credentials", name)); }
  for (const name of auth) {
    checkVaultHome(walkieHome, "kimi", dir);
    checkVaultDirectories(walkieHome, credentials);
    if (!lstatSync(join(credentials, name)).isFile()) throw new Error("Kimi credential is not a regular file");
    unlinkSync(join(credentials, name));
  }
  if (names.includes("credentials")) { checkVaultHome(walkieHome, "kimi", dir); checkVaultDirectories(walkieHome, credentials); rmdirSync(credentials); }
  checkVaultHome(walkieHome, "kimi", dir);
  rmdirSync(dir);
  return { moved: [...other, ...extraCredentials.map((name) => `credentials/${name}`)] };
}
