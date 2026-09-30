// Local API routes for Projects (WALKIE-PROJECTS-1, PROTOCOL §5 "Projects"). Imported by the daemon for its side
// effect of registering routes; the same transport checks as every route (socket, or token / dashboard session +
// Host + Origin on loopback). People-only actions refuse an X-Walkie-Agent or X-Walkie-Under-Agent caller (service.ts requirePerson).
import { z } from "zod";
import { Address, EventId } from "../../protocol/schemas.ts";
import { associate } from "../../protocol/projects/assoc.ts";
import { cardsCsv } from "../../protocol/projects/format.ts";
import {
  Automations, Column, ColumnRole, PathRule, Prefix, MAX_COLUMNS, MAX_LABELS, MAX_PATHS,
  type CardView, type ProjectStub, type ProjectView,
} from "../../protocol/projects/schema.ts";
import { HttpError, json, parseWith, readJson } from "../http.ts";
import { LOCAL_BODY_MAX, limitWrite, refuseAgentJoinContent, requireTeam, route, type RouteCtx } from "../local-routes.ts";
import { agentsView } from "../views.ts";
import type { ProjectsIndex } from "./index.ts";
import { BatchReq } from "../../protocol/projects/batch.ts";
import { applyBatch, importBudgetKey } from "./batch.ts";
import { cardFiles } from "./room.ts";
import { adminGate, agentCaller } from "../admin/gate.ts";
import {
  automation, cardAction, comment, createBoard, createCard, createProject, findCard, findProject, requirePerson,
  updateBoard, updateCard, updateProject, visibleProject, visibleProjects, type WriteCtx,
} from "./service.ts";

function idx(c: RouteCtx): ProjectsIndex {
  if (!c.projects) throw new HttpError(404, "not_found", "projects are not available on this daemon");
  return c.projects;
}

function w(c: RouteCtx): WriteCtx {
  requireTeam(c);
  return {
    core: c.core, idx: idx(c), client: c.client, catchUp: c.sync.requestCatchUp, ...(c.agent ? { agent: c.agent } : {}),
    ...(c.underAgent ? { underAgent: true } : {}),
  };
}

/**
 * AGENT-ADMIN-1: a person's write done by their agent (project settings, board changes, export, deleting or restoring a
 * card, a project created with automations or path rules) passes the admin gate (audited, naming the agent) and is then
 * signed as the person: the fold accepts those ops from a person only (on pre.5 peers too, so nothing diverges).
 */
function adminW(c: RouteCtx, action: string): WriteCtx {
  const ctx = w(c);
  if (!agentCaller(c)) return ctx;
  adminGate(c, action);
  const { agent: _agent, underAgent: _under, ...person } = ctx;
  return person;
}

const Columns = z.array(Column).min(1).max(MAX_COLUMNS);
const Line = (max: number) => z.string().trim().min(1).max(max);
const Label = z.string().trim().min(1).max(32).regex(/^[^\n\r\t]+$/);
const Due = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const CreateProjectReq = z.object({
  name: Line(60), prefix: Prefix.optional(), folder: z.string().trim().max(40).optional(), description: z.string().max(2_000).optional(),
  private: z.boolean().optional(), paths: z.array(PathRule).max(MAX_PATHS).optional(), columns: Columns.optional(),
  meter: z.enum(["count", "points"]).optional(), automations: Automations.optional(), board: Line(40).optional(),
}).strict();
const UpdateProjectReq = z.object({
  name: Line(60).optional(), folder: z.string().trim().max(40).optional(), description: z.string().max(2_000).optional(),
  prefix: Prefix.optional(), paths: z.array(PathRule).max(MAX_PATHS).optional(), meter: z.enum(["count", "points"]).optional(),
  automations: Automations.optional(), state: z.enum(["active", "archived", "deleted"]).optional(), private: z.boolean().optional(),
  steward: z.enum(["on", "off"]).optional(), steward_node: z.string().regex(/^(?:[0-9a-f]{16})?$/).optional(),
}).strict();
const BoardReq = z.object({ name: Line(40), columns: Columns.optional() }).strict();
const UpdateBoardReq = z.object({ name: Line(40).optional(), columns: Columns.optional(), state: z.enum(["active", "archived"]).optional() }).strict();
const CreateCardReq = z.object({
  project: z.string().min(1).max(60), board: EventId.optional(), title: Line(200), body: z.string().max(16_000).optional(),
  column: z.string().min(1).max(40).optional(), assignee: Address.nullable().optional(), reviewer: Address.nullable().optional(),
  labels: z.array(Label).max(MAX_LABELS).optional(), estimate: z.number().int().min(0).max(1_000).nullable().optional(), due: Due.nullable().optional(),
}).strict();
const UpdateCardReq = z.object({
  title: Line(200).optional(), body: z.string().max(16_000).optional(), board: EventId.optional(),
  column: z.string().min(1).max(40).optional(), before: EventId.optional(), after: EventId.optional(),
  assignee: Address.nullable().optional(), reviewer: Address.nullable().optional(), labels: z.array(Label).max(MAX_LABELS).optional(),
  estimate: z.number().int().min(0).max(1_000).nullable().optional(), due: Due.nullable().optional(),
  blocked: z.boolean().optional(), blocked_reason: z.string().max(300).nullable().optional(),
  state: z.enum(["open", "archived", "deleted"]).optional(),
}).strict();
const CommentReq = z.object({ text: z.string().min(1).max(16_000) }).strict();
const ActionReq = z.object({ reason: z.string().max(300).optional() }).strict();
const AutomationReq = z.object({ event: z.enum(["pr_opened", "pr_merged"]), task: z.string().min(3).max(40) }).strict();

