import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../protocol/canonical.ts";
import { NodeId } from "../../protocol/schemas.ts";
import type { Core } from "../core.ts";
import { HttpError } from "../http.ts";
import { verifySig } from "../keys.ts";
import { PeerCallError, type PeerClient } from "../peer-client.ts";
import { GRANT_DAYS, type Grant } from "../provision/grant.ts";
import { nodeMember } from "../roster.ts";

const PREFIX = "walkie:ssh-revoke:v1:";
const ADMIN_AGENT = "walkie-admin";
export const SSH_REVOCATION_CAP = "ssh_revocation_v1";
/** What a person is told when the only answers were 404s: released pre.10 / pre.10.1 daemons have no receipt route. */
const OLDER_PEERS_MESSAGE = "SSH revocation is recorded on this machine only: the team machines asked run an older Walkie that cannot hold its receipt (update the roster authority first)";
/** How long one team peer gets to store a receipt before the revocation goes on without it. */
export const RECEIPT_PEER_TIMEOUT_MS = 3_000;
/** A receipt names a grant created in the last 91 days: a grant lives at most GRANT_DAYS (90), plus a day of clock slack. */
export const RECEIPT_WINDOW_MS = (GRANT_DAYS + 1) * 86_400_000;
/** The most receipts one node may have stored inside that window. Only its own signing key can make them. */
export const RECEIPTS_PER_TARGET = 10;
/** Each stored receipt makes the authority publish a team post, so one node gets five a minute. */
const RECEIPT_RATE = { capacity: 5, perSecond: 5 / 60 } as const;

const Packet = z.object({
  v: z.literal(1), team: z.string().regex(/^[0-9a-f]{16}$/), target: NodeId,
  grant_created_at: z.number().int().safe().positive(), owner_node: NodeId,
  owner_key_hash: z.string().regex(/^[0-9a-f]{64}$/), sig: z.string().max(200),
}).strict();
export type SshRevocationPacket = z.infer<typeof Packet>;

function signedPart(packet: Omit<SshRevocationPacket, "sig">): string {
  return `${PREFIX}${canonicalJson(packet)}`;
}

function keyHash(grant: Grant): string {
  return createHash("sha256").update(grant.owner_ssh?.public_key ?? "").digest("hex");
}

export function signSshRevocation(core: Core, grant: Grant): SshRevocationPacket {
  if (!grant.owner_ssh || grant.team_id !== core.teamId || grant.target_node !== core.nodeId) throw new Error("SSH grant does not belong to this node");
  const unsigned = { v: 1 as const, team: grant.team_id, target: core.nodeId, grant_created_at: grant.created_at,
    owner_node: grant.owner_node, owner_key_hash: keyHash(grant) };
  return { ...unsigned, sig: core.keys.sign(signedPart(unsigned)) };
}

function valid(core: Core, packet: SshRevocationPacket): boolean {
  const node = core.roster.nodes.get(packet.target);
  if (!node || packet.team !== core.teamId) return false;
  const { sig, ...unsigned } = packet;
  return verifySig(node.pubkey, signedPart(unsigned), sig);
}

/**
 * Every receipt post comes from a daemon's `walkie-admin` agent, so the lookups start at that agent's index and read
 * only its posts, not every #general post. The unary plus keeps SQLite from choosing the wide kind/channel/status
 * indexes instead.
 */
export const RECEIPT_SQL = `SELECT id, body FROM events WHERE author_agent = '${ADMIN_AGENT}' AND +kind = 'msg.post' AND +channel = 'general' ` +
  `AND +status = 'ok' AND +redacted = 0 AND json_extract(body, '$.text') LIKE '${PREFIX}%'`;

interface Stored { id: string; packet: SshRevocationPacket }

