// Local API routes for integrations (PROTOCOL §5). Imported by the daemon for its side effect of
// registering routes. Same transport checks as every other route (socket, or token + Host + Origin on
// loopback); configuration changes are for people only (an X-Walkie-Agent header is refused).
import { adminGate } from "../daemon/admin/gate.ts";
import { z } from "zod";
import type { Event } from "../protocol/schemas.ts";
import { HttpError, json, parseWith, readJson } from "../daemon/http.ts";
import { LOCAL_BODY_MAX, limitWrite, requireTeam, route as addRoute, type Handler, type RouteCtx } from "../daemon/local-routes.ts";
import { isConnectorId, type ConnectorId } from "./config.ts";
import { CreateReq, parseKeys, type LinearService } from "./linear-service.ts";
import { ConfigureReq, type IntegrationManager } from "./manager.ts";
import { PostError } from "./poster.ts";
import { scrubMessage, scrubSecrets } from "./scrub.ts";
import { setIntegrationSlot, type SlotDeps } from "../license/integrations.ts";

export interface Integrations { readonly manager: IntegrationManager; readonly linear: LinearService }

/** Connector ids whose posts count as meeting posts. */
export const MEETING_SOURCES = ["fireflies", "wispr"] as const;
const MeetingsQuery = z.object({
  q: z.string().max(200).optional(),
  since_ts: z.coerce.number().int().optional(),
  before_ts: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Every integration route answers through this: any error leaving it (an HttpError message, or any
 * other error that would be logged as internal) is scrubbed of every configured key and of
 * secret-shaped tokens first, so an upstream echo can't reach a response or a log line. A success
 * body goes through the same scrubber (keys used + patterns), always, configured keys or not (#2).
 */
function route(method: string, path: string | RegExp, h: Handler): void {
  addRoute(method, path, async (c, params) => {
    try {
      const res = await h(c, params);
      const known = c.integrations?.manager.knownSecrets() ?? [];
      // Final gate on the success path too: no known key and nothing secret-shaped in any response body.
      const body = await res.text();
      const clean = scrubSecrets(body, known);
      return new Response(clean, { status: res.status, headers: res.headers });
    } catch (err) {
      const m = c.integrations?.manager;
      const clean = (msg: string) => (m ? m.safeMessage(new Error(msg), [], 500) : scrubMessage(msg, [], 500));
      if (err instanceof HttpError) {
        const details = err.details ? Object.fromEntries(Object.entries(err.details).map(([k, v]) => [k, typeof v === "string" ? clean(v) : v])) : undefined;
        throw new HttpError(err.status, err.code, clean(err.message), details);
      }
      c.core.log.warn("integration_route_failed", { path: c.url.pathname, err: clean(err instanceof Error ? err.message : String(err)) });
      if (err instanceof PostError) throw new HttpError(409, "post_failed", clean(err.message));
      throw new HttpError(500, "internal", "internal error");
    }
  });
}

function need(c: RouteCtx): Integrations {
  if (!c.integrations) throw new HttpError(404, "not_found", "integrations are not available on this daemon");
  return c.integrations;
}

function connector(id: string | undefined): ConnectorId {
  if (!isConnectorId(id)) throw new HttpError(404, "not_found", `no integration "${String(id).slice(0, 40)}" (fireflies, wispr, linear)`);
  return id;
}


route("GET", "/v1/integrations", (c) => json({ integrations: need(c).manager.views() }));

/** The slot's roster path: appended on the authority, a roster request elsewhere. */
function slotDeps(c: RouteCtx): SlotDeps {
  return { core: c.core, client: c.client, catchUp: c.sync?.requestCatchUp };
}

/** Releases this node's slot after a disable/remove; never fails the disable (logged, retried by the reconciler). */
function releaseSlot(c: RouteCtx, id: ConnectorId): void {
  setIntegrationSlot(slotDeps(c), id, false).catch((err: unknown) =>
    c.core.log.warn("integration_slot_release_failed", { connector: id, err: err instanceof Error ? err.message : String(err) }));
}

route("POST", /^\/v1\/integrations\/([a-z]+)$/, async (c, [id]) => {
  const cid = connector(id);
  const body = parseWith(ConfigureReq, await readJson(c.req, 16 * 1024));
  adminGate(c, `${body.enabled === false ? "disabled" : "configured"} the ${cid} integration`);
  const m = need(c).manager;
  const was = m.settings(cid).enabled === true;
  const wants = body.enabled !== false;
  if (wants && !was) {
    // Turning it on: a valid configuration first, then the plan's slot at the authority (402 plan_limit
    // past it, src/license/integrations.ts); only then is the connector enabled here. Authority offline:
    // the request is queued and the connector waits (202, pending_enable).
    m.configure(cid, body, { dryRun: true });
    const res = await setIntegrationSlot(slotDeps(c), cid, true);
    if ("queued" in res) return json({ queued: true, request_id: res.request_id, integration: m.configure(cid, body, { pendingEnable: true }) }, 202);
  }
  const integration = m.configure(cid, body);
  if (was && !wants) releaseSlot(c, cid);
  return json({ integration });
});

route("DELETE", /^\/v1\/integrations\/([a-z]+)$/, (c, [id]) => {
  const cid = connector(id);
  adminGate(c, `removed the ${cid} integration`);
  const m = need(c).manager;
  const was = m.settings(cid).enabled === true;
  const integration = m.remove(cid);
  if (was) releaseSlot(c, cid);
  return json({ integration });
});

route("POST", /^\/v1\/integrations\/([a-z]+)\/run$/, async (c, [id]) => {
  const cid = connector(id);
  adminGate(c, `ran a ${cid} sync now`);
  const m = need(c).manager;
  if (!m.settings(cid).enabled) throw new HttpError(409, "not_enabled", `${cid} is not enabled`);
  c.noTimeout();
  return json({ integration: await m.runNow(cid) });
});

route("GET", "/v1/linear/issues", async (c) => {
  const keys = parseKeys(c.url.searchParams.get("keys"));
  if (!keys.length) return json({ enabled: need(c).manager.settings("linear").enabled === true, issues: {} });
  c.noTimeout();
  return json(await need(c).linear.issues(keys));
});

route("POST", "/v1/linear/issues", async (c) => {
  const body = parseWith(CreateReq, await readJson(c.req, LOCAL_BODY_MAX));
  if (body.from) requireTeam(c); // the thread is read from, and the link posted to, the team log
  if (!body.dry_run) limitWrite(c);
  c.noTimeout();
  const res = await need(c).linear.create(body);
  return json(res, res.partial === true ? 207 : 200); // 207: the issue exists, its backlink is queued (FINAL Codex 6)
});

/** Recent meeting posts (Fireflies / Wispr), newest first, optionally filtered by text and time. */
route("GET", "/v1/meetings", (c) => {
  const q = parseWith(MeetingsQuery, Object.fromEntries(c.url.searchParams));
  const needle = q.q?.toLowerCase();
  const rows = c.core.store.queryEvents({
    kinds: ["msg.post"], agents: [...MEETING_SOURCES], roots: true, since_ts: q.since_ts, before_ts: q.before_ts, limit: 500,
  });
  const events: Event[] = [];
  for (const r of rows) {
    const ev = JSON.parse(r.json) as Event;
    if (!c.core.visible(ev)) continue;
    if (needle && !String((ev.body as { text?: unknown }).text ?? "").toLowerCase().includes(needle)) continue;
    events.push(ev);
    if (events.length >= q.limit) break;
  }
  return json({ events });
});

