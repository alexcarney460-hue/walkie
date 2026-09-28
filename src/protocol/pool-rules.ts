// COMPANY POOL rules shared by the daemon, the CLI and the dashboard (no zod, no node: the dashboard bundle imports it).
import type { AccountVault } from "./accounts.ts";

/**
 * The team's company account pool (Alex 2026-09-27: "Team setting, on for us"): company = on (every vault login not
 * marked personal is lent to every member's machines); per-account = off, each login's own policy only. OFF by
 * default, and unknown means off (fail closed).
 */
export type TeamPolicy = "company" | "per-account";
export const DEFAULT_TEAM_POLICY: TeamPolicy = "per-account";

/**
 * The last 10 % of every window of a login is kept for its person (Alex decision): a borrower ranks on its room minus
 * this, and never uses it at or below it.
 */
export const PERSONAL_RESERVE_PCT = 10;

/**
 * What a holder machine lends a login as right now: "company" (the team's pool on, not personal, the holder pooled it),
 * else its own policy (local = lends to nobody). Pure: the dashboard and the CLI listing use it.
 */
export function lendsAs(v: AccountVault, team: TeamPolicy): AccountVault["policy"] | "company" {
  return v.company === true && v.personal !== true && team === "company" ? "company" : v.policy;
}