function parseReceipt(body: string): SshRevocationPacket | null {
  try {
    const text = (JSON.parse(body) as { text?: unknown }).text;
    const parsed = Packet.safeParse(typeof text === "string" && text.startsWith(PREFIX) ? JSON.parse(text.slice(PREFIX.length)) : null);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** The correctly signed receipts naming `target` that this node's log holds, whichever node posted them. */
function receiptsOf(core: Core, target: string): Stored[] {
  const out: Stored[] = [];
  for (const row of core.store.db.query<{ id: string; body: string }, []>(RECEIPT_SQL).all()) {
    const packet = parseReceipt(row.body);
    if (packet && packet.target === target && valid(core, packet)) out.push({ id: row.id, packet });
  }
  return out;
}

/**
 * A peer stores the target-signed receipt as an ordinary signed team post, compatible with older peers. Storing one
 * makes this node publish a post for the caller, so who may ask, how often and how many are bounded: never an
 * observer, five a minute per node, one receipt per (node, grant) whatever the signature bytes, at most ten per node
 * in the window, and only for a grant that can still be live. A receipt this node already holds is answered with its
 * event id and costs nothing.
 */
export function retainSshRevocation(core: Core, caller: string, input: unknown, now = Date.now()): string {
  const parsed = Packet.safeParse(input);
  if (!parsed.success || parsed.data.target !== caller || !valid(core, parsed.data)) {
    throw new HttpError(403, "invalid_ssh_revocation", "SSH revocation packet is invalid");
  }
  const packet = parsed.data;
  if (nodeMember(core.roster, caller)?.role === "observer") throw new HttpError(403, "forbidden", "observers cannot store SSH revocation receipts");
  if (packet.grant_created_at < now - RECEIPT_WINDOW_MS) throw new HttpError(400, "ssh_revocation_stale", "SSH revocation names a grant older than a grant can live");
  const held = receiptsOf(core, caller);
  const same = held.find((r) => r.packet.grant_created_at === packet.grant_created_at);
  if (same) return same.id;
  if (held.filter((r) => r.packet.grant_created_at >= now - RECEIPT_WINDOW_MS).length >= RECEIPTS_PER_TARGET) {
    throw new HttpError(429, "ssh_receipts_capped", `this machine already has ${RECEIPTS_PER_TARGET} SSH revocation receipts in the last ${GRANT_DAYS + 1} days`);
  }
  if (!core.limiter.take(`ssh-revocation:${caller}`, RECEIPT_RATE, now)) throw new HttpError(429, "rate_limited", "too many SSH revocation receipts");
  if (!core.roster.channels.has("general")) throw new HttpError(503, "team_not_ready", "team channel is not ready");
  return core.emit("msg.post", { text: `${PREFIX}${JSON.stringify(packet)}` }, { channel: "general", agent: ADMIN_AGENT }).id;
}

/** Rows written through this connection so far: any new, re-validated or redacted event moves it (the vv alone would not). */
function storeVersion(core: Core): number {
  return core.store.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n ?? -1;
}

const verdicts = new WeakMap<Core, Map<string, { version: number; revoked: boolean }>>();
const MAX_VERDICTS = 8;

/**
 * A receipt revokes only the grant it names (its creation time identifies a grant on this target: a new consent is
 * always created after the old grant's revocation). A later grant with the same target and owner key is not blocked.
 * The tunnel check runs every 250 ms per live tunnel, so the verdict is reused until the store has changed.
 */
export function teamSshRevoked(core: Core, grant: Grant): boolean {
  if (!grant.owner_ssh) return false;
  const hash = keyHash(grant);
  const key = `${grant.created_at}:${hash}`;
  const version = storeVersion(core);
  const memo = verdicts.get(core) ?? new Map<string, { version: number; revoked: boolean }>();
  const hit = memo.get(key);
  if (hit && hit.version === version) return hit.revoked;
  const revoked = receiptsOf(core, core.nodeId)
    .some((r) => r.packet.grant_created_at === grant.created_at && r.packet.owner_key_hash === hash);
  if (memo.size >= MAX_VERDICTS) memo.clear();
  memo.set(key, { version, revoked });
  verdicts.set(core, memo);
  return revoked;
}

/** `promise`, or a rejection after `ms`: a peer that never answers must not hold the revocation up. */
function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); });
  promise.catch(() => undefined); // a failure that arrives after the bound is not an unhandled rejection
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * The roster authority holds every receipt, and the SSH gate trusts only its view of the log. A target that is not
 * the authority therefore sends its receipt to the authority alone: a copy on any other peer would never be consulted.
 * A target that is the authority stores the receipt in its own log, then also offers it to every reachable peer,
 * because a receipt it could not write locally survives only on those peers. Peers are asked all at once and each
 * gets `timeoutMs`, so a silent peer delays the caller by one bound, not one per peer.
 */
export async function publishSshRevocation(core: Core, client: PeerClient, grant: Grant, timeoutMs = RECEIPT_PEER_TIMEOUT_MS): Promise<void> {
  const packet = signSshRevocation(core, grant);
  if (nodeMember(core.roster, core.nodeId)?.role === "observer") {
    throw new Error("observer machines cannot store SSH revocation receipts with the team; the revocation is kept on this machine only");
  }
  const authority = core.authority;
  if (!authority) throw new Error("SSH revocation requires a team authority");
  const isAuthority = authority === core.nodeId;
  let retained = false;
  if (isAuthority) {
    try { retainSshRevocation(core, core.nodeId, packet); retained = true; }
    catch (err) { core.log.warn("ssh_revocation_local_failed", { error: (err as Error).message }); }
  }
  const peers = isAuthority
    ? [...core.roster.nodes.values()].filter((node) => node.node_id !== core.nodeId && !node.revoked)
    : [core.roster.nodes.get(authority)].filter((node) => !!node);
  const outcomes = await Promise.all(peers.map(async (peer): Promise<"stored" | "unsupported" | "failed" | "skipped"> => {
    const addr = peer && client.addrOf(peer);
    if (!peer || !addr) return "skipped";
    try { await within(timeoutMs, client.sshRevoke(addr, packet, timeoutMs)); return "stored"; }
    catch (err) {
      // A 404 is a released daemon without this route: it can never hold a receipt, so it is neither retried nor a fault.
      if (err instanceof PeerCallError && err.status === 404) {
        core.log.info("ssh_revocation_peer_unsupported", { peer: peer.node_id });
        return "unsupported";
      }
      core.log.warn("ssh_revocation_peer_failed", { peer: peer.node_id, error: (err as Error).message });
      return "failed";
    }
  }));
  if (retained || outcomes.includes("stored")) return;
  const asked = outcomes.filter((outcome) => outcome !== "skipped");
  if (asked.length > 0 && asked.every((outcome) => outcome === "unsupported")) throw new Error(OLDER_PEERS_MESSAGE);
  throw new Error("SSH revocation could not be retained by a team peer");
}
