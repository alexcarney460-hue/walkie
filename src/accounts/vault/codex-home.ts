// A vault Codex account's CODEX_HOME (ACCOUNTS-2): ~/.walkie/vault/codex/<id>/, 0700. Only auth.json is the account's
// own (written by `codex login`, refreshed by Codex itself). The user's own CODEX_HOME is shared: sessions/ (so `codex
// resume <id>` finds a session started on another account), history, AGENTS.md, skills, … are symlinks back to it,
// re-linked before every launch. An entry Codex replaced with a real file is left alone (never clobbered). Removing the
// home unlinks the symlinks; it never follows them.
// Round 5 (Codex 1): two entries are NOT linked, because they could route the vault account's requests elsewhere:
//   · config.toml is a Walkie-managed COPY of the user's, rewritten before every launch with every provider / base-URL
//     key removed (model_provider, model_providers, chatgpt_base_url, openai_base_url — at the top level and in
//     profiles); the result is parsed and checked, and a config that cannot be cleaned means no credentials. Project
//     trust decisions Codex writes into the copy are carried back to the user's own config.toml.
//   · .env (Codex loads $CODEX_HOME/.env into its own environment) is never linked or copied.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { privateDir } from "./vault.ts";

/** Names that belong to one account and are never linked. */
const OWN = /^(?:auth\.json.*|\.credentials\.json.*)$/;
/** Names never linked into an account home (round 5): config is a cleaned copy, .env files are left out. */
// Round 7 (Opus r6 HIGH): every TOML file, not only config.toml — Codex 0.156 profiles are `<name>.config.toml`
// files next to it (`-p work` loads work.config.toml), and any of them can name a provider.
const NEVER_LINK = /^(?:[^/]*\.toml(?:\..*)?|\.env.*|agents|walkie-agent-configs)$/;
/** The TOML files of the user's CODEX_HOME that get a cleaned copy (config.toml, profiles, any other *.toml). */
const COPIED_TOML = /^[A-Za-z0-9._-]+\.toml$/;
const MANAGED_PREFIX = "# walkie-managed: a copy of your Codex ";
/** First line of the managed copy (how removal and re-sync recognise it). */
export const MANAGED_CONFIG_MARK = "# walkie-managed: a copy of your Codex config.toml with provider / base-URL keys removed (edit the original)";
/** Keys that choose where Codex sends requests (and so the account's tokens). */
const ROUTING_KEYS = new Set([
  "model_provider", "model_providers", "chatgpt_base_url", "openai_base_url",
  // Round 7 (Codex r6 1): the voice (realtime) endpoints and the thread store endpoint carry the account's auth too.
  "experimental_realtime_ws_base_url", "experimental_realtime_webrtc_call_base_url", "experimental_thread_store_endpoint",
]);

export function vaultCodexRoot(walkieHome: string): string {
  return join(walkieHome, "vault", "codex");
}

/** The user's own CODEX_HOME: $CODEX_HOME unless that is one of our account homes, else ~/.codex. */
export function codexBaseHome(walkieHome: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const set = env.CODEX_HOME && env.CODEX_HOME.startsWith("/") ? resolve(env.CODEX_HOME) : null;
  if (set && !isVaultCodexHome(set, walkieHome)) return set;
  return join(home, ".codex");
}

export function isVaultCodexHome(dir: string, walkieHome: string): boolean {
  const root = resolve(vaultCodexRoot(walkieHome)) + sep;
  return resolve(dir).startsWith(root);
}

/**
 * Entries every account home must share with the user's own CODEX_HOME. They are created in the base first (round 1,
 * Opus 1): on a fresh ~/.codex, Codex would otherwise create them as real directories inside the account home, and
 * `codex resume <id>` on another account would not find the session.
 */
export const SHARED_DIRS = ["sessions", "archived_sessions", "log"] as const;
export const SHARED_FILES = ["config.toml", "history.jsonl"] as const;

function ensureBase(baseHome: string): void {
  if (!existsSync(baseHome)) mkdirSync(baseHome, { recursive: true, mode: 0o700 });
  for (const d of SHARED_DIRS) if (!existsSync(join(baseHome, d))) mkdirSync(join(baseHome, d), { recursive: true, mode: 0o700 });
  for (const f of SHARED_FILES) if (!existsSync(join(baseHome, f))) writeFileSync(join(baseHome, f), "", { mode: 0o600 });
}

