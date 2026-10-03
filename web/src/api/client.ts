// Same-origin client for the daemon's local API. The dashboard session (from `walkie dashboard`, kept in this
// origin's localStorage by lib/session.ts) goes in the X-Walkie-Session header of every call; cookies are never
// sent and never authorize anything. Nothing here ever sees the daemon's durable token.
import { forgetSession, sessionHeaders } from "../lib/session.ts";
import type {
  AccountsPool, AccountView, AgentsPayload, AgentView, AskView, BoardView, CardDetail, CardView, Column, Event, IntegrationView, InviteCode, LinearIssueInfo,
  MeView, MobileStatus, NodeView, OrchestratorAccess, OrchestratorView, OrchMessage, PairView, PendingJoin, PlanLimitDetails, PlanView, ProjectView, ProjectsPayload,
  ResetAttemptView, ResetResult, Role, RoomFileDetail, RoomFileView, StatusPagePayload, StatusReportPayload, TeamView, TimelineEntry,
  SeatMode, SeatRuntime, SeatsLocalView, SeatsView,
  Schedule, Recommendation, RecommendationsPayload, RecommendationDecision,
  ImportOptions, ImportPlan, ImportSelection, ImportStatus, JobView, SyncResult, SyncView,
} from "./types.ts";
import type { ActivationResult } from "../lib/plan.ts";
import type { AddMachine } from "../../../src/protocol/add-machine.ts";

export class ApiError extends Error {
  /** A 409 secret_detected's detector kinds (DATA-ROOM-1). */
  findings?: string[];
  constructor(readonly code: string, message: string, readonly status: number, readonly details?: PlanLimitDetails) {
    super(message);
  }
}

const RESOURCES = new Set<PlanLimitDetails["resource"]>(["people", "machines", "restricted_channels", "integrations", "projects", "boards"]);
const PLANS = new Set<PlanLimitDetails["plan"]>(["free", "team", "business"]);

/** The extra fields of a 402 `plan_limit` error, if they are well formed (the body is untrusted). */
export function planLimitDetails(e: Record<string, unknown>): PlanLimitDetails | undefined {
  const { resource, limit, used, plan, upgrade_url, subscribed } = e;
  if (typeof resource !== "string" || !RESOURCES.has(resource as PlanLimitDetails["resource"])) return undefined;
  if (typeof limit !== "number" || typeof used !== "number" || typeof upgrade_url !== "string") return undefined;
  const p = typeof plan === "string" && PLANS.has(plan as PlanLimitDetails["plan"]) ? (plan as PlanLimitDetails["plan"]) : "free";
  return { resource: resource as PlanLimitDetails["resource"], limit, used, plan: p, upgrade_url, subscribed: subscribed === true };
}

/** The plan-limit details when `err` is a 402 plan_limit refusal. */
export function planLimitOf(err: unknown): PlanLimitDetails | null {
  return err instanceof ApiError && err.code === "plan_limit" && err.details ? err.details : null;
}

const TIMEOUT_MS = 10_000;

const FRIENDLY: Record<string, string> = {
  rate_limited: "You're sending too fast. Wait a few seconds and try again.",
  forbidden: "You don't have permission to do that.",
  unauthorized: "Your dashboard session has ended. Run `walkie dashboard` in a terminal to sign in again.",
  no_team: "This machine isn't on a team yet.",
  network: "Can't reach the Walkie daemon on this machine.",
  timeout: "The daemon took too long to answer.",
};

export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) return FRIENDLY[err.code] ?? err.message;
  return "Something went wrong. Try again.";
}

async function send(path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
  try {
    return await fetch(path, { ...init, credentials: "omit", headers: sessionHeaders(init.headers) });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    throw new ApiError(timedOut ? "timeout" : "network", timedOut ? "request timed out" : "daemon unreachable", 0);
  }
}

async function parse(res: Response, path: string): Promise<unknown> {
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError("bad_response", `unexpected response from ${path}`, res.status);
    }
  }
  if (!res.ok) {
    const raw = (data as { error?: unknown }).error;
    const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const code = typeof e.code === "string" ? e.code : `http_${res.status}`;
    const message = typeof e.message === "string" ? e.message : res.statusText;
    const error = new ApiError(code, message, res.status, code === "plan_limit" ? planLimitDetails(e) : undefined);
    if (code === "secret_detected" && Array.isArray(e.findings)) error.findings = e.findings.filter((x): x is string => typeof x === "string").slice(0, 20);
    throw error;
  }
  return data;
}

