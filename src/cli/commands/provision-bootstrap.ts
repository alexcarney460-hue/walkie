// `walkie provision grant-bootstrap`: how the Windows enrollment records the person's one consent from inside WSL.
// The person typed ALLOW in the PowerShell bootstrap's own consent (which names the owner, the launchers, the seat cap,
// the profile and, when the link carried it, owner SSH); the elevated bootstrap then installed the root-owned marker
// and runs this, as the Ubuntu user, with ONE JSON object on stdin. It posts the same POST /v1/provision/grant the
// terminal and the desktop app post (surface "windows"), with `consentText(..., owner_ssh)` and the packet in that one
// request. A packet is dropped, said plainly, when it is damaged or when this Ubuntu already runs an SSH server that is not
// Walkie's (src/cli/ssh-foreign.ts): the consent recorded then leaves SSH out. Not for terminals: a person at a terminal
// uses `walkie provision grant` and types their own yes.
import { z } from "zod";
import { WalkieError } from "../../client/index.ts";
import { consentText } from "../../daemon/provision/consent.ts";
import { isWsl } from "../../daemon/machine-stats/wsl.ts";
import { profile as builtInProfile } from "../../daemon/provision/profiles.ts";
import { Handle, NodeId } from "../../protocol/schemas.ts";
import { UsageError } from "../args.ts";
import { EXIT, type Ctx } from "../context.ts";
import { c } from "../format.ts";
import { grantRefusalLine, OWNER_SSH_DAMAGED, readOwnerSsh } from "../ssh-packet.ts";
import type { SshStepDeps } from "../ssh-enroll.ts";
import { FOREIGN_SSH_CONTINUES, ownerSshUnlessForeign } from "../ssh-foreign.ts";

const BootstrapInput = z.object({
  owner_node: NodeId, owner_handle: Handle,
  launchers: z.array(z.string().min(2).max(140)).min(1).max(20),
  seat_cap: z.number().int().min(1).max(64),
  profile: z.enum(["developer-worker", "freight-worker"]),
  /** The invite's id (sha256 of its one-use secret, first 32 hex): what the packet must name. The invite itself never reaches here. */
  invite_id: z.string().regex(/^[0-9a-f]{32}$/),
  owner_ssh: z.string().regex(/^[A-Za-z0-9_-]{1,1200}$/).optional(),
}).strict();

export interface BootstrapGrantDeps {
  stdinIsTty: boolean;
  isWsl(): Promise<boolean>;
  markerPresent(): boolean;
  now(): number;
  /** The SSH status and unit hints of this Ubuntu: to see whether an SSH server that is not Walkie's already answers on 22. Absent: not looked at. */
  ssh?: SshStepDeps;
}

export async function grantFromBootstrap(ctx: Ctx, raw: string, deps: BootstrapGrantDeps): Promise<number> {
  if (deps.stdinIsTty) throw new UsageError("provision grant-bootstrap takes the Windows enrollment's JSON on stdin; at a terminal use: walkie provision grant");
  if (!(await deps.isWsl())) throw new UsageError("provision grant-bootstrap is for the Windows enrollment, inside WSL");
  let parsed: z.infer<typeof BootstrapInput>;
  try { parsed = BootstrapInput.parse(JSON.parse(raw)); }
  catch { throw new UsageError("provision grant-bootstrap: the enrollment input is not the expected JSON"); }
  if (!deps.markerPresent()) throw new UsageError("the root-owned enrollment marker is missing: the enrollment's root batch installs it before this step");
  const client = ctx.client();
  const [me, team] = await Promise.all([client.me(), client.team()]);
  const ownerNode = team.nodes.find((n) => n.node_id === parsed.owner_node);
  const owner = ownerNode && team.members.find((m) => m.handle === ownerNode.handle && m.role === "owner");
  if (!me.team || !me.handle || !ownerNode || !owner || owner.handle !== parsed.owner_handle) {
    throw new UsageError("the owner named by the enrollment is not a current owner of the team this machine joined");
  }
  const ssh = readOwnerSsh(parsed.owner_ssh, { teamId: me.team.id, handle: me.handle, ownerNode: ownerNode.node_id,
    ownerHandle: owner.handle, inviteId: parsed.invite_id, now: deps.now() });
  if (ssh.state === "damaged") ctx.err(c.yellow(OWNER_SSH_DAMAGED.replace(" The consent below leaves SSH out.", " The enrollment continues without SSH.")));
  // The consent PowerShell showed could not know whether this Ubuntu already runs its own SSH server. Walkie does not use one
  // that is not its own: owner SSH stays off, the consent recorded is the one without SSH, and the reason is said here.
  const ownerSsh = await ownerSshUnlessForeign(ssh.state === "carried" ? ssh.packet : undefined, deps.ssh, (line) => ctx.err(c.yellow(line)), FOREIGN_SSH_CONTINUES);
  const profiles = [{ id: parsed.profile, version: builtInProfile(parsed.profile)?.version ?? 1 }];
  const text = consentText(owner.handle, parsed.launchers, parsed.seat_cap, profiles, undefined, ownerSsh);
  try {
    const grant = await client.provisionGrant({ owner_node: ownerNode.node_id, launchers: parsed.launchers, seat_cap: parsed.seat_cap, profiles,
      ...(ownerSsh ? { owner_ssh: ownerSsh } : {}), company_mode: true, consent_version: 1, consent_text: text, consented: true,
      confirmation: { surface: "windows", typed_phrase: "yes" } });
    ctx.out(`enrollment grant for @${owner.handle} recorded; expires ${new Date(grant.expires_at).toISOString()}`);
    return EXIT.ok;
  } catch (error) {
    const line = error instanceof WalkieError ? grantRefusalLine(error.code, error.message, "run the Windows installer again") : null;
    if (line) throw new UsageError(`nothing was recorded: ${line}`);
    throw error;
  }
}

export function realBootstrapDeps(markerPresent: () => boolean, ssh?: SshStepDeps): BootstrapGrantDeps {
  return { stdinIsTty: process.stdin.isTTY === true, isWsl: () => isWsl(), markerPresent, now: Date.now, ...(ssh ? { ssh } : {}) };
}
