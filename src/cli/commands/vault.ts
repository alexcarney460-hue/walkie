// walkie accounts add|remove|policy|vault|pick|exec|shims (ACCOUNTS-2): the vault of logins the switcher moves
// sessions between. Adding, removing and changing who may use a login are for a person at a terminal (agents are
// refused); picking and running a command on the picked account (`exec`) are for scripts and agents too.
import { remoteRunToken } from "../../client/remote-run.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { identifyCodex } from "../../accounts/adapters/codex.ts";
import { activeLeases, releaseLease, writeLease, writeMark } from "../../accounts/leases.ts";
import { accountId, maskEmail } from "../../accounts/mask.ts";
import { selectOwnFirst, type Candidate } from "../../accounts/select.ts";
import { codexBaseHome, finalCodexHome, pendingCodexHome, removeCodexHome } from "../../accounts/vault/codex-home.ts";
import { POLICIES, Vault, walkieHomeDir, type Policy, type VaultEntry, type VaultProvider } from "../../accounts/vault/vault.ts";
import { PLAN_RE } from "../../protocol/accounts.ts";
import { unswitchedSessions, type UnswitchedSession } from "../../protocol/accounts-format.ts";
import { WalkieClient } from "../../client/index.ts";
import { defaultSource } from "../../switch/accounts.ts";
import { installShims, profileFile, realCli, shimsFirst, uninstallShims } from "../../switch/shims.ts";
import { recordTrusted, sameObjects, trustedRecipient } from "../../switch/trusted.ts";
import { credentialEnv, EXIT_ALL_EXHAUSTED, exhaustedLine, proxyAllowed } from "../../switch/wrapper.ts";
import { personalCommand, poolCommand, promoteCommand, splitCommand } from "./accounts-pool.ts";
import { absTime } from "../../protocol/accounts-format.ts";
import { planCodexArgv, routingOverride } from "../../switch/codex-routing.ts";
import { agentSignals, type ProcRow } from "../agent-detect.ts";
import { agentAdminOn, auditLocal } from "../admin-gate.ts";
import { AGENT_ADMIN_OFF } from "../../daemon/admin/gate.ts";
import { importClaudeLogin, type ClaudeImport } from "../../accounts/vault/import.ts";
import { bool, need, str, UsageError } from "../args.ts";
import { EXIT, readStdin, type Ctx } from "../context.ts";
import { c, pad, safeTerm } from "../format.ts";
import { openTty, type Tty } from "../tty.ts";

function provider(s: string | undefined): VaultProvider {
  if (s === "claude" || s === "codex") return s;
  throw new UsageError("provider must be claude or codex");
}

/**
 * Who confirms a vault change (AGENT-ADMIN-1). A person at a terminal answers the command's own questions there. An
 * agent (`--for-agent`, an agent runtime's environment marker, or an agent runtime among the ancestor processes:
 * agent-detect.ts), or anything without a terminal, is this machine's person's agent: while agent admin is on it goes
 * ahead with what it gave (a token on stdin, --account/--email, the policy) and every yes/no is yes; with agent admin
 * off it is refused. `o` is for tests (an environment and a process table instead of this process's).
 */
export function person(
  ctx: Pick<Ctx, "args"> & Partial<Pick<Ctx, "agentSignals">>, what: string,
  o: { env?: NodeJS.ProcessEnv; table?: () => ReadonlyMap<number, ProcRow> | null; home?: string } = {},
): Tty {
  // CODEX_HOME alone is a person's own setting (a shell export), not an agent session's marker.
  const { CODEX_HOME: _home, ...env } = o.env ?? process.env;
  const signals = !o.env && !o.table && ctx.agentSignals ? ctx.agentSignals()
    : agentSignals({ forAgentFlag: ctx.args.flags.get("for-agent") === true, env, ...(o.table ? { table: o.table } : {}) });
  const tty = signals.marker ? null : openTty();
  if (tty) return tty;
  if (!agentAdminOn(o.home)) {
    throw new UsageError(`${what}: agents can't change the vault here, ${AGENT_ADMIN_OFF}`);
  }
  return AGENT_TTY;
}

