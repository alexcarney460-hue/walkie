import { VERSION } from "./version.ts";
import { SEATS_V2_CAP } from "../protocol/seats.ts";
import { hostFor } from "./orchestrator/host.ts";
import { ScheduleClaim } from "./orchestrator/leadership.ts";
import { ScheduleDefaultRequest, ScheduleProgress } from "../protocol/talkie-management.ts";
import { SignedScheduleManagement, SignedSchedulePeer, verifyScheduleManagement, verifySchedulePeer } from "./orchestrator/schedule-forward.ts";
import { z } from "zod";
// Peer API (PROTOCOL §4). Two ways in, one set of handlers:
//   tailscale  bound to the Tailscale IP; `tailscale whois` + roster gate on every request.
//   direct     Walkie Direct (src/daemon/direct/net.ts): the caller's node key is authenticated by QUIC/TLS, and
//              the gate is that key ∈ the roster's admitted, non-revoked nodes of current members. Joining takes
//              an owner-signed invite instead of a whois login (src/daemon/invite.ts).
import { mayAdministerHere, servePeerAdmin } from "./admin/remote.ts";

/** How long a remote admin request's body may take to arrive. */
const ADMIN_BODY_MS = 10_000;
import type { Server } from "bun";
import { nodeIdFromPubkey } from "../protocol/ids.ts";
import { jsonDepthOk, stubOf } from "../protocol/header.ts";
import {
  AgentName, ChannelName, EventId, MAX_IDS_PER_FETCH, NodeId, PEER_PAGE_BUDGET, PeerEventsPush, PeerJoinReq, PeerVvRelay, RosterRequest,
  type Event, type PeerHello, type PeerJoinRes, type PeerOwnerAddr, type PeerPushRes,
} from "../protocol/schemas.ts";
import { blobServable } from "./blob-auth.ts";
import { readBlob } from "./blobs.ts";
import type { Core } from "./core.ts";
import { HttpError, errorResponse, json, normalizeIp, parseWith, readBytes, readJson } from "./http.ts";
import { shortNodeName, type WhoisResult } from "./identity.ts";
import { checkInvite, decodeInvite, directLogin } from "./invite.ts";
import { isValidPubkey } from "./keys.ts";
import { RateLimiter, type BucketSpec } from "./ratelimit.ts";
import { applyRequest } from "./requests.ts";
import { grantLease, probeLease, refreshBorrowedUsage } from "./vault-lease.ts";
import { LEASE_LAUNCHER_CAP } from "./vault-lease-policy.ts";
import {
  DEFAULT_PEER_PORT, canSeeChannel, directMemberByKey, endpointHex, isRestricted, memberByHandle, nodeMember, pickTransport, servesDirect, transportFields,
  transportsOf, withTransport, type MemberRec,
} from "./roster.ts";
import { JoinLimitError, type EventRow } from "./store.ts";
import type { TunnelDecision } from "./direct/net.ts";
import type { TunnelGrant } from "../pool/run/stage.ts";
import { WsEnd } from "../pool/run/tunnel.ts";
import { trackOp } from "./watchdog.ts";
import { PEER_SIG_CAP, PeerNonceBook, hasPeerSig, peerSigTier, signPeerVv, verifyPeerSigResult, type PeerSigHeaders, type PeerSigResult } from "./peer-sig.ts";
import { peerSigRequired, peerSigStrict, recordPeerProof, recordPeerSignature, rememberValidPeerSignature } from "./peer-capabilities.ts";
import { PeerClient } from "./peer-client.ts";
import { sshTunnelGrant } from "./ssh/tunnel.ts";
import { sshTunnelProblem } from "./ssh/tunnel.ts";
import { retainSshRevocation, SSH_REVOCATION_CAP } from "./ssh/team-revocation.ts";
import { userInfo } from "node:os";

export const PEER_BODY_MAX = 1024 * 1024;

/** A split-run tunnel's WebSocket (Tailscale): the stage's grant, and the End once open. */
export interface TunnelSocketData { grant: TunnelGrant; end: WsEnd | null }

function isStub(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { redacted?: unknown }).redacted === true;
}
const REQUEST_BODY_MAX = 256 * 1024;
/** Requests from keys that aren't admitted nodes (joiners, strangers), all of them together. */
const UNADMITTED_DIRECT: BucketSpec = { capacity: 20, perSecond: 5 };
/**
 * Separate from `core.limiter`. Unadmitted keys are free to mint; a per-key entry on the main limiter (512 keys,
 * least recently used dropped) let a stranger push out an admitted peer's bucket. One limiter per daemon.
 */
const unadmittedDirectLimiters = new WeakMap<Core, RateLimiter>();
function unadmittedDirectLimiter(core: Core): RateLimiter {
  let limiter = unadmittedDirectLimiters.get(core);
  if (!limiter) { limiter = new RateLimiter(); unadmittedDirectLimiters.set(core, limiter); }
  return limiter;
}

interface Caller { ip: string; who: WhoisResult; member: MemberRec }

/** Who is calling: a tailnet source IP (to `whois`), or a QUIC-authenticated node key (Walkie Direct). */
export type PeerOrigin = { readonly kind: "tailscale"; readonly ip: string } | { readonly kind: "direct"; readonly pubkey: string };


/** Where the roster authority listens (joins and roster requests go there, PROTOCOL §2). */
export function authorityAddr(core: Core): PeerOwnerAddr | null {
  const n = core.authority ? core.roster.nodes.get(core.authority) : undefined;
  if (!n) return null;
  return { node_id: n.node_id, hostname: n.hostname, ip: n.ip, port: n.port, ...(n.transports ? { pubkey: n.pubkey, transports: [...n.transports] } : {}) };
}

export class PeerApi {
  private readonly peerNonces = new PeerNonceBook(Date.now());
  private readonly unsignedWarned = new Map<string, number>();
  constructor(private readonly core: Core, private readonly sshOptions: { port?: number; keyHome?: string } = {}) {}

  private badSignature(reason: PeerSigResult = "bad_signature"): never {
    const message = reason === "clock_skew" ? "peer signature clock skew exceeds two minutes"
      : reason === "too_old" ? "peer signature is too old for this receiver or below its replay floor"
      : reason === "replay" ? "peer signature nonce was already used"
      : "valid node-key request signature required";
    throw new HttpError(403, "bad_peer_sig", message);
  }

