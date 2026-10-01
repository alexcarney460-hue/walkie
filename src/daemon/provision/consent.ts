import type { Grant } from "./grant.ts";

export const CONSENT_VERSION = 1;
export const CLI_CONSENT_PHRASE = "yes";
type Selection = Grant["profiles"][number];

/** The installer displays this exact text with an unchecked choice before asking the local daemon for a grant. */
export function consentText(owner: string, launchers: readonly string[], cap: number, profiles: readonly Selection[], accounts?: Grant["worker_accounts"], ownerSsh?: Grant["owner_ssh"]): string {
  const selected = accounts ? ` Worker accounts: Claude ${accounts.claude ?? "waiting for owner account"}; Codex ${accounts.codex ?? "waiting for owner account"}.` : "";
  return `Allow @${owner} to provision this company machine remotely. The named launchers may run agents as your macOS/Windows-WSL/Linux user. Owners can use Walkie's allow-listed remote admin commands; launched agents can run arbitrary code, read and change files and keys you can access, and use your Walkie daemon as you.${ownerSsh ? ` @${owner}, their everyday agents running as their OS user, and WalkieTalkie may sign in to this machine over SSH as your user, through Walkie, using a Walkie SSH service that listens only on this machine and accepts only key logins. Walkie records the caller, source machine, session time and duration, but not session content, and posts one summary to you. Revoke with walkie ssh revoke, walkie admin remote off, or by leaving the team.` : ""} Owner-provided subscription logins may be leased for a run.${selected} Walkie records who provisioned and launched; you can stop seats with walkie seats deny, stop remote setup with walkie admin remote off and walkie agents admin off, or leave the team. Launchers: ${launchers.join(", ")}. Seat cap: ${cap}. Profiles: ${profiles.map((p) => `${p.id} v${p.version}`).join(", ")}. On Windows, enrollment may keep WSL running after sign-in and change its power policy.`;
}
