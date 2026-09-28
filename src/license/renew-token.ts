// The renewal token (docs/BUSINESS.md "Renewal"): 32 random bytes, base64url, handed to the roster
// authority ONCE when an activation code is first bound to the team. It lives only in
// <home>/license-renew-token (0600) on the authority, never on the chain; the site keeps only its
// sha256. Moving the authority to another machine means copying this file there.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TEAM_ID } from "./format.ts";

export const RENEW_TOKEN_FILE = "license-renew-token";
/** base64url of 32 bytes, unpadded. */
export const RENEWAL_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const StoredToken = z.object({
  lic_id: z.string().min(1).max(200),
  team: z.string().regex(TEAM_ID),
  token: z.string().regex(RENEWAL_TOKEN),
}).strict();
export type StoredToken = z.infer<typeof StoredToken>;

export function renewTokenPath(home: string): string { return join(home, RENEW_TOKEN_FILE); }

/** Writes the token file atomically, mode 0600. Throws on invalid input. */
export function saveRenewToken(home: string, t: StoredToken): void {
  const valid = StoredToken.parse(t);
  const path = renewTokenPath(home);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(valid) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** The stored token, or null when there is none or the file is not a valid token record. */
export function loadRenewToken(home: string): StoredToken | null {
  const path = renewTokenPath(home);
  if (!existsSync(path)) return null;
  try {
    const p = StoredToken.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}
