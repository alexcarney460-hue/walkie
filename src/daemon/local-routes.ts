// Local API routes (PROTOCOL §5). Transport/auth checks live in local-api.ts.
import { z } from "zod";
import { canonicalJson } from "../protocol/canonical.ts";
import { ORCHESTRATOR_AGENT } from "../protocol/orchestrator.ts";
import { SEATS_AGENT, isSeatAgent, seatsChannelNode } from "../protocol/seats.ts";
import { hostFor } from "./orchestrator/host.ts";
import { redactSecrets } from "../protocol/safety.ts";
import {
  Address, AgentName, AnswerReq, AskReq, ChannelName, ChannelReq, EventsQuery, Handle, InviteReq, NodeId, PostReq, Role,
  StatusReq, DeliveriesReq, TransportKind, type BodyOf, type Event, type RosterRequestKind,
} from "../protocol/schemas.ts";
import type { TransportControl } from "./direct/link.ts";
import { INVITE_PREFIX, createInvite, directLogin, inviteMintPos } from "./invite.ts";
import { addressedTo, getAskView, MAX_WAIT_S, parseAddress, waitForAsk } from "./asks.ts";
import { MAX_BLOB_BYTES, readBlob, sha256Hex, writeBlob } from "./blobs.ts";
import { ActivateReq, activateOnAuthority, alreadyActive, checkActivatable } from "../license/activate.ts";
import type { Core } from "./core.ts";
import { HttpError, json, parseWith, readBytes, readJson } from "./http.ts";
import { joinTeam, joinWithInvite } from "./join.ts";
import type { PeerClient } from "./peer-client.ts";
import type { PeerApiStatus } from "./peer-link.ts";
import { blobServable, shareChannels } from "./blob-auth.ts";
import { admitJoin, checkAuthorityReachable, queuedView, submitRequest } from "./requests.ts";
import { DEFAULT_PEER_PORT, activeNodes, endpointHex, memberByHandle, servesDirect, transportFields, type NodeRec, seatsChannelRule } from "./roster.ts";
import type { PeerAddr } from "./transport.ts";
import { saveConfigField } from "./config.ts";
import { ADMIN_AGENT } from "./admin/audit.ts";
import { adminGate, agentCaller, personOnly } from "./admin/gate.ts";
import { FLEET_AGENT, STEWARD_AGENT } from "../protocol/projects/steward-core.ts";
import type { SyncManager } from "./sync.ts";
import { parseProvenance, projectStatus } from "../protocol/status-projection.ts";
import { accountsView, agentsPayload, ARCHIVE_PAGE_MAX, askView, cutAskView, isLiveSubagentRow, liveSubagents, meView, nodesView, teamView } from "./views.ts";
import { MAX_SUBAGENTS_PER_PARENT, namedUnder } from "../protocol/subagents.ts";
import { requestLease } from "./vault-lease.ts";
import { plainText } from "../protocol/plain-text.ts";
import { VERSION } from "./version.ts";
import { addMachineCommand, addMachineLink, releaseTag } from "../protocol/add-machine.ts";
import type { Integrations } from "../integrations/routes.ts";
import { activateCode, isActivationCode } from "../license/bind.ts";
import { refreshLicense } from "../license/renew.ts";
import type { LicenseService } from "../license/service.ts";
import type { AccountsService } from "../accounts/service.ts";
import type { MobileManager } from "./mobile/manager.ts";
import type { ProjectsIndex } from "./projects/index.ts";

export const LOCAL_BODY_MAX = 256 * 1024;

export interface RouteCtx {
  readonly core: Core; readonly sync: SyncManager; readonly client: PeerClient;
  /** Connectors (src/integrations); absent when the daemon runs without them. */
  readonly integrations?: Integrations;
  /** The vendor's license service, for activation codes (src/license/bind.ts). */
  readonly licenseService?: LicenseService;
  readonly req: Request; readonly url: URL; readonly agent?: string;
  /** The caller serves a model though it names no agent (X-Walkie-Under-Agent: 1, the CLI under an agent runtime). */
  readonly underAgent?: boolean;
  /** Disables the idle timeout for long-lived responses (SSE, long-poll). */
  readonly noTimeout: () => void;
  readonly tailscaleError?: string;
  /** The peer API's state (up, or retrying and why) for `/v1/diag`. */
  readonly peerApi?: () => PeerApiStatus;
  /** When the request's credential ends (a dashboard session's absolute deadline): a stream closes then. */
  readonly credentialExpiresAt?: number;
  /**
   * How the caller authenticated (ORCH-FIX-11/12): a dashboard session, the CLI (the unix socket, or the durable token
   * over loopback), or a paired phone through the encrypted relay (mobile/tunnel.ts); `credentialSignal` aborts when
   * that credential ends (sign-out, token rotation, a revoked phone; none for the unix socket, the OS user's own).
   */
  readonly via: "dashboard" | "cli" | "phone";
  /** X-Walkie-Orchestrator-Token: the orchestrator host's child proving it writes as `orchestrator` (ORCH-FIX-13). */
  readonly orchestratorToken?: string;
  readonly credentialSignal?: AbortSignal;
  /** Which transport this daemon runs, and Walkie Direct's endpoint (src/daemon/direct/link.ts). */
  readonly transport?: TransportControl;
  /** This machine's accounts service (limit resets, src/accounts/routes.ts); null when accounts are off. */
  readonly accounts?: () => AccountsService | null;
  /** The request came with a dashboard session (a person at the dashboard), not the durable token. */
  readonly dashboard?: boolean;
  /** Paired phones (src/daemon/mobile/routes.ts). */
  readonly mobile?: MobileManager;
  /** A write rate-limit key of its own (a paired phone's writes don't share the desktop person's bucket). */
  readonly rateKey?: string;
  /** The board index (WALKIE-PROJECTS-1, src/daemon/projects/); absent in a daemon started without it. */
  readonly projects?: ProjectsIndex;
  /**
   * Which listener the request came in on (ACCOUNTS-2; `transport` on its lane, renamed at the pre.4 merge because pre.3
   * uses `transport` for Walkie Direct's control): "unix" = the unix socket (this OS user); "tcp" = loopback, token or
   * dashboard; absent = neither (a paired phone's request through the relay).
   */
  readonly listener?: "unix" | "tcp";
}

