// Local API for this machine's orchestrator (PROTOCOL §8, ORCH-FIX-11): GET /v1/orchestrator, its local conversation
// (GET /v1/orchestrator/messages, POST /v1/orchestrator/say | stop-reply) and POST /v1/orchestrator/start | stop.
// Only the person at this machine drives it: the dashboard (a session) or the CLI (the unix socket, or the durable
// token), never an agent, never a peer (nothing of it is on the peer API). The conversation is never replicated.
import { agentCaller, adminGate, adminRead } from "../admin/gate.ts";
import { z } from "zod";
import { MAX_MESSAGE_CHARS, MODEL_PATTERN, ORCHESTRATOR_ACCESS, PERMISSION_MODES, type OrchestratorView } from "../../protocol/orchestrator.ts";
import { HttpError, json, parseWith, readJson } from "../http.ts";
import { LOCAL_BODY_MAX, requireTeam, route, type RouteCtx } from "../local-routes.ts";
import { hostFor } from "./host.ts";

/**
 * A person at this machine: never an agent (a present X-Walkie-Agent), whichever it is, and never a paired phone (the
 * phone reaches no orchestrator route in v1; its allow-list has none either, mobile/tunnel.ts).
 */
function personOnly(c: RouteCtx, what: string): void {
  // AGENT-ADMIN-1: the conversation is the person's own voice to their orchestrator (an agent's text would be read as
  // theirs), so talking to it and reading it stay a person's; starting, stopping and its status are admin (below).
  if (c.agent !== undefined || c.underAgent) throw new HttpError(403, "forbidden", `the orchestrator is ${what} by the person at this machine, never an agent (use the dashboard or a plain terminal)`);
  if (c.via === "phone") throw new HttpError(403, "forbidden", "the orchestrator is reached from this machine's dashboard or terminal only");
}

function noPhone(c: RouteCtx): void {
  if (c.via === "phone") throw new HttpError(403, "forbidden", "the orchestrator is reached from this machine's dashboard or terminal only");
}

function host(c: RouteCtx) {
  const h = hostFor(c.core);
  if (!h) throw new HttpError(503, "unavailable", "this daemon runs without the orchestrator");
  return h;
}

function view(c: RouteCtx): OrchestratorView {
  return { local: host(c).view() };
}

route("GET", "/v1/orchestrator", (c) => {
  noPhone(c);
  adminRead(c);
  return json(view(c));
});

/** The local conversation, oldest first: one conversation's (`thread`), or the latest `limit` messages of all. */
route("GET", "/v1/orchestrator/messages", (c) => {
  requireTeam(c);
  personOnly(c, "read");
  const thread = c.url.searchParams.get("thread") ?? undefined;
  const limit = Math.min(Math.max(Number(c.url.searchParams.get("limit") ?? 500) || 500, 1), 2_000);
  const sinceRaw = c.url.searchParams.get("since");
  const since = sinceRaw === null ? undefined : Number(sinceRaw);
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0)) throw new HttpError(400, "invalid", "since must be epoch ms");
  return json({ messages: c.core.store.orchMessages({ ...(thread ? { thread } : {}), limit, ...(since !== undefined ? { since } : {}) }) });
});

const SayReq = z.object({ text: z.string().min(1).max(MAX_MESSAGE_CHARS), thread: z.string().min(1).max(64).optional() });
/** The person sends a message; it is authorised again when it runs (a session that ends first: `refused`). */
route("POST", "/v1/orchestrator/say", async (c) => {
  requireTeam(c);
  personOnly(c, "talked to");
  const b = parseWith(SayReq, await readJson(c.req, LOCAL_BODY_MAX));
  const message = host(c).say(b.text, b.thread, {
    via: c.via === "dashboard" ? "dashboard" : "cli",
    ...(c.credentialSignal ? { signal: c.credentialSignal } : {}),
    ...(c.credentialExpiresAt !== undefined ? { expiresAt: c.credentialExpiresAt } : {}),
  });
  return json({ message });
});

const StopReplyReq = z.object({ thread: z.string().min(1).max(64) });
/** The stop button: the reply in progress in `thread` stops, and that conversation's queued messages are dropped. */
route("POST", "/v1/orchestrator/stop-reply", async (c) => {
  requireTeam(c);
  personOnly(c, "stopped");
  const b = parseWith(StopReplyReq, await readJson(c.req, LOCAL_BODY_MAX));
  return json({ stopped: host(c).stopReply(b.thread), ...view(c) });
});