  private async checkSignature(req: Request, url: URL, nodeId: string, pubkey: string): Promise<void> {
    const ts = req.headers.get("x-walkie-ts") ?? "";
    const nonce = req.headers.get("x-walkie-nonce") ?? "";
    const sig = req.headers.get("x-walkie-sig") ?? "";
    if (!/^(0|[1-9][0-9]*)$/.test(ts) || !/^[0-9a-f]{32}$/.test(nonce) || !sig) this.badSignature();
    const body = req.method === "GET" ? "" : url.pathname === "/peer/v1/admin/run"
      ? await Promise.race([readBytes(req, 64 * 1024), Bun.sleep(ADMIN_BODY_MS).then((): never => {
        throw new HttpError(408, "timeout", "the request body didn't arrive in time");
      })])
      : await readBytes(req, PEER_BODY_MAX);
    const admitted = this.core.roster.nodes.get(nodeId);
    const bookNonce = admitted?.pubkey === pubkey && !!nodeMember(this.core.roster, nodeId);
    const result = verifyPeerSigResult(pubkey, { method: req.method, path: url.pathname, query: url.search,
      body, requester: nodeId, target: this.core.nodeId, team: this.core.teamId ?? "", ts: Number(ts), nonce },
    { "X-Walkie-Ts": ts, "X-Walkie-Nonce": nonce, "X-Walkie-Sig": sig } satisfies PeerSigHeaders,
    this.peerNonces, Date.now(), bookNonce);
    if (result !== "valid") this.badSignature(result);
    if (bookNonce) {
      rememberValidPeerSignature(this.core.store, nodeId);
      recordPeerSignature(this.core, nodeId);
    }
  }

  private callerSigRequired(nodeId: string): boolean {
    return peerSigStrict(this.core.roster, this.core.store)
      || peerSigRequired(this.core.roster, this.core.store, nodeId);
  }

  private warnUnsigned(nodeId: string, path: string, method: string): void {
    const now = Date.now();
    if (now - (this.unsignedWarned.get(nodeId) ?? -Infinity) < 600_000) return;
    this.unsignedWarned.set(nodeId, now);
    this.core.log.warn("peer_unsigned", { node: nodeId, path, method });
  }

  start(host: string, port: number): Server<TunnelSocketData> {
    return Bun.serve<TunnelSocketData>({
      hostname: host,
      port,
      maxRequestBodySize: PEER_BODY_MAX + 1024,
      idleTimeout: 30,
      fetch: (req, server) => this.handle(req, normalizeIp(server.requestIP(req)?.address), server),
      error: (err) => errorResponse(err, this.core.log),
      // WALKIE-POOL-2: split-run tunnels over Tailscale (the gate ran before the upgrade; see upgradeTunnel).
      websocket: {
        maxPayloadLength: 1024 * 1024,
        idleTimeout: 0,
        open: (ws) => {
          const end = new WsEnd({ sendBytes: (b) => void ws.send(b), sendText: (t) => void ws.send(t), close: () => ws.close() },
            (fault) => this.core.log.warn("pool_tunnel_fault", { fault, via: "tailscale" }));
          ws.data.end = end;
          void ws.data.grant.accept(end).finally(() => { try { ws.close(); } catch { /* closed */ } });
        },
        message: (ws, msg) => ws.data.end?.message(typeof msg === "string" ? msg : new Uint8Array(msg)),
        close: (ws) => ws.data.end?.closed(),
      },
    });
  }

  /**
   * `from`: the tailnet source IP (a string), or the origin a transport established. `server` (Tailscale only) lets
   * a split-run tunnel upgrade to a WebSocket, after which there is no Response (undefined).
   */
  async handle(req: Request, from: string | PeerOrigin, server?: Server<TunnelSocketData>): Promise<Response> {
    try {
      const origin: PeerOrigin = typeof from === "string" ? { kind: "tailscale", ip: from } : from;
      return await trackOp(`peer ${req.method} ${new URL(req.url).pathname}`,
        () => (origin.kind === "direct" ? this.routeDirect(req, origin.pubkey) : this.route(req, origin.ip, server)));
    } catch (err) {
      return errorResponse(err, this.core.log);
    }
  }

  /**
   * WALKIE-POOL-2: a split-run tunnel over Walkie Direct (a CONNECT stream). The same gate as every Direct request
   * (the QUIC-authenticated key is an admitted node of a current member, rate limits, team header), then the stage
   * decides (only the run's head, only while it runs, within its tunnel caps).
   */
  async tunnelDirect(path: string, headers: Record<string, string>, pubkey: string): Promise<TunnelDecision> {
    const core = this.core;
    try {
      const nodeId = nodeIdFromPubkey(pubkey);
      const member = directMemberByKey(core.roster, pubkey);
      if (!member) {
        core.log.warn("peer_denied", { node: nodeId, path, via: "direct", reason: "tunnel_not_member" });
        throw new HttpError(403, "not_member", "caller is not an admitted machine of this team");
      }
      if (!core.limiter.take(`peer:direct:${nodeId}`, core.limits.peer)) throw new HttpError(429, "rate_limited", "slow down");
      const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      if (lower["x-walkie-team"] !== core.teamId) throw new HttpError(409, "conflict", "team mismatch");
      if (lower["x-walkie-node"] !== undefined && lower["x-walkie-node"] !== nodeId) throw new HttpError(403, "forbidden", "X-Walkie-Node does not match the connection's key");
      const signed = new Request(`http://peer.invalid${path}`, { headers });
      if (hasPeerSig(signed.headers)) await this.checkSignature(signed, new URL(signed.url), nodeId, pubkey);
      // These headers are supplied by the source node. Direct authenticates the
      // node key and roster owner; caller labels only add reported audit detail.
      const sshAgent = lower["x-walkie-ssh-claim"] ?? lower["x-walkie-ssh-agent"];
      const sshCaller = lower["x-walkie-ssh-caller"];
      if (path === "/peer/v1/ssh" && sshAgent !== undefined && !AgentName.safeParse(sshAgent).success) {
        throw new HttpError(400, "invalid_agent", "invalid SSH caller agent");
      }
      if (path === "/peer/v1/ssh" && sshCaller !== undefined &&
          sshCaller !== "person" && sshCaller !== "unverified caller" && !AgentName.safeParse(sshCaller).success) {
        throw new HttpError(400, "invalid_caller", "invalid SSH caller attribution");
      }
      const g = path === "/peer/v1/ssh" ? sshTunnelGrant(core, nodeId, this.sshOptions.port, this.sshOptions.keyHome,
        { caller: sshCaller ?? "unverified caller", ...(sshAgent ? { claim: sshAgent } : {}) }) : this.tunnelGrant(path, nodeId);
      return { accept: g.accept, release: g.release };
    } catch (err) {
      return { refuse: errorResponse(err, core.log) };
    }
  }

