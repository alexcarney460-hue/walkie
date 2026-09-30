// Minting a Walkie Direct code on this (owner) node: `walkie invite`, `walkie team add-machine`, and a rented
// machine's 1-hour code (RENT-2, src/daemon/compute/). Shared so the local routes and the compute poller mint the same
// way. The code is a bearer credential: only its chain id is ever logged.
import type { Role } from "../protocol/schemas.ts";
import type { Core } from "./core.ts";
import type { TransportControl } from "./direct/link.ts";
import { HttpError } from "./http.ts";
import { createInvite, inviteMintPos } from "./invite.ts";
import { memberByHandle, servesDirect } from "./roster.ts";

export interface MintedInvite { code: string; id: string; role: Role; expires_at: number; existing_member: boolean }

/** Mints a code for `handle` (PROTOCOL §4 "Direct"); a current member's code adds a machine, same role. */
export async function mintInviteCode(
  core: Core, transport: TransportControl | undefined, handle: string, asked: Role, opts: { ttlMs?: number } = {},
): Promise<MintedInvite> {
  const authorityId = core.authority;
  const authority = authorityId ? core.roster.nodes.get(authorityId) : undefined;
  if (!authority || !servesDirect(authority)) {
    const where = core.isAuthority() ? "run: walkie direct enable" : `on ${authority?.hostname ?? "the authority"} run: walkie direct enable`;
    throw new HttpError(409, "direct_unavailable", `the team's roster authority doesn't run Walkie Direct yet, so an invite code couldn't reach it (${where}); Tailscale teammates: walkie invite <tailscale-login> --handle <name>`);
  }
  // A current member's invite adds a machine: their role stays what it is.
  const holder = memberByHandle(core.roster, handle);
  const current = holder && holder.role !== "removed" ? holder : undefined;
  const role = current ? (current.role as Role) : asked;
  const relay = core.isAuthority() && transport ? await transport.relayHint(3_000) : null;
  const inv = createInvite(core.keys, {
    team: core.teamId as string, authority: authority.pubkey, ...(relay ? { relay } : {}), handle, role,
    now: core.clock(), pos: inviteMintPos(core.roster), ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
  });
  core.log.info("invite_created", { handle, role, invite: inv.id, expires_at: inv.expires_at });
  return { code: inv.code, id: inv.id, role, expires_at: inv.expires_at, existing_member: !!current };
}
