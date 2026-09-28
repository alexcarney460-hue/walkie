// The per-owner account vault (ACCOUNTS-2): ~/.walkie/vault.db, on this machine only (never replicated, never in an
// event, never in a snapshot). It holds the logins `walkie claude` / `walkie codex` switch between:
//   claude: a `claude setup-token` one-year token, sealed with AES-256-GCM (seal.ts) under a data key kept in the OS
//           key store (keystore.ts). Walkie never refreshes it (a setup-token has no refresh token).
//   codex:  a dedicated CODEX_HOME directory (~/.walkie/vault/codex/<id>, 0700) that `codex login` wrote its own
//           auth.json into; Codex refreshes that login itself, one refresher per login. Nothing secret is in the db.
// Labels are the controlled ones of protocol/accounts.ts (a masked email or a provider label), never a full email.
// Adding, removing and changing a policy are for people only (the CLI refuses agents); reading a token is
// in-process only (the wrapper, `walkie accounts exec`, and the daemon's usage poll / owner-checked hand-out).
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { isAccountLabel, PLAN_RE } from "../../protocol/accounts.ts";
import { defaultKeyStore, fileKeyStore, type KeyStore } from "./keystore.ts";
import { aadFor, openAtRest, sealAtRest } from "./seal.ts";
import { codexAccessOnly, codexLeaseCopy, type CodexAccess } from "./codex-access.ts";

export const VAULT_PROVIDERS = ["claude", "codex"] as const;
export type VaultProvider = (typeof VAULT_PROVIDERS)[number];
/**
 * local = this machine only (default) · own = also the owner's other machines · shared = also named teammates. The
 * company pool is not a policy: it is a TEAM setting (`walkie accounts pool on`, off by default) that lends every login
 * not marked personal to every member's machines while it is on (COMPANY POOL, pool.ts).
 */
export const POLICIES = ["local", "own", "shared"] as const;
export type Policy = (typeof POLICIES)[number];
export const MAX_VAULT_ACCOUNTS = 16;
export const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
/** A `claude setup-token` token (the one-year OAuth token). API keys and browser-login tokens are refused. */
export const SETUP_TOKEN_RE = /^sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]{16,1024}$/;
/** Setup-tokens last one year; the vault warns this long before. */
export const SETUP_TOKEN_TTL_MS = 365 * 86_400_000;

export interface VaultEntry {
  id: string;
  provider: VaultProvider;
  label: string;
  plan: string | null;
  policy: Policy;
  /** shared: the teammates' handles it may be handed to. */
  share_with: string[];
  created_at: number;
  /** claude: when the setup-token runs out (approximate: a year from when it was added). */
  expires_at: number | null;
  /** codex: the account's CODEX_HOME. */
  home: string | null;
  /** The id is a real account id (the same account's browser login, metered elsewhere, shares it). */
  linked: boolean;
  /** This stored credential's generation (new on every add): marks name the generation they are about. */
  gen: string;
  /** COMPANY POOL: since when this machine is the account's home (its lender): when added, or promoted. */
  home_at: number;
  /** COMPANY POOL: its person keeps it out of the company pool (`walkie accounts personal`); its policy still applies. */
  personal: boolean;
}

const Row = z.object({
  id: z.string().regex(/^[0-9a-f]{24}$/), provider: z.enum(VAULT_PROVIDERS), label: z.string(), plan: z.string().nullable(),
  policy: z.enum(POLICIES), share_with: z.string(), created_at: z.number(), expires_at: z.number().nullable(),
  home: z.string().nullable(), linked: z.number(), gen: z.string(), home_at: z.number().nullable(), personal: z.number(),
});

export function walkieHomeDir(): string {
  return process.env.WALKIE_HOME ?? join(homedir(), ".walkie");
}

/**
 * Creates a private directory (0700). An existing directory keeps its mode (WALKIE_HOME might point somewhere shared by
 * mistake; the vault's own files are 0600 either way), except the directories Walkie itself owns under it.
 */