/** The answers an agent gives: yes to every confirmation, the default (Enter) to every other question. */
export const AGENT_TTY: Tty = {
  ask: async (q) => (/\[y\/N\]\s*$/.test(q) ? "y" : ""),
  secret: async () => { throw new UsageError("no terminal to type a token in: pipe it on stdin, or leave stdin empty to import this machine's Claude login"); },
  close: () => undefined,
};

/** person() plus the audit line of an agent's change (the vault never reaches the daemon otherwise). */
async function admitted(ctx: Ctx, what: string): Promise<Tty> {
  const tty = person(ctx, what);
  if (tty === AGENT_TTY) await auditLocal(ctx, `${what}${ctx.args.pos.length > 1 ? ` ${ctx.args.pos.slice(1).join(" ")}` : ""}`.slice(0, 300));
  return tty;
}

async function confirm(tty: Tty, q: string): Promise<boolean> {
  return /^y(es)?$/i.test((await tty.ask(`${q} [y/N] `)).trim());
}

const Recorded = z.object({ records: z.array(z.object({ id: z.string(), provider: z.string(), label: z.string(), plan: z.string().nullable(), token_login: z.boolean().optional(), vault: z.boolean().optional() }).passthrough()) }).passthrough();

/** Claude accounts phase 1 recorded on this machine (a setup-token can be linked to one of them). */
function recordedClaude(walkieHome: string): { id: string; label: string; plan: string | null }[] {
  try {
    const p = Recorded.safeParse(JSON.parse(readFileSync(join(walkieHome, "accounts.json"), "utf8")));
    return p.success ? p.data.records.filter((r) => r.provider === "claude" && !r.token_login && !r.vault).map((r) => ({ id: r.id, label: r.label, plan: r.plan })) : [];
  } catch {
    return [];
  }
}

function findEntry(vault: Vault, ref: string): VaultEntry {
  const list = vault.list();
  const hits = list.filter((e) => e.id === ref || (ref.length >= 6 && e.id.startsWith(ref)) || e.label === ref);
  if (hits.length === 1) return hits[0] as VaultEntry;
  if (!hits.length) throw new UsageError(`no vault account matches "${ref}" (see: walkie accounts vault)`);
  throw new UsageError(`"${ref}" matches ${hits.length} accounts; use more of the id`);
}

// ---- add ---------------------------------------------------------------------------------

/** The token: typed (hidden) at the terminal, or piped on stdin (`… | walkie accounts add claude`). */
/**
 * Piped stdin, or "" when nothing arrives within `ms` (an agent's tool runner may leave stdin open and silent: the
 * import then runs instead of waiting forever) or stdin is a terminal.
 */
export async function stdinWithin(ms = 2_000): Promise<string> {
  if (process.stdin.isTTY) return "";
  return Promise.race([readStdin(), Bun.sleep(ms).then(() => "")]);
}

export function tokenReader(
  tty: Tty, importer: () => Promise<ClaudeImport> = importClaudeLogin, note: (s: string) => void = () => undefined,
  piped: () => Promise<string> = stdinWithin,
): () => Promise<string> {
  return async () => {
    // A person's pipe is waited for (`claude setup-token | walkie accounts add claude` takes a browser sign-in first);
    // an agent's stdin only briefly.
    const typed = (tty === AGENT_TTY ? await piped()
      : process.stdin.isTTY ? await tty.secret("Paste the token `claude setup-token` printed (input hidden, Enter imports this machine's login): ")
      : await readStdin()).trim();
    if (typed) return typed;
    // Nothing pasted or piped: this machine's existing Claude login, when it is a long-lived token (AGENT-ADMIN-1).
    const imported = await importer();
    if ("why" in imported) throw new UsageError(`no token given, and ${imported.why}. Pipe a setup-token on stdin: claude setup-token, then … | walkie accounts add claude`);
    note(`imported ${imported.source}`);
    return imported.token;
  };
}

