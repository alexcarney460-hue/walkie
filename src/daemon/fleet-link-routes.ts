// Local API for fleet links (FLEET-LINK-1, PROTOCOL §5): owners mint, list and revoke them. Minting and revoking are
// a person's (the dashboard, or a confirmed terminal; agents are refused). The link's record lives on the roster
// authority: on any other owner's machine these routes reach it over the peer API (`POST /peer/v1/links`). The secret
// is made here and never leaves this machine except inside the token returned to the person.
import { z } from "zod";
import { Handle } from "../protocol/schemas.ts";
import { releaseTag } from "../protocol/add-machine.ts";
import {
  FLEET_LINK_DEFAULT_DAYS, FLEET_LINK_DEFAULT_USES, FLEET_LINK_MAX_USES, fleetLinkCommand, fleetLinkUrl, fleetLinkWindowsCommand,
  type FleetLinkMinted, type FleetLinkView, type FleetLinksView,
} from "../protocol/fleet-link.ts";
import { DAY_MS, FLEET_LINK_MAX_DAYS, encodeFleetLink, newLinkSecret } from "./fleet-link.ts";
import { linksView, registerLink, revokeLink, type LinksPeerReq, type RegisterLink } from "./fleet-link-service.ts";
import { HttpError, json, parseWith, readJson } from "./http.ts";
import { LOCAL_BODY_MAX, requireOwner, requirePerson, route, type RouteCtx } from "./local-routes.ts";
import { PeerCallError } from "./peer-client.ts";
import { servesDirect } from "./roster.ts";
import { VERSION } from "./version.ts";

const MintReq = z.object({
  /** Whose machines they become (a current member's handle); default: the owner minting it. */
  for: Handle.optional(),
  /** How many machines it admits; 0 = unlimited (bounded by the node limits). */
  uses: z.number().int().min(0).max(FLEET_LINK_MAX_USES).default(FLEET_LINK_DEFAULT_USES),
  expires_days: z.number().int().min(1).max(FLEET_LINK_MAX_DAYS).default(FLEET_LINK_DEFAULT_DAYS),
  /** Each machine waits in the owners' Waiting to join list until one approves it. */
  approve: z.boolean().default(false),
  /** The owner means it: the target is an observer. */
  observer: z.boolean().optional(),
  /** Explicit acknowledgement that these machines receive owner-level access. */
  owner_machines: z.boolean().optional(),
});
const RevokeReq = z.object({ id: z.string().regex(/^[0-9a-f]{6,32}$/, "a fleet link id (hex, at least 6 characters)") });

// What the roster authority answers (a peer: validated before use).
const ViewSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/), short: z.string().max(32), handle: Handle, role: z.enum(["owner", "member", "observer"]),
  uses: z.number().int().min(0).max(FLEET_LINK_MAX_USES), used: z.number().int().min(0), pending: z.number().int().min(0),
  expires_at: z.number().int(), approve: z.boolean(), created_at: z.number().int(), created_by: z.string().max(64),
  revoked_at: z.number().int().nullable(), state: z.enum(["active", "used_up", "expired", "revoked", "dead"]), reason: z.string().max(64).optional(),
});
const UseSchema = z.object({
  link: z.string().max(32), node_id: z.string().max(16), hostname: z.string().max(63),
  generation: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  state: z.enum(["admitted", "pending", "declined", "refused"]), reason: z.string().max(64).optional(), at: z.number().int(),
});
const CreatedSchema = z.object({ link: ViewSchema, relay: z.string().max(200).nullable() });
const RevokedSchema = z.object({ link: ViewSchema });
const ListSchema = z.object({ links: z.array(ViewSchema).max(1_000), uses: z.array(UseSchema).max(1_000), authority: z.string().max(63) });