export type Handler = (c: RouteCtx, params: string[]) => Promise<Response> | Response;
const routes: { method: string; re: RegExp; h: Handler }[] = [];
/** Registers a local API route (other modules add theirs, e.g. src/integrations/routes.ts). */
export function route(method: string, path: string | RegExp, h: Handler): void {
  routes.push({ method, re: typeof path === "string" ? new RegExp(`^${path}$`) : path, h });
}

/** Whether this build serves `method path` (feature detection, e.g. seats: GET /v1/seats). */
export function hasRoute(method: string, path: string): boolean {
  return routes.some((r) => r.method === method && r.re.test(path));
}

export async function dispatch(c: RouteCtx): Promise<Response> {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") refuseReservedAgent(c);
  for (const r of routes) {
    const m = r.re.exec(c.url.pathname);
    if (!m) continue;
    if (r.method !== c.req.method) continue;
    return r.h(c, m.slice(1).map((s) => decodeURIComponent(s)));
  }
  if (routes.some((r) => r.re.test(c.url.pathname))) throw new HttpError(405, "method_not_allowed", "method not allowed");
  throw new HttpError(404, "not_found", "no such route");
}

// ---- helpers ----------------------------------------------------------------------

export function requireTeam(c: RouteCtx): void {
  if (!c.core.teamId) throw new HttpError(409, "no_team", "not in a team yet (run: walkie init <name> --handle <you> or walkie join <peer>)");
  if (!c.core.me()) throw new HttpError(403, "forbidden", "this node is not an admitted member");
}

function requireOwner(c: RouteCtx): void {
  requireTeam(c);
  if (c.core.me()?.role !== "owner") throw new HttpError(403, "forbidden", "owner role required");
}

/**
 * The agent name `orchestrator` is its host's (ORCH-FIX-13, Opus r13 LOW): a write under it (a post, ask, answer,
 * share or roster change) is accepted only from the host's own Claude, which proves it with the per-run secret only its
 * process got (X-Walkie-Orchestrator-Token), so nothing else in the team can pass for this machine's orchestrator.
 */
function refuseReservedAgent(c: RouteCtx): void {
  if (c.agent !== ORCHESTRATOR_AGENT) return;
  if (hostFor(c.core)?.acceptsToken(c.orchestratorToken)) return;
  throw new HttpError(403, "forbidden", "the agent name \"orchestrator\" is reserved for this machine's orchestrator host");
}

export function limitWrite(c: RouteCtx): void {
  refuseReservedAgent(c);
  const spec = c.agent ? c.core.limits.agentWrite : c.core.limits.humanWrite;
  if (!c.core.limiter.take(`write:${c.rateKey ?? c.agent ?? "human"}`, spec)) throw new HttpError(429, "rate_limited", "too many writes; slow down");
}

function redact(c: RouteCtx, text: string, raw?: boolean): { text: string; redactions: string[] } {
  if (raw || !c.core.config.redact) return { text, redactions: [] };
  return redactSecrets(text);
}

/** Status text is authored locally and replicated: redact before it is signed. */
function redactStatus<T extends { title?: string; activity?: string }>(c: RouteCtx, s: T): T {
  return {
    ...s,
    ...(s.title !== undefined ? { title: redact(c, s.title).text } : {}),
    ...(s.activity !== undefined ? { activity: redact(c, s.activity).text } : {}),
  };
}

function agentAskPolicy(c: RouteCtx, agent: string): string {
  const row = c.core.store.agent(c.core.nodeId, agent);
  if (!row) return "auto";
  return (JSON.parse(row.body) as { ask_policy?: string }).ask_policy ?? "auto";
}

/**
 * Roster writes (PROTOCOL §2): the authority appends directly; any other node sends a roster request
 * to the authority, or queues it (202 `{queued: true}`) while the authority is unreachable.
 */
async function rosterWrite(c: RouteCtx, kind: RosterRequestKind, body: Record<string, unknown>): Promise<Response> {
  refuseReservedAgent(c);
  if (c.core.isAuthority() && kind !== "team.admit") return json({ event: c.core.emit(kind, body as never, { agent: c.agent }) });
  const res = await submitRequest(c.core, c.client, c.sync.requestCatchUp, kind, body);
  return "queued" in res ? json(res, 202) : json(res);
}

/**
 * Posting to an unknown channel creates it as a public channel. Off the authority that is a roster
 * request; while the authority is unreachable the creation is queued and the post is refused (409
 * `channel_pending`) rather than held, so nothing unsendable sits in anyone's log.
 */
async function ensureChannel(c: RouteCtx, name: string): Promise<void> {
  const ch = c.core.roster.channels.get(name);
  if (!ch && name.startsWith("p-")) {
    throw new HttpError(409, "unknown_channel", `#${name}: channel names starting with p- are reserved for projects (walkie projects create <name>)`);
  }
  if (!ch) {
    // `seats-<node>` is made by that machine's `walkie seats enable` only (PROTOCOL §11): a post never creates it.
    const seatsNode = seatsChannelNode(name);
    if (seatsNode && c.core.roster.nodes.has(seatsNode)) throw new HttpError(409, "seats_not_allowed", `#${name} doesn't exist: that machine doesn't take seats (its person turns them on with: walkie seats enable)`);
    if (c.core.isAuthority()) {
      c.core.emit("channel.upsert", { name }, { agent: c.agent });
      return;
    }
    const res = await submitRequest(c.core, c.client, c.sync.requestCatchUp, "channel.upsert", { name });
    if (!c.core.roster.channels.has(name)) {
      const why = "queued" in res ? "the roster authority is offline; creation is queued" : "not synced from the roster authority yet";
      throw new HttpError(409, "channel_pending", `#${name} doesn't exist yet (${why}); retry the post once it does`);
    }
    return;
  }
  if (!c.core.visible({ channel: name })) throw new HttpError(403, "forbidden", `#${name} is restricted and you are not a member`);
  if (ch.archived) throw new HttpError(409, "conflict", `#${name} is archived`);
}

export function mentionsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(^|[\s(])(@[a-z][a-z0-9-]{0,23}(?:\/[a-z0-9][a-z0-9.-]{0,62}(?:\/[a-z0-9][a-z0-9._-]{0,47})?)?)/g)) {
    const a = m[2] as string;
    if (Address.safeParse(a).success) out.add(a);
    if (out.size >= 20) break;
  }
  return [...out];
}

function parseEvent(json: string): Event { return JSON.parse(json) as Event; }

// ---- identity / team -----------------------------------------------------------------