async function request<T>(method: string, path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<T> {
  const res = await send(path, {
    method,
    headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await parse(res, path)) as T;
}

/** One server-sent event from /v1/stream. */
export type StreamHandler = (type: string, data: string) => void;

/**
 * `GET /v1/stream?agents=delta` read with fetch (EventSource can't send the session header). `onOpen` runs once the
 * daemon accepts it, `onData` on every chunk (heartbeats included: the liveness signal); resolves when the daemon ends
 * the stream, rejects with an ApiError when it refuses it.
 */
async function stream(onOpen: () => void, onMessage: StreamHandler, onData: () => void, signal: AbortSignal): Promise<void> {
  const res = await send("/v1/stream?agents=delta", { headers: { Accept: "text/event-stream" }, cache: "no-store", signal });
  if (!res.ok || !res.body) {
    await parse(res, "/v1/stream");
    throw new ApiError("bad_response", "the stream had no body", res.status);
  }
  onOpen();
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    onData();
    buf += value;
    for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let type = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) onMessage(type, data.join("\n"));
    }
  }
}

/** Downloads an artifact: fetched with the session header, then saved from a blob URL. */
async function download(hash: string, name: string): Promise<void> {
  return downloadPath(`/v1/artifacts/${hash}`, name);
}

/** Any authenticated GET saved as a file (artifacts, project exports). */
async function downloadPath(path: string, name: string): Promise<void> {
  const res = await send(path, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) await parse(res, path);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The secret kinds a 409 secret_detected carries (the body is untrusted: strings only). */
export function secretFindings(err: unknown): string[] | null {
  if (!(err instanceof ApiError) || err.code !== "secret_detected") return null;
  return err.findings ?? [];
}

/**
 * Uploads a file to a project's Data Room (a new version when a live file has that name). `allowSecrets`: the person
 * confirmed an upload the secret scan flagged.
 */
async function roomAdd(channel: string, file: Blob, meta: { name: string; card?: string; pin?: boolean; allowSecrets?: boolean }): Promise<{ file: RoomFileView; version: number; created: boolean; unchanged?: boolean; warnings?: string[] }> {
  const path = `/v1/projects/${encodeURIComponent(channel)}/room`;
  const res = await send(path, {
    method: "POST",
    headers: {
      Accept: "application/json", "Content-Type": "application/octet-stream", "X-Walkie-Name": encodeURIComponent(meta.name),
      "X-Walkie-Mime": (file.type || "application/octet-stream").slice(0, 100),
      ...(meta.card ? { "X-Walkie-Card": encodeURIComponent(meta.card) } : {}), ...(meta.pin ? { "X-Walkie-Pin": "1" } : {}),
      ...(meta.allowSecrets ? { "X-Walkie-Allow-Secrets": "1" } : {}),
    },
    body: file,
    signal: AbortSignal.timeout(180_000),
  });
  return (await parse(res, path)) as { file: RoomFileView; version: number; created: boolean; unchanged?: boolean; warnings?: string[] };
}

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]);
  return entries.length ? `?${new URLSearchParams(entries)}` : "";
}

export interface EventsParams {
  channel?: string;
  thread?: string;
  kinds?: string;
  before_ts?: number;
  since_ts?: number;
  limit?: number;
}