export async function addClaude(ctx: Ctx, vault: Vault, tty: Tty, walkieHome: string, readToken = tokenReader(tty, importClaudeLogin, (l) => ctx.err(l))): Promise<VaultEntry> {
  const token = await readToken();
  const known = recordedClaude(walkieHome);
  let linked: { id: string; label: string; plan: string | null } | null = null;
  const want = str(ctx.args, "account");
  if (want) {
    linked = known.find((k) => k.id === want || k.id.startsWith(want) || k.label === want) ?? null;
    if (!linked) throw new UsageError(`no recorded Claude account matches "${want}"`);
  } else if (known.length && !str(ctx.args, "email")) {
    ctx.err("Which account is this token for? (its usage meter is then shared with this entry)");
    known.forEach((k, i) => ctx.err(`  ${i + 1}) ${safeTerm(k.label)}${k.plan ? ` · ${safeTerm(k.plan)}` : ""}`));
    ctx.err("  0) another account (not listed)");
    const n = Number((await tty.ask("Number: ")).trim() || "0");
    linked = Number.isInteger(n) && n >= 1 && n <= known.length ? known[n - 1] as (typeof known)[number] : null;
  }
  const email = str(ctx.args, "email");
  const label = linked?.label ?? maskEmail(email) ?? "Claude account";
  const plan = linked?.plan ?? (str(ctx.args, "plan") && PLAN_RE.test(str(ctx.args, "plan") as string) ? str(ctx.args, "plan") as string : null);
  const id = linked?.id ?? accountId("claude", "setup-token", createHash("sha256").update(token).digest("hex").slice(0, 32));
  if (!(await confirm(tty, `Store this setup-token for ${label} in the vault (encrypted, this machine only)?`))) throw new UsageError("not stored");
  return vault.addClaude({ id, label, plan, token, linked: !!linked });
}

/**
 * The environment `codex login` runs in (round 4, Codex 2): the person's, with start-up, loader, endpoint, CA/TLS and
 * (unless allowed) proxy settings removed — the same cleaning a credentialed session gets — and no API key.
 */
export function codexLoginEnv(env: NodeJS.ProcessEnv, walkieHome: string, home: string): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) raw[k] = v;
  const clean = credentialEnv(raw, proxyAllowed(walkieHome));
  for (const k of ["CODEX_API_KEY", "OPENAI_API_KEY", "WALKIE_REAL_CODEX", "WALKIE_REAL_CLAUDE"]) delete clean[k];
  return { ...clean, CODEX_HOME: home, WALKIE_NO_SWITCH: "1" };
}

async function addCodex(ctx: Ctx, vault: Vault, tty: Tty, walkieHome: string): Promise<VaultEntry> {
  const real = realCli("codex", walkieHome);
  if (!real) throw new UsageError("codex is not on PATH");
  // Only the native codex that passes the trust checks sees the new login (never a script found first on PATH).
  const trust = trustedRecipient(walkieHome, "codex", real, { cwd: process.cwd(), shimDir: join(walkieHome, "bin") });
  if (!trust.ok) throw new UsageError(`not running ${real} for the login: ${safeTerm(trust.why)}`);
  const home = pendingCodexHome(walkieHome, codexBaseHome(walkieHome));
  let done = false;
  try {
    ctx.err(`Log in to the ChatGPT account to add (codex login, into its own CODEX_HOME):`);
    const extra = ctx.args.pos.slice(2);
    if (routingOverride(extra)) throw new UsageError("a -c override of the provider or its endpoints is not allowed for the login");
    const plan = planCodexArgv(["login", ...extra]);
    if (!plan.ok) throw new UsageError(`the login's arguments could not be read with certainty (${plan.why})`);
    if (!sameObjects(trust.ids)) throw new UsageError("codex changed between its check and the login; nothing was added");
    // Round 5: the login's own endpoints are pinned too (the pending home's config is already a cleaned copy).
    const p = Bun.spawn([...trust.argv, ...plan.argv], { stdio: ["inherit", "inherit", "inherit"], env: codexLoginEnv(process.env, walkieHome, home) });
    if ((await p.exited) !== 0) throw new UsageError("codex login did not finish; nothing was added");
    const ident = identifyCodex({ provider: "codex", dir: home, isDefault: false });
    if (!ident) throw new UsageError("that login is not a ChatGPT plan login (an API-key login has no usage to switch on); nothing was added");
    if (vault.get(ident.id)) throw new UsageError(`${ident.label} is already in the vault`);
    if (!(await confirm(tty, `Add ${ident.label}${ident.plan ? ` (${ident.plan})` : ""} to the vault?`))) throw new UsageError("not added");
    const final = finalCodexHome(home, walkieHome, ident.id);
    done = true;
    return vault.addCodex({ id: ident.id, label: ident.label, plan: ident.plan, home: final });
  } finally {
    if (!done && existsSync(home)) {
      try { removeCodexHome(home, walkieHome); } catch (err) { ctx.err(c.yellow(`left ${home} in place: ${(err as Error).message}`)); }
    }
  }
}