const StartReq = z.object({
  model: z.string().regex(MODEL_PATTERN).optional(),
  cwd: z.string().min(1).max(1_000).optional(),
  permission_mode: z.enum(PERMISSION_MODES as [string, ...string[]]).optional(),
  access: z.enum(ORCHESTRATOR_ACCESS as [string, ...string[]]).optional(),
  claude: z.string().min(1).max(1_000).optional(),
  path: z.string().max(8_000).optional(),
});

route("POST", "/v1/orchestrator/start", async (c) => {
  requireTeam(c);
  noPhone(c);
  const b = parseWith(StartReq, await readJson(c.req, LOCAL_BODY_MAX));
  adminRead(c);
  if (agentCaller(c) && (b.access === "full" || b.claude !== undefined || b.path !== undefined || b.cwd !== undefined || (b.permission_mode && b.permission_mode !== "default"))) {
    throw new HttpError(403, "person_only", "only a person can give WalkieTalkie shell access or elevated permissions or choose its binary and folder");
  }
  // ORCH-2: the audit line says which access and model an agent started it with (AGENT-ADMIN-1: agents may, audited).
  adminGate(c, `started the orchestrator (access: ${b.access ?? "platform"}, model: ${b.model ?? "default"})`);
  // The dashboard's Start dialog (PRE5-INT, ORCH-2) chooses the access and the model; which claude binary, its PATH,
  // folder and permission mode stay with the CLI (as the Seats view's opt-in: a dashboard session never names a binary).
  if (c.via !== "cli" && Object.entries(b).some(([k, v]) => k !== "access" && k !== "model" && v !== undefined)) {
    throw new HttpError(403, "forbidden", "the dashboard starts the orchestrator with its defaults and the access and model you pick; its folder, permission mode and claude path are set with walkie orchestrator start");
  }
  c.noTimeout();
  await host(c).start(b as Parameters<ReturnType<typeof host>["start"]>[0]);
  return json(view(c));
});

const ModelReq = z.object({ model: z.string().regex(MODEL_PATTERN) });
/**
 * ORCH-2: switches the model (the dashboard's picker, `walkie orchestrator model`, an agent under AGENT-ADMIN-1),
 * keeping the conversation: Claude resumes the same session with the new model at the next idle point.
 */
route("POST", "/v1/orchestrator/model", async (c) => {
  requireTeam(c);
  noPhone(c);
  const b = parseWith(ModelReq, await readJson(c.req, LOCAL_BODY_MAX));
  adminGate(c, `switched the orchestrator model to ${b.model}`);
  c.noTimeout();
  return json({ local: await host(c).setModel(b.model) });
});

const AccessReq = z.object({ access: z.enum(ORCHESTRATOR_ACCESS as [string, ...string[]]) });
/** ORCH-2: `walkie talkie access platform|full`: the access changes, keeping the conversation (as a model switch). */
route("POST", "/v1/orchestrator/access", async (c) => {
  requireTeam(c);
  noPhone(c);
  const b = parseWith(AccessReq, await readJson(c.req, LOCAL_BODY_MAX));
  if (agentCaller(c) && b.access === "full") {
    throw new HttpError(403, "person_only", "only a person can give WalkieTalkie shell access");
  }
  adminGate(c, `set WalkieTalkie's access to ${b.access}`);
  c.noTimeout();
  return json({ local: await host(c).setAccess(b.access as "platform" | "full") });
});

/** pre.8: `walkie talkie auto` / the dashboard's Resume: back to automatic (clears a start or a stop by hand). */
route("POST", "/v1/orchestrator/auto", async (c) => {
  requireTeam(c);
  noPhone(c);
  if (agentCaller(c) && host(c).wouldAutoElevate()) {
    throw new HttpError(403, "person_only", "only a person can give WalkieTalkie shell access or elevated permissions");
  }
  adminGate(c, "returned WalkieTalkie to automatic");
  return json({ local: await host(c).resumeAuto() });
});

const LeadEligibleReq = z.object({ eligible: z.boolean() });
route("POST", "/v1/orchestrator/lead-eligible", async (c) => {
  requireTeam(c);
  personOnly(c, "configured");
  const b = parseWith(LeadEligibleReq, await readJson(c.req, LOCAL_BODY_MAX));
  host(c).setLeadEligible(b.eligible);
  return json({ eligible: b.eligible });
});

/** Stops the orchestrator on this machine. */
route("POST", "/v1/orchestrator/stop", async (c) => {
  requireTeam(c);
  noPhone(c);
  adminGate(c, "stopped the orchestrator");
  const h = host(c);
  const was = h.running;
  // ORCH-2: a stop by hand sticks (the auto-start leaves it stopped until it is started by hand), also when it was
  // only standing by.
  await h.stopByHand();
  return json({ stopped: was ? "local" : "none", ...view(c) });
});
