// Shared fixtures for the owner-SSH integration tests: an owner who is also the roster authority ("lead") and one
// worker machine with a private SSH home, in a cluster of their own, plus the person's one local consent to an owner
// SSH packet, and a loopback echo server that stands in for sshd.
import { expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { decodeInvite } from "../../src/daemon/invite.ts";
import { consentText } from "../../src/daemon/provision/consent.ts";
import { readGrant, type Grant } from "../../src/daemon/provision/grant.ts";
import { PROFILES } from "../../src/daemon/provision/profiles.ts";
import { mintOwnerSshGrant } from "../../src/daemon/ssh/grant.ts";
import { waitFor, type Cluster, type TestNode } from "./cluster.ts";

export const profile = { id: "developer-worker" as const, version: PROFILES["developer-worker"].version };

export function publicKey(): string {
  const name = Buffer.from("ssh-ed25519");
  const a = Buffer.alloc(4); a.writeUInt32BE(name.length);
  const b = Buffer.alloc(4); b.writeUInt32BE(32);
  return `ssh-ed25519 ${Buffer.concat([a, name, b, Buffer.alloc(32, 3)]).toString("base64")}`;
}

export const failWrite = (): never => { throw new Error("injected disk failure"); };
export const everyWriteFails = { record: failWrite, audit: failWrite, adminAudit: failWrite, grantState: failWrite };

export interface IsolatedTeam { lead: TestNode; worker: TestNode; home: string; inviteId: string }

/** An owner (also the roster authority) and one worker machine, in a cluster of their own. `sshPort`: the fake sshd. */
export async function isolatedTeam(isolated: Cluster, teamName: string, sshPort: number): Promise<IsolatedTeam> {
  const home = join(isolated.root, "person-ssh");
  mkdirSync(home);
  const lead = await isolated.add({ name: "lead", login: "-", direct: true });
  const worker = await isolated.add({ name: "worker", login: "-", direct: true, sshUserHome: home, sshPort });
  await lead.client().init(teamName, "alex");
  const invite = await lead.client().inviteCode("kira");
  const decoded = decodeInvite(invite.code);
  if ("error" in decoded) throw new Error("test invite malformed");
  expect((await worker.client().join(invite.code)).admitted).toBe(true);
  await waitFor(() => worker.d.core.roster.nodes.has(lead.d.nodeId) && worker.d.core.roster.invites?.has(decoded.id),
    { what: "worker roster before SSH grant" });
  return { lead, worker, home, inviteId: decoded.id };
}

/** The machine person's one local consent to the owner's SSH packet; a different expiry makes a distinct packet. */
export async function consentSsh(team: IsolatedTeam, expiresAt = Date.now() + 60_000): Promise<Grant> {
  const packet = mintOwnerSshGrant(team.lead.d.core.keys, { team_id: team.lead.d.core.teamId as string, owner_handle: "alex",
    recipient: "kira", invite_id: team.inviteId, public_key: publicKey(), expires_at: expiresAt });
  await team.worker.client().request("POST", "/v1/provision/grant", { owner_node: team.lead.d.nodeId, launchers: ["@alex"], seat_cap: 2,
    profiles: [profile], company_mode: true, owner_ssh: packet, consent_version: 1, consented: true,
    consent_text: consentText("alex", ["@alex"], 2, [profile], undefined, packet), confirmation: { surface: "desktop", typed_phrase: "yes" } });
  const grant = readGrant(team.worker.home);
  if (!grant?.owner_ssh) throw new Error("SSH grant missing");
  return grant;
}

/** A loopback echo server on a free port: what the daemon's tunnel connects to instead of a real sshd. */
export async function echoServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((socket) => { socket.on("data", (bytes) => socket.write(bytes)); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** A grant record naming `node` as the target (not installed on disk): enough to sign receipts and publish them. */
export function grantFor(node: TestNode, ownerNode: TestNode = node, createdAt = Date.now()): Grant {
  const teamId = node.d.core.teamId as string;
  return { team_id: teamId, owner_node: ownerNode.d.nodeId, target_node: node.d.nodeId, recipient: "alex", consent_text: "consent",
    consent_version: 1, company_mode: true, launchers: ["@alex"], seat_cap: 1, profiles: [profile], created_at: createdAt,
    expires_at: createdAt + 86_400_000, ssh_state: "active",
    owner_ssh: mintOwnerSshGrant(ownerNode.d.core.keys, { team_id: teamId, owner_handle: "alex", recipient: "alex",
      invite_id: "c".repeat(32), public_key: publicKey(), expires_at: createdAt + 60_000 }) };
}
