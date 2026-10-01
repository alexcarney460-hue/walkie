import { existsSync, lstatSync, readFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ownerKeyLine } from "./authorized-keys.ts";

export const ownerPrivateKeyPath = (walkieHome: string): string => join(walkieHome, "owner-ssh-ed25519");

/** This key stays in Walkie's private home; it is never installed in the person's ~/.ssh by default. */
export function ownerPublicKey(walkieHome: string, create = false): string | null {
  if (create && !existsSync(walkieHome)) mkdirSync(walkieHome, { recursive: true, mode: 0o700 });
  if (!lstatSync(walkieHome).isDirectory()) throw new Error("Walkie home must be a directory");
  const privatePath = ownerPrivateKeyPath(walkieHome);
  const publicPath = `${privatePath}.pub`;
  if (!existsSync(privatePath)) {
    if (!create) return null;
    const result = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", privatePath], { stdio: "ignore" });
    if (result.status !== 0) throw new Error("ssh-keygen could not create the owner key");
  }
  for (const path of [privatePath, publicPath]) {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error("owner SSH key must be a regular file");
  }
  chmodSync(privatePath, 0o600);
  const publicKey = readFileSync(publicPath, "utf8").trim();
  ownerKeyLine("verify", "verify", publicKey);
  return publicKey;
}