async function add(ctx: Ctx, walkieHome: string): Promise<number> {
  const prov = provider(need(ctx.args, 1, "provider (claude|codex)"));
  const tty = await admitted(ctx, "walkie accounts add");
  const vault = Vault.open(walkieHome);
  try {
    const e = prov === "claude" ? await addClaude(ctx, vault, tty, walkieHome) : await addCodex(ctx, vault, tty, walkieHome);
    writeMark(walkieHome, e.id, null); // a new credential: what sessions learned about the old one no longer applies
    const ks = await vault.keyStore();
    ctx.out(`${c.green("added")} ${PROVIDER[e.provider]} ${safeTerm(e.label)} ${c.dim(`(${e.id.slice(0, 8)}, policy ${e.policy}${e.provider === "claude" ? `, key in ${ks.kind}` : ""})`)}`);
    ctx.out(c.dim("While the team's company account pool is on (walkie accounts pool), every member's machines can lease it; keep it out with: walkie accounts personal <account>"));
    if (ks.warning && e.provider === "claude") ctx.err(c.yellow(`note: ${ks.warning}`));
    if (e.provider === "codex") ctx.out(c.dim("Codex logins are protected like Codex protects them (a 0600 auth.json in the account's own 0700 directory, not encrypted by Walkie); Claude tokens are encrypted."));
    if (!shimsFirst(walkieHome)) ctx.out(c.dim("Sessions switch when started with `walkie claude` / `walkie codex`, or everywhere after: walkie accounts shims install"));
    return EXIT.ok;
  } finally {
    tty.close();
    vault.close();
  }
}

const PROVIDER: Record<VaultProvider, string> = { claude: "Claude", codex: "Codex" };


// ---- remove / policy / vault ------------------------------------------------------------------

async function remove(ctx: Ctx, walkieHome: string): Promise<number> {
  const ref = need(ctx.args, 1, "account (id or label)");
  const tty = await admitted(ctx, "walkie accounts remove");
  const vault = Vault.open(walkieHome);
  try {
    const e = findEntry(vault, ref);
    if (!(await confirm(tty, `Remove ${PROVIDER[e.provider]} ${e.label} from the vault?`))) return EXIT.error;
    // The account home first: it refuses (and nothing is removed) when Codex wrote real entries there.
    const moved = e.provider === "codex" && e.home ? removeCodexHome(e.home, walkieHome, { move: bool(ctx.args, "move"), baseHome: codexBaseHome(walkieHome) }).moved : [];
    if (moved.length) ctx.out(c.dim(`moved ${moved.join(", ")} into ${codexBaseHome(walkieHome)}`));
    vault.remove(e.id);
    writeMark(walkieHome, e.id, null);
    ctx.out(`${c.green("removed")} ${safeTerm(e.label)}`);
    ctx.out(c.dim(e.provider === "claude"
      ? "The setup-token itself stays valid until you revoke it in your Claude account settings; sessions already running keep it until they end."
      : "The login is deleted from this machine; sessions already running keep it until they end."));
    return EXIT.ok;
  } finally {
    tty.close();
    vault.close();
  }
}