route("GET", "/v1/healthz", () => json({ ok: true, version: VERSION }));
route("GET", "/v1/me", (c) => json(meView(c.core, c.tailscaleError, c.transport)));

/** Starts Walkie Direct for init/join (503 when this daemon can't run it). */
async function enableDirect(c: RouteCtx): Promise<void> {
  if (!c.transport) throw new HttpError(503, "direct_unavailable", "Walkie Direct is not available in this daemon");
  try {
    await c.transport.enableDirect();
  } catch (err) {
    throw new HttpError(503, "direct_unavailable", `Walkie Direct could not start: ${(err as Error).message}`);
  }
}

/**
 * The transport a new team uses: the one asked for; else the daemon's configured one; else Tailscale when it is
 * signed in (v0.1 behaviour) and Walkie Direct when it isn't. `walkie setup` asks for Direct explicitly.
 */
function initTransport(c: RouteCtx, asked: TransportKind | undefined): TransportKind {
  const current = c.transport?.mode() ?? null;
  if (asked && current && c.core.config.transport && asked !== current) {
    throw new HttpError(409, "conflict", `config.json sets transport to ${current}`);
  }
  return asked ?? current ?? (c.core.login ? "tailscale" : "direct");
}

const InitReq = z.object({ team_name: z.string().min(1).max(60), handle: Handle, transport: TransportKind.optional() });
route("POST", "/v1/init", async (c) => {
  const body = parseWith(InitReq, await readJson(c.req, LOCAL_BODY_MAX));
  if (initTransport(c, body.transport) === "direct") {
    if (c.core.teamId) throw new HttpError(409, "team_exists", "this node already belongs to a team");
    await enableDirect(c);
    c.core.createTeam(body.team_name, body.handle, { login: directLogin(body.handle) });
    // The founding node's record says it serves Walkie Direct (team.create predates the transport fields).
    c.core.emit("team.node", {
      node_id: c.core.nodeId, login: directLogin(body.handle), hostname: c.core.hostname, pubkey: c.core.keys.pubkey,
      ip: "", port: c.core.peerPort || DEFAULT_PEER_PORT, endpoint: endpointHex(c.core.keys.pubkey), transports: ["direct"],
    });
  } else {
    c.core.createTeam(body.team_name, body.handle);
  }
  c.core.emit("channel.upsert", { name: "general", topic: "Team-wide channel" });
  c.sync.rosterChanged();
  return json(meView(c.core, c.tailscaleError, c.transport));
});

/** `peer`: a teammate's machine (Tailscale), or a Walkie Direct invite code; `invite` names the latter explicitly. */
const JoinReq = z.object({ peer: z.string().min(1).max(512).optional(), invite: z.string().min(1).max(512).optional() })
  .refine((b) => !!b.peer !== !!b.invite, { message: "give peer or invite" });
route("POST", "/v1/join", async (c) => {
  const body = parseWith(JoinReq, await readJson(c.req, LOCAL_BODY_MAX));
  c.noTimeout();
  // A pasted code may carry whitespace (a trailing newline, a wrapped line): codes never contain any. Anything that
  // looks like a code takes the invite path, whose errors never echo it (it is a bearer credential).
  const target = (body.invite ?? body.peer as string).trim();
  const compact = target.replace(/\s+/g, "");
  const code = body.invite !== undefined || looksLikeInvite(compact) ? compact : undefined;
  if (code) return json(await joinWithInvite(c.core, c.sync, c.client, code, () => enableDirect(c)));
  return json(await joinTeam(c.core, c.sync, c.client, target));
});

/** An invite code, or something meant to be one (damaged in the paste): "wk1" and 40+ characters with no dot. */
function looksLikeInvite(s: string): boolean {
  return s.startsWith(INVITE_PREFIX) && s.length > 40 && !s.includes(".");
}

/**
 * `walkie invite --handle <name>` (owner, Walkie Direct): a single-use code valid for 7 days, signed by this node,
 * naming the roster authority's endpoint (and its relay when this node is the authority). Nothing is emitted
 * until the invite is used; the code itself is never logged. On a Tailscale team (mixed teams) the authority must
 * serve Direct (`walkie direct enable` there); the minting machine itself needn't.
 */
const InviteCodeReq = z.object({ handle: Handle, role: Role.default("member") });
route("POST", "/v1/team/invite-code", async (c) => {
  requireOwner(c);
  const b = parseWith(InviteCodeReq, await readJson(c.req, LOCAL_BODY_MAX));
  adminGate(c, `minted an invite code for @${b.handle} (${b.role})`);
  const inv = await mintInvite(c, b.handle, b.role);
  return json({ code: inv.code, handle: b.handle, role: inv.role, expires_at: inv.expires_at, existing_member: inv.existing_member });
});

/**
 * AGENT-ADMIN-1: invites, add-machine links, roles, revocations of the person's own machines and join approvals are
 * admin actions an agent on this machine may take for its person (admin/gate.ts: audited, and refused while the person
 * has agent admin off). Removing a member, revoking another member's machine and moving the roster authority stay a
 * person's (personOnly). An agent is a request naming X-Walkie-Agent (the MCP server, the CLI with WALKIE_AGENT) or
 * marked X-Walkie-Under-Agent (the CLI in an agent runtime's environment).
 */

/** Mints a Walkie Direct code for `handle` (PROTOCOL §4 "Direct"); a current member's code adds a machine, same role. */
async function mintInvite(c: RouteCtx, handle: string, asked: Role): Promise<{ code: string; role: Role; expires_at: number; existing_member: boolean }> {
  const authorityId = c.core.authority;
  const authority = authorityId ? c.core.roster.nodes.get(authorityId) : undefined;
  if (!authority || !servesDirect(authority)) {
    const where = c.core.isAuthority() ? "run: walkie direct enable" : `on ${authority?.hostname ?? "the authority"} run: walkie direct enable`;
    throw new HttpError(409, "direct_unavailable", `the team's roster authority doesn't run Walkie Direct yet, so an invite code couldn't reach it (${where}); Tailscale teammates: walkie invite <tailscale-login> --handle <name>`);
  }
  // A current member's invite adds a machine: their role stays what it is.
  const holder = memberByHandle(c.core.roster, handle);
  const current = holder && holder.role !== "removed" ? holder : undefined;
  const role = current ? (current.role as Role) : asked;
  c.noTimeout();
  const relay = c.core.isAuthority() && c.transport ? await c.transport.relayHint(3_000) : null;
  const inv = createInvite(c.core.keys, {
    team: c.core.teamId as string, authority: authority.pubkey, ...(relay ? { relay } : {}), handle, role,
    now: c.core.clock(), pos: inviteMintPos(c.core.roster),
  });
  c.core.log.info("invite_created", { handle, role, invite: inv.id, expires_at: inv.expires_at });
  return { code: inv.code, role, expires_at: inv.expires_at, existing_member: !!current };
}