/** Links every entry of the base home that the account home does not have (except the account's own files). */
export function syncCodexHome(accountHome: string, baseHome: string): { linked: string[]; kept: string[] } {
  privateDir(accountHome, true);
  ensureBase(baseHome);
  const linked: string[] = [];
  const kept: string[] = [];
  // Round 5: an older version's links to config.toml / .env are removed; the cleaned config is written instead.
  for (const name of readdirSync(accountHome)) {
    if (NEVER_LINK.test(name) && isLink(join(accountHome, name))) unlinkSync(join(accountHome, name));
  }
  writeManagedConfig(accountHome, baseHome);
  writeManagedProfiles(accountHome, baseHome);
  writeManagedAgentsDir(accountHome, baseHome);
  for (const name of readdirSync(baseHome)) {
    if (OWN.test(name) || NEVER_LINK.test(name)) continue;
    const at = join(accountHome, name);
    let st: ReturnType<typeof lstatSync> | null = null;
    try { st = lstatSync(at); } catch { /* missing */ }
    if (st && !st.isSymbolicLink()) { kept.push(name); continue; }
    if (st) continue; // already a link
    try { symlinkSync(join(baseHome, name), at); linked.push(name); } catch { /* raced: next launch */ }
  }
  return { linked, kept };
}

/**
 * The user's config.toml without routing keys (round 5). Line-based: keys named in ROUTING_KEYS (dotted forms too, at
 * the top level or in any table such as a profile) and whole [model_providers…] tables are dropped; the result must
 * parse and hold none of those keys anywhere, else this throws (the caller then gives the session no credentials).
 */
export function sanitizeCodexConfig(text: string): string {
  const out: string[] = [];
  let dropTable = false;
  for (const line of text.split("\n")) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      const path = (header[1] as string).split(".").map((x) => x.trim().replace(/^["']|["']$/g, ""));
      dropTable = path.some((seg) => ROUTING_KEYS.has(seg));
      if (!dropTable) out.push(line);
      continue;
    }
    if (dropTable) continue;
    const kv = /^\s*([A-Za-z0-9_."'-]+?)\s*=\s*(.*)$/.exec(line);
    if (kv) {
      const segs = (kv[1] as string).split(".").map((x) => x.trim().replace(/^["']|["']$/g, ""));
      if (segs.some((seg) => ROUTING_KEYS.has(seg))) {
        const v = (kv[2] as string).trim();
        // A value spanning lines cannot be dropped safely line by line: refuse.
        if (v.startsWith('"""') || v.startsWith("'''") || (/^[[{]/.test(v) && !balanced(v))) {
          throw new Error("the Codex config has a provider setting this cannot remove safely");
        }
        continue;
      }
    }
    out.push(line);
  }
  const clean = out.join("\n");
  let parsed: unknown;
  try { parsed = Bun.TOML.parse(clean); } catch (err) { throw new Error(`the Codex config does not parse (${(err as Error).message.slice(0, 80)})`); }
  if (hasRoutingKey(parsed)) throw new Error("the Codex config still names a provider or base URL after cleaning");
  return clean;
}

function balanced(v: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (const ch of v) {
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "#") break;
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
  }
  return depth === 0 && !quote;
}

function hasRoutingKey(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasRoutingKey);
  if (!v || typeof v !== "object") return false;
  return Object.entries(v as Record<string, unknown>).some(([k, x]) => ROUTING_KEYS.has(k) || hasRoutingKey(x));
}

/** `[projects."<path>"]` blocks of a config (Codex's trust decisions), by header line. */
function projectBlocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>();
  let cur: string | null = null;
  let buf: string[] = [];
  const flush = () => { if (cur) blocks.set(cur, buf.join("\n").replace(/\s+$/, "")); };
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) {
      flush();
      cur = /^\s*\[projects\.("[^"]*"|'[^']*'|[A-Za-z0-9_-]+)\]\s*$/.test(line) ? line.trim() : null;
      buf = cur ? [line] : [];
      continue;
    }
    if (cur) buf.push(line);
  }
  flush();
  return blocks;
}

/** Writes the cleaned copy of the user's config.toml into an account home (carrying back new project trust first). */
export function writeManagedConfig(accountHome: string, baseHome: string): void {
  const basePath = join(baseHome, "config.toml");
  const mine = join(accountHome, "config.toml");
  let base = existsSync(basePath) ? readFileSync(basePath, "utf8") : "";
  if (existsSync(mine) && !isLink(mine)) {
    const current = readFileSync(mine, "utf8");
    if (current.startsWith(MANAGED_CONFIG_MARK)) {
      const known = projectBlocks(base);
      const fresh = [...projectBlocks(current)].filter(([h]) => !known.has(h)).map(([, b]) => b);
      if (fresh.length && existsSync(basePath)) {
        base = `${base.replace(/\n*$/, "\n")}\n${fresh.join("\n\n")}\n`;
        writeFileSync(basePath, base);
      }
    }
  }
  const clean = managedToml(base, baseHome, accountHome);
  writeFileSync(mine, `${MANAGED_CONFIG_MARK}\n${clean}`, { mode: 0o600 });
  chmodSync(mine, 0o600);
}

/**
 * Cleaned copies of every other TOML file of the user's CODEX_HOME (round 7: profiles are `<name>.config.toml`), with
 * the same sanitizer; a copy whose original is gone is removed. A file that cannot be cleaned throws (no credentials).
 */
export function writeManagedProfiles(accountHome: string, baseHome: string): string[] {
  const written: string[] = [];
  const names = existsSync(baseHome) ? readdirSync(baseHome).filter((n) => COPIED_TOML.test(n) && n !== "config.toml") : [];
  for (const name of names) {
    const src = join(baseHome, name);
    try { if (!statSync(src).isFile()) continue; } catch { continue; }
    const clean = managedToml(readFileSync(src, "utf8"), baseHome, accountHome);
    const mine = join(accountHome, name);
    if (isLink(mine)) unlinkSync(mine);
    writeFileSync(mine, `${MANAGED_PREFIX}${name} with provider / base-URL keys removed (edit the original)\n${clean}`, { mode: 0o600 });
    chmodSync(mine, 0o600);
    written.push(name);
  }
  for (const name of readdirSync(accountHome)) {
    if (!COPIED_TOML.test(name) || name === "config.toml" || names.includes(name)) continue;
    if (isManagedConfig(join(accountHome, name))) unlinkSync(join(accountHome, name));
  }
  return written;
}

/** Where the cleaned copies of sub-agent role config files go in an account home (round 8). */
export const AGENT_CONFIGS_DIR = "walkie-agent-configs";

function tomlString(v: string): string | null {
  const t = v.trim().replace(/\s+#.*$/, "");
  const basic = /^"((?:[^"\\]|\\.)*)"$/.exec(t);
  if (basic) { try { return JSON.parse(`"${basic[1]}"`) as string; } catch { return null; } }
  const literal = /^'([^']*)'$/.exec(t);
  return literal ? literal[1] as string : null;
}

