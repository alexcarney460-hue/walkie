// Local API routes for a project's status page (PROJECT-PAGES-1, PROTOCOL §10 "Status page"). Imported by the daemon for its
// side effect of registering routes; the same transport checks as every route. The page is visible exactly as the project is
// (404 for one this member can't see, a private project of others included). A fact and a screen are written by a project
// member or their named agent; the dashboard session reads the page and writes nothing.
import { z } from "zod";
import { SCREEN_MAX_BYTES } from "../../protocol/projects/schema.ts";
import { HttpError, json, parseWith, readBytes, readJson } from "../http.ts";
import { LOCAL_BODY_MAX, limitWrite, refuseAgentJoinContent, requireTeam, route, type RouteCtx } from "../local-routes.ts";
import { agentsView } from "../views.ts";
import { addScreen, buildPage, removeScreen, setFact } from "./page.ts";
import { visibleProject, type WriteCtx } from "./service.ts";

function ctx(c: RouteCtx): WriteCtx {
  requireTeam(c);
  if (!c.projects) throw new HttpError(404, "not_found", "projects are not available on this daemon");
  return {
    core: c.core, idx: c.projects, client: c.client, catchUp: c.sync.requestCatchUp, ...(c.agent ? { agent: c.agent } : {}),
    ...(c.underAgent ? { underAgent: true } : {}),
  };
}

const PAGE = "^\\/v1\\/projects\\/(p-[0-9a-f]{8})\\/page";
/** Loose bounds only: the daemon's own checks (page.ts) answer with the plain reason, which says the real limit. */
const FactReq = z.object({
  label: z.string().min(1).max(300), value: z.string().min(1).max(1_000).optional(), remove: z.literal(true).optional(),
}).strict().refine((b) => (b.value === undefined) !== (b.remove === undefined), { message: "give a value, or remove: true (not both)" });
const ScreenReq = z.object({
  title: z.string().min(1).max(300), group: z.string().min(1).max(300), status: z.string().min(1).max(40), about: z.string().min(1).max(1_500),
  route: z.string().min(1).max(300).optional(), note: z.string().min(1).max(1_000).optional(),
}).strict();
const RemoveScreenReq = z.object({ group: z.string().min(1).max(300), title: z.string().min(1).max(300) }).strict();
/** The details of a screen travel in a header, URI-encoded JSON: at most this long (the most they can be is about 7 KB). */
const SCREEN_HEADER_MAX = 12_000;

route("GET", new RegExp(`${PAGE}$`), (c, [channel]) => {
  const w = ctx(c);
  const project = visibleProject(w, channel as string);
  return json(buildPage({ core: c.core, idx: w.idx, agents: () => agentsView(c.core, c.sync) }, project));
});

route("POST", new RegExp(`${PAGE}\\/facts$`), async (c, [channel]) => {
  const w = ctx(c);
  const b = parseWith(FactReq, await readJson(c.req, LOCAL_BODY_MAX));
  refuseAgentJoinContent(c, b);
  limitWrite(c);
  return json(setFact(w, channel as string, { label: b.label, value: b.remove ? null : (b.value as string) }));
});

/** The image's bytes (PNG, JPEG or WebP, at most 8 MB) as the body, its details in `X-Walkie-Screen` (URI-encoded JSON). */
route("POST", new RegExp(`${PAGE}\\/screens$`), async (c, [channel]) => {
  const w = ctx(c);
  limitWrite(c);
  const raw = c.req.headers.get("x-walkie-screen");
  if (!raw || raw.length > SCREEN_HEADER_MAX) throw new HttpError(400, "invalid", "X-Walkie-Screen (the screen's details, URI-encoded JSON) is required");
  let details: unknown;
  try { details = JSON.parse(decodeURIComponent(raw)); } catch { throw new HttpError(400, "invalid", "X-Walkie-Screen is URI-encoded JSON"); }
  const meta = parseWith(ScreenReq, details);
  refuseAgentJoinContent(c, meta);
  const bytes = await readBytes(c.req, SCREEN_MAX_BYTES);
  c.noTimeout();
  return json(addScreen(w, channel as string, bytes, meta));
});

route("POST", new RegExp(`${PAGE}\\/screens\\/remove$`), async (c, [channel]) => {
  const w = ctx(c);
  const b = parseWith(RemoveScreenReq, await readJson(c.req, LOCAL_BODY_MAX));
  limitWrite(c);
  return json(removeScreen(w, channel as string, b));
});