/**
 * `walkie team add-machine <handle>` / the dashboard's "Add a machine" (owner, person only): a single-use code for
 * another machine of a CURRENT member, plus the shareable link (the code only in its fragment) and the install
 * command pinned to this daemon's release. Members can't mint for themselves: the roster authority only admits
 * codes an owner's machine signed (invite_issuer_not_owner), so an owner does it for them.
 */
const AddMachineReq = z.object({ handle: Handle });
route("POST", "/v1/team/add-machine", async (c) => {
  requireOwner(c);
  const b = parseWith(AddMachineReq, await readJson(c.req, LOCAL_BODY_MAX));
  adminGate(c, `minted an add-machine link for @${b.handle}`);
  const m = memberByHandle(c.core.roster, b.handle);
  if (!m || m.role === "removed") throw new HttpError(404, "not_found", `@${b.handle} isn't on the team; invite a new person with: walkie invite --handle ${b.handle}`);
  const inv = await mintInvite(c, b.handle, m.role as Role);
  const tag = releaseTag(VERSION);
  // The pinned build's setup asks the consent question only when it hosts seats (src/cli/commands/team-agents.ts).
  const teamAgents = hasRoute("GET", "/v1/seats");
  return json({
    code: inv.code, handle: b.handle, role: inv.role, expires_at: inv.expires_at, existing_member: true,
    version: VERSION, team_agents: teamAgents, link: addMachineLink(inv.code, tag, teamAgents), command: addMachineCommand(inv.code, tag),
  });
});

route("GET", "/v1/team", (c) => {
  const view = teamView(c.core, c.sync);
  if (!view) throw new HttpError(409, "no_team", "not in a team yet");
  return json(view);
});

route("POST", "/v1/team/invite", async (c) => {
  requireOwner(c);
  const b = parseWith(InviteReq, await readJson(c.req, LOCAL_BODY_MAX));
  adminGate(c, `invited ${b.login} as @${b.handle} (${b.role})`);
  // SEC-COOKIE-2: an invite adds a person (or re-admits a removed one); it never changes a current member's role.
  // Role changes go through /v1/team/member (`walkie team role`), which a dashboard session can't reach.
  const existing = c.core.roster.members.get(b.login);
  if (existing && existing.role !== "removed") {
    throw new HttpError(409, "conflict", `${b.login} is already on the team as @${existing.handle} (${existing.role}); change a role with: walkie team role ${existing.handle} <role>`);
  }
  return rosterWrite(c, "team.member", { login: b.login, handle: b.handle, role: b.role, ...(b.display_name ? { display_name: b.display_name } : {}) });
});

const MemberReq = z.object({ handle: Handle, role: z.union([Role, z.literal("removed")]) });
route("POST", "/v1/team/member", async (c) => {
  requireOwner(c);
  const b = parseWith(MemberReq, await readJson(c.req, LOCAL_BODY_MAX));
  if (b.role === "removed") personOnly(c, "remove a member from the team");
  else adminGate(c, `made @${b.handle} ${b.role}`);
  const m = memberByHandle(c.core.roster, b.handle);
  if (!m) throw new HttpError(404, "not_found", `no member @${b.handle}`);
  return rosterWrite(c, "team.member", { login: m.login, handle: m.handle, role: b.role, ...(m.display_name ? { display_name: m.display_name } : {}) });
});

const AuthorityReq = z.object({ node: z.string().min(1).max(100) });
route("POST", "/v1/team/authority", async (c) => {
  requireOwner(c);
  personOnly(c, "move the roster authority");
  const b = parseWith(AuthorityReq, await readJson(c.req, LOCAL_BODY_MAX));
  const target = [...c.core.roster.nodes.values()].find((n) => !n.revoked && (n.node_id === b.node || n.hostname === b.node));
  if (!target) throw new HttpError(404, "not_found", `no admitted machine ${b.node}`);
  checkAuthorityReachable(c.core.roster, target.node_id);
  return rosterWrite(c, "team.authority", { node_id: target.node_id });
});

/**
 * `walkie team revoke <machine>` (owner): revokes one machine (node id or hostname) through the roster authority,
 * like every roster write; its key is refused at once and its open Walkie Direct connections are closed. The
 * member keeps their other machines. Not this machine (another owner revokes it), and never the authority (the
 * chain refuses it: transfer authority first). An explicitly revoked key can't rejoin, even with a new invite.
 */
const RevokeReq = z.object({ node: z.string().min(1).max(100) });
route("POST", "/v1/team/revoke", async (c) => {
  requireOwner(c);
  const b = parseWith(RevokeReq, await readJson(c.req, LOCAL_BODY_MAX));
  const matches = [...c.core.roster.nodes.values()].filter((n) => !n.revoked && (n.node_id === b.node || n.hostname === b.node));
  if (!matches.length) throw new HttpError(404, "not_found", `no admitted machine ${b.node}`);
  if (matches.length > 1) throw new HttpError(409, "ambiguous", `${matches.length} machines are named ${b.node}; give the node id (walkie who --json)`);
  const n = matches[0] as NodeRec;
  if (n.node_id === c.core.nodeId) throw new HttpError(409, "conflict", "this is your own machine; revoke it from another owner's machine");
  if (n.node_id === c.core.authority) throw new HttpError(409, "conflict", "that machine is the roster authority; move authority first (walkie team authority <machine>)");
  // An agent revokes its person's own machines only; another member's machine is as good as removing them (a person's).
  if (agentCaller(c) && c.core.roster.members.get(n.login)?.handle !== c.core.myHandle()) personOnly(c, "revoke another member's machine");
  adminGate(c, `revoked the machine ${n.hostname}`);
  return rosterWrite(c, "team.node", {
    node_id: n.node_id, login: n.login, hostname: n.hostname, pubkey: n.pubkey, ip: n.ip, port: n.port, revoked: true, ...transportFields(n),
  });
});

