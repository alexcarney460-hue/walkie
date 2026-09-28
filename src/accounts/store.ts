// Two files in ~/.walkie (0600, no token in either), both read ROW BY ROW and written atomically with fsync
// (temp file, fsync, rename, fsync of the directory; RESET-5: power loss and panics happen):
//   accounts.json         recorded accounts and their last readings, Kimi aliases. Rebuildable: an unreadable file is
//                         kept aside (copied) and polling starts over. Pre-RESET daemons rewrite it on a rollback.
//   reset-attempts.json   the reset ledger (RESET-5): attempts, polling holds (Retry-After, backoff, Keychain) and the
//                         recovery marker. Older daemons never touch it, so a rollback to pre.2 can't erase it. An
//                         unreadable file, or an unreadable attempt row, is COPIED aside (the original stays until a
//                         marker is written over it), and any leftover `reset-attempts.json.corrupt-*` blocks resets at
//                         startup until a person confirms they checked usage (then renamed `.checked`).
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, writeSync, chmodSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { AccountProvider, AccountUsage } from "../protocol/accounts.ts";

/** Accounts kept per machine, in memory and in the file alike (least recently seen dropped first). */
export const MAX_RECORDS = 64;
export const LEDGER_FILE = "reset-attempts.json";
const CORRUPT = ".corrupt-";

export const RecordRow = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/), provider: AccountProvider, label: z.string().max(48), plan: z.string().max(24).nullable(),
  pending: z.boolean().optional(), token_login: z.boolean().optional(), dir: z.string().max(4096), is_default: z.boolean(), last_seen: z.number(),
  /** ACCOUNTS-2: a vault account (re-created from the vault on start; kept here for its last reading, which the
   *  switcher also reads when the daemon does not answer). */
  vault: z.boolean().optional(),
  reading: AccountUsage.nullable(),
  /** RESET-CLOCK-1: the remembered reset times (validated entry by entry on load; absent in files from pre.5). */
  clock: z.array(z.unknown()).optional().catch(undefined),
});
export type RecordRow = z.infer<typeof RecordRow>;

const KimiAliases = z.record(z.object({ id: z.string(), label: z.string().max(48), plan: z.string().max(24).nullable() }));
export type KimiAliases = z.infer<typeof KimiAliases>;

/** A polling hold for one account: no poll before `not_before` (Retry-After, backoff), the backoff to carry on. */
export const HoldRow = z.object({ not_before: z.number(), backoff_ms: z.number().min(0) });
export type HoldRow = z.infer<typeof HoldRow>;
export type Recovery = { kept: string; at: number };

const AccountsShape = z.object({
  version: z.literal(1),
  records: z.array(z.unknown()).default([]),
  kimi_aliases: z.unknown().optional(),
  /** Read only to migrate a RESET-2..4 build's ledger into its own file. */
  reset_attempts: z.array(z.unknown()).optional(),
});

const LedgerShape = z.object({
  version: z.literal(1),
  attempts: z.array(z.unknown()).default([]),
  holds: z.record(z.unknown()).default({}),
  keychain_blocked_until: z.number().optional(),
  recovery: z.object({ kept: z.string().max(256), at: z.number() }).nullable().optional(),
});

// ---- atomic, durable writes ------------------------------------------------------

function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try { fd = openSync(dir, "r"); fsyncSync(fd); } catch { /* some filesystems refuse a directory fsync */ } finally { if (fd !== null) closeSync(fd); }
}

/** Writes `path` atomically and durably: temp file (0600) + fsync, directory fsync, rename, directory fsync. Throws. */
export function writeDurable(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  fsyncDir(dirname(path));
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}

