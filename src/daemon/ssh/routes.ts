import { route } from "../local-routes.ts";
import { json, HttpError } from "../http.ts";
import { personOnly } from "../admin/gate.ts";
import { appendAudit } from "../admin/audit.ts";
import { readGrant } from "../provision/grant.ts";
import { hasOwnerKey } from "./authorized-keys.ts";
import { sshTunnelProblem } from "./tunnel.ts";
import { noteRevocationOutcome, revokeSshAccess } from "./revoke.ts";
import { sshServerStatus } from "./server.ts";
import { PeerCallError } from "../peer-client.ts";
import { publishSshRevocation } from "./team-revocation.ts";
import { denySshInMemory, sshRevocationUnsaved } from "./state.ts";
import { closeSshTunnelsQuietly } from "./tunnel.ts";

route("POST", "/v1/ssh/revoke", async (c) => {
  personOnly(c, "revoke owner SSH access");
  if (c.via === "phone") throw new HttpError(403, "person_only", "revoke SSH access at this machine");
  const grant = readGrant(c.core.paths.home);
  if (!grant?.owner_ssh) throw new HttpError(404, "grant_absent", "no owner SSH grant exists");
  denySshInMemory(c.core.paths.home);
  closeSshTunnelsQuietly(c.core);
  // The durable local revocation comes before any network call: a restart while the team receipt is still in flight
  // (a slow or offline authority) must already find the gate closed.
  let removed = 0;
  let localFailure: unknown;
  try { removed = revokeSshAccess(c.core, grant); } catch (err) { localFailure = err; }
  let teamFailure: unknown;
  try { await publishSshRevocation(c.core, c.client, grant); } catch (err) { teamFailure = err; }
  // Nothing saved here and no receipt held by the team: only this process's memory refuses, until a restart.
  const refusal = noteRevocationOutcome(c.core.paths.home, localFailure ?? null, !teamFailure);
  if (localFailure) throw refusal ?? localFailure;
  if (teamFailure) throw new HttpError(503, "ssh_team_receipt_unavailable", (teamFailure as Error).message);
  appendAudit(c.core, { actor: `@${grant.recipient}`, action: `revoked owner SSH key; removed=${removed}`, machine: c.core.hostname, via: "local" });
  return json({ removed });
});

route("GET", "/v1/ssh/status", async (c) => {
  const grant = readGrant(c.core.paths.home);
  const owner = grant?.owner_ssh;
  let ownerKeyPresent = false;
  let ownerKeyError: string | null = null;
  try {
    ownerKeyPresent = !!owner && hasOwnerKey(c.core.sshUserHome, grant.team_id, owner.owner_handle, owner.public_key);
  } catch { ownerKeyError = "authorized_keys or its managed record cannot be inspected"; }
  const reason = owner ? sshTunnelProblem(c.core, grant.owner_node) : "grant_absent";
  return json({
    owner_key_present: ownerKeyPresent,
    owner_key_error: ownerKeyError,
    tunnel_allowed: reason === null,
    reason,
    is_authority: c.core.isAuthority(),
    revocation_unsaved: sshRevocationUnsaved(c.core.paths.home),
    server: await sshServerStatus(),
  });
});

route("GET", "/v1/ssh/target", async (c) => {
  if (c.via === "phone") throw new HttpError(403, "forbidden", "SSH target lookup is local only");
  const name = c.url.searchParams.get("machine") ?? "";
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new HttpError(400, "invalid", "invalid machine name");
  const matches = [...c.core.roster.nodes.values()].filter((n) => !n.revoked && (n.hostname === name || n.node_id === name));
  if (matches.length !== 1) throw new HttpError(404, "not_found", "name one admitted machine");
  const addr = c.client.addrVia(matches[0]!, "direct");
  if (!addr) throw new HttpError(409, "target_outdated", "target does not serve Walkie Direct");
  try { return json(await c.client.sshInfo(addr)); }
  catch (err) {
    if (err instanceof PeerCallError && err.status === 404) throw new HttpError(409, "target_outdated", "target does not support SSH tunnels");
    throw err;
  }
});