/**
 * `walkie direct enable` (mixed teams, PROTOCOL §4): this Tailscale machine also serves Walkie Direct, so machines
 * that joined with an invite code can reach it. Persisted (`"direct": true` in config.json); its roster record gains
 * "direct" (the authority re-pins itself, another machine proves its key to the authority over Direct).
 */
route("POST", "/v1/direct/enable", async (c) => {
  requireTeam(c);
  if (!c.transport) throw new HttpError(503, "direct_unavailable", "Walkie Direct is not available in this daemon");
  if (c.transport.mode() === "direct") return json({ transports: c.transport.serving(), advertised: true, direct: c.transport.direct() });
  c.noTimeout();
  saveConfigField(c.core.paths.config, "direct", true);
  let res: { advertised: boolean; reason?: string };
  try {
    res = await c.transport.enableDual();
  } catch (err) {
    throw new HttpError(503, "direct_unavailable", `Walkie Direct could not start: ${(err as Error).message}`);
  }
  return json({ transports: c.transport.serving(), ...res, direct: c.transport.direct() });
});

const AdmitReq = z.object({ node_id: NodeId, approve: z.boolean() });
route("POST", "/v1/team/admit", async (c) => {
  requireOwner(c);
  const b = parseWith(AdmitReq, await readJson(c.req, LOCAL_BODY_MAX));
  adminGate(c, `${b.approve ? "approved" : "denied"} the join of machine ${b.node_id}`);
  if (c.core.isAuthority()) return json({ event: admitJoin(c.core, b.node_id, b.approve) });
  return rosterWrite(c, "team.admit", b);
});

/** Join requests awaiting approval (held by the authority) and this node's queued roster requests. */
route("GET", "/v1/team/pending", (c) => {
  requireTeam(c);
  const owner = c.core.me()?.role === "owner";
  return json({
    requests: owner ? c.core.store.joinRequests(c.core.clock()).map(({ pubkey: _p, ...rest }) => rest) : [],
    roster_requests: queuedView(c.core),
  });
});

route("POST", "/v1/channels", async (c) => {
  requireTeam(c);
  // `requested_by` is the authority's to set (it says who asked); a caller never supplies it.
  const { requested_by: _by, ...b } = parseWith(ChannelReq, await readJson(c.req, LOCAL_BODY_MAX));
  // Project channels are made by `walkie projects create` and changed through project settings; a NEW `p-` name is
  // reserved. An existing `p-…` channel from before Projects (no project marker) stays an ordinary channel and is
  // managed here like any other (round-2 audit, Codex M7).
  if (b.name.startsWith("p-") && (!c.core.roster.channels.has(b.name) || c.core.isProjectChannel(b.name))) {
    throw new HttpError(409, "conflict", "channel names starting with p- are reserved for projects (walkie projects)");
  }
  const seats = seatsChannelRule(b, c.core.roster, c.core.myHandle() ?? "");
  if (seats && seats.status !== "ok") {
    throw new HttpError(403, "forbidden", `#${b.name} is a machine's seats channel: only that machine's person shapes it (walkie seats enable there)`);
  }
  return rosterWrite(c, "channel.upsert", b);
});

// ---- license (docs/BUSINESS.md) -------------------------------------------------------

/** The team's effective plan, usage and license (`walkie license`, the dashboard's Billing panel). */
route("GET", "/v1/license", (c) => {
  requireTeam(c);
  return json(c.core.plan());
});

/**
 * `walkie license activate <code|key>` (owner). An activation code is exchanged online for this team's
 * license, on the authority only (src/license/bind.ts). A license key for this team is recorded on the
 * chain as `team.license` through the authority (a roster request elsewhere; 202 queued while it's offline).
 */
route("POST", "/v1/license", async (c) => {
  requireOwner(c);
  const { key } = parseWith(ActivateReq, await readJson(c.req, LOCAL_BODY_MAX));
  if (isActivationCode(c.core, key)) {
    if (!c.licenseService) throw new HttpError(503, "license_service_unavailable", "this daemon has no license service configured");
    c.noTimeout();
    const res = await activateCode(c.core, c.licenseService, key);
    return json({ ...res, plan: c.core.plan() });
  }
  checkActivatable(c.core, key);
  if (alreadyActive(c.core, key)) return json({ event: null, plan: c.core.plan() });
  if (c.core.isAuthority()) return json({ event: activateOnAuthority(c.core, key), plan: c.core.plan() });
  const res = await submitRequest(c.core, c.client, c.sync.requestCatchUp, "team.license", { key });
  return "queued" in res ? json(res, 202) : json({ ...res, plan: c.core.plan() });
});

/** `walkie license refresh` (owner, on the authority): fetch the subscription's current grant now (FINAL Codex 4). */
route("POST", "/v1/license/refresh", async (c) => {
  requireOwner(c);
  if (!c.licenseService) throw new HttpError(503, "license_service_unavailable", "this daemon has no license service configured");
  c.noTimeout();
  const res = await refreshLicense(c.core, c.licenseService, c.core.log);
  return json({ ...res, plan: c.core.plan() });
});

route("GET", "/v1/peers", (c) => json({ nodes: nodesView(c.core, c.sync) }));

/** Diagnostics for `walkie doctor` (additive to PROTOCOL §5). */
route("GET", "/v1/diag", (c) => json({
  version: VERSION,
  uptime_s: Math.round((Date.now() - c.core.startedAt) / 1000),
  identity: c.core.identity.kind,
  peer_listen: c.core.ip ? `${c.core.ip}:${c.core.peerPort}` : null,
  ...(c.peerApi ? { peer_api: c.peerApi() } : {}),
  ...(c.transport ? { transport: c.transport.mode(), direct: c.transport.direct() } : {}),
  events: c.core.store.countEvents(),
  pending: c.core.store.pendingCount(),
  conflicts: c.core.store.conflictOrigins(),
  sse_clients: c.core.hub.size,
  now: Date.now(),
}));

// ---- board --------------------------------------------------------------------------

route("GET", "/v1/events", (c) => {
  const q = parseWith(EventsQuery, Object.fromEntries(c.url.searchParams));
  const kinds = q.kinds ? q.kinds.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const rows = c.core.store.queryEvents({ ...q, kinds });
  const events = rows.map((r) => parseEvent(r.json)).filter((e) => c.core.visible(e));
  return json({ events });
});

