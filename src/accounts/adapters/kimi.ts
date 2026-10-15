// Kimi Code accounts.
//   identify: no identity file; the login is recorded under a provisional id until GET /coding/v1/me answers
//             (user id + email), which the poller asks with the current token.
//   token:    <KIMI_CODE_HOME>/credentials/kimi-code.json or kimi-code-env-<16 hex>.json access_token, read-only.
//   usage:    GET https://api.kimi.com/coding/v1/usages. `usage` (the weekly quota) and `limits[]` (the 5-hour window)
//             are trusted; the `usages` block disagrees with them in practice and is ignored.
// Never calls a token or refresh endpoint.
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { AccountWindow } from "../../protocol/accounts.ts";
import { getUsageJson, USAGE_URLS, type FetchLike } from "../http.ts";
import { accountId, maskEmail } from "../mask.ts";
import type { AccessToken, Identity, Login, Reading } from "../types.ts";
import { kindForSeconds, num, readingFrom, toMs, window } from "../windows.ts";
import { checkVaultDirectories, inferredVaultHome, readVaultCredential, verifyPrivateVaultHome } from "../vault/vault-path.ts";

/** The CLI has used both names. Select by name and mtime only; never follow a link. */
export function kimiCredentialsPath(login: Login, refusal: (reason: string) => void = () => undefined): string | null {
  const dir = join(login.dir, "credentials");
  try {
    const vault = inferredVaultHome("kimi", login.dir);
    if (login.vault || vault) verifyPrivateVaultHome(vault?.walkieHome ?? join(login.dir, "..", "..", ".."), "kimi", vault?.home ?? login.dir);
    checkVaultDirectories(login.dir, dir);
  } catch (err) { refusal(`Kimi credential path is unsafe: ${(err as Error).message}. Fix the path before using this login.`); return null; }
  const regular = (path: string): { mtime: number } | null => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) { refusal("Kimi credential is a symlink or not a regular file. Fix the credential file before using this login."); return null; }
    if ((stat.mode & 0o777) !== 0o600) { refusal("Kimi credential permissions are unsafe. Fix the file mode to 0600 before using this login."); return null; }
    if (stat.uid !== process.getuid?.()) { refusal("Kimi credential owner is unsafe. Fix the file owner to the current user before using this login."); return null; }
    return { mtime: stat.mtimeMs };
  };
  const fixed = join(dir, "kimi-code.json");
  try { return regular(fixed) ? fixed : null; } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null; }
  let names: string[];
  try { names = readdirSync(dir).filter((n) => /^kimi-code-env-[0-9a-fA-F]{16}\.json$/.test(n)); } catch { return null; }
  const ranked = names.map((name) => {
    const path = join(dir, name);
    try { const stat = regular(path); return stat ? { path, mtime: stat.mtime } : null; }
    catch { return null; }
  }).filter((x): x is { path: string; mtime: number } => x !== null);
  if (ranked.length !== names.length) return null;
  ranked.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  return ranked[0]?.path ?? null;
}

/** A provisional identity for a login whose /me answer is not known yet (stable per home as files rotate). */
export function provisionalKimiIdentity(login: Login): Identity | null {
  const path = kimiCredentialsPath(login);
  if (!path) return null;
  // The CLI may rotate between env-named files. The home, not one file name, is this provisional login.
  return { provider: "kimi", id: accountId("kimi", "login", login.dir), label: "Kimi account", plan: null, pending: true };
}

const Me = z.object({
  user_id: z.string().min(1).max(100),
  email: z.string().max(320).nullable().optional(),
  user_level_name: z.string().max(64).nullable().optional(),
});

/** Identity from the /me body (exported for fixtures). */
export function kimiIdentityFromMe(body: unknown): Identity | null {
  const m = Me.safeParse(body);
  if (!m.success) return null;
  return { provider: "kimi", id: accountId("kimi", m.data.user_id), label: maskEmail(m.data.email) ?? "Kimi account", plan: null };
}