async function policy(ctx: Ctx, walkieHome: string): Promise<number> {
  const ref = need(ctx.args, 1, "account (id or label)");
  const pol = need(ctx.args, 2, "policy (local|own|shared)") as Policy;
  if (!POLICIES.includes(pol)) throw new UsageError("policy must be local, own or shared (the company pool is a team setting: walkie accounts pool)");
  const tty = await admitted(ctx, "walkie accounts policy");
  const vault = Vault.open(walkieHome);
  try {
    const e = findEntry(vault, ref);
    const shareWith = (str(ctx.args, "with") ?? "").split(",").map((h) => h.trim().replace(/^@/, "")).filter(Boolean);
    const what = pol === "local" ? "this machine only" : pol === "own" ? "your own machines" : `your machines and ${shareWith.map((h) => `@${h}`).join(", ")}`;
    if (!(await confirm(tty, `Let ${e.label} be used from ${what}?`))) return EXIT.error;
    const next = vault.setPolicy(e.id, pol, shareWith);
    ctx.out(`${c.green("policy")} ${safeTerm(next.label)}: ${next.policy}${next.share_with.length ? ` (${next.share_with.join(", ")})` : ""}`);
    if (pol === "shared") ctx.out(c.dim("Hand-outs to teammates also need \"vault_sharing\": true in this machine's ~/.walkie/config.json (the owner's setting)."));
    return EXIT.ok;
  } finally {
    tty.close();
    vault.close();
  }
}

async function list(ctx: Ctx, walkieHome: string): Promise<number> {
  if (!Vault.exists(walkieHome)) {
    if (ctx.json) ctx.out(JSON.stringify({ accounts: [], shims: shimsFirst(walkieHome) }));
    else ctx.out(`No vault on this machine yet. Add a login with ${c.bold("walkie accounts add claude")} or ${c.bold("walkie accounts add codex")}.`);
    return EXIT.ok;
  }
  const vault = Vault.open(walkieHome);
  try {
    const entries = vault.list();
    const leases = activeLeases(walkieHome);
    if (ctx.json) {
      ctx.out(JSON.stringify({
        accounts: entries.map((e) => ({ id: e.id, provider: e.provider, label: e.label, plan: e.plan, policy: e.policy, share_with: e.share_with, expires_at: e.expires_at, linked: e.linked, home_at: e.home_at, personal: e.personal, leases: leases.filter((l) => l.account === e.id).length })),
        shims: shimsFirst(walkieHome),
      }));
      return EXIT.ok;
    }
    if (!entries.length) ctx.out("The vault is empty.");
    for (const e of entries) {
      const n = leases.filter((l) => l.account === e.id).length;
      const soon = e.expires_at !== null && e.expires_at - Date.now() < 30 * 86_400_000;
      ctx.out(`${pad(PROVIDER[e.provider], 7)} ${pad(safeTerm(e.label), 18)} ${c.dim(e.id.slice(0, 8))}  ${pad(e.policy, 6)}${e.share_with.length ? c.dim(` → ${e.share_with.join(",")}`) : ""}${n ? `  ${c.green(`${n} session${n === 1 ? "" : "s"}`)}` : ""}${soon ? c.yellow("  token expires soon") : ""}`);
    }
    ctx.out(c.dim(shimsFirst(walkieHome) ? "Switching is on for every claude / codex started from a shell with the shims first on PATH." : "Switching: start sessions with `walkie claude` / `walkie codex`, or turn it on everywhere: walkie accounts shims install"));
    const outside = await unswitchedHere();
    if (outside.length) ctx.out(c.yellow(`Outside the switcher on this machine (restart to enable switching): ${outside.map((u) => u.agent).join(", ")}`));
    return EXIT.ok;
  } finally {
    vault.close();
  }
}

/** This machine's running Claude Code / Codex sessions not under the switcher (needs the daemon; [] without it). */
async function unswitchedHere(): Promise<UnswitchedSession[]> {
  try {
    const client = new WalkieClient({ timeoutMs: 1_500 });
    const [me, agents, accounts] = await Promise.all([client.me(), client.agents(), client.accounts()]);
    return unswitchedSessions(agents.agents, accounts.accounts).filter((u) => u.node === me.node.id);
  } catch {
    return [];
  }
}

// ---- pick / exec -----------------------------------------------------------------------------

async function pickFor(prov: VaultProvider, model: string | null, walkieHome: string) {
  const src = defaultSource(walkieHome);
  const now = Date.now();
  const sel = selectOwnFirst(await src.gather(prov, now), { provider: prov, model, now, thresholdPct: thresholdPct(walkieHome) });
  return { src, sel };
}

