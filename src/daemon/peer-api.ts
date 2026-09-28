import { VERSION } from "./version.ts";
import { SEATS_V2_CAP } from "../protocol/seats.ts";
import { hostFor } from "./orchestrator/host.ts";
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
  ChannelName, EventId, MAX_IDS_PER_FETCH, NodeId, PEER_PAGE_BUDGET, PeerEventsPush, PeerJoinReq, RosterRequest,
  type Event, type PeerHello, type PeerJoinRes, type PeerOwnerAddr, type PeerPushRes,
} from "../protocol/schemas.ts";
import { blobServable } from "./blob-auth.ts";
import { readBlob } from "./blobs.ts";
import type { Core } from "./core.ts";
import { HttpError, errorResponse, json, normalizeIp, parseWith, readJson } from "./http.ts";
import { shortNodeName, type WhoisResult } from "./identity.ts";
import { checkInvite, directLogin } from "./invite.ts";
import { isValidPubkey } from "./keys.ts";
import type { BucketSpec } from "./ratelimit.ts";
import { applyRequest } from "./requests.ts";
import { grantLease, refreshBorrowedUsage } from "./vault-lease.ts";
import {
  DEFAULT_PEER_PORT, canSeeChannel, directMemberByKey, endpointHex, isRestricted, memberByHandle, nodeMember, pickTransport, servesDirect, transportFields,
  transportsOf, withTransport, type MemberRec,
} from "./roster.ts";
import { JoinLimitError, type EventRow } from "./store.ts";
import type { TunnelDecision } from "./direct/net.ts";
import type { TunnelGrant } from "../pool/run/stage.ts";
import { WsEnd } from "../pool/run/tunnel.ts";
import { trackOp } from "./watchdog.ts";

export const PEER_BODY_MAX = 1024 * 1024;

/** A split-run tunnel's WebSocket (Tailscale): the stage's grant, and the End once open. */
export interface TunnelSocketData { grant: TunnelGrant; end: WsEnd | null }

