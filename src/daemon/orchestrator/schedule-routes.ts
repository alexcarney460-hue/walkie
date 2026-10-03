import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ORCHESTRATOR_AGENT } from "../../protocol/orchestrator.ts";
import { ScheduleTask, nextRuns, validateCron } from "../../protocol/talkie-schedule.ts";
import { ScheduleManagement, type ScheduleManagementResult } from "../../protocol/talkie-management.ts";
import { adminGate, adminRead, personOnly } from "../admin/gate.ts";
import { HttpError, json, parseWith, readJson } from "../http.ts";
import { LOCAL_BODY_MAX, requireTeam, route, type RouteCtx } from "../local-routes.ts";
import { hostFor } from "./host.ts";
import { PeerCallError } from "../peer-client.ts";
import { signScheduleManagement } from "./schedule-forward.ts";

function schedules(c: RouteCtx) {
  requireTeam(c);
  if (c.via === "phone") throw new HttpError(403, "forbidden", "schedules are managed from this machine only");
  const host = hostFor(c.core);
  if (!host) throw new HttpError(503, "unavailable", "WalkieTalkie is unavailable");
  return host.schedules;
}

function management(c: RouteCtx, action: string): void {
  requireTeam(c);
  if (c.via === "phone") throw new HttpError(403, "forbidden", "schedules are managed from this machine only");
  if (c.core.me()?.role !== "owner") throw new HttpError(403, "forbidden", "only a team owner manages WalkieTalkie schedules");
  if (c.agent === ORCHESTRATOR_AGENT) throw new HttpError(403, "forbidden", "WalkieTalkie's own tools cannot edit schedules");
  adminGate(c, action, { post: false });
}

const Add = z.object({ name: z.string().trim().min(1).max(80), cron: z.string().min(1).max(100), task: ScheduleTask }).strict();
const Edit = Add.partial().extend({ enabled: z.boolean().optional() }).strict();
const Reset = z.object({ confirm: z.string() }).strict();

async function manage(c: RouteCtx, op: "add" | "edit" | "remove" | "reset", id?: string, input?: unknown): Promise<ScheduleManagementResult> {
  const request = ScheduleManagement.parse({ op, ...(id ? { id } : {}), ...(input ? { input } : {}),
    handle: c.core.myHandle() ?? "unknown", machine: c.core.hostname, audit_id: randomUUID(),
    ...(c.agent || c.underAgent ? { agent: c.agent ?? "agent (unnamed)" } : {}) });
  if (c.core.isAuthority()) {
    const host = schedules(c);
    if (!(await host.ensureChannel())) throw new HttpError(409, "channel_pending", "schedule channel is waiting for repair");
    return host.manage(request);
  }
  if (op === "reset") throw new HttpError(403, "forbidden", "reset is available only on the authority machine");
  const authority = c.core.authority ? c.core.roster.nodes.get(c.core.authority) : null;
  const addr = authority && c.client.addrOf(authority);
  const unavailable = () => new HttpError(503, "authority_unreachable",
    `the schedule authority is unreachable; try again when ${authority?.hostname ?? "its machine"} is online`);
  if (!addr) throw unavailable();
  try { return await c.client.scheduleManage(addr, signScheduleManagement(c.core, request)); }
  catch (err) {
    if (err instanceof PeerCallError && err.status === 404)
      throw new HttpError(409, "authority_outdated", `${authority?.hostname ?? "The authority"} runs an older Walkie; update it`);
    if (err instanceof PeerCallError && err.status >= 400 && err.status < 500)
      throw new HttpError(err.status, err.code, err.message);
    throw unavailable();
  }
}

route("GET", "/v1/orchestrator/schedules", (c) => {
  adminRead(c);
  const manager = schedules(c);
  return json({ schedules: manager.list(), status: manager.status?.() ?? null });
});

route("GET", "/v1/orchestrator/schedules/unresolved", (c) => {
  adminRead(c);
  requireTeam(c);
  if (c.core.me()?.role !== "owner") throw new HttpError(403, "forbidden", "only a team owner reads unresolved completions");
  const manager = schedules(c);
  const rawLimit = c.url.searchParams.get("limit");
  const limit = rawLimit === null ? 100 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new HttpError(400, "bad_page", "unresolved page limit is invalid");
  return json(manager.unresolvedPage(c.url.searchParams.get("after") ?? undefined, limit));
});

route("POST", "/v1/orchestrator/schedules/unresolved/ack-legacy", (c) => {
  management(c, "acknowledged older WalkieTalkie schedule completion outcomes");
  return json(schedules(c).acknowledgeLegacyOverflow());
});

route("GET", "/v1/orchestrator/schedules/next", (c) => {
  adminRead(c);
  const cron = c.url.searchParams.get("cron") ?? "";
  try { validateCron(cron); return json({ times: nextRuns(cron, Date.now()) }); }
  catch (err) { throw new HttpError(400, "invalid_cron", err instanceof Error ? err.message : "invalid cron"); }
});

route("POST", "/v1/orchestrator/schedules", async (c) => {
  const b = parseWith(Add, await readJson(c.req, LOCAL_BODY_MAX));
  management(c, `added WalkieTalkie schedule ${b.name}`);
  try { return json(await manage(c, "add", undefined, b), 201); }
  catch (err) { if (err instanceof HttpError) throw err; throw new HttpError(400, "invalid", String(err)); }
});

route("PATCH", /^\/v1\/orchestrator\/schedules\/([0-9a-f-]{36})$/, async (c, [id]) => {
  const b = parseWith(Edit, await readJson(c.req, LOCAL_BODY_MAX));
  management(c, `edited WalkieTalkie schedule ${id}`);
  try { return json(await manage(c, "edit", id!, b)); }
  catch (err) { if (err instanceof HttpError) throw err; throw new HttpError(400, "invalid", String(err)); }
});

route("DELETE", /^\/v1\/orchestrator\/schedules\/([0-9a-f-]{36})$/, async (c, [id]) => {
  management(c, `removed WalkieTalkie schedule ${id}`);
  return json(await manage(c, "remove", id!));
});

route("POST", /^\/v1\/orchestrator\/schedules\/([0-9a-f-]{36})\/run-now$/, async (c, [id]) => {
  // A lease-fenced WalkieTalkie child may request a run even when it cannot manage its schedule.
  if (c.agent !== ORCHESTRATOR_AGENT) adminGate(c, `ran WalkieTalkie schedule ${id}`);
  return json({ run_id: await schedules(c).runNow(id!) });
});

route("POST", /^\/v1\/orchestrator\/schedules\/([0-9a-f-]{36})\/reset$/, async (c, [id]) => {
  requireTeam(c);
  personOnly(c, "reset a WalkieTalkie schedule's claimed-slot mark");
  if (c.core.me()?.role !== "owner") throw new HttpError(403, "forbidden", "only a team owner resets schedules");
  if (c.listener !== "unix" && !(c.listener === "tcp" && c.via === "dashboard" && c.dashboard))
    throw new HttpError(403, "forbidden", "reset is available on the local socket or a dashboard session only");
  const body = parseWith(Reset, await readJson(c.req, LOCAL_BODY_MAX));
  if (body.confirm !== id) throw new HttpError(400, "not_confirmed", "type the exact schedule id to confirm reset");
  return json(await manage(c, "reset", id!));
});
