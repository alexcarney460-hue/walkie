// COMPANY POOL (Alex, verbatim: "every machine should have access to every account in the company to keep machines
// working smoothly"). The team's accounts policy (company | per-account) and who may lease a vault login under it.
//
// The pool is a TEAM setting (Alex 2026-09-27: "Team setting, on for us"), OFF by default: an owner (the person or the
// owner's agent) turns it on with `walkie accounts pool on` in that machine's config.json; it is advertised on that
// machine's accounts snapshot and every machine takes the newest owner setting it has seen (daemon/team-pool.ts; off
// when unknown). While it is on, every vault login not marked personal (`walkie accounts personal`) is lent to every
// owner's and member's machines; each login's own policy (local / own / shared, `vault_sharing`) applies as before.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { DEFAULT_TEAM_POLICY, TeamPolicyAd, type AccountVault, type TeamPolicy } from "../protocol/accounts.ts";


/** What this machine's config.json says (`vault_team_policy`), or null when never set here. */
export function localTeamPolicy(configPath: string): TeamPolicyAd | null {
  try {
    const raw = (JSON.parse(readFileSync(configPath, "utf8")) as { vault_team_policy?: unknown }).vault_team_policy;
    const p = TeamPolicyAd.safeParse(raw);
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

/** Writes `vault_team_policy` into config.json (keeping every other key), atomically. */
export function writeLocalTeamPolicy(configPath: string, policy: TeamPolicy, now = Date.now()): TeamPolicyAd {
  let cfg: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${configPath} is not a JSON object`);
    cfg = parsed as Record<string, unknown>;
  }
  const ad: TeamPolicyAd = { policy, at: now };
  const tmp = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ ...cfg, vault_team_policy: ad }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, configPath);
  return ad;
}

export interface EffectiveTeamPolicy { policy: TeamPolicy; at: number | null; by: string | null }

/** The newest setting among the team owners' machines; off (per-account) when no owner set one — fail closed. */
export function effectiveTeamPolicy(ads: ReadonlyArray<{ role: string; handle: string; ad: TeamPolicyAd | null | undefined }>): EffectiveTeamPolicy {
  let best: { ad: TeamPolicyAd; handle: string } | null = null;
  for (const a of ads) if (a.role === "owner" && a.ad && (!best || a.ad.at > best.ad.at)) best = { ad: a.ad, handle: a.handle };
  return best ? { policy: best.ad.policy, at: best.ad.at, by: best.handle } : { policy: DEFAULT_TEAM_POLICY, at: null, by: null };
}

/**
 * Whether `me` may lease this login from the machine holding it (the borrower's view; that machine re-checks): its own
 * policy (own / shared), or the company pool — the holder advertises `company` (its team pool on, not personal), this
 * machine also knows the pool is on, and `me` is an owner or member (observers never borrow through the pool).
 */
export function mayLeaseUnder(v: AccountVault | undefined, owner: string, me: string, team: TeamPolicy, role: string | null = "member"): boolean {
  if (!v) return false;
  if (v.policy === "own" && owner === me) return true;
  if (v.policy === "shared" && (owner === me || (v.share_with ?? []).includes(me))) return true;
  return isPooled(v, team) && (owner === me || role === "owner" || role === "member");
}

/** Whether a login is lent to the whole company right now (its holder pooled it and this machine knows the pool is on). */
export function isPooled(v: AccountVault | undefined, team: TeamPolicy): boolean {
  return !!v && v.company === true && v.personal !== true && team === "company";
}