route("GET", /^\/v1\/events\/([^/]+)$/, (c, [id]) => {
  const row = c.core.store.getRow(id as string);
  if (!row || row.redacted === 1 || row.status !== "ok") throw new HttpError(404, "not_found", "no such event");
  const event = parseEvent(row.json);
  if (!c.core.visible(event)) throw new HttpError(404, "not_found", "no such event");
  const replies = c.core.store.replies(event.id).map((r) => parseEvent(r.json)).filter((e) => c.core.visible(e));
  return json({ event, replies });
});

route("POST", "/v1/post", async (c) => {
  requireTeam(c);
  const b = parseWith(PostReq, await readJson(c.req, LOCAL_BODY_MAX));
  limitWrite(c);
  await ensureChannel(c, b.channel);
  const { text, redactions } = redact(c, b.text, b.raw);
  const mentions = mentionsIn(text);
  const body: BodyOf<"msg.post"> = {
    text, ...(b.thread ? { thread: b.thread } : {}), ...(mentions.length ? { mentions } : {}),
    ...(b.artifacts?.length ? { artifacts: b.artifacts } : {}),
  };
  const event = c.core.emit("msg.post", body, { channel: b.channel, agent: c.agent });
  return json({ event, redactions });
});

// ---- asks ---------------------------------------------------------------------------

route("POST", "/v1/ask", async (c) => {
  requireTeam(c);
  const b = parseWith(AskReq, await readJson(c.req, LOCAL_BODY_MAX));
  limitWrite(c);
  const target = parseAddress(b.to);
  if (!memberByHandle(c.core.roster, target.handle) || memberByHandle(c.core.roster, target.handle)?.role === "removed") {
    throw new HttpError(404, "not_found", `no member @${target.handle}`);
  }
  if (b.channel) {
    await ensureChannel(c, b.channel);
    const members = c.core.roster.channels.get(b.channel)?.members;
    if (members && !members.includes(target.handle)) throw new HttpError(400, "invalid", `@${target.handle} can't see #${b.channel}`);
  }
  const { text, redactions } = redact(c, b.text);
  const event = c.core.emit("ask", {
    to: b.to, text, expires_at: Date.now() + b.timeout_s * 1000, ...(b.artifacts?.length ? { artifacts: b.artifacts } : {}),
  }, { channel: b.channel, agent: c.agent });
  return json({ event, redactions });
});

route("GET", /^\/v1\/asks\/([^/]+)$/, async (c, [id]) => {
  const wait = Number(c.url.searchParams.get("wait") ?? "0");
  if (!Number.isFinite(wait) || wait < 0) throw new HttpError(400, "invalid", "wait must be seconds >= 0");
  if (wait > 0) c.noTimeout();
  return json(await waitForAsk(c.core, id as string, Math.min(wait, MAX_WAIT_S), c.req.signal));
});

/** A positive integer query parameter (at most `max`), or null when absent or malformed. */
function intParam(c: RouteCtx, name: string, max: number): number | null {
  const v = Number(c.url.searchParams.get(name) ?? "");
  return Number.isInteger(v) && v > 0 ? Math.min(v, max) : null;
}

route("GET", "/v1/asks", (c) => {
  const state = c.url.searchParams.get("state");
  const toMe = c.url.searchParams.get("to") === "me";
  const handle = c.core.myHandle();
  if (toMe && c.agent && agentAskPolicy(c, c.agent) !== "auto") return json({ asks: [] }); // human/off: people answer in the dashboard
  // Optional bounds for small clients (the phone link sets both): texts cut to `text_max` characters, and the list cut
  // (newest first) once it would pass `max_bytes` encoded, marked `truncated`, so the answer is small whatever the asks hold.
  const textMax = intParam(c, "text_max", 1_000_000);
  const maxBytes = intParam(c, "max_bytes", 64 * 1024 * 1024);
  const asks: unknown[] = [];
  let size = 0;
  for (const row of c.core.store.asks()) {
    const v0 = askView(c.core, row);
    if (!c.core.visible(v0.ask) || (state && v0.state !== state)) continue;
    if (toMe && !(handle !== null && addressedTo((v0.ask.body as { to: string }).to,
      { handle, hostname: c.core.hostname, ...(c.agent ? { agent: c.agent } : {}) }))) continue;
    const v = textMax ? cutAskView(v0, textMax) : v0;
    if (maxBytes) {
      const n = Buffer.byteLength(JSON.stringify(v)) + 1;
      if (size + n > maxBytes) return json({ asks, truncated: true });
      size += n;
    }
    asks.push(v);
  }
  return json({ asks });
});

route("POST", "/v1/deliveries", async (c) => {
  requireTeam(c);
  if (!c.agent) throw new HttpError(400, "invalid", "X-Walkie-Agent is required to claim deliveries");
  const b = parseWith(DeliveriesReq, await readJson(c.req, LOCAL_BODY_MAX));
  return json({ claimed: c.core.store.claimDeliveries(c.agent, b.ids) });
});

route("POST", "/v1/answer", async (c) => {
  requireTeam(c);
  const b = parseWith(AnswerReq, await readJson(c.req, LOCAL_BODY_MAX));
  limitWrite(c);
  const view = getAskView(c.core, b.ask);
  const to = parseAddress((view.ask.body as { to: string }).to);
  if (to.handle !== c.core.myHandle()) throw new HttpError(403, "forbidden", `this ask is addressed to @${to.handle}`);
  if (view.state === "expired") throw new HttpError(409, "conflict", "ask expired");
  const { text } = redact(c, b.text);
  const event = c.core.emit("answer", {
    ask: b.ask, text, ...(b.declined ? { declined: true } : {}), ...(b.artifacts?.length ? { artifacts: b.artifacts } : {}),
  }, { channel: view.ask.channel, agent: c.agent });
  return json({ event });
});

// ---- agents --------------------------------------------------------------------------