  /**
   * The grant for `/peer/v1/pool/tunnel/<run>` (a split run's stage) or `/peer/v1/pool/serve-tunnel/<id>` (a served
   * model's proxy, POOL-REAL-1) from an admitted node (throws the refusal).
   */
  private tunnelGrant(path: string, nodeId: string): TunnelGrant {
    const m = /^\/peer\/v1\/pool\/(tunnel|serve-tunnel)\/([0-9a-f]{32})$/.exec(path);
    if (!m) throw new HttpError(404, "not_found", "not found");
    if (!this.core.pool) throw new HttpError(404, "not_found", "split runs are not available on this daemon");
    if (m[1] === "serve-tunnel") {
      const member = nodeMember(this.core.roster, nodeId);
      if (!member || member.role === "observer") throw new HttpError(403, "forbidden", "an observer's machine can't use served models");
      if (!this.core.limiter.take(`pool-serve-tunnel:${nodeId}`, { capacity: 60, perSecond: 1 })) throw new HttpError(429, "rate_limited", "too many tunnel requests");
      return this.core.pool.server.tunnel(m[2]!, nodeId);
    }
    return this.core.pool.stages.tunnel(m[2]!, nodeId);
  }

  private async route(req: Request, ip: string, server?: Server<TunnelSocketData>): Promise<Response> {
    const url = new URL(req.url);
    const core = this.core;
    if (!url.pathname.startsWith("/peer/v1/")) throw new HttpError(404, "not_found", "not found");
    const nodeHdr = req.headers.get("x-walkie-node") ?? "";
    // Keyed on the WireGuard-authenticated source IP only: headers are caller-controlled.
    if (!core.limiter.take(`peer:${ip}`, core.limits.peer)) throw new HttpError(429, "rate_limited", "slow down");

    const who = await core.identity.whois(ip, req.headers);
    if (!who) throw new HttpError(403, "forbidden", "caller is not a known tailnet identity");
    // Walkie Direct members have `direct:<handle>` logins and no tailnet identity: a whois answer can never be one.
    if (who.login.startsWith("direct:")) {
      core.log.warn("peer_denied", { ip, path: url.pathname, reason: "direct_login_over_tailscale" });
      throw new HttpError(403, "not_member", "caller is not a member of this team");
    }
    const member = core.roster.members.get(who.login);
    if (!member || member.role === "removed") {
      core.log.warn("peer_denied", { ip, login: who.login, path: url.pathname, reason: "not_member" });
      throw new HttpError(403, "not_member", "caller is not a member of this team");
    }
    const caller: Caller = { ip, who, member };
    const path = url.pathname;

    if (req.method === "GET" && path === "/peer/v1/hello") {
      if (hasPeerSig(req.headers)) {
        const node = core.roster.nodes.get(nodeHdr);
        // A joiner's public key is not in the roster yet. Discovery is public to a member's login.
        if (node) await this.checkSignature(req.clone(), url, nodeHdr, node.pubkey);
      }
      return json(this.hello());
    }
    if (req.method === "POST" && path === "/peer/v1/join") {
      const known = core.roster.nodes.get(nodeHdr);
      if (known && !hasPeerSig(req.headers) && this.callerSigRequired(nodeHdr)) this.badSignature();
      return json(await this.join(req, req.clone(), caller, nodeHdr));
    }

    const team = core.teamId;
    if (req.headers.get("x-walkie-team") !== team) throw new HttpError(409, "conflict", "team mismatch");
    const node = core.roster.nodes.get(nodeHdr);
    // A Direct-only machine (its record doesn't serve Tailscale) is never let in over the tailnet, whatever login.
    if (!node || node.revoked || node.login !== who.login || node.ip !== ip || !transportsOf(node).includes("tailscale")) {
      core.log.warn("peer_denied", { ip, login: who.login, node: nodeHdr, path, reason: "node_not_admitted" });
      throw new HttpError(403, "forbidden", "calling node is not admitted");
    }
    const tier = peerSigTier(req.method, path);
    const present = hasPeerSig(req.headers);
    if (tier === "A" && !present) this.badSignature();
    if (tier === "B" && !present) {
      if (this.callerSigRequired(nodeHdr)) this.badSignature();
      this.warnUnsigned(nodeHdr, path, req.method);
    }
    if (present) await this.checkSignature(req.clone(), url, nodeHdr, node.pubkey);
    if (path.startsWith("/peer/v1/pool/tunnel/") || path.startsWith("/peer/v1/pool/serve-tunnel/")) {
      // WALKIE-POOL-2: the gate above passed (tailnet identity -> admitted node of a current member); the stage decides.
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket" || !server) throw new HttpError(426, "upgrade_required", "a tunnel is a WebSocket");
      const grant = this.tunnelGrant(path, nodeHdr);
      if (server.upgrade(req, { data: { grant, end: null } })) return undefined as unknown as Response;
      grant.release();
      throw new HttpError(400, "invalid", "WebSocket upgrade failed");
    }
    // AGENT-ADMIN-1: a remote admin command may run for minutes; the 30 s idle timeout is lifted for it, but only for a
    // caller who may administer this machine (fix round 2: never for anyone who could just hold a connection open).
    if (path === "/peer/v1/admin/run" && mayAdministerHere(core, member)) server?.timeout(req, 0);
    return this.serveAdmitted(req, url, nodeHdr, member);
  }