/** Sends one request to the roster authority; its refusals come back as they are, an outage as 503. */
async function atAuthority<T>(c: RouteCtx, body: LinksPeerReq, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  const id = c.core.authority;
  const node = id ? c.core.roster.nodes.get(id) : undefined;
  const addr = node ? c.client.addrOf(node) : null;
  const where = node?.hostname ?? "the roster authority";
  if (!node || !addr) throw new HttpError(503, "authority_unreachable", `fleet links are kept on the roster authority (${where}), which this machine can't reach`);
  let res: unknown;
  try {
    res = await c.client.links(addr, body);
  } catch (err) {
    if (err instanceof PeerCallError && err.status === 404 && err.code === "not_found" && body.op !== "revoke") {
      throw new HttpError(409, "authority_outdated", `the roster authority (${where}) runs a Sqwakie without fleet links: upgrade it first`);
    }
    if (err instanceof PeerCallError && err.status >= 400 && err.status < 500) throw new HttpError(err.status, err.code, err.message);
    throw new HttpError(503, "authority_unreachable", `the roster authority (${where}) isn't reachable right now; fleet links are kept there (nothing can join with one while it is offline either)`);
  }
  const parsed = schema.safeParse(res);
  if (!parsed.success) throw new HttpError(502, "bad_response", "the roster authority's answer has the wrong shape");
  return parsed.data;
}

route("POST", "/v1/team/links", async (c) => {
  requireOwner(c);
  requirePerson(c, "mint fleet links");
  const b = parseWith(MintReq, await readJson(c.req, LOCAL_BODY_MAX));
  const core = c.core;
  const authority = core.authority ? core.roster.nodes.get(core.authority) : undefined;
  if (!authority || !servesDirect(authority)) {
    const where = core.isAuthority() ? "run: walkie direct enable" : `on ${authority?.hostname ?? "the roster authority"} run: walkie direct enable`;
    throw new HttpError(409, "direct_unavailable", `the team's roster authority doesn't run Sqwakie Direct yet, so machines couldn't reach it with a link (${where})`);
  }
  c.noTimeout();
  const handle = b.for ?? (core.myHandle() as string);
  const { secret, id } = newLinkSecret();
  // Whole seconds: the token carries seconds, and the authority matches the record to it.
  const expires_at = Math.floor((core.clock() + b.expires_days * DAY_MS) / 1000) * 1000;
  const reg: RegisterLink = { id, handle, uses: b.uses, approve: b.approve, expires_at, ...(b.observer ? { observer: true } : {}), ...(b.owner_machines ? { owner_machines: true } : {}) };
  const created = core.isAuthority()
    ? await registerLink(core, reg, core.nodeId)
    : await atAuthority(c, { op: "create", link: reg }, CreatedSchema);
  const token = encodeFleetLink(core.keys, secret, {
    team: core.teamId as string, authority: authority.pubkey, ...(created.relay ? { relay: created.relay } : {}),
    handle, expires_at, uses: b.uses, approve: b.approve,
  });
  const tag = releaseTag(VERSION);
  const res: FleetLinkMinted = {
    ...(created.link as FleetLinkView), token, link: fleetLinkUrl(token, tag), command: fleetLinkCommand(token, tag),
    windows_command: fleetLinkWindowsCommand(token, tag), version: VERSION,
  };
  return json(res);
});

route("GET", "/v1/team/links", async (c) => {
  requireOwner(c);
  c.noTimeout();
  const view: FleetLinksView = c.core.isAuthority() ? linksView(c.core) : await atAuthority(c, { op: "list" }, ListSchema);
  return json(view);
});

route("POST", "/v1/team/links/revoke", async (c) => {
  requireOwner(c);
  requirePerson(c, "revoke fleet links");
  const b = parseWith(RevokeReq, await readJson(c.req, LOCAL_BODY_MAX));
  c.noTimeout();
  const by = c.core.myHandle() as string;
  const link = c.core.isAuthority() ? revokeLink(c.core, b.id, by) : (await atAuthority(c, { op: "revoke", id: b.id }, RevokedSchema)).link;
  return json({ link });
});