function isStub(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { redacted?: unknown }).redacted === true;
}
const REQUEST_BODY_MAX = 256 * 1024;
/** Requests from keys that aren't admitted nodes (joiners, strangers), all of them together. */
const UNADMITTED_DIRECT: BucketSpec = { capacity: 20, perSecond: 5 };

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
  constructor(private readonly core: Core) {}

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
      const g = this.tunnelGrant(path, nodeId);
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

    if (req.method === "GET" && path === "/peer/v1/hello") return json(this.hello());
    if (req.method === "POST" && path === "/peer/v1/join") return json(await this.join(req, caller, nodeHdr));

    const team = core.teamId;
    if (req.headers.get("x-walkie-team") !== team) throw new HttpError(409, "conflict", "team mismatch");
    const node = core.roster.nodes.get(nodeHdr);
    // A Direct-only machine (its record doesn't serve Tailscale) is never let in over the tailnet, whatever login.
    if (!node || node.revoked || node.login !== who.login || node.ip !== ip || !transportsOf(node).includes("tailscale")) {
      core.log.warn("peer_denied", { ip, login: who.login, node: nodeHdr, path, reason: "node_not_admitted" });
      throw new HttpError(403, "forbidden", "calling node is not admitted");
    }
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
   * Walkie Direct gate: the QUIC-authenticated key names the node. Rate limits are per endpoint, plus one shared
   * bucket for every key that isn't an admitted node (keys are free to mint). A revoked node, a removed member's
   * node and an outsider all get `403 not_member`; only `/join` with a valid invite admits a new key.
   */
  private async routeDirect(req: Request, pubkey: string): Promise<Response> {
    const url = new URL(req.url);
    const core = this.core;
    if (!url.pathname.startsWith("/peer/v1/")) throw new HttpError(404, "not_found", "not found");
    const nodeId = nodeIdFromPubkey(pubkey);
    // The stored key must match, not just the 64-bit id, and the record must serve Direct (a Tailscale-only
    // machine's key gets in only after proving it with a Direct /join: PROTOCOL §4 "Mixed teams").
    const member = directMemberByKey(core.roster, pubkey);
    if (!member && !core.limiter.take("peer:direct-unadmitted", UNADMITTED_DIRECT)) throw new HttpError(429, "rate_limited", "slow down");
    if (!core.limiter.take(`peer:direct:${nodeId}`, core.limits.peer)) throw new HttpError(429, "rate_limited", "slow down");
    const path = url.pathname;

    if (req.method === "POST" && path === "/peer/v1/join") return json(await this.joinDirect(req, pubkey, nodeId));
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
    return this.serveAdmitted(req, url, nodeId, member);
  }

  /** The endpoints behind the gate, for an admitted node `nodeId` of `member`. */
  private async serveAdmitted(req: Request, url: URL, nodeId: string, member: MemberRec): Promise<Response> {
    const core = this.core;
    const path = url.pathname;
    if (req.method === "GET" && path === "/peer/v1/vv") {
      const online = core.reachedPeers?.() ?? [];
      return json({
        node: core.nodeId, vv: core.store.vv(), ts: Date.now(),
        capabilities: { version: VERSION, caps: [SEATS_V2_CAP] },
        ...(online.length ? { online } : {}),
        ...(core.publishedStats() ? { stats: core.publishedStats() } : {}),
        ...(core.accounts ? { accounts: core.accounts } : {}), // ACCOUNTS-1: this machine's accounts + usage (PROTOCOL §3)
        ...(core.poolShare?.() ? { pool: core.poolShare() } : {}), // WALKIE-POOL-2: split-run sharing (PROTOCOL §3)
      });
    }
    if (req.method === "POST" && path === "/peer/v1/orchestrator/lease") {
      const host = hostFor(core);
      if (!host) throw new HttpError(503, "unavailable", "orchestrator leadership unavailable");
      if (!core.limiter.take(`orchestrator-lease:${nodeId}`, { capacity: 30, perSecond: 20 })) throw new HttpError(429, "rate_limited", "too many lease requests");
      return json(host.grantLeadership(nodeId));
    }
    if (req.method === "POST" && path === "/peer/v1/vault/usage") {
      if (member.role === "observer") throw new HttpError(403, "forbidden", "observers cannot refresh borrowed accounts");
      return json(refreshBorrowedUsage(core, nodeId, await readJson(req, 1024)));
    }
    if (req.method === "POST" && path === "/peer/v1/vault/lease") {
      // ACCOUNTS-2 phase 3: a setup-token from this machine's vault, if its policy allows the caller (vault-lease.ts).
      const res = await grantLease(core, { vault: core.vault, sharing: core.vaultSharing, nonces: core.vaultNonces, grants: core.vaultGrants, teamPolicy: core.teamPolicy, roomLeft: core.vaultRoomLeft, renew: core.vaultRenew }, nodeId, member, await readJson(req, 16 * 1024));
      return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    if (req.method === "GET" && path === "/peer/v1/events") return json(this.serveEvents(url, member.handle));
    if (req.method === "POST" && path === "/peer/v1/events") return json(await this.receive(req, nodeId));
    if (req.method === "POST" && path === "/peer/v1/roster-request") return json(await this.rosterRequest(req, nodeId));
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
      endpoint: endpointHex(pubkey), transports: ["direct"], invite: inv.id,
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
      endpoint: endpointHex(n.pubkey), transports: withTransport(n, "direct"),
    });
    core.log.info("node_direct_enabled", { node: nodeId, transports: withTransport(n, "direct").join(",") });
    return { admitted: true, team, node_id: nodeId };
  }

  private async join(req: Request, c: Caller, nodeHdr: string): Promise<PeerJoinRes> {
    const core = this.core;
    const body = parseWith(PeerJoinReq, await readJson(req, PEER_BODY_MAX));
    if (!isValidPubkey(body.pubkey)) throw new HttpError(400, "invalid", "pubkey is not a valid ed25519 key");
    const nodeId = nodeIdFromPubkey(body.pubkey);
    if (nodeHdr && nodeHdr !== nodeId) throw new HttpError(400, "invalid", "X-Walkie-Node does not match pubkey");
    const team = core.teamId as string;
    const known = core.roster.nodes.get(nodeId);
    // Explicitly revoked: an owner must re-admit it. Revoked only by the member's removal: after a
    // re-invite the machine joins again like a new one (Fable F6), subject to auto_admit/approval.
    if (known?.revoked && !known.revoked_by_removal) throw new HttpError(403, "forbidden", "this node was revoked; an owner must re-admit it");
    if (known && known.login !== c.who.login) throw new HttpError(403, "forbidden", "node belongs to another member");
    // A machine admitted over Walkie Direct can't be re-pinned to a tailnet address by a Tailscale join: nothing
    // here proves the caller holds its key (PROTOCOL §4 "Mixed teams").
    if (known && !transportsOf(known).includes("tailscale")) throw new HttpError(403, "forbidden", "this machine joined over Walkie Direct");
    const existing = known && !known.revoked ? known : undefined;
    const port = body.port ?? DEFAULT_PEER_PORT;
    const moved = !!existing && (existing.ip !== c.ip || existing.port !== port);
    if (existing && !moved) return { admitted: true, team, node_id: nodeId };
    if (!core.isAuthority()) {
      const authority = authorityAddr(core);
      return { admitted: false, reason: "not_authority", ...(authority ? { authority } : {}) };
    }
    if (existing && moved) {
      // Same machine re-joining from a new address (Tailscale IP or port changed): re-pin it.
      core.emit("team.node", { node_id: nodeId, login: existing.login, hostname: existing.hostname, pubkey: existing.pubkey, ip: c.ip, port, ...transportFields(existing) });
      core.log.info("node_repinned", { node: nodeId, ip: c.ip, port });
      return { admitted: true, team, node_id: nodeId };
    }

    const hostname = shortNodeName(body.hostname);
    core.checkNodeCapacity(nodeId, c.who.login); // 409 node_limit, also before queueing an approval
    core.checkPlan("team.node", { node_id: nodeId, login: c.who.login }); // 402 plan_limit, likewise
    if (!core.config.auto_admit) {
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
    core.emit("team.node", { node_id: nodeId, login: c.who.login, hostname, pubkey: body.pubkey, ip: c.ip, port });
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