  /**
   * Walkie Direct gate: the QUIC-authenticated key names the node. Admitted nodes are limited per endpoint on the
   * main limiter. Every key that isn't an admitted node shares one pre-auth limiter (keys are free to mint) and
   * does not take a slot on the main one. A revoked node, a removed member's node and an outsider all get
   * `403 not_member`; only `/join` with a valid invite admits a new key.
   */
  private async routeDirect(req: Request, pubkey: string): Promise<Response> {
    const url = new URL(req.url);
    const core = this.core;
    if (!url.pathname.startsWith("/peer/v1/")) throw new HttpError(404, "not_found", "not found");
    const nodeId = nodeIdFromPubkey(pubkey);
    // The stored key must match, not just the 64-bit id, and the record must serve Direct (a Tailscale-only
    // machine's key gets in only after proving it with a Direct /join: PROTOCOL §4 "Mixed teams").
    const member = directMemberByKey(core.roster, pubkey);
    if (!member) {
      if (!unadmittedDirectLimiter(core).take("peer:direct-unadmitted", UNADMITTED_DIRECT)) throw new HttpError(429, "rate_limited", "slow down");
    } else if (!core.limiter.take(`peer:direct:${nodeId}`, core.limits.peer)) throw new HttpError(429, "rate_limited", "slow down");
    const path = url.pathname;
    if (hasPeerSig(req.headers)) await this.checkSignature(req.clone(), url, nodeId, pubkey);

    if (req.method === "POST" && path === "/peer/v1/join") return json(await this.joinDirect(req, pubkey, nodeId));
    if (req.method === "POST" && path === "/peer/v1/invite-preview") {
      const body = await readJson(req, 512);
      if (!body || typeof body !== "object" || typeof (body as { code?: unknown }).code !== "string") throw new HttpError(400, "invalid", "invite code required");
      const team = core.teamId;
      if (!team) throw new HttpError(409, "no_team", "this authority has no team");
      const check = checkInvite((body as { code: string }).code, core.roster, team, core.clock());
      if (!check.ok && check.reason !== "invite_used") throw new HttpError(403, check.reason, "invite cannot be verified by this authority");
      if (!core.isAuthority()) throw new HttpError(409, "not_authority", "the roster authority has moved; ask for a new link");
      const invite = check.ok ? check.invite : decodeInvite((body as { code: string }).code);
      if ("error" in invite) throw new HttpError(403, "invite_malformed", "invite cannot be verified by this authority");
      const inviter = nodeMember(core.roster, invite.issuer);
      if (!inviter || inviter.role !== "owner") throw new HttpError(403, "invite_issuer_not_owner", "inviter is no longer a team owner");
      return json({ team_id: team, team_name: core.roster.team?.name, inviter_handle: inviter.handle, spent: !check.ok });
    }
    if (!member) {
      const n = core.roster.nodes.get(nodeId);
      const reason = !n ? "not_member" : n.revoked ? "node_revoked" : nodeMember(core.roster, nodeId) ? "not_direct" : "member_removed";
      core.log.warn("peer_denied", { node: nodeId, path, via: "direct", reason });
      throw new HttpError(403, "not_member", "caller is not an admitted machine of this team");
    }
    if (req.method === "GET" && path === "/peer/v1/hello") return json(this.hello());
    if (req.headers.get("x-walkie-team") !== core.teamId) throw new HttpError(409, "conflict", "team mismatch");
    const nodeHdr = req.headers.get("x-walkie-node");
    if (nodeHdr !== null && nodeHdr !== nodeId) {
      core.log.warn("peer_denied", { node: nodeId, path, via: "direct", reason: "node_header_mismatch" });
      throw new HttpError(403, "forbidden", "X-Walkie-Node does not match the connection's key");
    }
    if (req.method === "GET" && path === "/peer/v1/ssh/info") {
      const problem = sshTunnelProblem(core, nodeId);
      if (problem) throw new HttpError(403, problem, `SSH unavailable: ${problem}`);
      return json({ user: userInfo().username });
    }
    return this.serveAdmitted(req, url, nodeId, member);
  }

