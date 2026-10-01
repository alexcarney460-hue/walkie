import type { Core } from "../core.ts";
import { nodeMember } from "../roster.ts";
import { readSwitches } from "../admin/switches.ts";
import { authorizeProvision, grantSuspensionProblem, readGrant, type Grant } from "./grant.ts";
import { rootMarkerPresent } from "./root-marker.ts";

export function provisionUidProblem(uid = process.getuid?.()): string | null {
  return uid === 0 ? "root_forbidden" : null;
}

/** Read fresh roster, switches and private grant each time a step is about to act. */
export function provisionProblem(core: Core, actorNode: string, id: string, localPerson = false): string | null {
  let grant: Grant | null;
  try { grant = readGrant(core.paths.home); } catch { return "grant_invalid"; }
  try { if (grant && !rootMarkerPresent(core.paths.home)) return "root_marker_required"; }
  catch { return "root_marker_invalid"; }
  try { if (grantSuspensionProblem(core.paths.home, grant)) return "ssh_install_failed"; }
  catch { return "grant_suspension_invalid"; }
  const actor = core.roster.nodes.get(actorNode);
  const owner = grant && core.roster.nodes.get(grant.owner_node);
  const switches = readSwitches(core.paths.config);
  return authorizeProvision({
    grant, teamId: core.teamId, targetHandle: core.me()?.handle ?? null, targetNode: core.nodeId,
    actorHandle: actor && !actor.revoked ? nodeMember(core.roster, actorNode)?.handle ?? null : null,
    actorNode: actor && !actor.revoked ? actorNode : null,
    actorRole: actor && !actor.revoked ? nodeMember(core.roster, actorNode)?.role ?? null : null,
    ownerHandle: owner && !owner.revoked ? nodeMember(core.roster, owner.node_id)?.handle ?? null : null,
    ownerNodeCurrent: !!owner && !owner.revoked && nodeMember(core.roster, owner.node_id)?.role === "owner",
    remoteAdmin: switches.remote_admin, agentAdmin: switches.agent_admin, profile: id, localPerson,
  });
}
