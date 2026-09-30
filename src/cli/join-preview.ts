// Native app preflight. The invite is read on stdin and sent only to its pinned roster authority.
import { decodeInvite } from "../daemon/invite.ts";
import { generateKeys } from "../daemon/keys.ts";
import { DirectNet, type DirectOptions } from "../daemon/direct/net.ts";
import type { Logger } from "../daemon/logger.ts";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export async function previewInvite(code: string, options: DirectOptions = {}): Promise<{ team_id: string; team_name: string; inviter_handle: string; spent: boolean }> {
  const inv = decodeInvite(code);
  if ("error" in inv) throw new Error("The invite is malformed.");
  const net = await DirectNet.start({ keys: generateKeys(), log: quiet, admitted: () => false,
    handler: async () => new Response(null, { status: 403 }) }, options);
  try {
    const response = await net.request({ ip: "", port: 0, pubkey: inv.authority, ...(inv.relay ? { relay: inv.relay } : {}) }, {
      method: "POST", path: "/peer/v1/invite-preview", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`The authority could not verify this invite (HTTP ${response.status}). Ask for a new link or an updated authority.`);
    const data: unknown = await response.json();
    if (!data || typeof data !== "object") throw new Error("The authority sent an invalid preview.");
    const p = data as Record<string, unknown>;
    if (p.team_id !== inv.team || typeof p.team_name !== "string" || !p.team_name || p.team_name.length > 100 || typeof p.spent !== "boolean" ||
      typeof p.inviter_handle !== "string" || !/^[a-z][a-z0-9-]{0,23}$/.test(p.inviter_handle)) {
      throw new Error("The authority's team or inviter does not match this invite.");
    }
    return { team_id: p.team_id, team_name: p.team_name, inviter_handle: p.inviter_handle, spent: p.spent } as { team_id: string; team_name: string; inviter_handle: string; spent: boolean };
  } finally {
    await net.stop();
  }
}