  /** The endpoints behind the gate, for an admitted node `nodeId` of `member`. */
  private async serveAdmitted(req: Request, url: URL, nodeId: string, member: MemberRec): Promise<Response> {
    const core = this.core;
    const path = url.pathname;
    core.onPeerContact?.(nodeId); // the gate has passed: this machine is up (presence rule, sync.ts)
    if (req.method === "GET" && path === "/peer/v1/vv") {
      const online = core.reachedPeers?.() ?? [];
      const body = {
        node: core.nodeId, vv: core.store.vv(), ts: Date.now(),
        capabilities: { version: VERSION, caps: [SEATS_V2_CAP, PEER_SIG_CAP, SSH_REVOCATION_CAP, LEASE_LAUNCHER_CAP] },
        ...(online.length ? { online } : {}),
        ...(core.publishedStats() ? { stats: core.publishedStats() } : {}),
        ...(core.accounts ? { accounts: core.accounts } : {}), // ACCOUNTS-1: this machine's accounts + usage (PROTOCOL §3)
        ...(core.poolShare?.() ? { pool: core.poolShare() } : {}), // WALKIE-POOL-2: split-run sharing (PROTOCOL §3)
      };
      const challenge = req.headers.get("x-walkie-vv-challenge") ?? "";
      if (!/^[0-9a-f]{32}$/.test(challenge)) return json(body);
      const relay_proof = signPeerVv(core.keys, { node: body.node, ts: body.ts }, nodeId, challenge);
      const proved = { ...body, relay_proof };
      return json({ ...proved, proof: signPeerVv(core.keys, proved, nodeId, challenge) });
    }
    if (req.method === "POST" && path === "/peer/v1/peer-proof") {
      if (!core.isAuthority()) throw new HttpError(409, "not_authority", "this node is not the roster authority");
      if (!core.limiter.take(`peer-proof:${nodeId}`, { capacity: 30, perSecond: 1 })) {
        throw new HttpError(429, "rate_limited", "too many peer proofs");
      }
      const report = parseWith(PeerVvRelay, await readJson(req, 4 * 1024));
      const recorded = recordPeerProof(core, report, nodeId);
      if (recorded === "invalid") {
        throw new HttpError(403, "bad_peer_proof", "node-key proof is invalid or expired");
      }
      return json({ recorded: recorded === "recorded" });
    }
    if (req.method === "POST" && path === "/peer/v1/orchestrator/lease") {
      verifySchedulePeer(core, nodeId, "lease", parseWith(SignedSchedulePeer, await readJson(req, 1024)), z.object({}).strict());
      const host = hostFor(core);
      if (!host) throw new HttpError(503, "unavailable", "orchestrator leadership unavailable");
      if (!core.limiter.take(`orchestrator-lease:${nodeId}`, { capacity: 30, perSecond: 20 })) throw new HttpError(429, "rate_limited", "too many lease requests");
      return json(host.grantLeadership(nodeId));
    }
    if (req.method === "POST" && path === "/peer/v1/orchestrator/schedule-claim") {
      if (member.role !== "owner") throw new HttpError(403, "forbidden", "only an owner lead claims schedule runs");
      const host = hostFor(core);
      if (!host) throw new HttpError(503, "unavailable", "orchestrator leadership unavailable");
      const wire = parseWith(SignedSchedulePeer, await readJson(req, 24_000));
      const claim = verifySchedulePeer(core, nodeId, "schedule-claim", wire, ScheduleClaim);
      if (!core.limiter.take(`schedule-claim:${nodeId}`, { capacity: 30, perSecond: 5 })) throw new HttpError(429, "rate_limited", "too many schedule claims");
      return json(host.claimSchedule(nodeId, claim));
    }
    if (req.method === "POST" && path === "/peer/v1/orchestrator/schedule-manage") {
      if (!core.isAuthority()) throw new HttpError(409, "not_authority", "only the roster authority manages schedules");
      if (member.role !== "owner") throw new HttpError(403, "forbidden", "only a current owner manages schedules");
      const wire = parseWith(SignedScheduleManagement, await readJson(req, 24_000));
      const request = verifyScheduleManagement(core, nodeId, wire);
      if (!core.limiter.take(`schedule-manage:${nodeId}`, { capacity: 20, perSecond: 2 }))
        throw new HttpError(429, "rate_limited", "too many schedule changes");
      const host = hostFor(core);
      if (!host) throw new HttpError(503, "unavailable", "schedule authority is unavailable");
      const replay = host.schedules.replayed(request, nodeId);
      if (replay) return json(replay);
      if (!(await host.schedules.ensureChannel())) throw new HttpError(409, "channel_pending", "schedule channel is waiting for repair");
      return json(host.schedules.manage(request, nodeId));
    }
    if (req.method === "POST" && path === "/peer/v1/orchestrator/schedule-progress") {
      if (!core.isAuthority()) throw new HttpError(409, "not_authority", "only the schedule authority records progress");
      if (member.role === "observer") throw new HttpError(403, "forbidden", "observers cannot report schedule progress");
      const wire = parseWith(SignedSchedulePeer, await readJson(req, 24_000));
      const progress = verifySchedulePeer(core, nodeId, "schedule-progress", wire, ScheduleProgress);
      if (!core.limiter.take(`schedule-progress:${nodeId}`, { capacity: 60, perSecond: 5 }))
        throw new HttpError(429, "rate_limited", "too many schedule progress reports");
      const host = hostFor(core);
      if (!host) throw new HttpError(503, "unavailable", "schedule authority is unavailable");
      return json(host.schedules.progress(nodeId, progress, (node, epoch) => host.holdsScheduleLease(node, epoch), wire.ts, wire.sig));
    }
    if (req.method === "POST" && path === "/peer/v1/orchestrator/schedule-defaults") {
      if (!core.isAuthority()) throw new HttpError(409, "not_authority", "only the schedule authority writes defaults");
      const body = verifySchedulePeer(core, nodeId, "schedule-defaults",
        parseWith(SignedSchedulePeer, await readJson(req, 2048)), ScheduleDefaultRequest);
      if (!core.limiter.take(`schedule-defaults:${nodeId}`, { capacity: 5, perSecond: 0.2 }))
        throw new HttpError(429, "rate_limited", "too many default requests");
      const host = hostFor(core);
      if (!host || !host.holdsScheduleLease(nodeId, body.epoch))
        throw new HttpError(403, "forbidden", "only the current lead requests defaults");
      const before = core.store.channelEventCount("talkie-schedules");
      await host.schedules.defaultsForAuthority();
      return json({ created: core.store.channelEventCount("talkie-schedules") > before });
    }
    if (req.method === "POST" && path === "/peer/v1/vault/usage") {
      if (member.role === "observer") throw new HttpError(403, "forbidden", "observers cannot refresh borrowed accounts");
      return json(refreshBorrowedUsage(core, { vault: core.vault, sharing: core.vaultSharing, teamPolicy: core.teamPolicy }, nodeId, member, await readJson(req, 1024)));
    }
    if (req.method === "POST" && path === "/peer/v1/vault/lease") {
      // ACCOUNTS-2 phase 3: a setup-token from this machine's vault, if its policy allows the caller (vault-lease.ts).
      const res = await grantLease(core, { vault: core.vault, sharing: core.vaultSharing, nonces: core.vaultNonces, grants: core.vaultGrants, teamPolicy: core.teamPolicy, roomLeft: core.vaultRoomLeft, renew: core.vaultRenew }, nodeId, member, await readJson(req, 16 * 1024));
      return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    if (req.method === "POST" && path === "/peer/v1/vault/probe") {
      return json(await probeLease(core, { vault: core.vault, sharing: core.vaultSharing, nonces: core.vaultNonces,
        teamPolicy: core.teamPolicy, roomLeft: core.vaultRoomLeft }, nodeId, member, await readJson(req, 1024)));
    }
    if (req.method === "GET" && path === "/peer/v1/events") return json(this.serveEvents(url, member.handle));
    if (req.method === "POST" && path === "/peer/v1/events") return json(await this.receive(req, nodeId));
    if (req.method === "POST" && path === "/peer/v1/roster-request") return json(await this.rosterRequest(req, nodeId));
    if (req.method === "POST" && path === "/peer/v1/ssh/revocation") {
      return json({ event_id: retainSshRevocation(core, nodeId, await readJson(req, 1024)) });
    }
    if (req.method === "POST" && path === "/peer/v1/pool/stage") return json(await this.poolStage(req, nodeId, member));
    if (req.method === "POST" && path === "/peer/v1/pool/serve") return json(await this.poolServe(req, nodeId, member));
    // AGENT-ADMIN-1: an allow-listed walkie command, for an owner or this machine's own person (admin/remote.ts).
    if (req.method === "POST" && path === "/peer/v1/admin/run") {
      // Who may is known before the body is read; the body must arrive within 10 s (fix round 2, Opus MEDIUM).
      if (!mayAdministerHere(core, member)) throw new HttpError(403, "not_your_machine", `${core.hostname} is not @${member.handle}'s machine, and only a team owner may administer another person's machine`);
      const body = await Promise.race([readJson(req, 64 * 1024), Bun.sleep(ADMIN_BODY_MS).then((): never => { throw new HttpError(408, "timeout", "the request body didn't arrive in time"); })]);
      return json(await servePeerAdmin(core, nodeId, member, body));
    }
    const blob = /^\/peer\/v1\/blobs\/([0-9a-f]{64})$/.exec(path);
    if (req.method === "GET" && blob) return this.serveBlob(blob[1] as string, url.searchParams.get("channel") ?? "", member.handle, nodeId);
    throw new HttpError(404, "not_found", "not found");
  }

  private hello(): PeerHello {
    const core = this.core;
    const r = core.roster;
    return { team: r.team?.id ?? "", name: r.team?.name ?? "", node_id: core.nodeId, hostname: core.hostname, authority: authorityAddr(core) };
  }

  /**
   * `/join` over Walkie Direct. An admitted key is answered at once (idempotent, any node). Otherwise the caller
   * must present an invite, which only the roster authority redeems: signature by a current owner node, this
   * team, not expired, never used (the chain records its id on the `team.node`, so no replica or later authority
   * accepts it again). The invite's handle names the member: a new one gets `team.member` (the invite's role),
   * a removed one is re-invited, a current one gains a machine. The key admitted is the connection's own.
   */
  private async joinDirect(req: Request, pubkey: string, nodeId: string): Promise<PeerJoinRes> {
    const core = this.core;
    const body = parseWith(PeerJoinReq, await readJson(req, PEER_BODY_MAX));
    if (body.pubkey !== pubkey) throw new HttpError(403, "forbidden", "a machine can only join with the key it connects with");
    const team = core.teamId;
    if (!team) throw new HttpError(409, "no_team", "this node is not in a team");
    const r = core.roster;
    const known = r.nodes.get(nodeId);
    if (known && known.pubkey !== pubkey) throw new HttpError(403, "forbidden", "another machine's key has this node id");
    if (known?.revoked && !known.revoked_by_removal) throw new HttpError(403, "forbidden", "this node was revoked; an owner must re-admit it");
    if (known && nodeMember(r, nodeId)) {
      if (servesDirect(known)) return { admitted: true, team, node_id: nodeId };
      return this.addDirect(known.node_id, pubkey);
    }
    if (!body.invite) throw new HttpError(403, "not_member", "joining over Walkie Direct needs an invite code (an owner runs: walkie invite --handle <name>)");
    // Every node checks the code against its roster before saying anything about the team: a non-authority names
    // the authority (hostname, key) only to a caller holding a code this team's owner really signed.
    const check = checkInvite(body.invite, r, team, core.clock());
    if (!check.ok) {
      // Never the code itself: it is a bearer credential until used.
      core.log.warn("direct_join_refused", { node: nodeId, reason: check.reason });
      throw new HttpError(403, check.reason, `invite refused: ${check.reason.replace(/^invite_/, "").replace(/_/g, " ")}`);
    }
    if (!core.isAuthority()) {
      const authority = authorityAddr(core);
      return { admitted: false, reason: "not_authority", ...(authority ? { authority } : {}) };
    }
    const inv = check.invite;
    const holder = memberByHandle(r, inv.handle);
    const login = holder?.login ?? directLogin(inv.handle);
    if (known && known.login !== login) throw new HttpError(403, "forbidden", "node belongs to another member");
    core.checkNodeCapacity(nodeId, login); // 409 node_limit
    core.checkPlan("team.node", { node_id: nodeId, login }); // 402 plan_limit, before anything is emitted
    core.checkPlan("team.member", { login, handle: inv.handle, role: inv.role });
    if (!holder || holder.role === "removed") core.emit("team.member", { login, handle: inv.handle, role: inv.role });
    const hostname = shortNodeName(body.hostname);
    core.emit("team.node", {
      node_id: nodeId, login, hostname, pubkey, ip: "", port: DEFAULT_PEER_PORT,
      endpoint: endpointHex(pubkey), transports: ["direct"], invite: inv.id, peer_sig_v1: true,
    });
    core.log.info("node_admitted", { node: nodeId, login, hostname, via: "direct_invite", invite: inv.id, issuer: inv.issuer });
    return { admitted: true, team, node_id: nodeId };
  }

  /**
   * Mixed teams (PROTOCOL §4): an admitted Tailscale machine that turned Walkie Direct on (`walkie direct enable`)
   * dials the authority over Direct with its own node key, which QUIC has just authenticated: that proves it holds
   * the key a Tailscale join only named. The authority re-pins the record with "direct" added (same login, address
   * and key; an append, never a rewrite). Other nodes send it to the authority. No invite: the machine is already in.
   */
  private addDirect(nodeId: string, pubkey: string): PeerJoinRes {
    const core = this.core;
    const team = core.teamId as string;
    if (!core.isAuthority()) {
      const authority = authorityAddr(core);
      return { admitted: false, reason: "not_authority", ...(authority ? { authority } : {}) };
    }
    const n = core.roster.nodes.get(nodeId);
    if (!n || n.pubkey !== pubkey) throw new HttpError(403, "forbidden", "not this machine's key");
    core.emit("team.node", {
      node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: n.ip, port: n.port,
      endpoint: endpointHex(n.pubkey), transports: withTransport(n, "direct"), peer_sig_v1: true,
    });
    core.log.info("node_direct_enabled", { node: nodeId, transports: withTransport(n, "direct").join(",") });
    return { admitted: true, team, node_id: nodeId };
  }

  private async join(req: Request, copy: Request, c: Caller, nodeHdr: string): Promise<PeerJoinRes> {
    const core = this.core;
    const body = parseWith(PeerJoinReq, await readJson(req, PEER_BODY_MAX));
    if (!isValidPubkey(body.pubkey)) throw new HttpError(400, "invalid", "pubkey is not a valid ed25519 key");
    const nodeId = nodeIdFromPubkey(body.pubkey);
    if (nodeHdr && nodeHdr !== nodeId) throw new HttpError(400, "invalid", "X-Walkie-Node does not match pubkey");
    const team = core.teamId as string;
    const known = core.roster.nodes.get(nodeId);
    if (known) {
      if (!hasPeerSig(req.headers)) {
        if (this.callerSigRequired(nodeId)) this.badSignature();
      } else await this.checkSignature(copy, new URL(req.url), nodeId, known.pubkey);
    } else if (hasPeerSig(req.headers)) {
      // A new key proves possession only. Admission is decided below.
      await this.checkSignature(copy, new URL(req.url), nodeId, body.pubkey);
      rememberValidPeerSignature(core.store, nodeId);
    } else if (peerSigStrict(core.roster, core.store)) {
      throw new HttpError(403, "update_required", "this team requires Walkie 0.2.0-pre.10 or newer: update, then join again");
    }
    // Explicitly revoked: an owner must re-admit it. Revoked only by the member's removal: after a
    // re-invite the machine joins again like a new one (Fable F6), subject to auto_admit/approval.
    if (known?.revoked && !known.revoked_by_removal) throw new HttpError(403, "forbidden", "this node was revoked; an owner must re-admit it");
    if (known && known.login !== c.who.login) throw new HttpError(403, "forbidden", "node belongs to another member");
    // A machine admitted over Walkie Direct can't be re-pinned to a tailnet address by a Tailscale join: nothing
    // here proves the caller holds its key (PROTOCOL §4 "Mixed teams").
    if (known && !transportsOf(known).includes("tailscale")) throw new HttpError(403, "forbidden", "this machine joined over Walkie Direct");
    const existing = known && !known.revoked ? known : undefined;
    const port = body.port ?? existing?.port ?? DEFAULT_PEER_PORT;
    if (existing && port !== existing.port && !hasPeerSig(req.headers)) {
      throw new HttpError(403, "bad_peer_sig", "changing a legacy peer port requires a node-key request signature");
    }
    const moved = !!existing && (existing.ip !== c.ip || existing.port !== port);
    if (existing && !moved) return { admitted: true, team, node_id: nodeId };
    if (!core.isAuthority()) {
      const authority = authorityAddr(core);
      return { admitted: false, reason: "not_authority", ...(authority ? { authority } : {}) };
    }
    if (existing && moved) {
      // Same machine re-joining from a new address (Tailscale IP or port changed): re-pin it.
      if (!hasPeerSig(req.headers)) core.log.warn("peer_legacy_repin", { node: nodeId, ip: c.ip, port });
      core.emit("team.node", { node_id: nodeId, login: existing.login, hostname: existing.hostname, pubkey: existing.pubkey, ip: c.ip, port, ...transportFields(existing),
        ...(existing.peer_sig_v1 ? { peer_sig_v1: true } : {}) });
      core.log.info("node_repinned", { node: nodeId, ip: c.ip, port });
      return { admitted: true, team, node_id: nodeId };
    }

    const hostname = shortNodeName(body.hostname);
    core.checkNodeCapacity(nodeId, c.who.login); // 409 node_limit, also before queueing an approval
    core.checkPlan("team.node", { node_id: nodeId, login: c.who.login }); // 402 plan_limit, likewise
    // Roster history retains revoked and removed nodes. Neither resets first-machine admission.
    const hasEverHadLoginNode = [...core.roster.nodes.values()].some((n) => n.login === c.who.login);
    let inviteId: string | undefined;
    if (body.invite) {
      const checked = checkInvite(body.invite, core.roster, team, core.clock());
      if (!checked.ok) throw new HttpError(403, checked.reason, "add-machine credential refused");
      const holder = memberByHandle(core.roster, checked.invite.handle);
      if (!holder || holder.login !== c.who.login || holder.role === "removed") {
        throw new HttpError(403, "invite_wrong_login", "add-machine credential names another login");
      }
      inviteId = checked.invite.id;
    }
    if ((!core.config.auto_admit || hasEverHadLoginNode) && !inviteId) {
      try {
        core.store.addJoinRequest({ node_id: nodeId, login: c.who.login, pubkey: body.pubkey, hostname, ip: c.ip, port, requested_at: core.clock() });
      } catch (err) {
        if (err instanceof JoinLimitError) throw new HttpError(429, "join_limit", `${err.message}; an owner must approve or wait for them to expire (24 h)`);
        throw err;
      }
      core.hub.nodesChanged();
      return { admitted: false, reason: "pending_approval" };
    }
    // The address pinned for the node is the one we observed, not the one it claimed.
    core.emit("team.node", { node_id: nodeId, login: c.who.login, hostname, pubkey: body.pubkey, ip: c.ip, port,
      ...(hasPeerSig(req.headers) ? { peer_sig_v1: true } : {}),
      ...(inviteId ? { invite: inviteId } : {}) });
    if (hasPeerSig(req.headers)) rememberValidPeerSignature(core.store, nodeId);
    core.log.info("node_admitted", { node: nodeId, login: c.who.login, hostname, ip: c.ip, port });
    return { admitted: true, team, node_id: nodeId };
  }

  /** The event or its stub, as the calling peer may see it (restricted channels, PROTOCOL §3). */
  private asServed(row: EventRow, peerHandle: string, statusStubs = false): unknown {
    const r = this.core.roster;
    if (row.redacted === 1) return JSON.parse(row.json) as unknown;
    // Only to a peer that accepts status stubs (an older one would refuse the stub and never get past that seq).
    if (row.kind === "agent.status") {
      const ev = JSON.parse(row.json) as Event;
      if (!this.core.serveStatusInFull(ev, { legacy: !statusStubs })) return stubOf(ev); // superseded / over-shared
    }
    if (isRestricted(r, row.channel) && !canSeeChannel(r, row.channel, peerHandle)) return stubOf(JSON.parse(row.json) as Event);
    return JSON.parse(row.json) as unknown;
  }

  /** R6: a page stops before its serialized size passes PEER_PAGE_BUDGET (always at least one event). */
  private budgeted(rows: readonly EventRow[], peerHandle: string, statusStubs = false): { events: unknown[] } {
    const events: unknown[] = [];
    let bytes = 16;
    for (const row of rows) {
      const served = this.asServed(row, peerHandle, statusStubs);
      bytes += Buffer.byteLength(JSON.stringify(served)) + 1;
      if (events.length && bytes > PEER_PAGE_BUDGET) break;
      events.push(served);
    }
    return { events };
  }

  private serveEvents(url: URL, peerHandle: string): { events: unknown[] } {
    const statusStubs = url.searchParams.get("status_stubs") === "1";
    const idsParam = url.searchParams.get("ids");
    if (idsParam !== null) {
      const ids = idsParam.split(",").filter(Boolean);
      if (!ids.length || ids.length > MAX_IDS_PER_FETCH || !ids.every((id) => EventId.safeParse(id).success)) {
        throw new HttpError(400, "invalid", `ids must be 1..${MAX_IDS_PER_FETCH} event ids`);
      }
      return this.budgeted(this.core.store.rowsByIds(ids), peerHandle, statusStubs);
    }
    const origin = url.searchParams.get("origin") ?? "";
    if (!NodeId.safeParse(origin).success) throw new HttpError(400, "invalid", "origin must be a node id");
    const after = Number(url.searchParams.get("after") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "500");
    if (!Number.isInteger(after) || after < 0) throw new HttpError(400, "invalid", "after must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, "invalid", "limit must be 1..500");
    return this.budgeted(this.core.store.rowsForSync(origin, after, this.core.store.vvOf(origin), limit), peerHandle, statusStubs);
  }

  /**
   * Mixed teams (PROTOCOL §4): the caller shares no transport with the machine that uploaded the bytes (the origin
   * of an accepted share of the hash in this channel, which holds provenance). This node, which reaches both, fetches
   * them from that origin once, gaining provenance the ordinary way (fetched for an accepted share from a peer with
   * provenance), then serves them under the usual rule. One hop: only from a share's origin, never onward.
   */
  private async fetchThrough(hash: string, channel: string, peerHandle: string, callerNode: string): Promise<boolean> {
    const core = this.core;
    const r = core.roster;
    const caller = r.nodes.get(callerNode);
    if (!core.fetchBlob || !caller || !r.channels.has(channel) || !canSeeChannel(r, channel, peerHandle)) return false;
    const origins = new Set(core.store.blobRefRows(hash).filter((s) => s.channel === channel).map((s) => s.origin));
    for (const o of origins) {
      const n = r.nodes.get(o);
      if (!n || o === core.nodeId || o === callerNode || pickTransport(n, caller) !== null) continue;
      if (await core.fetchBlob(o, hash, channel)) return true; // the caller's access is re-judged by serveBlob against the roster as it is now
    }
    return false;
  }

  /** WALKIE-POOL-2: a head asks this machine to start, renew or stop its stage of a split run (PROTOCOL §4). */
  private async poolStage(req: Request, nodeId: string, member: MemberRec): Promise<unknown> {
    const core = this.core;
    if (!core.pool) throw new HttpError(404, "not_found", "split runs are not available on this daemon");
    // Observers read; they don't put load on teammates' machines.
    if (member.role === "observer") throw new HttpError(403, "forbidden", "an observer's machine can't start a split run");
    const raw = await readJson(req, REQUEST_BODY_MAX);
    if (!core.limiter.take(`pool-stage:${nodeId}`, { capacity: 30, perSecond: 1 })) throw new HttpError(429, "rate_limited", "too many stage requests");
    return core.pool.stages.handle(raw, nodeId);
  }

  /** POOL-REAL-1: a member machine starts / connects to / renews / leaves / stops a model this machine serves whole. */
  private async poolServe(req: Request, nodeId: string, member: MemberRec): Promise<unknown> {
    const core = this.core;
    if (!core.pool) throw new HttpError(404, "not_found", "served models are not available on this daemon");
    if (member.role === "observer") throw new HttpError(403, "forbidden", "an observer's machine can't use served models");
    const raw = await readJson(req, REQUEST_BODY_MAX);
    if (!core.limiter.take(`pool-serve:${nodeId}`, { capacity: 30, perSecond: 1 })) throw new HttpError(429, "rate_limited", "too many serve requests");
    return core.pool.server.handle(raw, nodeId);
  }

  /** Roster requests are served by the authority only (PROTOCOL §2); the requester must be the caller. */
  private async rosterRequest(req: Request, nodeHdr: string): Promise<{ event: Event | null }> {
    const raw = await readJson(req, REQUEST_BODY_MAX);
    if (!jsonDepthOk(raw)) throw new HttpError(400, "invalid", "request nests too deeply");
    const body = parseWith(RosterRequest, raw);
    if (body.node !== nodeHdr) throw new HttpError(403, "forbidden", "request node does not match the caller");
    if (!this.core.limiter.take(`roster:${nodeHdr}`, this.core.limits.humanWrite)) throw new HttpError(429, "rate_limited", "too many roster requests");
    return { event: applyRequest(this.core, body) };
  }

  /** Pushed events; the pushing node is their relay for the pending byte cap (F3). */
  private async receive(req: Request, nodeHdr: string): Promise<PeerPushRes> {
    const body = parseWith(PeerEventsPush, await readJson(req, PEER_BODY_MAX));
    const out: PeerPushRes = { accepted: 0, pending: 0, rejected: [] };
    for (const e of body.events) {
      const res = this.core.ingest(e, "remote", nodeHdr);
      if (res.status === "accepted" && !isStub(e)) this.core.onPeerEvent?.(e as Event, nodeHdr);
      if (res.status === "accepted" || res.status === "duplicate") out.accepted++;
      else if (res.status === "pending") out.pending++;
      else out.rejected.push({ id: String((e as { id?: unknown })?.id ?? "?"), reason: res.reason ?? "rejected" });
    }
    return out;
  }

  private async serveBlob(hash: string, channel: string, peerHandle: string, callerNode: string): Promise<Response> {
    if (!ChannelName.safeParse(channel).success) throw new HttpError(400, "invalid", "channel is required");
    if (!blobServable(this.core.roster, this.core.store, hash, channel, peerHandle)) {
      // fetchThrough awaits another machine: the caller may have lost the channel, its node or its membership
      // meanwhile (Codex mixed-teams MEDIUM 1), so judge again against the roster as it is after the download.
      const fetched = await this.fetchThrough(hash, channel, peerHandle, callerNode);
      const member = nodeMember(this.core.roster, callerNode);
      if (!fetched || !member || member.handle !== peerHandle || !blobServable(this.core.roster, this.core.store, hash, channel, peerHandle)) {
        throw new HttpError(404, "not_found", "blob not available");
      }
    }
    const bytes = readBlob(this.core.paths.blobs, hash);
    if (!bytes) throw new HttpError(404, "not_found", "blob not stored on this node");
    return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
  }
}