/**
 * Sub-agent role configs (round 8, Opus r7): `[agents.<role>] config_file = "<path>"` names a config file loaded for that
 * role's sub-agents, which can name a provider too. Each one is cleaned (same sanitizer, and it may not name another
 * config_file) into the account home, and the line is rewritten to that copy. Written in any other form (an inline
 * table, a dotted key elsewhere), it is not rewritten here — and the check afterwards refuses it.
 */
export function rewriteAgentConfigs(text: string, baseDir: string, accountHome: string): string {
  const out: string[] = [];
  let inAgents = false;
  for (const line of text.split("\n")) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      const path = (header[1] as string).split(".").map((x) => x.trim().replace(/^["']|["']$/g, ""));
      inAgents = path[0] === "agents" && path.length === 2;
      out.push(line);
      continue;
    }
    const kv = inAgents ? /^\s*config_file\s*=\s*(.*)$/.exec(line) : null;
    if (!kv) { out.push(line); continue; }
    const raw = tomlString(kv[1] as string);
    if (raw === null) throw new Error("a sub-agent config_file is not a plain string");
    const src = isAbsolute(raw) ? raw : join(baseDir, raw.replace(/^~(?=\/)/, homedir()));
    if (!existsSync(src)) throw new Error(`the sub-agent config file ${raw} does not exist`);
    const clean = sanitizeCodexConfig(readFileSync(src, "utf8"));
    if (/config_file/.test(clean)) throw new Error(`the sub-agent config file ${raw} names another config file`);
    const dir = join(accountHome, AGENT_CONFIGS_DIR);
    privateDir(dir, true);
    const copy = join(dir, `${createHash("sha256").update(resolve(src)).digest("hex").slice(0, 16)}.toml`);
    writeFileSync(copy, `${MANAGED_PREFIX}${raw} (a sub-agent role config) with provider / base-URL keys removed (edit the original)\n${clean}`, { mode: 0o600 });
    chmodSync(copy, 0o600);
    out.push(`config_file = ${JSON.stringify(copy)}`);
  }
  return out.join("\n");
}

/** Every `config_file` a parsed config names must be one of the cleaned copies in this account home. */
export function checkAgentConfigs(parsed: unknown, accountHome: string): void {
  const allowed = join(accountHome, AGENT_CONFIGS_DIR) + "/";
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "config_file" && !(typeof x === "string" && x.startsWith(allowed))) throw new Error("a sub-agent config_file points outside the cleaned copies");
      walk(x);
    }
  };
  walk(parsed);
}