export const api = {
  me: () => request<MeView>("GET", "/v1/me"),
  team: () => request<TeamView>("GET", "/v1/team"),
  /**
   * The live roster by default; scope "archive" lists the Agent archive (newest first), filtered by node, search and
   * state on the daemon before the page is cut (total / truncated say how much more there is).
   */
  agents: (p: { scope?: "live" | "archive" | "all"; node?: string; q?: string; states?: string; limit?: number; offset?: number } = {}) =>
    request<AgentsPayload>("GET", `/v1/agents${qs({ ...p })}`),
  guests: () => request<{ guests: { id: string; node: string; agent: string; owner: string; address: string; revoked: boolean; expiresAt: number; lastReportAt: number | null; cards: { id: string; key: string }[] }[]; killed: boolean }>("GET", "/v1/guests"),
  revokeGuest: (agent: string) => request<{ revoked: boolean }>("POST", `/v1/guests/${encodeURIComponent(agent)}/revoke`, {}),
  setGuestKill: (killed: boolean) => request<{ killed: boolean }>("POST", "/v1/guests/kill", { killed }),
  peers: () => request<{ nodes: NodeView[]; local_lag?: { max_ms: number; at: number } | null }>("GET", "/v1/peers"),
  accounts: () => request<{ accounts: AccountView[]; pool?: AccountsPool }>("GET", "/v1/accounts"),
  /** The attempt the confirmation sheet confirms: minted and bound to the account by the daemon (or an earlier one). */
  prepareReset: (account: string) => request<{ attempt: ResetAttemptView }>("POST", "/v1/accounts/reset/prepare", { account }),
  /** Uses one limit reset on an account held on this machine (Codex); `request_id` is the prepared attempt's id. */
  useReset: (account: string, requestId: string) =>
    request<{ result: ResetResult }>("POST", "/v1/accounts/reset", { account, request_id: requestId }, 90_000),
  /** A person checked usage: releases the account's unconfirmed attempt, and an unreadable reset ledger. */
  resolveReset: (account: string) => request<{ attempt: string | null; ledger: boolean }>("POST", "/v1/accounts/reset/resolve", { account }),
  /** Brings the account's next usage poll forward (after a reset used on the provider's own page). */
  refreshAccount: (account: string) => request<{ scheduled: boolean; held: boolean }>("POST", "/v1/accounts/refresh", { account }),
  events: (p: EventsParams = {}) => request<{ events: Event[] }>("GET", `/v1/events${qs({ ...p })}`),
  event: (id: string) => request<{ event: Event; replies: Event[] }>("GET", `/v1/events/${encodeURIComponent(id)}`),
  asks: (p: { state?: string; to?: string } = {}) => request<{ asks: AskView[] }>("GET", `/v1/asks${qs(p)}`),
  post: (b: { channel: string; text: string; thread?: string }) => request<{ event: Event }>("POST", "/v1/post", b),
  answer: (b: { ask: string; text: string; declined?: boolean }) => request<{ event: Event }>("POST", "/v1/answer", b),
  pending: () => request<{ requests: PendingJoin[] }>("GET", "/v1/team/pending"),
  admit: (b: { node_id: string; approve: boolean }) => request<{ event?: Event }>("POST", "/v1/team/admit", b),
  orchestrator: () => request<OrchestratorView>("GET", "/v1/orchestrator"),
  recommendations: () => request<RecommendationsPayload>("GET", "/v1/talkie/recs?status=all"),
  // An approval echoes the `outgoing` text the person was shown; the daemon refuses it if what it would do now differs.
  answerRecommendation: (id: string, decision: RecommendationDecision, seen?: string) =>
    request<{ rec: Recommendation; result?: string }>("POST", `/v1/talkie/recs/${encodeURIComponent(id)}/${decision}`,
      decision === "approve" && seen !== undefined ? { seen } : {}),
  schedules: () => request<{ schedules: Schedule[]; status: string | null }>("GET", "/v1/orchestrator/schedules"),
  scheduleNext: (cron: string) => request<{ times: number[] }>("GET", `/v1/orchestrator/schedules/next?cron=${encodeURIComponent(cron)}`),
  scheduleAdd: (body: Pick<Schedule, "name" | "cron" | "task">) => request<{ schedule: Schedule }>("POST", "/v1/orchestrator/schedules", body),
  scheduleEdit: (id: string, body: Partial<Pick<Schedule, "name" | "cron" | "task" | "enabled">>) => request<{ schedule: Schedule }>("PATCH", `/v1/orchestrator/schedules/${encodeURIComponent(id)}`, body),
  scheduleRemove: (id: string) => request<{ removed: boolean }>("DELETE", `/v1/orchestrator/schedules/${encodeURIComponent(id)}`),
  scheduleRunNow: (id: string) => request<{ run_id: string }>("POST", `/v1/orchestrator/schedules/${encodeURIComponent(id)}/run-now`, {}),
  /** This machine's local orchestrator conversation (ORCH-FIX-11). */
  orchestratorMessages: (limit = 1_000, since?: number) =>
    request<{ messages: OrchMessage[] }>("GET", `/v1/orchestrator/messages?limit=${limit}${since !== undefined ? `&since=${since}` : ""}`),
  orchestratorSay: (text: string, thread?: string) => request<{ message: OrchMessage }>("POST", "/v1/orchestrator/say", { text, ...(thread ? { thread } : {}) }),
  orchestratorStopReply: (thread: string) => request<{ stopped: boolean }>("POST", "/v1/orchestrator/stop-reply", { thread }),
  /** Starts this machine's orchestrator with the daemon's defaults (the dashboard is the person; the phone is refused). */
  /** The dashboard chooses the access and the model (ORCH-2); everything else is the daemon's defaults. */
  orchestratorStart: (access?: OrchestratorAccess, model?: string) =>
    request<OrchestratorView>("POST", "/v1/orchestrator/start", { ...(access ? { access } : {}), ...(model && model !== "default" ? { model } : {}) }, 60_000),
  /** ORCH-2: switches the model; the conversation continues (after the reply in progress). */
  /** pre.8: Resume = back to automatic (runs here when this machine leads, else stands by). */
  orchestratorAuto: () => request<OrchestratorView>("POST", "/v1/orchestrator/auto", {}, 30_000),
  orchestratorModel: (model: string) => request<OrchestratorView>("POST", "/v1/orchestrator/model", { model }, 60_000),
  /** ORCH-2: platform (Walkie tools only) or full access; the conversation continues (after the reply in progress). */
  orchestratorAccess: (access: OrchestratorAccess) => request<OrchestratorView>("POST", "/v1/orchestrator/access", { access }, 60_000),
  /** Stops this machine's orchestrator (its conversations stay). */
  orchestratorStop: () => request<OrchestratorView & { stopped: "local" | "none" }>("POST", "/v1/orchestrator/stop", {}, 30_000),
  invite: (b: { login: string; handle: string; role: Role; display_name?: string }) => request<{ event: Event }>("POST", "/v1/team/invite", b),
  /** Walkie Direct: a single-use invite code (7 days) for `handle`. */
  inviteCode: (b: { handle: string; role: Role }) => request<InviteCode>("POST", "/v1/team/invite-code", b, 15_000),
  /** Owner: a one-time link + install command for another machine of a current member. */
  addMachine: (b: { handle: string }) => request<AddMachine>("POST", "/v1/team/add-machine", b, 15_000),
  channel: (b: { name: string; topic?: string; members?: string[] }) => request<{ event: Event }>("POST", "/v1/channels", b),
  license: () => request<PlanView>("GET", "/v1/license"),
  activateLicense: (key: string) => request<ActivationResult>("POST", "/v1/license", { key }, 30_000),
  download,
  stream,
  integrations: () => request<{ integrations: IntegrationView[] }>("GET", "/v1/integrations"),
  configureIntegration: (id: string, b: Record<string, unknown>) => request<{ integration: IntegrationView }>("POST", `/v1/integrations/${encodeURIComponent(id)}`, b),
  removeIntegration: (id: string) => request<{ integration: IntegrationView }>("DELETE", `/v1/integrations/${encodeURIComponent(id)}`),
  runIntegration: (id: string) => request<{ integration: IntegrationView }>("POST", `/v1/integrations/${encodeURIComponent(id)}/run`, {}, 150_000),
  /** Ends this tab's dashboard session on the daemon and forgets it here. */
  // ---- remote seats (PROTOCOL §11) ----
  seats: () => request<SeatsView>("GET", "/v1/seats"),
  /** The dashboard sets only these (the daemon refuses the rest from a session: the CLI's). */
  seatsConfig: (b: { allow: boolean; same_user?: boolean }) => request<{ local: SeatsLocalView }>("POST", "/v1/seats/config", b, 60_000),
  seatRun: (b: { machine: string; runtime: SeatRuntime; model?: string; permission_mode?: SeatMode; prompt: string; timeout_s?: number; v?: 2 }) =>
    request<{ event: Event; seat: string }>("POST", "/v1/seats/run", b),
  seatStop: (seat: string) => request<{ stopped: string; verified?: boolean; why?: string }>("POST", "/v1/seats/stop", { seat }, 30_000),
  /** "I'm using this computer": at most `max` seats keep running here (the rest pause, launches queue). */
  seatsBusy: (b: { max: number; for_s?: number }) => request<{ local: SeatsLocalView }>("POST", "/v1/seats/busy", b),
  /** "I'm done": paused seats continue, queued ones start. */
  seatsResume: () => request<{ local: SeatsLocalView }>("POST", "/v1/seats/resume", {}),
  // ---- AGENT-ADMIN-1: this machine's admin switches and audit log ----
  admin: () => request<AdminView>("GET", "/v1/admin?limit=5"),
  adminSwitches: (b: { agent_admin?: boolean; remote_admin?: boolean }) => request<{ agent_admin: boolean; remote_admin: boolean }>("POST", "/v1/admin/switches", b),
  logout: async () => {
    try {
      const res = await send("/auth/logout", { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok && res.status !== 401) throw new ApiError(`http_${res.status}`, res.statusText, res.status);
    } finally {
      forgetSession();
    }
  },
  /** Walkie on your phone (WALKIE-PWA-1): Team → Devices. */
  mobile: () => request<MobileStatus>("GET", "/v1/mobile"),
  mobilePair: () => request<PairView>("POST", "/v1/mobile/pair", {}, 15_000),
  mobileRevoke: (id: string) => request<{ revoked: true }>("DELETE", `/v1/mobile/devices/${encodeURIComponent(id)}`),
  // ---- Linear import (LINEAR-IMPORT-1) ----
  linearImportStatus: () => request<ImportStatus>("GET", "/v1/import/linear/status"),
  /** A dry run: reads Linear, writes nothing (the key: the Linear integration's, or a key file path). */
  linearImportPlan: (options: Partial<ImportOptions>, keyFile?: string) =>
    request<{ plan: ImportPlan }>("POST", "/v1/import/linear/plan", { options, ...(keyFile ? { key_file: keyFile } : {}) }, 600_000),
  linearImportRun: (selection: ImportSelection, keyFile?: string) =>
    request<{ job: JobView }>("POST", "/v1/import/linear/run", { selection, ...(keyFile ? { key_file: keyFile } : {}) }, 60_000),
  linearImportCancel: () => request<{ job: JobView | null }>("POST", "/v1/import/linear/cancel", {}),
  linearSync: (twoWay?: boolean, keyFile?: string) =>
    request<{ result: SyncResult }>("POST", "/v1/import/linear/sync", { ...(twoWay !== undefined ? { two_way: twoWay } : {}), ...(keyFile ? { key_file: keyFile } : {}) }, 600_000),
  linearSyncSettings: (b: { enabled?: boolean; two_way?: boolean; interval_min?: number; key_file?: string | null }) =>
    request<{ sync: SyncView }>("POST", "/v1/import/linear/settings", b),
  // ---- projects (WALKIE-PROJECTS-1) ----
  projects: () => request<ProjectsPayload>("GET", "/v1/projects"),
  project: (channel: string) => request<{ project: ProjectView; cards: CardView[]; timeline: TimelineEntry[] }>("GET", `/v1/projects/${encodeURIComponent(channel)}`, undefined, 30_000),
  createProject: (b: { name: string; prefix?: string; folder?: string; description?: string; private?: boolean; paths?: Array<{ path: string } | { repo: string }> }) =>
    request<{ project: ProjectView }>("POST", "/v1/projects", b, 30_000),
  updateProject: (channel: string, b: Record<string, unknown>) => request<{ project: ProjectView }>("POST", `/v1/projects/${encodeURIComponent(channel)}`, b, 30_000),
  createBoard: (channel: string, b: { name: string; columns?: Column[] }) => request<{ board: BoardView }>("POST", `/v1/projects/${encodeURIComponent(channel)}/boards`, b),
  updateBoard: (channel: string, board: string, b: Record<string, unknown>) => request<{ board: BoardView }>("POST", `/v1/projects/${encodeURIComponent(channel)}/boards/${encodeURIComponent(board)}`, b),
  exportProject: (channel: string, format: "csv" | "json" | "ndjson", name: string) => downloadPath(`/v1/projects/${encodeURIComponent(channel)}/export?format=${format}`, name),
  task: (ref: string) => request<CardDetail & { agents: AgentView[]; files?: RoomFileView[] }>("GET", `/v1/tasks/${encodeURIComponent(ref)}`),
  /** Simple mode lists cards (GET /v1/tasks). The same route the CLI already uses. */
  tasks: (p: { project?: string; board?: string; q?: string; assignee?: string; state?: string; role?: string; limit?: number } = {}) =>
    request<TasksPayload>("GET", `/v1/tasks${qs(p)}`),
  /** Simple mode's Approve posts to the existing done route. The path is written out so the dashboard allow-list check can see /done. */
  taskDone: (ref: string) => request<{ task: CardView }>("POST", `/v1/tasks/${encodeURIComponent(ref)}/done`, {}),
  // ---- Data Room (DATA-ROOM-1) ----
  room: (channel: string, all = false) => request<{ files: RoomFileView[]; limits: { files: number; versions: number } }>("GET", `/v1/projects/${encodeURIComponent(channel)}/room${all ? "?all=1" : ""}`),
  roomFile: (channel: string, file: string) => request<RoomFileDetail>("GET", `/v1/projects/${encodeURIComponent(channel)}/room/${encodeURIComponent(file)}`),
  statusReport: (channel: string) => request<StatusReportPayload>("GET", `/v1/projects/${encodeURIComponent(channel)}/status-report`),
  /** A project's status page (PROJECT-PAGES-1): the story, the facts, the screens. Read only: the terminal and the agents write it. */
  statusPage: (channel: string) => request<StatusPagePayload>("GET", `/v1/projects/${encodeURIComponent(channel)}/page`),
  /** A screen's image bytes (a Data Room version), fetched with the session header; the page checks them before it shows them. */
  roomBytes: async (channel: string, file: string, v?: number): Promise<Uint8Array> => {
    const url = `/v1/projects/${encodeURIComponent(channel)}/room/${encodeURIComponent(file)}/content${v ? `?v=${v}` : ""}`;
    const res = await send(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) await parse(res, url);
    return new Uint8Array(await res.arrayBuffer());
  },
  roomChange: (channel: string, file: string, b: { name?: string; pin?: boolean; state?: "active" | "removed"; attach?: string[]; detach?: string[] }) =>
    request<{ file: RoomFileView }>("POST", `/v1/projects/${encodeURIComponent(channel)}/room/${encodeURIComponent(file)}`, b),
  roomAdd,
  roomDownload: (channel: string, file: string, name: string, v?: number) =>
    downloadPath(`/v1/projects/${encodeURIComponent(channel)}/room/${encodeURIComponent(file)}/content${v ? `?v=${v}` : ""}`, name),
  createTask: (b: { project: string; board?: string; title: string; column?: string; assignee?: string | null; labels?: string[] }) => request<{ task: CardView }>("POST", "/v1/tasks", b),
  updateTask: (ref: string, b: Record<string, unknown>) => request<{ task: CardView }>("POST", `/v1/tasks/${encodeURIComponent(ref)}`, b),
  commentTask: (ref: string, text: string) => request<{ event: Event; task: CardView }>("POST", `/v1/tasks/${encodeURIComponent(ref)}/comment`, { text }),
  linearIssues: (keys: string[]) => request<{ enabled: boolean; issues: Record<string, LinearIssueInfo | null>; error?: string }>("GET", `/v1/linear/issues${qs({ keys: keys.join(",") })}`, undefined, 30_000),
};

/** GET /v1/tasks: cards across projects, newest change first. */
export interface TasksPayload {
  tasks: CardView[];
  total: number;
  truncated: boolean;
  projects: Array<{ channel: string; name: string; prefix: string; boards: BoardView[] }>;
}

/** GET /v1/admin (AGENT-ADMIN-1): the switches and the newest audit entries of this machine. */
export interface AdminView {
  agent_admin: boolean; remote_admin: boolean; machine: string;
  audit: { ts: number; actor: string; action: string; machine: string; via: string; refused?: string }[];
}