/** Private projects this member can't see: the roster names the channel and its members, nothing else is known. */
function stubs(c: RouteCtx): ProjectStub[] {
  const out: ProjectStub[] = [];
  for (const [name, ch] of c.core.roster.channels) {
    if (c.core.isProjectChannel(name) && ch.members && !c.core.visible({ channel: name })) out.push({ channel: name, private: true, stub: true, members: [...ch.members] });
  }
  return out;
}

// ---- projects -----------------------------------------------------------------------------------------------------

route("GET", "/v1/projects", (c) => {
  const ctx = w(c);
  const all = c.url.searchParams.get("all") === "1";
  const projects = visibleProjects(ctx).filter((p) => all || p.state !== "deleted")
    .sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
  return json({ projects, stubs: stubs(c) });
});

route("POST", "/v1/projects", async (c) => {
  const b = parseWith(CreateProjectReq, await readJson(c.req, LOCAL_BODY_MAX));
  const ctx = b.automations || b.paths?.length ? adminW(c, `created the project "${b.name}" with ${b.automations ? "automations" : "path rules"}`) : w(c);
  limitWrite(c);
  c.noTimeout();
  return json({ project: await createProject(ctx, b) });
});

/** A project with its cards (open and archived; `?deleted=1` adds deleted ones; `?board=` one board). */
route("GET", /^\/v1\/projects\/(p-[0-9a-f]{8})$/, (c, [channel]) => {
  const ctx = w(c);
  const project = visibleProject(ctx, channel as string);
  const states = c.url.searchParams.get("deleted") === "1" ? ["open", "archived", "deleted"] : ["open", "archived"];
  const board = c.url.searchParams.get("board") ?? undefined;
  const cards = ctx.idx.db.cards(project.channel, { ...(board ? { board } : {}), states, limit: 20_000 });
  return json({ project, cards, timeline: ctx.idx.settingsOf(project.channel).project?.timeline ?? [] });
});

route("POST", /^\/v1\/projects\/(p-[0-9a-f]{8})$/, async (c, [channel]) => {
  const b = parseWith(UpdateProjectReq, await readJson(c.req, LOCAL_BODY_MAX));
  refuseAgentJoinContent(c, b);
  // FO-6 (pre.8 merge): the board steward's switch and lease stay a person's, even under agent admin (an agent may
  // only dry-run the steward); other settings follow AGENT-ADMIN-1's audited gate.
  if ((b.steward !== undefined || b.steward_node !== undefined) && agentCaller(c)) requirePerson(w(c), "the board steward's switch and lease");
  const ctx = adminW(c, `changed project ${channel}: ${Object.keys(b).join(", ") || "nothing"}`);
  limitWrite(c);
  c.noTimeout();
  return json({ project: await updateProject(ctx, channel as string, b) });
});

route("POST", /^\/v1\/projects\/(p-[0-9a-f]{8})\/boards$/, async (c, [channel]) => {
  const ctx = w(c);
  const b = parseWith(BoardReq, await readJson(c.req, LOCAL_BODY_MAX));
  limitWrite(c);
  return json({ board: createBoard(ctx, channel as string, b) });
});