export function thresholdPct(walkieHome: string, env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = Number(env.WALKIE_SWITCH_AT);
  if (env.WALKIE_SWITCH_AT && Number.isFinite(fromEnv) && fromEnv >= 50 && fromEnv <= 100) return fromEnv;
  try {
    const v = (JSON.parse(readFileSync(join(walkieHome, "config.json"), "utf8")) as { switch_threshold_pct?: unknown }).switch_threshold_pct;
    return typeof v === "number" && v >= 50 && v <= 100 ? v : 95;
  } catch {
    return 95;
  }
}

function pickJson(p: Candidate & { room: number | null }): Record<string, unknown> {
  return { account: p.id, provider: p.provider, label: p.label, room_pct: p.room, source: p.source, owner: p.owner, leases: p.leases, pooled: p.pooled === true };
}

async function pick(ctx: Ctx, walkieHome: string): Promise<number> {
  const prov = provider(str(ctx.args, "provider") ?? ctx.args.pos[1]);
  const { sel } = await pickFor(prov, str(ctx.args, "model") ?? null, walkieHome);
  if (!sel.pick) {
    const line = exhaustedLine(sel);
    if (ctx.json) ctx.out(JSON.stringify({ account: null, waiting_until: sel.waitUntil, next_free: line.next_free, excluded: sel.excluded.map((e) => ({ account: e.id, label: e.label, owner: e.owner ?? null, why: e.why, until: e.until })) }));
    else ctx.out(`no ${prov} account has room${sel.nextFree ? `; next account frees at ${absTime(sel.nextFree.at, Date.now())}, ${safeTerm(sel.nextFree.label)}${sel.nextFree.owner ? ` (@${safeTerm(sel.nextFree.owner)})` : ""}` : sel.waitUntil ? `; the earliest is usable again at ${absTime(sel.waitUntil, Date.now())}` : ""}`);
    return EXIT_ALL_EXHAUSTED;
  }
  if (ctx.json) ctx.out(JSON.stringify(pickJson(sel.pick)));
  else ctx.out(`${safeTerm(sel.pick.label)} ${c.dim(`(${sel.pick.id.slice(0, 8)}, ${sel.pick.room === null ? "usage unknown" : `${Math.round(sel.pick.room)}% left`}${sel.pick.source === "peer" ? `, from @${sel.pick.owner}'s vault` : ""})`)}`);
  return EXIT.ok;
}

/**
 * `walkie accounts exec --provider claude|codex [--model m] -- <command…>`: runs one command (a headless launcher, a
 * `claude -p` job) on the picked account and exits with its status. Claude: CLAUDE_CODE_OAUTH_TOKEN in the command's
 * environment (inherited by what it starts; the same user's processes only); Codex: CODEX_HOME. Exit 75 when every
 * account is out (stderr says until when).
 */
/**
 * The lease `accounts exec` holds while its command runs. A hand-out's grant goes into it (round 3, Codex 9), so the
 * owner's daemon can verify this session like a wrapped one.
 */
export function execLease(
  provider: "claude" | "codex", p: { id: string; own: boolean; owner: string | null; source: string; node?: string },
  creds: { grant?: string }, pid: number, agent: string | undefined,
): Parameters<typeof writeLease>[1] {
  return {
    provider, account: p.id, pid,
    ...(agent && /^[a-z0-9][a-z0-9._-]{0,47}$/.test(agent) ? { agent } : {}),
    ...(!p.own && p.owner ? { owner: p.owner } : {}), ...(p.source === "peer" && p.node ? { from_node: p.node } : {}),
    ...(creds.grant ? { grant: creds.grant } : {}),
  };
}