export function privateDir(path: string, tighten = false): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = statSync(path);
  if (!st.isDirectory()) throw new Error(`${path} is not a directory`);
  if (tighten && (st.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

export function validLabel(label: string): boolean {
  return isAccountLabel(label);
}

export class Vault {
  private keys: KeyStore | null = null;

  private constructor(
    private readonly db: Database,
    readonly vaultId: string,
    readonly path: string,
    private readonly keyStoreFactory: () => Promise<KeyStore>,
  ) {}

  /** The key store (resolved on first use). */
  async keyStore(): Promise<KeyStore> {
    this.keys ??= await this.keyStoreFactory();
    return this.keys;
  }

  /** Opens (creating) the vault in a walkie home. The key store is only touched when a secret is sealed or opened. */
  static open(walkieHome = walkieHomeDir(), opts: { keystore?: KeyStore; home?: string } = {}): Vault {
    privateDir(walkieHome);
    const path = join(walkieHome, "vault.db");
    const fresh = !existsSync(path);
    const db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=3000;");
    db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, plan TEXT, policy TEXT NOT NULL DEFAULT 'local',
        share_with TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, expires_at INTEGER, secret BLOB, home TEXT,
        linked INTEGER NOT NULL DEFAULT 0);`);
    // Round 1 (Codex 9): a credential generation per stored login, so marks about an older credential never apply.
    const cols = (db.query("PRAGMA table_info(accounts)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("gen")) db.exec("ALTER TABLE accounts ADD COLUMN gen TEXT NOT NULL DEFAULT ''");
    // COMPANY POOL: when this machine became the login's home (null = when it was added).
    if (!cols.includes("home_at")) db.exec("ALTER TABLE accounts ADD COLUMN home_at INTEGER");
    // COMPANY POOL: its person keeps it out of the pool (nothing is pooled unless the team turns the pool on).
    if (!cols.includes("personal")) db.exec("ALTER TABLE accounts ADD COLUMN personal INTEGER NOT NULL DEFAULT 0");
    let id = (db.query("SELECT v FROM meta WHERE k = 'vault_id'").get() as { v: string } | null)?.v;
    if (!id) {
      id = randomBytes(12).toString("hex");
      db.query("INSERT OR IGNORE INTO meta (k, v) VALUES ('vault_id', ?)").run(id);
      id = (db.query("SELECT v FROM meta WHERE k = 'vault_id'").get() as { v: string }).v;
    }
    if (fresh) chmodSync(path, 0o600);
    const given = opts.keystore;
    return new Vault(db, id, path, given ? async () => given : () => defaultKeyStore(walkieHome, opts.home ?? homedir()));
  }

  /** Whether a vault exists in this walkie home, without creating one (the shims' fast path). */
  static exists(walkieHome = walkieHomeDir()): boolean {
    return existsSync(join(walkieHome, "vault.db"));
  }

  close(): void { this.db.close(); }

  list(): VaultEntry[] {
    const rows = this.db.query("SELECT id, provider, label, plan, policy, share_with, created_at, expires_at, home, linked, gen, home_at, personal FROM accounts ORDER BY created_at").all();
    return rows.flatMap((r) => {
      const p = Row.safeParse(r);
      if (!p.success) return [];
      const d = p.data;
      let share: string[] = [];
      try { share = (JSON.parse(d.share_with) as unknown[]).filter((h): h is string => typeof h === "string" && HANDLE_RE.test(h)); } catch { /* none */ }
      return [{
        id: d.id, provider: d.provider, label: validLabel(d.label) ? d.label : d.provider === "claude" ? "Claude account" : "ChatGPT account",
        plan: d.plan && PLAN_RE.test(d.plan) ? d.plan : null, policy: d.policy, share_with: share, created_at: d.created_at,
        expires_at: d.expires_at, home: d.home, linked: d.linked === 1, gen: d.gen, home_at: d.home_at ?? d.created_at, personal: d.personal === 1,
      }];
    });
  }

  get(id: string): VaultEntry | null {
    return this.list().find((e) => e.id === id) ?? null;
  }

  private checkRoom(id: string): void {
    if (this.get(id)) throw new Error("that account is already in the vault");
    if (this.list().length >= MAX_VAULT_ACCOUNTS) throw new Error(`the vault holds at most ${MAX_VAULT_ACCOUNTS} accounts`);
  }

  /** Sealed tokens in the vault (a new key would orphan them). */
  sealedCount(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM accounts WHERE secret IS NOT NULL").get() as { n: number }).n;
  }

  private missingKey(kind: string): Error {
    const n = this.sealedCount();
    return new Error(`the vault key is missing from the ${kind} key store${n ? ` while ${n} sealed token${n === 1 ? "" : "s"} exist` : ""}. `
      + "Walkie will not make a new key that would orphan them: restore the key (Keychain item \"walkie-vault\", or ~/.walkie/vault.key), "
      + "or remove those accounts (walkie accounts remove <account>) and add them again.");
  }

  /**
   * The data key. A new one is made only for a vault with no sealed token yet, under an exclusive lock file so two
   * first `add`s in parallel cannot each make one (round 1, Codex 8 / Opus 5); a key that went missing while tokens
   * exist is an error with the recovery steps, never silently replaced.
   */
  private async key(create: boolean): Promise<Buffer> {
    const keys = await this.keyStore();
    const k = await keys.get(this.vaultId);
    if (k) return k;
    if (!create || this.sealedCount() > 0) throw this.missingKey(keys.kind);
    return this.createKeyOnce(keys);
  }

  /**
   * First-key creation, serialized with an ownership-safe claim (round 2, Codex 6 / Opus 9): a `key_claim` row
   * (pid:nonce) taken in a short SQLite write transaction. Only its holder makes the key; a claim is taken over only
   * when its process is gone, and only by compare-and-swap on the exact value seen (two contenders cannot both take
   * it); releasing deletes the row only while it still holds our nonce. The others wait for the key to appear.
   */
  private async createKeyOnce(initial: KeyStore): Promise<Buffer> {
    let keys = initial;
    const mine = `${process.pid}:${randomBytes(8).toString("hex")}`;
    const end = Date.now() + 20_000;
    for (;;) {
      if (this.claimKey(mine)) {
        try {
          // Round 4 (Codex 5): secret-tool cannot store create-only, so a stale writer could replace a published key.
          // A NEW key never goes to libsecret: it goes to the 0600 file (create-only), which the key store selection
          // then keeps using for this vault. An existing libsecret key keeps working.
          if (keys.kind === "libsecret") {
            keys = fileKeyStore(dirname(this.path), "libsecret cannot store a new key create-only, so the vault key is a 0600 file");
            this.keys = keys;
          }
          const again = await keys.get(this.vaultId);
          if (again) return again;
          if (this.sealedCount() > 0) throw this.missingKey(keys.kind);
          const fresh = randomBytes(32);
          await keys.put(this.vaultId, fresh);
          // Whatever the store holds now is THE key (ours, or one written first — create-only never replaces it).
          const stored = await keys.get(this.vaultId);
          if (!stored) throw new Error("the vault key could not be read back from the key store");
          return stored;
        } finally {
          this.db.query("DELETE FROM meta WHERE k = 'key_claim' AND v = ?").run(mine);
        }
      }
      await Bun.sleep(100);
      const k = await keys.get(this.vaultId);
      if (k) return k;
      if (Date.now() > end) throw new Error("another walkie is still setting up the vault key; try again");
    }
  }

  /** Takes the key-creation claim: free, or held by a process that no longer exists (compare-and-swap). */
  private claimKey(mine: string): boolean {
    const tx = this.db.transaction((): boolean => {
      const row = this.db.query("SELECT v FROM meta WHERE k = 'key_claim'").get() as { v: string } | null;
      if (!row) { this.db.query("INSERT INTO meta (k, v) VALUES ('key_claim', ?)").run(mine); return true; }
      const pid = Number(row.v.split(":")[0]);
      let alive = true;
      try { process.kill(pid, 0); } catch (err) { alive = (err as NodeJS.ErrnoException).code === "EPERM"; }
      if (alive) return false;
      return this.db.query("UPDATE meta SET v = ? WHERE k = 'key_claim' AND v = ?").run(mine, row.v).changes === 1;
    });
    return tx.immediate();
  }

  async addClaude(a: { id: string; label: string; plan: string | null; token: string; linked: boolean; now?: number }): Promise<VaultEntry> {
    if (!SETUP_TOKEN_RE.test(a.token)) throw new Error("that is not a `claude setup-token` token (it starts with sk-ant-oat)");
    if (!validLabel(a.label)) throw new Error("invalid account label");
    this.checkRoom(a.id);
    const now = a.now ?? Date.now();
    const blob = sealAtRest(await this.key(true), a.token, aadFor(this.vaultId, a.id, "claude"));
    this.db.query("INSERT INTO accounts (id, provider, label, plan, policy, share_with, created_at, expires_at, secret, home, linked, gen) VALUES (?, 'claude', ?, ?, 'local', '[]', ?, ?, ?, NULL, ?, ?)")
      .run(a.id, a.label, a.plan && PLAN_RE.test(a.plan) ? a.plan : null, now, now + SETUP_TOKEN_TTL_MS, blob, a.linked ? 1 : 0, randomBytes(8).toString("hex"));
    return this.get(a.id) as VaultEntry;
  }

  addCodex(a: { id: string; label: string; plan: string | null; home: string; now?: number }): VaultEntry {
    if (!validLabel(a.label)) throw new Error("invalid account label");
    this.checkRoom(a.id);
    this.db.query("INSERT INTO accounts (id, provider, label, plan, policy, share_with, created_at, expires_at, secret, home, linked, gen) VALUES (?, 'codex', ?, ?, 'local', '[]', ?, NULL, NULL, ?, 1, ?)")
      .run(a.id, a.label, a.plan && PLAN_RE.test(a.plan) ? a.plan : null, a.now ?? Date.now(), a.home, randomBytes(8).toString("hex"));
    return this.get(a.id) as VaultEntry;
  }

  remove(id: string): VaultEntry | null {
    const e = this.get(id);
    if (!e) return null;
    this.db.query("DELETE FROM accounts WHERE id = ?").run(id);
    return e;
  }

  setPolicy(id: string, policy: Policy, shareWith: readonly string[] = []): VaultEntry {
    const e = this.get(id);
    if (!e) throw new Error("no such account in the vault");
    // COMPANY POOL: a Codex login may be lent too — as an access-only lease (codex-access.ts); its refresh token never
    // leaves this machine, so this machine stays its only refresher.
    const share = policy === "shared" ? [...new Set(shareWith)] : [];
    if (share.some((h) => !HANDLE_RE.test(h))) throw new Error("--with takes teammates' handles (a,b)");
    if (policy === "shared" && !share.length) throw new Error("shared needs --with <handle,…>");
    this.db.query("UPDATE accounts SET policy = ?, share_with = ? WHERE id = ?").run(policy, JSON.stringify(share), id);
    return this.get(id) as VaultEntry;
  }

  // ---- company pool ---------------------------------------------------------------------------

  /** COMPANY POOL: its person keeps it out of the pool (true) or lets the pool have it again (false). */
  setPersonal(id: string, personal: boolean): VaultEntry {
    if (!this.get(id)) throw new Error("no such account in the vault");
    this.db.query("UPDATE accounts SET personal = ? WHERE id = ?").run(personal ? 1 : 0, id);
    return this.get(id) as VaultEntry;
  }

  /**
   * Makes this machine the login's home (COMPANY POOL promotion): borrowers lease from the online holder with the
   * newest home_at. This machine's login is its own (added here), so two holders never share one refresh token.
   */
  promote(id: string, now = Date.now()): VaultEntry {
    if (!this.get(id)) throw new Error("no such account in the vault");
    this.db.query("UPDATE accounts SET home_at = ? WHERE id = ?").run(now, id);
    return this.get(id) as VaultEntry;
  }

  /**
   * The lease copy of a vault Codex login (codex-access.ts codexLeaseCopy: never its refresh token or email): null when
   * its access token's expiry cannot be read or it runs out within the lease minimum (this machine renews it, below).
   */
  codexAccess(id: string, now = Date.now()): CodexAccess | null {
    const text = this.codexAuthText(id);
    return text === null ? null : codexLeaseCopy(text, now);
  }

  /** When a vault Codex login's access token runs out (its JWT exp), or null when unreadable (renewal planning). */
  codexExpiry(id: string): number | null {
    const text = this.codexAuthText(id);
    return text === null ? null : codexAccessOnly(text)?.expiresAt ?? null;
  }

  private codexAuthText(id: string): string | null {
    const e = this.get(id);
    if (!e || e.provider !== "codex" || !e.home) return null;
    const file = join(e.home, "auth.json");
    try {
      const st = statSync(file);
      if (!st.isFile() || st.size > 64 * 1024) return null;
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  /** The Claude setup-token, decrypted in memory for one launch / one request. Never logged, never stored elsewhere. */
  async claudeToken(id: string): Promise<string> {
    const row = this.db.query("SELECT secret FROM accounts WHERE id = ? AND provider = 'claude'").get(id) as { secret: Uint8Array | null } | null;
    if (!row?.secret) throw new Error("no Claude token for that account in the vault");
    return openAtRest(await this.key(false), row.secret, aadFor(this.vaultId, id, "claude"));
  }
}

