// walkie accounts --all | split | pool | personal | promote (RESET-CLOCK-1 / COMPANY POOL): the fleet-wide
// accounts picture for the team's orchestrator, a suggested split of seats over the logins, the team accounts policy,
// and the person's controls over their own logins. Nothing here reads or prints a credential.
import { join } from "node:path";
import { fleetView, nextFreeByProvider, splitLogin, suggestSplit, type Fleet, type SplitMachine, type SplitResult } from "../../protocol/fleet.ts";

export { nextFreeByProvider };
import { readFileSync, writeFileSync } from "node:fs";
import { writeLocalTeamPolicy } from "../../accounts/pool.ts";
import { Vault, walkieHomeDir } from "../../accounts/vault/vault.ts";
import { absTime, resetText, windowLabel } from "../../protocol/accounts-format.ts";
import { DEFAULT_TEAM_POLICY, type AccountView, type TeamPolicy } from "../../protocol/accounts.ts";
import { DEFAULT_HOST_MAX } from "../../protocol/seats.ts";
import { defang } from "../../protocol/safety.ts";
import { ACCOUNTS_NOTE } from "../agent-output.ts";
import { need, str, UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { c, pad, safeTerm } from "../format.ts";

type Pool = { policy: TeamPolicy; at: number | null; by: string | null };
/** The confirmation channel: a terminal, or (agent admin on) an agent's audited yes (vault.ts admitted). */
type Gate = { close(): void; ask(q: string): Promise<string> };

/** For an agent: free text (hostnames, agent names) defanged; labels and handles are already validated. */
function forModel(f: Fleet): Fleet {
  return {
    machines: f.machines.map((m) => ({ ...m, hostname: defang(m.hostname, 80), accounts: m.accounts.map((a) => ({ ...a, agents: a.agents.map((x) => defang(x, 60)) })) })),
    using_now: f.using_now.map((u) => ({ ...u, hostname: defang(u.hostname, 80), agent: u.agent === null ? null : defang(u.agent, 60) })),
  };
}

export function renderFleet(f: Fleet, pool: Pool, now: number, tz?: string): string {
  const lines = [`${c.bold("Accounts across the fleet")} ${c.dim(`· company pool ${pool.policy === "company" ? "on" : "off"}${pool.by ? ` (set by @${safeTerm(pool.by)})` : ""}`)}`];
  for (const m of f.machines) {
    lines.push("", `${c.bold(safeTerm(m.hostname))} ${c.dim(`@${safeTerm(m.handle)}${m.self ? " · this machine" : ""}${m.online ? "" : " · offline"}`)}`);
    for (const a of m.accounts) {
      const tags = [a.pooled ? "pooled" : a.policy ?? "session login", a.lender ? "lends it" : "", a.needs_relogin ? c.red("needs re-login") : ""].filter(Boolean).join(" · ");
      lines.push(`  ${pad(a.provider, 7)} ${pad(safeTerm(a.label), 20)} ${c.dim(`@${safeTerm(a.owner)} · ${tags}${a.agents.length ? ` · used by ${safeTerm(a.agents.join(", "))}` : ""}`)}`);
      for (const w of a.windows) {
        const used = w.used_pct === null ? "—" : `${Math.round(w.used_pct)}% used`;
        const reset = w.resets_at === null ? "reset not reported" : w.resets_at > now ? `${resetText(w.resets_at, now)} (${absTime(w.resets_at, now, tz)})` : "reset passed, not yet confirmed";
        lines.push(`    ${pad(safeTerm(windowLabel({ kind: w.kind, scope: w.scope, window_s: w.window_s, used_pct: 0, resets_at: null })), 16)} ${pad(used, 10)} ${c.dim(`${reset} · seen ${absTime(w.observed_at, now, tz)}`)}`);
      }
    }
  }
  if (f.using_now.length) {
    lines.push("", c.bold("In use now"));
    for (const u of f.using_now) lines.push(`  ${safeTerm(u.hostname)}${u.agent ? ` ${safeTerm(u.agent)}` : ""} → ${safeTerm(u.label)} ${c.dim(`(@${safeTerm(u.owner)}'s ${u.provider}${u.verified ? "" : ", unverified"})`)}`);
  }
  return lines.join("\n");
}

/** `walkie accounts --all [--json]`: every machine's accounts, windows, resets and who uses what now. */
export async function fleetCommand(ctx: Ctx): Promise<number> {
  const res = await ctx.client().accounts();
  const pool: Pool = res.pool ?? { policy: DEFAULT_TEAM_POLICY, at: null, by: null };
  const now = Date.now();
  const f = fleetView(res.accounts, pool.policy, now);
  if (ctx.json) {
    const body = { at: now, pool, ...(ctx.forAgent ? forModel(f) : f), next_free: nextFreeByProvider(res.accounts, now) };
    ctx.out(JSON.stringify(ctx.forAgent ? { ...body, trust: "team-member", note: ACCOUNTS_NOTE } : body));
  } else {
    ctx.out(renderFleet(f, pool, now));
  }
  return EXIT.ok;
}

// ---- suggest a split ---------------------------------------------------------------------------

/** `--caps alex-mac=3,build-02=2` → hostname → cap. */
export function parseCaps(s: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of (s ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^([A-Za-z0-9._-]{1,63})=(\d{1,2})$/.exec(part);
    if (!m) throw new UsageError(`--caps takes host=n,host=n (got "${part}")`);
    out.set(m[1] as string, Number(m[2]));
  }
  return out;
}

export function renderSplit(r: SplitResult, provider: string, now: number, tz?: string): string {
  const total = r.machines.reduce((n, m) => n + m.cap, 0);
  const lines = [`${c.bold("Suggested split")} ${c.dim(`(${provider}: ${r.machines.length} machine${r.machines.length === 1 ? "" : "s"}, ${total} seats; the last 10% of each login is kept for its person)`)}`];
  for (const m of r.machines) {
    const seats = m.seats.map((s) => `${s.seats} × ${safeTerm(s.label)}${s.plan ? ` (${safeTerm(s.plan)})` : ""}`).join(", ") || c.dim("no login with room");
    lines.push(`  ${pad(safeTerm(m.hostname), 16)} ${c.dim(`(${m.cap})`)} ${seats}${m.idle > 0 && m.seats.length ? c.dim(` · ${m.idle} idle`) : ""}`);
  }
  for (const w of r.waiting) {
    const why = w.why === "unreachable" ? "no machine holding it is online" : w.frees_at !== null && w.frees_at > now ? `frees at ${absTime(w.frees_at, now, tz)}` : "reset time not reported";
    lines.push(`  ${c.yellow("waiting")} ${safeTerm(w.label)} ${c.dim(why)}`);
  }
  return lines.join("\n");
}

export async function splitCommand(ctx: Ctx): Promise<number> {
  const provider = str(ctx.args, "provider") ?? ctx.args.pos[1] ?? "claude";
  if (!["claude", "codex", "kimi", "grok"].includes(provider)) throw new UsageError("--provider must be claude, codex, kimi or grok");
  const caps = parseCaps(str(ctx.args, "caps"));
  const client = ctx.client();
  const [res, peers, seats] = await Promise.all([client.accounts(), client.peers(), client.seats().catch(() => null)]);
  const team = res.pool?.policy ?? DEFAULT_TEAM_POLICY;
  const now = Date.now();
  const machines: SplitMachine[] = peers.nodes.map((n) => ({
    node_id: n.node_id, hostname: n.hostname, handle: n.handle, online: n.self || n.online,
    cap: caps.get(n.hostname) ?? (n.self && seats ? seats.local.max : DEFAULT_HOST_MAX),
  }));
  const logins = res.accounts.filter((a) => a.provider === provider).map((a) => splitLogin(a, team, now));
  const r = suggestSplit(machines, logins);
  if (ctx.json) ctx.out(JSON.stringify({ provider, at: now, ...(ctx.forAgent ? { ...r, machines: r.machines.map((m) => ({ ...m, hostname: defang(m.hostname, 80) })) } : r) }));
  else ctx.out(renderSplit(r, provider, now));
  return EXIT.ok;
}

// ---- the team's pool setting / personal / promote -------------------------------------------------

const POOL_ON_TEXT = "The company account pool is on: every vault login not marked personal can be leased by every member's machines (the last 10% of each window stays with its person).";

/**
 * `walkie accounts pool [on|off]` (COMPANY POOL, Alex 2026-09-27: "Team setting, on for us"): shows, or — a team owner,
 * the person or the owner's agent — sets the team's pool. Off by default. The setting is this machine's config and
 * travels on its accounts snapshot; the newest owner setting is the team's. Turning it on tells the team in #general.
 */
export async function poolCommand(ctx: Ctx, walkieHome = walkieHomeDir()): Promise<number> {
  const want = ctx.args.pos[1];
  if (want !== undefined && want !== "on" && want !== "off" && want !== "status") throw new UsageError("walkie accounts pool takes on, off or status");
  const client = ctx.client();
  if (want === undefined || want === "status") {
    const res = await client.accounts();
    const pool: Pool = res.pool ?? { policy: DEFAULT_TEAM_POLICY, at: null, by: null };
    if (ctx.json) ctx.out(JSON.stringify({ on: pool.policy === "company", ...pool }));
    else ctx.out(`company account pool: ${pool.policy === "company" ? c.green("on") : c.bold("off")}${pool.by ? c.dim(` (set by @${safeTerm(pool.by)})`) : c.dim(" (never turned on)")}`);
    return EXIT.ok;
  }
  const me = await client.me();
  if (me.role !== "owner") throw new UsageError("only a team owner (or an owner's agent) turns the company account pool on or off");
  const ad = writeLocalTeamPolicy(join(walkieHome, "config.json"), want === "on" ? "company" : "per-account");
  let told = false;
  if (want === "on") {
    try {
      await client.post({ channel: "general", text: `${POOL_ON_TEXT} Keep one of yours out: walkie accounts personal <account> (on the machine that holds it).` });
      told = true;
    } catch { /* the setting stands; the dashboard banner and `walkie accounts` still tell each member */ }
  }
  if (ctx.json) ctx.out(JSON.stringify({ on: want === "on", at: ad.at, told_team: told }));
  else ctx.out(`${c.green("company account pool")} ${want} ${c.dim(want === "on"
    ? `— every member's vault logins not marked personal can be leased by every machine${told ? "; posted to #general" : ""}`
    : "— new leases stop; each login's own policy applies again")}`);
  return EXIT.ok;
}

/**
 * The pool notice for this machine's person (never an agent or --json): shown once per time an owner turned the pool
 * on (`~/.walkie/pool-notice-seen` holds the last one shown).
 */
export function poolNoticeLines(pool: Pool | undefined, walkieHome = walkieHomeDir()): string[] {
  if (!pool || pool.policy !== "company" || pool.at === null) return [];
  const seenFile = join(walkieHome, "pool-notice-seen");
  let seen = 0;
  try { seen = Number(readFileSync(seenFile, "utf8").trim()) || 0; } catch { /* never shown */ }
  if (seen >= pool.at) return [];
  try { writeFileSync(seenFile, `${pool.at}\n`, { mode: 0o600 }); } catch { /* shown again next time */ }
  return [
    c.yellow(`${POOL_ON_TEXT}${pool.by ? ` (turned on by @${safeTerm(pool.by)})` : ""}`),
    c.dim("  Keep one of yours out any time: walkie accounts personal <account>   (this notice is shown once)"),
  ];
}

/** `walkie accounts personal <account> [off]`: keep a login out of the company pool (or let the pool have it again). */
export async function personalCommand(ctx: Ctx, person: (ctx: Ctx, what: string) => Gate | Promise<Gate>, walkieHome = walkieHomeDir()): Promise<number> {
  const ref = need(ctx.args, 1, "account (id or label)");
  const off = ctx.args.pos[2] === "off";
  if (ctx.args.pos[2] !== undefined && !off) throw new UsageError("usage: walkie accounts personal <account> [off]");
  const tty = await person(ctx, "walkie accounts personal");
  const vault = Vault.open(walkieHome);
  try {
    const e = findOne(vault, ref);
    const q = off ? `Let the company pool lend ${e.label} again (while the team's pool is on)?` : `Keep ${e.label} out of the company pool?`;
    if (!/^y(es)?$/i.test((await tty.ask(`${q} [y/N] `)).trim())) return EXIT.error;
    const next = vault.setPersonal(e.id, !off);
    ctx.out(off
      ? `${c.green("pooled")} ${safeTerm(next.label)} ${c.dim("— lent to every member's machines while the team's pool is on")}`
      : `${c.green("personal")} ${safeTerm(next.label)} ${c.dim(`— not pooled; its policy (${next.policy}) still applies`)}`);
    return EXIT.ok;
  } finally {
    tty.close();
    vault.close();
  }
}

export async function promoteCommand(ctx: Ctx, person: (ctx: Ctx, what: string) => Gate | Promise<Gate>, walkieHome = walkieHomeDir()): Promise<number> {
  const ref = need(ctx.args, 1, "account (id or label)");
  const tty = await person(ctx, "walkie accounts promote");
  const vault = Vault.open(walkieHome);
  try {
    const e = findOne(vault, ref);
    if (!/^y(es)?$/i.test((await tty.ask(`Make this machine the one teammates lease ${e.label} from (its own login here)? [y/N] `)).trim())) return EXIT.error;
    vault.promote(e.id);
    ctx.out(`${c.green("home")} ${safeTerm(e.label)} ${c.dim("— borrowers lease it from this machine while it is online; this machine's login refreshes only itself")}`);
    return EXIT.ok;
  } finally {
    tty.close();
    vault.close();
  }
}

function findOne(vault: Vault, ref: string) {
  const hits = vault.list().filter((e) => e.id === ref || (ref.length >= 6 && e.id.startsWith(ref)) || e.label === ref);
  if (hits.length === 1) return hits[0] as NonNullable<(typeof hits)[number]>;
  if (!hits.length) throw new UsageError(`no vault account matches "${ref}" (see: walkie accounts vault)`);
  throw new UsageError(`"${ref}" matches ${hits.length} accounts; use more of the id`);
}