async function exec(ctx: Ctx, walkieHome: string): Promise<number> {
  // AGENT-ADMIN-1 fix round 2: never in a remote admin run (the allow-list refuses it too): it runs a program with an
  // account's credential (exec) or decides which program gets one (trust-cli).
  if (remoteRunToken()) throw new UsageError("not in a remote admin run: it runs a program with an account's credential");
  const prov = provider(str(ctx.args, "provider"));
  const cmd = ctx.args.pos.slice(1);
  if (!cmd.length) throw new UsageError("usage: walkie accounts exec --provider claude|codex -- <command…>");
  const { src, sel } = await pickFor(prov, str(ctx.args, "model") ?? null, walkieHome);
  if (!sel.pick) {
    ctx.err(JSON.stringify(exhaustedLine(sel)));
    return EXIT_ALL_EXHAUSTED;
  }
  const p = sel.pick;
  const creds = await src.credentials(p, process.env.WALKIE_AGENT ?? null);
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) raw[k] = v;
  const env = credentialEnv(raw, proxyAllowed(walkieHome));
  if (prov === "claude") {
    for (const k of ["CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) delete env[k];
    env.CLAUDE_CODE_OAUTH_TOKEN = creds.token as string;
  } else {
    env.CODEX_HOME = creds.home as string;
  }
  env.WALKIE_ACCOUNT = p.id;
  env.WALKIE_NO_SWITCH = "1"; // the command's own claude/codex must not re-pick through the shims
  let lease: ReturnType<typeof writeLease>;
  try {
    lease = writeLease(walkieHome, execLease(prov, p, creds, process.pid, process.env.WALKIE_AGENT));
  } catch (err) {
    creds.release?.();
    throw err;
  }
  try {
    ctx.err(c.dim(`walkie: running on ${p.label}`));
    const child = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"], env });
    const forward = (sig: NodeJS.Signals) => () => { try { child.kill(sig); } catch { /* gone */ } };
    const term = forward("SIGTERM");
    const ignore = () => undefined; // Ctrl-C reaches the command itself (same process group)
    process.on("SIGTERM", term);
    process.on("SIGINT", ignore);
    try {
      const code = await child.exited;
      return child.signalCode ? 128 + 15 : code;
    } finally {
      process.off("SIGTERM", term);
      process.off("SIGINT", ignore);
    }
  } finally {
    releaseLease(walkieHome, lease);
    creds.release?.(); // COMPANY POOL: a leased Codex home goes with the command
  }
}

// ---- shims -----------------------------------------------------------------------------------

/**
 * Records the real claude / codex found on PATH as the binaries Walkie may hand credentials to (round 1, Codex 1), after
 * checking they sit where only this person (or root) can change them. Returns the lines to print.
 */
export function recordClis(walkieHome: string): string[] {
  const lines: string[] = [];
  for (const name of ["claude", "codex"] as const) {
    const found = realCli(name, walkieHome);
    if (!found) { lines.push(c.dim(`${name}: not on PATH (nothing recorded)`)); continue; }
    try {
      const e = recordTrusted(walkieHome, name, found, { cwd: process.cwd() });
      lines.push(`${c.green("trusted")} ${name}: ${e.path}${e.realpath !== e.path ? c.dim(` → ${e.realpath}`) : ""}`);
    } catch (err) {
      lines.push(c.yellow(`${(err as Error).message} — sessions of ${name} will run without Walkie accounts`));
    }
  }
  return lines;
}

async function trustCli(ctx: Ctx, walkieHome: string): Promise<number> {
  // AGENT-ADMIN-1 fix round 2: never in a remote admin run (the allow-list refuses it too): it runs a program with an
  // account's credential (exec) or decides which program gets one (trust-cli).
  if (remoteRunToken()) throw new UsageError("not in a remote admin run: it runs a program with an account's credential");
  const tty = await admitted(ctx, "walkie accounts trust-cli");
  try {
    if (!(await confirm(tty, "Trust the claude / codex found on PATH now to receive your vault's credentials?"))) return EXIT.error;
  } finally {
    tty.close();
  }
  for (const l of recordClis(walkieHome)) ctx.out(l);
  return EXIT.ok;
}

async function shims(ctx: Ctx, walkieHome: string): Promise<number> {
  const action = need(ctx.args, 1, "install|uninstall");
  const withProfile = bool(ctx.args, "profile");
  if (withProfile || action === "install") {
    const tty = await admitted(ctx, `walkie accounts shims ${action}`);
    try {
      const q = action === "install"
        ? `Install the claude / codex shims${withProfile ? " and add them to your shell profile" : ""} (every session switches accounts)?`
        : "Remove the shims and their PATH line from your shell profile?";
      if (!(await confirm(tty, q))) return EXIT.error;
    } finally {
      tty.close();
    }
  }
  const profile = withProfile ? profileFile() : null;
  if (action === "install") {
    const trusted = recordClis(walkieHome);
    const r = installShims(walkieHome, { profile });
    ctx.out(`${c.green("installed")} ${r.written.join(", ")}`);
    for (const l of trusted) ctx.out(l);
    if (r.profile) ctx.out(`${c.green("added")} the PATH line to ${r.profile}; open a new terminal (or: source ${r.profile})`);
    else if (!r.onPath) ctx.out(`Put this line in your shell profile (or re-run with --profile to add it):\n  ${r.pathLine}`);
    ctx.out(c.dim("Every claude / codex started after that switches accounts when one hits its limit (the session resumes on an account with room). WALKIE_NO_SWITCH=1 turns it off for one command."));
    return EXIT.ok;
  }
  if (action === "uninstall") {
    const r = uninstallShims(walkieHome, { profile });
    ctx.out(`${c.green("removed")} ${r.removed.length ? r.removed.join(", ") : "nothing (no shims)"}${r.profile ? ` and the PATH line from ${r.profile}` : ""}`);
    return EXIT.ok;
  }
  throw new UsageError("usage: walkie accounts shims install|uninstall [--profile]");
}

/**
 * `walkie accounts borrow on|off` (round 1, Opus 4): whether this person's sessions may run on teammates' shared
 * accounts — only ever when every own account is out. Off by default; config.json `borrow_shared`.
 */
async function borrow(ctx: Ctx, walkieHome: string): Promise<number> {
  const v = need(ctx.args, 1, "on|off");
  if (v !== "on" && v !== "off") throw new UsageError("usage: walkie accounts borrow on|off");
  const tty = await admitted(ctx, "walkie accounts borrow");
  try {
    if (v === "on" && !(await confirm(tty, "Run on teammates' shared accounts when all of your own are out?"))) return EXIT.error;
    setConfigField(walkieHome, "borrow_shared", v === "on");
    ctx.out(`${c.green("borrowing")} ${v === "on" ? "on: teammates' shared accounts are used only after all of yours are out" : "off"}`);
    return EXIT.ok;
  } finally {
    tty.close();
  }
}

/**
 * `walkie accounts allow-proxy on|off`: keep HTTP(S)_PROXY / ALL_PROXY for credentialed launches (off by default: a
 * proxy sees the token's requests). Base URLs, CA overrides and TLS switches are removed either way.
 */
async function allowProxy(ctx: Ctx, walkieHome: string): Promise<number> {
  const v = need(ctx.args, 1, "on|off");
  if (v !== "on" && v !== "off") throw new UsageError("usage: walkie accounts allow-proxy on|off");
  const tty = await admitted(ctx, "walkie accounts allow-proxy");
  try {
    if (v === "on" && !(await confirm(tty, "Let credentialed claude / codex sessions use your HTTP(S)_PROXY settings?"))) return EXIT.error;
    setConfigField(walkieHome, "allow_proxy", v === "on");
    ctx.out(`${c.green("proxy")} ${v === "on" ? "kept for credentialed sessions" : "removed from credentialed sessions"}`);
    return EXIT.ok;
  } finally {
    tty.close();
  }
}

/** Sets one field of ~/.walkie/config.json, keeping the rest (0600). */
export function setConfigField(walkieHome: string, key: string, value: unknown): void {
  const path = join(walkieHome, "config.json");
  let cur: Record<string, unknown> = {};
  try { cur = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { /* new */ }
  writeFileSync(path, JSON.stringify({ ...cur, [key]: value }, null, 2) + "\n", { mode: 0o600 });
}

export async function vaultCommand(ctx: Ctx, sub: string): Promise<number | null> {
  const home = walkieHomeDir();
  switch (sub) {
    case "add": return add(ctx, home);
    case "remove": return remove(ctx, home);
    case "policy": return policy(ctx, home);
    case "vault": return list(ctx, home);
    case "pick": return pick(ctx, home);
    case "exec": return exec(ctx, home);
    case "shims": return shims(ctx, home);
    case "borrow": return borrow(ctx, home);
    case "allow-proxy": return allowProxy(ctx, home);
    case "trust-cli": return trustCli(ctx, home);
    case "split": return splitCommand(ctx);
    case "pool": return poolCommand(ctx, home);
    case "personal": return personalCommand(ctx, admitted, home);
    case "promote": return promoteCommand(ctx, admitted, home);
    default: return null;
  }
}