route("POST", "/v1/status", async (c) => {
  requireTeam(c);
  const raw = await readJson(c.req, LOCAL_BODY_MAX);
  const b = parseWith(StatusReq, raw);
  // Where its text came from (never signed): the projection at emit decides what may be shared (status-projection.ts).
  const provenance = parseProvenance((raw as { provenance?: unknown } | null)?.provenance);
  if (c.agent && c.agent !== b.agent) throw new HttpError(403, "forbidden", "status agent must match X-Walkie-Agent");
  if (RESERVED_AGENTS.has(b.agent)) throw new HttpError(403, "forbidden", `agent name "${b.agent}" is reserved for the ${b.agent} integration`);
  if (b.agent === ORCHESTRATOR_AGENT) throw new HttpError(403, "forbidden", "the orchestrator's status is set by its host daemon only");
  if (b.agent === STEWARD_AGENT || b.agent === FLEET_AGENT) throw new HttpError(403, "forbidden", `the name "${b.agent}" is reserved for this daemon`);
  if (isSeatAgent(b.agent)) throw new HttpError(403, "forbidden", "seats' status is set by the host daemon only (PROTOCOL §11)");
  if (b.parent && !namedUnder(b.agent, b.parent)) throw new HttpError(400, "invalid", `a sub-agent of ${b.parent} is named "${b.parent}.<id>"`);
  // The seats host card (and a seat's) has no sub-agents a local process may add (Opus seats r9 LOW).
  if (b.parent && isSeatAgent(b.parent)) throw new HttpError(403, "forbidden", "seats' status is set by the host daemon only (PROTOCOL §11): nothing is a sub-agent of it");
  const latest = c.core.store.agent(c.core.nodeId, b.agent);
  // A sub-agent row belongs to one sub-agent (its full id is the status's `session`): another live one can't take it
  // over (Codex mission-sub r2 #1; the hooks pick a unique name, this is the daemon's own check).
  if (b.parent && latest && isLiveSubagentRow(latest)) {
    const owner = (JSON.parse(latest.body) as { session?: string }).session;
    if (owner && b.session && owner !== b.session) throw new HttpError(409, "conflict", `${b.agent} belongs to another sub-agent`);
  }
  // A session shows at most MAX_SUBAGENTS_PER_PARENT live sub-agents (WALKIE-MISSION-SUB-1): a new one beyond is refused.
  if (b.parent && b.state !== "offline" && !isLiveSubagentRow(latest) && liveSubagents(c.core, b.parent, b.agent) >= MAX_SUBAGENTS_PER_PARENT) {
    throw new HttpError(429, "rate_limited", `${b.parent} already shows ${MAX_SUBAGENTS_PER_PARENT} live sub-agents`);
  }
  c.core.noteLocalCwd(b.agent, b.cwd);
  const clean = redactStatus(c, JSON.parse(JSON.stringify(b)) as typeof b);
  // This machine's dashboard shows a sub-agent's description even when the team doesn't get it (share_prompts off).
  if (clean.parent) c.core.noteLocalSubagent(clean.agent, { title: clean.title, type: clean.subagent_type });
  const outgoing = projectStatus(clean, provenance, c.core.sharePolicy());
  if (latest && Date.now() - latest.ts < 2_000 && canonicalJson(JSON.parse(latest.body)) === canonicalJson(outgoing)) {
    return json({ event: null });
  }
  const event = c.core.statuses.submit(b.agent, clean, provenance);
  return event ? json({ event }) : json({ event: null, coalesced: true }, 202);
});

/**
 * ?scope=live (default) | archive | all, and for archive / all ?node=<id or hostname>&q=<search>&states=idle,offline
 * &limit=<n>&offset=<n> (filters apply before the page; the reply carries total / offset / truncated).
 */