/** A cleaned copy of a user's Codex TOML for an account home: routing keys removed, role configs cleaned and checked. */
export function managedToml(text: string, baseDir: string, accountHome: string): string {
  const clean = rewriteAgentConfigs(sanitizeCodexConfig(text), baseDir, accountHome);
  checkAgentConfigs(Bun.TOML.parse(clean), accountHome);
  return clean;
}

/**
 * The user's `agents/` directory (role definitions) as real files in the account home (round 8): TOML files cleaned,
 * other regular files copied, subdirectories one level deep; never a link to the user's own.
 */
export function writeManagedAgentsDir(accountHome: string, baseHome: string): void {
  const src = join(baseHome, "agents");
  const dest = join(accountHome, "agents");
  if (isLink(dest)) unlinkSync(dest);
  if (!existsSync(src)) return;
  const copyDir = (from: string, to: string, depth: number): void => {
    privateDir(to, true);
    for (const name of readdirSync(from)) {
      const f = join(from, name);
      const t = join(to, name);
      const st = lstatSync(f);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (depth < 2) copyDir(f, t, depth + 1); continue; }
      if (!st.isFile()) continue;
      if (isLink(t)) unlinkSync(t);
      const body = name.endsWith(".toml") ? `${MANAGED_PREFIX}agents/${name} with provider / base-URL keys removed (edit the original)\n${managedToml(readFileSync(f, "utf8"), from, accountHome)}` : readFileSync(f);
      writeFileSync(t, body, { mode: 0o600 });
    }
  };
  copyDir(src, dest, 1);
}

function isManagedConfig(p: string): boolean {
  try { return p.endsWith(".toml") && !isLink(p) && readFileSync(p, "utf8").startsWith(MANAGED_PREFIX); } catch { return false; }
}

/** Where a Codex session started with this CODEX_HOME writes its rollout files (the base's, through the link). */
export function codexSessionsDir(home: string): string {
  try { return realpathSync(join(home, "sessions")); } catch { return join(home, "sessions"); }
}

/** A fresh account home for `codex login` (renamed to the account id once the login is identified). */
export function pendingCodexHome(walkieHome: string, baseHome: string): string {
  const root = vaultCodexRoot(walkieHome);
  privateDir(join(walkieHome, "vault"), true);
  privateDir(root, true);
  const dir = join(root, `pending-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { mode: 0o700 });
  syncCodexHome(dir, baseHome);
  return dir;
}

export function finalCodexHome(pending: string, walkieHome: string, id: string): string {
  if (!/^[0-9a-f]{24}$/.test(id)) throw new Error("invalid account id");
  const dest = join(vaultCodexRoot(walkieHome), id);
  if (existsSync(dest)) throw new Error("that account is already in the vault");
  renameSync(pending, dest);
  return dest;
}

/**
 * Deletes an account home (round 1, Opus 1): symlinks are unlinked (never followed) and auth.json is deleted; any
 * other REAL entry Codex wrote there is moved into the base home when the base has no entry of that name (`move`), and
 * otherwise the removal is refused with the names, so nothing of the user's is ever deleted recursively.
 */
export function removeCodexHome(dir: string, walkieHome: string, opts: { move?: boolean; baseHome?: string } = {}): { moved: string[] } {
  if (!isVaultCodexHome(dir, walkieHome)) throw new Error("refusing to delete a directory outside the vault");
  if (!existsSync(dir)) return { moved: [] };
  const names = readdirSync(dir);
  // Walkie's own cleaned copies (config files, the agents directory, role configs) are deleted with the home.
  const managedDir = (n: string) => (n === "agents" || n === AGENT_CONFIGS_DIR) && lstatSync(join(dir, n)).isDirectory();
  const real = names.filter((n) => !OWN.test(n) && !lstatSync(join(dir, n)).isSymbolicLink() && !isManagedConfig(join(dir, n)) && !managedDir(n));
  if (real.length) {
    const base = opts.baseHome;
    const clash = base ? real.filter((n) => existsSync(join(base, n))) : real;
    if (!opts.move || !base || clash.length) {
      throw new Error(`${dir} holds ${real.join(", ")} that Codex wrote there (not links). `
        + (base && !clash.length ? "Run again with --move to move them into your own CODEX_HOME, or " : "")
        + "move or delete them yourself, then remove the account again.");
    }
  }
  const moved: string[] = [];
  for (const n of real) { renameSync(join(dir, n), join(opts.baseHome as string, n)); moved.push(n); }
  for (const n of names) {
    const p = join(dir, n);
    if (!existsSync(p) && !isLink(p)) continue;
    if (!moved.includes(n) && managedDir(n)) { rmSync(p, { recursive: true, force: true }); continue; }
    unlinkSync(p); // a symlink or auth.json* (files only: real directories were moved above)
  }
  rmdirSync(dir);
  return { moved };
}

function isLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}
