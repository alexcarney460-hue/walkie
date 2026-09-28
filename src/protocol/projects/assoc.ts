// Which project (and card) an agent is working on, from what its status already says (WALKIE-PROJECTS-1). Pure: the
// daemon (MCP "who's on it", card presence) and the dashboard (agent chips, live avatars) decide the same way.
//   1. a card key (PREFIX-n) in the status task, else in the branch name: that project and card;
//   2. else the longest project path that is a prefix of the agent's working directory;
//   3. else a project path rule naming the agent's repository.
export interface AgentStatusLike { task?: string; branch?: string; repo?: string; cwd?: string }
export interface ProjectLike {
  channel: string; prefix: string; state: string;
  paths: ReadonlyArray<{ path: string } | { repo: string }>;
}
export interface Association { channel: string; key?: string; via: "key" | "path" | "repo" }

const KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g;

/** Card keys mentioned in `s`, in order. */
export function keysIn(s: string | undefined): Array<{ prefix: string; n: number; key: string }> {
  if (!s) return [];
  return [...s.toUpperCase().matchAll(KEY_RE)].map((m) => ({ prefix: m[1] as string, n: Number(m[2]), key: `${m[1]}-${Number(m[2])}` }));
}

function norm(p: string): string {
  return p.replace(/\/+$/, "");
}

/** Whether `dir` is `prefix` or inside it (both home-relative or both absolute). */
export function underPath(dir: string, prefix: string): boolean {
  const d = norm(dir);
  const p = norm(prefix);
  return !!p && (d === p || d.startsWith(p + "/"));
}

/**
 * The agent's project. `hasCard(channel, n)` says whether that project has card n (a key naming no card still
 * associates the project, without the card). `cwd` may be passed separately (this machine's own agents: the daemon
 * keeps their directories locally even when they aren't shared).
 */
export function associate(
  status: AgentStatusLike, projects: readonly ProjectLike[], hasCard: (channel: string, n: number) => boolean, cwd = status.cwd,
): Association | null {
  const live = projects.filter((p) => p.state === "active");
  for (const src of [status.task, status.branch]) {
    for (const k of keysIn(src)) {
      const p = live.find((x) => x.prefix === k.prefix);
      if (p) return hasCard(p.channel, k.n) ? { channel: p.channel, key: k.key, via: "key" } : { channel: p.channel, via: "key" };
    }
  }
  if (cwd) {
    let best: { channel: string; len: number } | null = null;
    for (const p of live) {
      for (const r of p.paths) {
        if (!("path" in r) || !underPath(cwd, r.path)) continue;
        const len = norm(r.path).length;
        if (!best || len > best.len) best = { channel: p.channel, len };
      }
    }
    if (best) return { channel: best.channel, via: "path" };
  }
  if (status.repo) {
    const repo = status.repo.toLowerCase();
    const p = live.find((x) => x.paths.some((r) => "repo" in r && r.repo.toLowerCase() === repo));
    if (p) return { channel: p.channel, via: "repo" };
  }
  return null;
}

/** Status fields that are enums or ids and never carry free text. */
const STATUS_FIXED = new Set(["agent", "state", "runtime", "ask_policy", "started_at", "observed_at"]);

/**
 * A status body without any key of a private project (round-2/3/4 audits): `task` and `branch` naming one are dropped,
 * and every other text field (title, activity, repo, cwd, model, session, anything a newer writer adds) has each
 * `PREFIX-<digits>` (with any `-<hex run>` right after it, so a reference `PREFIX-<digits>-<8 hex>` goes whole) masked
 * as a whole token, where anything but a letter or digit bounds a token (`_`, `/`, `.`, `-`, space: `wt_LAYOFF-1`,
 * `LAYOFF-1_totals`, `feat/layoff-12-x` are masked; `WEBAPI-2` is not a key of `API`).
 * Masks are `*` of the same length (schema-safe). `anyKey` (an index rebuild in progress: which projects are private
 * isn't known yet) masks every key-shaped token of any prefix and drops task / branch carrying one: fail closed.
 * Forms such as `layoff-4b`, `wt/layoff1` or a key split by invisible characters aren't caught: private projects get
 * an opaque generated prefix by default, so those reveal nothing readable. Copies peers already received can't be
 * recalled by re-signing.
 */
export function scrubPrivateKeys<B extends Record<string, unknown>>(b: B, privatePrefixes: readonly string[], opts: { anyKey?: boolean } = {}): B {
  const prefixes = [...new Set(privatePrefixes)].filter((p) => /^[A-Z][A-Z0-9]{1,9}$/.test(p));
  if (!prefixes.length && !opts.anyKey) return b;
  const alt = opts.anyKey ? "[A-Za-z][A-Za-z0-9]{1,9}" : prefixes.join("|");
  // A reference's short id is masked with its key (round-6 audit, Codex M4: it hashes the card's id, which non-members
  // see in restricted-channel stubs). The whole hex run after `KEY-n-` goes, whatever its length or the character
  // after it (round-7 audit: an exact-8 group backtracked to the bare key and left `-9b36abcd2` readable).
  const keyRe = new RegExp(`(?<![A-Za-z0-9])(?:${alt})-\\d+(?![A-Za-z0-9])(?:-[0-9A-Fa-f]+)?`, "gi");
  const hits = (v: string) => { keyRe.lastIndex = 0; return keyRe.test(v); };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (STATUS_FIXED.has(k) || typeof v !== "string") { out[k] = v; continue; }
    if ((k === "task" || k === "branch") && hits(v)) continue;
    out[k] = hits(v) ? v.replace(keyRe, (m) => "*".repeat(m.length)) : v;
  }
  return out as B;
}

/**
 * The first card reference in `s`: `PREFIX-n-xxxxxxxx` (key + exactly 8 hex of short id, then no further hex:
 * preferred) or `PREFIX-n`; null if none. `web-12-feed-parser` is the key WEB-12 (a hex-looking word isn't a short id).
 */
export function cardRefIn(s: string | undefined): string | null {
  if (!s) return null;
  const full = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,7})-([0-9a-fA-F]{8})(?![0-9a-fA-F])/.exec(s);
  if (full) return `${(full[1] as string).toUpperCase()}-${Number(full[2])}-${(full[3] as string).toLowerCase()}`;
  const k = keysIn(s)[0];
  return k ? k.key : null;
}