export async function fetchKimiIdentity(fetchFn: FetchLike, token: AccessToken): Promise<Identity | null> {
  const body = await getUsageJson(fetchFn, USAGE_URLS.kimiMe, { Authorization: `Bearer ${token.value}` }, token.value);
  return kimiIdentityFromMe(body);
}

const Creds = z.object({ access_token: z.string().max(16_384), expires_at: z.number().nullable().optional() });

export function readKimiToken(login: Login, refusal: (reason: string) => void = () => undefined): AccessToken | "none" {
  const path = kimiCredentialsPath(login, refusal);
  if (!path) return "none";
  const vault = inferredVaultHome("kimi", login.dir);
  if (login.vault || vault) {
    const text = readVaultCredential(vault?.walkieHome ?? join(login.dir, "..", "..", ".."), "kimi", vault?.home ?? login.dir, `credentials/${basename(path)}`, 64 * 1024, refusal);
    if (text === null) return "none";
    try {
      const c = Creds.safeParse(JSON.parse(text));
      return c.success && c.data.access_token.length >= 8 ? { value: c.data.access_token, expiresAt: toMs(c.data.expires_at) } : "none";
    } catch { return "none"; }
  }
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    const current = lstatSync(path);
    if (!opened.isFile() || opened.ino !== current.ino || opened.dev !== current.dev
      || (opened.mode & 0o777) !== 0o600 || opened.uid !== process.getuid?.()) {
      refusal("Kimi credential changed or is unsafe. Fix its owner and mode to the current user and 0600 before using this login.");
      return "none";
    }
    checkVaultDirectories(login.dir, join(login.dir, "credentials"));
    const c = Creds.safeParse(JSON.parse(readFileSync(fd, "utf8")));
    if (!c.success || c.data.access_token.length < 8) return "none";
    return { value: c.data.access_token, expiresAt: toMs(c.data.expires_at) };
  } catch {
    refusal("Kimi credential read failed or its path changed. Check the credential path and file.");
    return "none";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

const UNIT_S: Record<string, number> = { TIME_UNIT_SECOND: 1, TIME_UNIT_MINUTE: 60, TIME_UNIT_HOUR: 3600, TIME_UNIT_DAY: 86_400 };

function quotaPct(d: Record<string, unknown> | undefined): number | null {
  if (!d) return null;
  const limit = num(d.limit);
  const used = num(d.used) ?? (limit !== null && num(d.remaining) !== null ? limit - (num(d.remaining) as number) : null);
  if (limit === null || used === null || limit <= 0) return null;
  return (used / limit) * 100;
}

/** Parses the /usages body. */
export function parseKimiUsage(body: unknown, at: number): Reading {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const windows: AccountWindow[] = [];
  for (const raw of Array.isArray(b.limits) ? b.limits.slice(0, 8) : []) {
    const l = (raw && typeof raw === "object" ? raw : {}) as { window?: Record<string, unknown>; detail?: Record<string, unknown> };
    const p = quotaPct(l.detail);
    if (p === null) continue;
    const dur = num(l.window?.duration);
    const unit = UNIT_S[String(l.window?.timeUnit ?? "")] ?? null;
    const secs = dur !== null && unit !== null ? dur * unit : null;
    windows.push(window(kindForSeconds(secs), p, toMs(l.detail?.resetTime), secs));
  }
  const usage = b.usage && typeof b.usage === "object" ? b.usage as Record<string, unknown> : undefined;
  const weekly = quotaPct(usage);
  if (weekly !== null) windows.push(window("weekly", weekly, toMs(usage?.resetTime), null));
  return readingFrom(at, windows, "api");
}

export async function fetchKimiUsage(fetchFn: FetchLike, token: AccessToken, at: number): Promise<Reading> {
  const body = await getUsageJson(fetchFn, USAGE_URLS.kimi, { Authorization: `Bearer ${token.value}` }, token.value);
  return parseKimiUsage(body, at);
}