const AgentsQuery = z.object({
  scope: z.enum(["live", "archive", "all"]).default("live"),
  node: z.string().max(120).optional(),
  q: z.string().max(200).optional(),
  states: z.string().max(60).optional()
    .transform((v) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(["working", "idle", "waiting", "blocked", "offline"])).max(5).optional()),
  limit: z.coerce.number().int().min(1).max(ARCHIVE_PAGE_MAX).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

route("GET", "/v1/agents", (c) => {
  const q = parseWith(AgentsQuery, Object.fromEntries(c.url.searchParams));
  return json(agentsPayload(c.core, c.sync, q));
});

// ACCOUNTS-1: the team's provider accounts and usage left, pooled (watch-only; no token is ever part of it).
route("GET", "/v1/accounts", (c) => {
  requireTeam(c);
  return json({ accounts: accountsView(c.core, c.sync), pool: c.core.teamPool() });
});

function ownerAddr(c: RouteCtx, node: NodeRec): PeerAddr {
  const addr = c.client.addrOf(node);
  if (!addr) throw new HttpError(502, "unreachable", "the owner's machine can't be reached from this machine (no transport in common)");
  return addr;
}

// ACCOUNTS-2 phase 3: a setup-token handed out by another machine's vault, for one wrapped launch. Unix socket only
// (the caller proved it is this OS user); the token is returned, never stored (vault-lease.ts).
route("POST", "/v1/vault/lease", async (c) => {
  if (c.listener !== "unix") throw new HttpError(403, "forbidden", "this route is only served on the unix socket");
  requireTeam(c);
  if (!c.core.limiter.take("vault-lease-local", { capacity: 20, perSecond: 20 / 3600 })) throw new HttpError(429, "rate_limited", "too many hand-outs; try later");
  // The owner's machine over a transport both serve (pre.4 merge: a Walkie Direct owner too), like every peer call.
  const res = await requestLease(c.core, (_addr, body, node) => c.client.vaultLease(ownerAddr(c, node), body).catch((err: unknown) => {
    const e = err as { status?: number; code?: string; message?: string };
    throw new HttpError(e.status && e.status >= 400 && e.status < 600 ? e.status : 502, e.code ?? "unreachable", `the owner's machine refused: ${plainText(String(e.message ?? "unreachable"), 200)}`);
  }), await readJson(c.req, 16 * 1024));
  return new Response(JSON.stringify(res), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
});

// ---- artifacts -------------------------------------------------------------------------

function header(c: RouteCtx, name: string): string | undefined {
  const v = c.req.headers.get(name);
  if (!v) return undefined;
  try { return decodeURIComponent(v); } catch { throw new HttpError(400, "invalid", `${name} is not URI-encoded`); }
}

route("POST", "/v1/artifacts", async (c) => {
  requireTeam(c);
  limitWrite(c);
  const name = header(c, "x-walkie-name");
  const mime = c.req.headers.get("x-walkie-mime") ?? "application/octet-stream";
  const note = header(c, "x-walkie-note");
  const channel = c.req.headers.get("x-walkie-channel") ?? "general";
  const thread = c.req.headers.get("x-walkie-thread") ?? undefined;
  if (!name || name.length > 200) throw new HttpError(400, "invalid", "X-Walkie-Name required (<=200 chars)");
  if (!ChannelName.safeParse(channel).success) throw new HttpError(400, "invalid", "X-Walkie-Channel is not a valid channel");
  if (mime.length > 100) throw new HttpError(400, "invalid", "X-Walkie-Mime too long");
  if (note && note.length > 2000) throw new HttpError(400, "invalid", "X-Walkie-Note too long");
  const bytes = await readBytes(c.req, MAX_BLOB_BYTES);
  if (bytes.byteLength === 0) throw new HttpError(400, "invalid", "empty artifact");
  await ensureChannel(c, channel);
  const hash = writeBlob(c.core.paths.blobs, bytes);
  c.core.store.addBlob(hash, bytes.byteLength, mime, name);
  const event = c.core.emit("artifact.share", {
    hash, name, size: bytes.byteLength, mime, ...(note ? { note: redact(c, note).text } : {}), ...(thread ? { thread } : {}),
  }, { channel, agent: c.agent });
  c.core.store.addProvenance(channel, hash); // R5: we uploaded these bytes with a share in this channel
  return json({ event });
});

/** Bytes for one visible share channel: local copy with provenance, else a peer with provenance (R5). */
export async function blobFor(
  c: RouteCtx, hash: string, channel: string, maxBytes = MAX_BLOB_BYTES, budget?: { left: number },
): Promise<Uint8Array | null> {
  const local = readBlob(c.core.paths.blobs, hash);
  if (local && blobServable(c.core.roster, c.core.store, hash, channel, c.core.myHandle())) return local;
  for (const n of activeNodes(c.core.roster)) {
    const addr = n.node_id === c.core.nodeId ? null : c.client.addrOf(n);
    if (!addr) continue;
    if (budget && budget.left <= 0) return null;
    const cap = Math.min(maxBytes, MAX_BLOB_BYTES, budget?.left ?? Infinity);
    const got = await c.client.blob(addr, hash, channel, cap).catch(() => null);
    // A failed attempt may have read up to `cap` bytes before it was dropped: charge that, not zero.
    if (budget) budget.left -= got ? got.byteLength : cap;
    if (!got || sha256Hex(got) !== hash) continue;
    writeBlob(c.core.paths.blobs, got);
    c.core.store.addProvenance(channel, hash);
    return got;
  }
  return null;
}

route("GET", /^\/v1\/artifacts\/([0-9a-f]{64})$/, async (c, [hash]) => {
  const h = hash as string;
  const channels = shareChannels(c.core.roster, c.core.store, h, c.core.myHandle());
  if (!channels.length) throw new HttpError(404, "not_found", "no visible artifact with that hash");
  c.noTimeout();
  let bytes: Uint8Array | null = null;
  for (const ch of channels) if (!bytes) bytes = await blobFor(c, h, ch);
  if (!bytes) throw new HttpError(404, "not_found", "artifact not available from any online peer");
  if (!c.core.store.blob(h)) {
    const share = c.core.store.blobRefRows(h).find((r) => r.channel && channels.includes(r.channel));
    const meta = share ? (parseEvent(share.json).body as { name?: string; mime?: string }) : {};
    c.core.store.addBlob(h, bytes.byteLength, meta.mime ?? null, meta.name ?? null);
  }
  const meta = c.core.store.blob(h);
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${(meta?.name ?? h).replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "X-Walkie-Mime": meta?.mime ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
});

// ---- stream ------------------------------------------------------------------------------

route("GET", "/v1/stream", (c) => {
  const chans = (c.url.searchParams.get("channels") ?? "").split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean);
  for (const ch of chans) if (!ChannelName.safeParse(ch).success) throw new HttpError(400, "invalid", `bad channel ${ch}`);
  // `agents=delta` (the dashboard): one roster snapshot from the hub, then only changed rows (WALKIE-LIVE-1).
  const agentsMode = c.url.searchParams.get("agents") ?? "full";
  if (agentsMode !== "full" && agentsMode !== "delta") throw new HttpError(400, "invalid", "agents must be full or delta");
  const agentsDelta = agentsMode === "delta";
  c.noTimeout();
  const res = c.core.hub.open(chans.length ? chans : null, [
    { type: "hello", me: meView(c.core, c.tailscaleError, c.transport) },
    ...(agentsDelta ? [] : [{ type: "agents" as const, ...agentsPayload(c.core, c.sync) }]),
    { type: "nodes", nodes: nodesView(c.core, c.sync) },
  ], c.req.signal, c.credentialExpiresAt, { agentsDelta, dashboard: c.via === "dashboard" && c.agent === undefined });
  if (!res) throw new HttpError(429, "rate_limited", "too many stream clients (max 64)");
  return res;
});

/** Agent names reserved for this daemon's connectors (the dashboard badges their posts as integrations). */
export const RESERVED_AGENTS: ReadonlySet<string> = new Set(["fireflies", "wispr", "linear"]);

/**
 * An absent header is a person; a PRESENT header must name an agent. Fetch trims header values, so `--agent " "`
 * arrives as "": treating that as absent would sign an agent's text as the person's own (ORCH-FIX-2, Codex HIGH 2).
 */
export function validAgentHeader(v: string | null): string | undefined {
  if (v === null) return undefined;
  if (v === "") throw new HttpError(400, "invalid", "X-Walkie-Agent is empty: name the agent, or send no header for a person");
  if (!AgentName.safeParse(v).success) throw new HttpError(400, "invalid", "X-Walkie-Agent is not a valid agent name");
  if (RESERVED_AGENTS.has(v)) throw new HttpError(403, "forbidden", `agent name "${v}" is reserved for the ${v} integration`);
  if (v === SEATS_AGENT) throw new HttpError(403, "forbidden", `agent name "${v}" is reserved for the seats host daemon`);
  if (v === ADMIN_AGENT) throw new HttpError(403, "forbidden", `agent name "${v}" is reserved for the admin audit trail`);
  // FO-6: the board steward's moves are trusted by the fold (it may move a person's card); only the daemon signs as it.
  if (v === STEWARD_AGENT || v === FLEET_AGENT) throw new HttpError(403, "forbidden", `agent name "${v}" is reserved for this daemon's ${v === FLEET_AGENT ? "fleet desk" : "board steward"}`);
  // A running seat speaks only through the seats' own socket (seats/seat-api.ts), so a `seat-*` post is always one.
  if (isSeatAgent(v)) throw new HttpError(403, "forbidden", `agent name "${v}" is reserved for remote seats`);
  return v;
}