// The board id's ":" arrives percent-encoded from the client and the dashboard (encodeURIComponent); captures are decoded.
route("POST", /^\/v1\/projects\/(p-[0-9a-f]{8})\/boards\/([0-9a-f]{16}(?::|%3[Aa])[0-9]+)$/, async (c, [channel, board]) => {
  const b = parseWith(UpdateBoardReq, await readJson(c.req, LOCAL_BODY_MAX));
  const ctx = adminW(c, `changed a board of project ${channel}: ${Object.keys(b).join(", ") || "nothing"}`);
  limitWrite(c);
  return json({ board: updateBoard(ctx, channel as string, board as string, b) });
});

/**
 * Export (people only): `format=csv` (cards), `json` (the project and its cards), `ndjson` (every signed post of the
 * channel, as signed, one per line: verifiable with the members' keys).
 */
route("GET", /^\/v1\/projects\/(p-[0-9a-f]{8})\/export$/, (c, [channel]) => {
  const ctx = adminW(c, `exported project ${channel}`);
  const project = visibleProject(ctx, channel as string);
  const format = c.url.searchParams.get("format") ?? "json";
  const file = `${project.prefix.toLowerCase()}-${new Date().toISOString().slice(0, 10)}`;
  const attach = (ext: string, type: string, body: string) => new Response(body, {
    headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${file}.${ext}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
  const cards = ctx.idx.db.cards(project.channel, { states: ["open", "archived"], limit: 20_000 });
  if (format === "csv") return attach("csv", "text/csv; charset=utf-8", cardsCsv(project, cards));
  if (format === "ndjson") return attach("ndjson", "application/x-ndjson", ctx.idx.db.signedPosts(project.channel, 250_000).map((l) => `${l}\n`).join(""));
  if (format === "json") return attach("json", "application/json", JSON.stringify({ project, cards }, null, 2));
  throw new HttpError(400, "invalid", "format is csv, json or ndjson");
});

/** A batch body: up to MAX_BATCH_OPS ops of up to 16 KB each. */
const BATCH_BODY_MAX = 4 * 1024 * 1024;

/**
 * Board ops batch (LINEAR-IMPORT-1): people only, up to 250 card writes signed in one transaction, paid for from the
 * import budget (not the interactive write limit). `429 rate_limited` carries `retry_after_s`.
 */
route("POST", /^\/v1\/projects\/(p-[0-9a-f]{8})\/batch$/, async (c, [channel]) => {
  const ctx = w(c);
  requirePerson(ctx, "bulk board writes (an import)");
  const b = parseWith(BatchReq, await readJson(c.req, BATCH_BODY_MAX));
  c.noTimeout();
  return json({ batch: applyBatch(ctx, channel as string, b.ops, { budgetKey: importBudgetKey(c.rateKey) }) });
});

// ---- tasks (cards across projects) --------------------------------------------------------------------------------

const TasksQuery = z.object({
  project: z.string().max(60).optional(), board: EventId.optional(), q: z.string().max(200).optional(),
  assignee: z.string().max(140).optional(), state: z.enum(["open", "archived", "deleted", "all"]).default("open"),
  role: z.string().max(80).optional()
    .transform((v) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined))
    .pipe(z.array(ColumnRole).max(6).optional()),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Whether an assignee address is "me": this agent exactly, or (for a person) any address of the person. */
function isMine(ctxAgent: string | undefined, handle: string, hostname: string, a: string | null): boolean {
  if (!a) return false;
  if (ctxAgent) return a === `@${handle}/${hostname}/${ctxAgent}` || a === `@${handle}/${hostname}` || a === `@${handle}`;
  return a === `@${handle}` || a.startsWith(`@${handle}/`);
}

route("GET", "/v1/tasks", (c) => {
  const ctx = w(c);
  const q = parseWith(TasksQuery, Object.fromEntries(c.url.searchParams));
  const projects = q.project ? [findProject(ctx, q.project)] : visibleProjects(ctx).filter((p) => p.state === "active");
  const byChannel = new Map(projects.map((p) => [p.channel, p]));
  const states = q.state === "all" ? ["open", "archived", "deleted"] : [q.state];
  let cards: CardView[];
  if (q.q) {
    cards = ctx.idx.db.search(q.q, [...byChannel.keys()], 500).map((id) => ctx.idx.db.card(id)).filter((x): x is CardView => !!x);
  } else {
    cards = [...byChannel.keys()].flatMap((ch) => ctx.idx.db.cards(ch, { ...(q.board ? { board: q.board } : {}), states, limit: 20_000 }));
  }
  const handle = c.core.myHandle() ?? "";
  const roleOf = (card: CardView) => byChannel.get(card.channel)?.boards.find((b) => b.id === card.board)?.columns.find((x) => x.id === card.column)?.role;
  const out = cards
    .filter((x) => states.includes(x.state) && (!q.board || x.board === q.board))
    .filter((x) => !q.assignee || (q.assignee === "me" ? isMine(c.agent, handle, c.core.hostname, x.assignee) : x.assignee === q.assignee))
    .filter((x) => !q.role || q.role.includes(roleOf(x) ?? "todo"))
    .sort((a, b) => b.updated_at - a.updated_at);
  const page = out.slice(0, q.limit);
  const used = new Set(page.map((x) => x.channel));
  return json({
    tasks: page, total: out.length, truncated: out.length > page.length,
    projects: projects.filter((p) => used.has(p.channel)).map((p) => ({ channel: p.channel, name: p.name, prefix: p.prefix, boards: p.boards })),
  });
});

route("POST", "/v1/tasks", async (c) => {
  const ctx = w(c);
  const b = parseWith(CreateCardReq, await readJson(c.req, LOCAL_BODY_MAX));
  refuseAgentJoinContent(c, { title: b.title, body: b.body });
  limitWrite(c);
  const { project, ...rest } = b;
  const p = findProject(ctx, project);
  return json({ task: createCard(ctx, p.channel, rest) });
});

/** The hooks (registered before /v1/tasks/:ref, which would match it): an agent opened or merged a pull request for its card (moves it when the project says so). */
route("POST", "/v1/tasks/automation", async (c) => {
  const ctx = w(c);
  const b = parseWith(AutomationReq, await readJson(c.req, LOCAL_BODY_MAX));
  limitWrite(c);
  return json({ task: automation(ctx, b.event, b.task) });
});

/** A card with its signed history (every op, ignored ones marked, and the comments) and the agents on it now. */
route("GET", /^\/v1\/tasks\/([^/]+)$/, (c, [ref]) => {
  const ctx = w(c);
  const { project, card } = findCard(ctx, ref as string);
  const folded = ctx.idx.foldCardNow(project.channel, card.id);
  const projects = visibleProjects(ctx);
  const agents = agentsView(c.core, c.sync).filter((a) => {
    const cwd = a.node === c.core.nodeId ? c.core.localCwds.get(a.agent) : undefined;
    return associate(a.status, projects, (ch, n) => ch === card.channel && n === card.n, cwd ?? a.status.cwd)?.key === card.key;
  });
  return json({ card, project, timeline: folded?.state.timeline ?? [], agents, files: cardFiles(ctx, project.channel, card.id) });
});

route("POST", /^\/v1\/tasks\/([^/]+)$/, async (c, [ref]) => {
  const b = parseWith(UpdateCardReq, await readJson(c.req, LOCAL_BODY_MAX));
  refuseAgentJoinContent(c, { title: b.title, body: b.body, blocked_reason: b.blocked_reason });
  const cur = b.state !== undefined && agentCaller(c) ? findCard(w(c), ref as string).card : null;
  const deletes = !!cur && b.state !== cur.state && (b.state === "deleted" || cur.state === "deleted");
  const ctx = deletes && cur ? adminW(c, `${b.state === "deleted" ? "deleted" : "restored"} card ${cur.key}`) : w(c);
  limitWrite(c);
  return json({ task: updateCard(ctx, ref as string, b) });
});

route("POST", /^\/v1\/tasks\/([^/]+)\/comment$/, async (c, [ref]) => {
  const ctx = w(c);
  const b = parseWith(CommentReq, await readJson(c.req, LOCAL_BODY_MAX));
  refuseAgentJoinContent(c, b.text);
  limitWrite(c);
  const event = comment(ctx, ref as string, b.text);
  return json({ event, task: findCard(ctx, ref as string).card });
});

route("POST", /^\/v1\/tasks\/([^/]+)\/(start|review|done|block|unblock)$/, async (c, [ref, action]) => {
  const ctx = w(c);
  const b = parseWith(ActionReq, await readJson(c.req, LOCAL_BODY_MAX));
  refuseAgentJoinContent(c, b.reason ?? "");
  limitWrite(c);
  const task = cardAction(ctx, ref as string, action as "start", b.reason);
  if (action === "block" && b.reason) comment(ctx, ref as string, `Blocked: ${b.reason}`);
  return json({ task });
});

export type { ProjectView };
