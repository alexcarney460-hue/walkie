// Where the vault's data key lives (ACCOUNTS-2). One random 32-byte key per vault, never in vault.db itself:
//   macOS:        a generic password in the login Keychain (service "walkie-vault", account = the vault id), written
//                 and read with /usr/bin/security. The key goes in on stdin (`security -i`), never on a command line,
//                 and because /usr/bin/security created the item it reads it back without a prompt (the daemon too).
//   Linux:        a key an earlier version stored in libsecret (`secret-tool`) is still read; a NEW key goes to the
//                 file below (secret-tool cannot store create-only: round 4).
//   Linux / WSL:  otherwise a 0600 file next to the vault (~/.walkie/vault.key), with a warning: anyone who can read
//                 your files can read the vault. Also what WALKIE_VAULT_KEYSTORE=file selects (tests, headless boxes).
// Every call has a hard deadline; a keystore that does not answer is an error, never a hang.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const KEYCHAIN_SERVICE = "walkie-vault";
const KEY_RE = /^[0-9a-f]{64}$/;
const DEADLINE_MS = 5_000;

export interface KeyStore {
  /** "keychain" | "libsecret" | "file" (shown by `walkie accounts vault`). */
  readonly kind: "keychain" | "libsecret" | "file";
  /** The key for this vault id, or null when none is stored yet. Throws when the store cannot be read. */
  get(vaultId: string): Promise<Buffer | null>;
  /**
   * Stores the key only if none is stored yet (round 3, Codex 5: create-only, so a writer that outlived its claim can
   * never replace a key another process already sealed tokens with). "exists" = one was there. Throws on failure.
   */
  put(vaultId: string, key: Buffer): Promise<"created" | "exists">;
  /** A warning to print when the key is protected by file permissions only. */
  readonly warning?: string;
}

interface Out { code: number; stdout: string }

/** Runs a fixed tool with an optional stdin payload, a minimal environment and a hard deadline. */
async function run(argv: string[], input: string | null, env: Record<string, string>): Promise<Out> {
  const proc = Bun.spawn(argv, { stdin: input === null ? "ignore" : "pipe", stdout: "pipe", stderr: "ignore", env });
  if (input !== null && proc.stdin && typeof proc.stdin !== "number") {
    proc.stdin.write(input);
    await proc.stdin.end();
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), DEADLINE_MS); });
  const done = (async () => ({ stdout: await new Response(proc.stdout).text(), code: await proc.exited }))();
  const res = await Promise.race([done, late]);
  clearTimeout(timer);
  if (res === "timeout") {
    try { proc.kill("SIGKILL"); } catch { /* gone */ }
    throw new Error(`${argv[0]} did not answer in time (is the keychain locked?)`);
  }
  return res;
}

function parseKey(s: string): Buffer | null {
  const t = s.trim().toLowerCase();
  return KEY_RE.test(t) ? Buffer.from(t, "hex") : null;
}

function minimalEnv(home: string): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/local/bin", LC_ALL: "C", HOME: home };
  for (const k of ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "DISPLAY"]) if (process.env[k]) env[k] = process.env[k] as string;
  return env;
}

/** A value `security -i` reads as one argument (hex keys and vault ids only; anything else is refused). */
function safeWord(s: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(s)) throw new Error("invalid keystore name");
  return s;
}

export function macKeychain(home: string, tool = "/usr/bin/security"): KeyStore {
  return {
    kind: "keychain",
    async get(vaultId) {
      const r = await run([tool, "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", safeWord(vaultId), "-w"], null, minimalEnv(home));
      if (r.code === 44) return null; // errSecItemNotFound
      if (r.code !== 0) throw new Error(`Keychain read failed (security exit ${r.code})`);
      const key = parseKey(r.stdout);
      if (!key) throw new Error("the Keychain item walkie-vault does not hold a vault key");
      return key;
    },
    async put(vaultId, key) {
      // No -U: an existing item is never replaced (errSecDuplicateItem). The key travels on stdin, never in argv.
      const line = `add-generic-password -s ${KEYCHAIN_SERVICE} -a ${safeWord(vaultId)} -l ${KEYCHAIN_SERVICE} -w ${safeWord(key.toString("hex"))}\n`;
      const r = await run([tool, "-i"], line, minimalEnv(home));
      const back = await this.get(vaultId);
      if (back && !back.equals(key)) return "exists";
      if (r.code !== 0 || !back) throw new Error(`Keychain write failed (security exit ${r.code})`);
      return "created";
    },
  };
}

export function libsecret(home: string, tool = "secret-tool"): KeyStore {
  return {
    kind: "libsecret",
    async get(vaultId) {
      const r = await run([tool, "lookup", "service", KEYCHAIN_SERVICE, "account", safeWord(vaultId)], null, minimalEnv(home));
      if (r.code !== 0 && !r.stdout.trim()) return null;
      const key = parseKey(r.stdout);
      if (!key) throw new Error("the libsecret item walkie-vault does not hold a vault key");
      return key;
    },
    // secret-tool has no create-only store (round 4, Codex 5): a new key is never written here — the vault puts it in
    // the 0600 file instead (vault.ts). Only keys an earlier version stored are read.
    async put() {
      throw new Error("libsecret cannot store a key create-only");
    },
  };
}

export function fileKeyStore(walkieHome: string, why?: string): KeyStore {
  const path = join(walkieHome, "vault.key");
  return {
    kind: "file",
    warning: `${why ? `${why}: ` : ""}the vault key is a 0600 file (${path}): anyone who can read your files can read the vault`,
    async get() {
      if (!existsSync(path)) return null;
      const key = parseKey(readFileSync(path, "utf8"));
      if (!key) throw new Error(`${path} does not hold a vault key`);
      return key;
    },
    async put(_vaultId, key) {
      try {
        writeFileSync(path, key.toString("hex") + "\n", { mode: 0o600, flag: "wx" }); // create-only
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
        throw err;
      }
      chmodSync(path, 0o600);
      return "created";
    },
  };
}

/** Whether a secret service answers (secret-tool installed and a collection unlocked). */
async function libsecretWorks(home: string): Promise<boolean> {
  if (!Bun.which("secret-tool")) return false;
  try {
    await run(["secret-tool", "lookup", "service", KEYCHAIN_SERVICE, "account", "probe"], null, minimalEnv(home));
    return !!process.env.DBUS_SESSION_BUS_ADDRESS;
  } catch {
    return false;
  }
}

/** The key store for this machine: WALKIE_VAULT_KEYSTORE=file|keychain|libsecret overrides the platform default. */
export async function defaultKeyStore(walkieHome: string, home: string, env: NodeJS.ProcessEnv = process.env): Promise<KeyStore> {
  const want = env.WALKIE_VAULT_KEYSTORE;
  if (want === "file") return fileKeyStore(walkieHome);
  if (want === "keychain" || (!want && process.platform === "darwin")) return macKeychain(home);
  // A key already in a file stays there (a later secret service must not orphan the vault) — also when libsecret is
  // asked for: a new key never goes to libsecret, it goes to that file (round 5, Codex 8: found again on reopening).
  if (existsSync(join(walkieHome, "vault.key"))) return fileKeyStore(walkieHome);
  if (want === "libsecret") return libsecret(home);
  return (await libsecretWorks(home)) ? libsecret(home) : fileKeyStore(walkieHome);
}