/** Copies `path` aside as <path>.corrupt-<ms> (0600, fsynced). Returns the kept file's name, or null. */
export function keepAside(path: string, now: number): string | null {
  const dest = `${path}${CORRUPT}${now}`;
  try {
    copyFileSync(path, dest);
    chmodSync(dest, 0o600);
    const fd = openSync(dest, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    fsyncDir(dirname(path));
    return basename(dest);
  } catch {
    return null;
  }
}

// ---- accounts.json ---------------------------------------------------------------

export interface AccountsFile { records: RecordRow[]; kimiAliases: KimiAliases; badRecords: number; legacyAttempts: unknown[] | null }

/** Reads accounts.json row by row. Unreadable: copied aside, and polling starts over (null). */
export function readAccountsFile(path: string, now: number): AccountsFile | null {
  if (!existsSync(path)) return null;
  let shape: z.infer<typeof AccountsShape>;
  try {
    const p = AccountsShape.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!p.success) throw new Error("shape");
    shape = p.data;
  } catch {
    keepAside(path, now);
    return null;
  }
  const rows = shape.records.map((r) => RecordRow.safeParse(r));
  const records = rows.flatMap((r) => (r.success ? [r.data] : [])).sort((a, b) => b.last_seen - a.last_seen).slice(0, MAX_RECORDS);
  const aliases = KimiAliases.safeParse(shape.kimi_aliases ?? {});
  return {
    records, kimiAliases: aliases.success ? aliases.data : {}, badRecords: rows.length - rows.filter((r) => r.success).length,
    legacyAttempts: shape.reset_attempts ?? null,
  };
}

export function writeAccountsFile(path: string, records: readonly RecordRow[], kimiAliases: KimiAliases): void {
  writeDurable(path, JSON.stringify({ version: 1, records: records.slice(0, MAX_RECORDS), kimi_aliases: kimiAliases }) + "\n");
}

// ---- reset-attempts.json ---------------------------------------------------------

export interface LedgerFile {
  attemptRows: unknown[];
  holds: Map<string, HoldRow>;
  keychainBlockedUntil: number;
  recovery: Recovery | null;
}

export type LedgerRead =
  | { kind: "none" }
  | { kind: "ok"; ledger: LedgerFile }
  /** Unreadable: copied aside (`kept`); the original stays until a recovery marker is written over it. */
  | { kind: "unreadable"; kept: string | null };

export function readLedgerFile(path: string, now: number): LedgerRead {
  if (!existsSync(path)) return { kind: "none" };
  try {
    const p = LedgerShape.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!p.success) throw new Error("shape");
    const holds = new Map<string, HoldRow>();
    for (const [id, raw] of Object.entries(p.data.holds)) {
      const h = HoldRow.safeParse(raw);
      if (h.success && /^[0-9a-f]{24}$/.test(id)) holds.set(id, h.data);
    }
    return { kind: "ok", ledger: { attemptRows: p.data.attempts, holds, keychainBlockedUntil: p.data.keychain_blocked_until ?? 0, recovery: p.data.recovery ?? null } };
  } catch {
    return { kind: "unreadable", kept: keepAside(path, now) };
  }
}

export function writeLedgerFile(path: string, d: { attemptRows: unknown[]; holds: ReadonlyMap<string, HoldRow>; keychainBlockedUntil: number; recovery: Recovery | null }): void {
  writeDurable(path, JSON.stringify({
    version: 1, attempts: d.attemptRows, holds: Object.fromEntries(d.holds),
    ...(d.keychainBlockedUntil ? { keychain_blocked_until: d.keychainBlockedUntil } : {}),
    recovery: d.recovery,
  }) + "\n");
}

/** Copies of an unreadable ledger nobody has confirmed yet (`reset-attempts.json.corrupt-<ms>`, not `.checked`). */
export function leftoverCorrupt(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.startsWith(`${LEDGER_FILE}${CORRUPT}`) && !f.endsWith(".checked")).sort();
  } catch {
    return [];
  }
}

/** A person confirmed they checked usage: the leftover copies are renamed `<name>.checked` (kept, no longer blocking). */
export function markCorruptChecked(dir: string): void {
  for (const f of leftoverCorrupt(dir)) renameSync(join(dir, f), join(dir, `${f}.checked`));
  fsyncDir(dir);
}
