// Typed client for the local daemon API (unix socket). Used by the CLI, MCP server and hooks.
import { REMOTE_AGENT, remoteRunToken } from "./remote-run.ts";
import { readFileSync } from "node:fs";
import type { BatchResult } from "../protocol/projects/batch.ts";
import type { ImportStatus, JobView, Plan, Selection, SyncResult, SyncView } from "../integrations/linear-import/views.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentsPayload, AgentView, AskView, Event, MeView, NodeView, PlanLimitDetails, PlanView, StreamMessage, TeamView,
} from "../protocol/schemas.ts";
import type { IntegrationView, LinearIssueInfo } from "../integrations/types.ts";
import { ORCHESTRATOR_TOKEN_ENV, ORCHESTRATOR_TOKEN_HEADER, type OrchMessage, type OrchestratorAccess, type OrchestratorView, type PermissionMode } from "../protocol/orchestrator.ts";
import type { AccountView } from "../protocol/accounts.ts";
import type { MachineStats } from "../protocol/machine-stats.ts";
import type { StatusProvenance } from "../protocol/status-projection.ts";
import { matchesSearch } from "../protocol/agent-roster.ts";
import { runtimeLabel } from "../cli/agent-detect.ts";
import type { RemoteRunRes } from "../protocol/admin.ts";
import type { ConnectionView, InstallView, PoolLocalView, PrepareView, RunView, ServeView } from "../protocol/pool.ts";
import type { MobileStatus, PairView } from "../daemon/mobile/manager.ts";
import type { AddMachine } from "../protocol/add-machine.ts";
import type { CreditBlock, LocalComputeState, LocalRentReq, Quotes, RentalView, RentResult } from "../protocol/compute.ts";
import type { BoardView, CardDetail, CardView, ProjectsPayload, ProjectView, TimelineEntry } from "../protocol/projects/schema.ts";
import type { RoomFileDetail, RoomFileView, TaskContext } from "../protocol/projects/room.ts";
import type { Schedule } from "../protocol/talkie-schedule.ts";

/** GET /v1/tasks: cards across projects, newest change first, with the projects they belong to. */
export interface TasksPayload {
  tasks: CardView[]; total: number; truncated: boolean;
  projects: Array<{ channel: string; name: string; prefix: string; boards: BoardView[] }>;
}
import type { HostAvailability, SeatMode, SeatRuntime, SeatWorkspace, SeatsLocalView, SeatsView } from "../protocol/seats.ts";

export function walkieHome(): string {
  return process.env.WALKIE_HOME ?? join(homedir(), ".walkie");
}
export function socketPath(): string {
  return process.env.WALKIE_SOCKET ?? join(walkieHome(), "walkie.sock");
}

/** An agents reply of any daemon version, with the MISSION-1 fields always present (older daemons send `agents` only). */
export function normalizeAgents(r: Partial<AgentsPayload> | null | undefined): AgentsPayload {
  const agents = Array.isArray(r?.agents) ? r.agents.map((a) => ({ ...a, archived: a.archived === true })) : [];
  return {
    ...r,
    agents,
    archive: Array.isArray(r?.archive) ? r.archive : [],
    ...(typeof r?.total === "number" ? {} : { total: agents.length, truncated: false }),
  };
}

export class WalkieError extends Error {
  /** `details` = the rest of the daemon's error object (e.g. a 402 plan_limit's limit/used/upgrade_url). */
  constructor(readonly code: string, message: string, readonly status: number, readonly details?: Partial<PlanLimitDetails>) { super(message); }
}

export interface ClientOptions {
  socket?: string; agent?: string; timeoutMs?: number;
  /**
   * This process serves a model (an agent runtime's environment, or --for-agent) even without an agent name: every
   * request says so (X-Walkie-Under-Agent: 1), so the daemon's person-only routes refuse it (WALKIE-ADD-MACHINE-2).
   */
  underAgent?: boolean;
  /**
   * A remote seat's credential for the seats' socket (PROTOCOL §11); default: the file WALKIE_SEAT_TOKEN_FILE names
   * (0600 in the seat's directory, so it never shows in a process listing), else WALKIE_SEAT_TOKEN.
   */
  seatToken?: string;
}

function seatTokenFromFile(): string | undefined {
  const file = process.env.WALKIE_SEAT_TOKEN_FILE;
  if (!file) return undefined;
  try { return readFileSync(file, "utf8").trim() || undefined; } catch { return undefined; }
}

export class WalkieClient {
  readonly socket: string;
  readonly agent?: string;
  readonly timeoutMs: number;
  readonly underAgent: boolean;
  private readonly seatToken?: string;

  constructor(opts: ClientOptions = {}) {
    this.seatToken = opts.seatToken ?? (seatTokenFromFile() || process.env.WALKIE_SEAT_TOKEN || undefined);
    this.socket = opts.socket ?? socketPath();
    this.agent = opts.agent ?? process.env.WALKIE_AGENT ?? (remoteRunToken() ? REMOTE_AGENT : undefined);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.underAgent = opts.underAgent === true;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.agent) h["X-Walkie-Agent"] = this.agent;
    // A child token follows every request, even if --agent names another agent. The daemon rejects that mismatch.
    const orch = process.env[ORCHESTRATOR_TOKEN_ENV];
    if (orch) h[ORCHESTRATOR_TOKEN_HEADER] = orch;
    if (this.underAgent) {
      h["X-Walkie-Under-Agent"] = "1";
      const rt = runtimeLabel(); // AGENT-ADMIN-1: names an unnamed agent's runtime in the audit trail
      if (rt) h["X-Walkie-Agent-Runtime"] = rt;
    }
    // AGENT-ADMIN-1: a remote admin run's own walkie (its daemon then names the remote actor, admin/runs.ts).
    const adminToken = remoteRunToken();
    if (adminToken) h["X-Walkie-Admin-Token"] = adminToken;
    if (this.seatToken) h.Authorization = `Bearer ${this.seatToken}`;
    return h;
  }

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`http://walkie${path}`, {
        method,
        unix: this.socket,
        headers: this.headers(body === undefined ? {} : { "Content-Type": "application/json" }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      } as RequestInit);
    } catch (err) {
      throw new WalkieError("daemon_unreachable", `walkie daemon not reachable at ${this.socket} (run: walkie daemon start)`, 0);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const e = data?.error ?? {};
      const { code: _c, message: _m, ...details } = e as Record<string, unknown>;
      throw new WalkieError(e.code ?? "http_" + res.status, e.message ?? res.statusText, res.status, details as Partial<PlanLimitDetails>);
    }
    return data as T;
  }

  healthz() { return this.request<{ ok: boolean; version: string }>("GET", "/v1/healthz", undefined, 2_000); }
  /** A one-shot 60 s dashboard login nonce (unix socket only; `walkie dashboard`). */
  authNonce() { return this.request<{ nonce: string; expires_at: number }>("POST", "/v1/auth/nonce", {}, 2_000); }
  /** Signs out every dashboard session (`walkie dashboard logout`; unix socket only). */
  logoutDashboards() { return this.request<{ revoked: number }>("POST", "/v1/auth/logout", {}, 2_000); }
  /** Replaces local.token and signs out every dashboard (`walkie token rotate`; unix socket only). */
  rotateToken() { return this.request<{ rotated: true; path: string }>("POST", "/v1/auth/rotate", {}, 5_000); }
  me() { return this.request<MeView>("GET", "/v1/me"); }
  /** `transport` "direct" (Walkie Direct) or "tailscale"; omitted: the daemon's (Tailscale if signed in, else Direct). */
  init(team_name: string, handle: string, transport?: "direct" | "tailscale") {
    return this.request<MeView>("POST", "/v1/init", { team_name, handle, ...(transport ? { transport } : {}) }, Math.max(this.timeoutMs, 30_000));
  }
  /** `peer`: a teammate's tailnet machine, or a Walkie Direct invite code. */
  join(peer: string) { return this.request<MeView & { admitted: boolean; reason?: string }>("POST", "/v1/join", { peer }, 60_000); }
  /** Owner (Walkie Direct): a single-use invite code for `handle`, valid for 7 days. */
  inviteCode(handle: string, role = "member") {
    return this.request<{ code: string; handle: string; role: string; expires_at: number; existing_member: boolean }>(
      "POST", "/v1/team/invite-code", { handle, role }, Math.max(this.timeoutMs, 15_000));
  }

  /** Another machine for a current member (owner, person only): the code, a shareable link and the install command. */
  addMachine(handle: string) {
    return this.request<AddMachine>("POST", "/v1/team/add-machine", { handle }, Math.max(this.timeoutMs, 15_000));
  }
  team() { return this.request<TeamView>("GET", "/v1/team"); }
  // ---- AGENT-ADMIN-1 ----
  admin(limit = 20) { return this.request<AdminView>("GET", `/v1/admin?limit=${limit}`); }
  adminSwitches(b: { agent_admin?: boolean; remote_admin?: boolean }) {
    return this.request<{ agent_admin: boolean; remote_admin: boolean }>("POST", "/v1/admin/switches", b);
  }
  adminAudit(action: string) { return this.request<{ recorded: boolean }>("POST", "/v1/admin/audit", { action }); }
  adminMachines() { return this.request<AdminMachines>("GET", "/v1/admin/machines"); }
  adminRun(b: { machines: string; argv: string[]; timeout_s?: number }) {
    return this.request<AdminRunResult>("POST", "/v1/admin/run", b, ((b.timeout_s ?? 300) + 30) * 1000);
  }
  license() { return this.request<PlanView>("GET", "/v1/license"); }
  /**
   * Owner: an activation code (exchanged online on the authority, so it may take a while) or a license key for
   * this team (recorded on the chain; `{queued: true}` while the authority is unreachable).
   */
  activateLicense(key: string) {
    return this.request<{ event: Event | null; plan?: PlanView; renewal?: "saved" | "kept" | "missing" } | { queued: true; request_id: string }>(
      "POST", "/v1/license", { key }, Math.max(this.timeoutMs, 30_000));
  }
  /** Owner, on the authority: fetch the subscription's current grant now (seat changes made in the portal). */
  refreshLicense() {
    return this.request<{ outcome: string; plan: PlanView | null }>("POST", "/v1/license/refresh", {}, Math.max(this.timeoutMs, 30_000));
  }
  invite(login: string, handle: string, role: string, display_name?: string) {
    return this.request<{ event: Event }>("POST", "/v1/team/invite", { login, handle, role, display_name });
  }
  setRole(handle: string, role: string) { return this.request<{ event: Event }>("POST", "/v1/team/member", { handle, role }); }
  /** Moves roster authority; `{queued: true}` while the current authority is unreachable. */
  setAuthority(node: string) {
    return this.request<{ event: Event | null } | { queued: true; request_id: string }>("POST", "/v1/team/authority", { node });
  }
  /** Revokes one machine (node id or hostname); `{queued: true}` while the roster authority is unreachable. */
  revokeNode(node: string) {
    return this.request<{ event: Event | null } | { queued: true; request_id: string }>("POST", "/v1/team/revoke", { node });
  }
  channel(body: { name: string; topic?: string; members?: string[]; public?: boolean; archived?: boolean }) {
    return this.request<{ event: Event }>("POST", "/v1/channels", body);
  }
  events(q: Record<string, string | number | undefined> = {}) {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return this.request<{ events: Event[] }>("GET", `/v1/events?${qs}`);
  }
  event(id: string) { return this.request<{ event: Event; replies: Event[] }>("GET", `/v1/events/${encodeURIComponent(id)}`); }
  post(body: { channel: string; text: string; thread?: string; artifacts?: string[]; raw?: boolean }) {
    return this.request<{ event: Event; redactions?: string[] }>("POST", "/v1/post", body);
  }
  ask(body: { to: string; text: string; channel?: string; timeout_s?: number; artifacts?: string[] }) {
    return this.request<{ event: Event; redactions?: string[] }>("POST", "/v1/ask", body);
  }
  askView(id: string, waitS = 0) {
    return this.request<AskView>("GET", `/v1/asks/${encodeURIComponent(id)}${waitS ? `?wait=${waitS}` : ""}`, undefined, (waitS + 10) * 1000);
  }
  /** Blocks until answered/declined/expired or timeoutS elapses (loops over 120 s long-polls). */
  async awaitAnswer(id: string, timeoutS: number): Promise<AskView> {
    const deadline = Date.now() + timeoutS * 1000;
    for (;;) {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      const view = await this.askView(id, Math.max(1, Math.min(120, left)));
      if (view.state !== "open" || Date.now() >= deadline) return view;
    }
  }
  asks(q: { state?: string; to?: string } = {}) {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined) as [string, string][]);
    return this.request<{ asks: AskView[] }>("GET", `/v1/asks?${qs}`);
  }
  answer(body: { ask: string; text: string; declined?: boolean; artifacts?: string[] }) {
    return this.request<{ event: Event }>("POST", "/v1/answer", body);
  }
  /**
   * Reports a status. `provenance` says where its title / task / activity text came from (status-projection.ts): the
   * daemon shares that text only as the sharing policy allows; without it the text counts as unknown and is dropped.
   */
  status(body: Record<string, unknown>, provenance?: StatusProvenance) {
    return this.request<{ event: Event | null }>("POST", "/v1/status", provenance ? { ...body, provenance } : body, Math.min(this.timeoutMs, 3_000));
  }
  /** Atomically claim delivery of these events to this agent; returns the ids this caller won. */
  claimDeliveries(ids: string[]) { return this.request<{ claimed: string[] }>("POST", "/v1/deliveries", { ids }); }
  /**
   * The live roster (default), the Agent archive or both; the archive's size per machine either way. A daemon from
   * before WALKIE-MISSION-1 answers with every agent and no archive fields: normalized here, once, for the CLI and the
   * MCP server alike (fix round 1, Codex 8).
   */
  async agents(q: { scope?: "live" | "archive" | "all"; node?: string; q?: string; states?: readonly string[]; limit?: number; offset?: number } = {}): Promise<AgentsPayload> {
    const params = new URLSearchParams();
    if (q.scope && q.scope !== "live") params.set("scope", q.scope);
    if (q.node) params.set("node", q.node);
    if (q.q) params.set("q", q.q);
    if (q.states?.length) params.set("states", q.states.join(","));
    if (q.limit) params.set("limit", String(q.limit));
    if (q.offset) params.set("offset", String(q.offset));
    const qs = params.toString();
    const r = normalizeAgents(await this.request<Partial<AgentsPayload>>("GET", `/v1/agents${qs ? `?${qs}` : ""}`));
    // A daemon from before MISSION-1 ignores the filters, limit and offset and sends every agent: filter and page here,
    // so a model never gets 1,200 agents in its context (Opus r2 #7).
    if (r.offset !== undefined || !q.limit) return r;
    const offset = q.offset ?? 0;
    const sorted = r.agents
      .filter((a) => !q.node || a.node === q.node || a.hostname === q.node)
      .filter((a) => !q.states?.length || q.states.includes(a.effective_state))
      .filter((a) => !q.q || matchesSearch(a, q.q))
      .sort((a, b) => b.updated_at - a.updated_at);
    const page = sorted.slice(offset, offset + q.limit);
    return { ...r, agents: page, total: sorted.length, offset, truncated: offset + page.length < sorted.length };
  }

  // ---- integrations (local only) ----
  integrations() { return this.request<{ integrations: IntegrationView[] }>("GET", "/v1/integrations"); }
  /** WALKIE-POOL-2 split runs: this machine's sharing, runtime, run and stage. */
  pool() { return this.request<PoolLocalView>("GET", "/v1/pool"); }
  poolShare(on: boolean, maxGb?: number | null) { return this.request<PoolLocalView>("POST", "/v1/pool/share", { on, ...(maxGb !== undefined ? { max_gb: maxGb } : {}) }); }
  poolRun(body: { model?: string; quant?: "q4" | "q8"; file?: string; machines?: string[] }) { return this.request<{ run: RunView }>("POST", "/v1/pool/run", body, 60_000); }
  poolStop() { return this.request<{ run: RunView | null }>("POST", "/v1/pool/stop", {}, 30_000); }
  /** POOL-REAL-1: serve a catalog model whole on one machine (this one, `on`, or the best one), connect to it. */
  poolServe(body: { model: string; quant?: "q4" | "q8"; on?: string }) {
    return this.request<{ on: { node_id: string; hostname: string; self: boolean }; serve?: ServeView; connection?: ConnectionView }>("POST", "/v1/pool/serve", body, 60_000);
  }
  poolServeStop(on?: string) { return this.request<{ serve?: ServeView | null; connection?: ConnectionView | null }>("POST", "/v1/pool/serve/stop", on ? { on } : {}, 30_000); }
  poolConnect(machine: string) { return this.request<{ connection: ConnectionView }>("POST", "/v1/pool/connect", { machine }, 30_000); }
  poolInstall() { return this.request<{ install: InstallView }>("POST", "/v1/pool/install", {}, 30_000); }
  poolPrepare(model: string, quant?: "q4" | "q8") { return this.request<{ prepare: PrepareView }>("POST", "/v1/pool/prepare", { model, ...(quant ? { quant } : {}) }, 30_000); }
  poolDisconnect(machine: string) { return this.request<{ connection: ConnectionView | null }>("POST", "/v1/pool/disconnect", { machine }, 30_000); }
  /** 202 `{queued, request_id, integration}` while the roster authority is offline (the connector waits for its slot). */
  configureIntegration(id: string, body: Record<string, unknown>) {
    return this.request<{ integration: IntegrationView; queued?: boolean; request_id?: string }>("POST", `/v1/integrations/${encodeURIComponent(id)}`, body);
  }
  removeIntegration(id: string) { return this.request<{ integration: IntegrationView }>("DELETE", `/v1/integrations/${encodeURIComponent(id)}`); }
  runIntegration(id: string) {
    return this.request<{ integration: IntegrationView }>("POST", `/v1/integrations/${encodeURIComponent(id)}/run`, {}, 180_000);
  }
  linearIssues(keys: string[]) {
    return this.request<{ enabled: boolean; issues: Record<string, LinearIssueInfo | null>; error?: string }>("GET", `/v1/linear/issues?keys=${encodeURIComponent(keys.join(","))}`, undefined, 30_000);
  }
  linearCreate(body: { title: string; from?: string; team?: string; dry_run?: boolean }) {
    return this.request<{
      issue?: { identifier: string; title: string; url: string }; event?: Event | null; dry_run?: boolean; mutation?: string;
      variables?: { input: { teamId: string; title: string; description: string } };
      /** 207: the issue exists but its backlink post failed and is queued for the connector's next runs. */
      backlink?: "queued"; partial?: boolean;
    }>("POST", "/v1/linear/issues", body, 60_000);
  }
  meetings(q: { q?: string; since_ts?: number; before_ts?: number; limit?: number } = {}) {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return this.request<{ events: Event[] }>("GET", `/v1/meetings?${qs}`);
  }
  // ---- projects (WALKIE-PROJECTS-1) ----
  projects(all = false) { return this.request<ProjectsPayload>("GET", `/v1/projects${all ? "?all=1" : ""}`); }
  createProject(body: Record<string, unknown>) { return this.request<{ project: ProjectView }>("POST", "/v1/projects", body, Math.max(this.timeoutMs, 30_000)); }
  project(channel: string, q: { board?: string; deleted?: boolean } = {}) {
    const qs = new URLSearchParams({ ...(q.board ? { board: q.board } : {}), ...(q.deleted ? { deleted: "1" } : {}) }).toString();
    return this.request<{ project: ProjectView; cards: CardView[]; timeline: TimelineEntry[] }>("GET", `/v1/projects/${encodeURIComponent(channel)}${qs ? `?${qs}` : ""}`);
  }
  updateProject(channel: string, body: Record<string, unknown>) {
    return this.request<{ project: ProjectView }>("POST", `/v1/projects/${encodeURIComponent(channel)}`, body, Math.max(this.timeoutMs, 30_000));
  }
  createBoard(channel: string, body: { name: string; columns?: unknown[] }) {
    return this.request<{ board: BoardView }>("POST", `/v1/projects/${encodeURIComponent(channel)}/boards`, body);
  }
  updateBoard(channel: string, board: string, body: Record<string, unknown>) {
    return this.request<{ board: BoardView }>("POST", `/v1/projects/${encodeURIComponent(channel)}/boards/${encodeURIComponent(board)}`, body);
  }
  /** `format` csv | json | ndjson (people only); the file's text. */
  async exportProject(channel: string, format: "csv" | "json" | "ndjson"): Promise<string> {
    const res = await fetch(`http://walkie/v1/projects/${encodeURIComponent(channel)}/export?format=${format}`, { unix: this.socket, headers: this.headers(), signal: AbortSignal.timeout(60_000) } as RequestInit);
    const text = await res.text();
    if (!res.ok) {
      const e = (text ? (JSON.parse(text) as { error?: { code?: string; message?: string } }) : {}).error ?? {};
      throw new WalkieError(e.code ?? `http_${res.status}`, e.message ?? res.statusText, res.status);
    }
    return text;
  }
  /** Board ops batch (people only): many card writes signed in one transaction (LINEAR-IMPORT-1). */
  batch(channel: string, ops: unknown[]) {
    return this.request<{ batch: BatchResult }>("POST", `/v1/projects/${encodeURIComponent(channel)}/batch`, { ops }, Math.max(this.timeoutMs, 120_000));
  }
  // ---- Linear import (LINEAR-IMPORT-1) ----
  linearImportPlan(body: { options: Record<string, unknown>; key?: string; key_file?: string }) {
    return this.request<{ plan: Plan }>("POST", "/v1/import/linear/plan", body, Math.max(this.timeoutMs, 600_000));
  }
  linearImportRun(body: { selection: Selection; key?: string; key_file?: string }) {
    return this.request<{ job: JobView }>("POST", "/v1/import/linear/run", body, Math.max(this.timeoutMs, 60_000));
  }
  linearImportResume(body: { key?: string; key_file?: string }) { return this.request<{ job: JobView }>("POST", "/v1/import/linear/resume", body); }
  linearImportCancel() { return this.request<{ job: JobView | null }>("POST", "/v1/import/linear/cancel", {}); }
  linearImportStatus() { return this.request<ImportStatus>("GET", "/v1/import/linear/status"); }
  linearSync(body: { two_way?: boolean; key?: string; key_file?: string }) {
    return this.request<{ result: SyncResult }>("POST", "/v1/import/linear/sync", body, Math.max(this.timeoutMs, 600_000));
  }
  linearSyncSettings(body: { enabled?: boolean; two_way?: boolean; interval_min?: number; key_file?: string | null }) {
    return this.request<{ sync: SyncView }>("POST", "/v1/import/linear/settings", body);
  }
  tasks(q: { project?: string; board?: string; q?: string; assignee?: string; state?: string; role?: string; limit?: number } = {}) {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
    return this.request<TasksPayload>("GET", `/v1/tasks${qs ? `?${qs}` : ""}`);
  }
  task(ref: string) { return this.request<CardDetail & { agents: AgentView[]; files?: RoomFileView[] }>("GET", `/v1/tasks/${encodeURIComponent(ref)}`); }
  /** The Data Room's part of an agent's context for a card: pinned documents (small text inline) and the card's files. */
  taskContext(ref: string, fetchMissing = false) {
    return this.request<TaskContext>("GET", `/v1/tasks/${encodeURIComponent(ref)}/context${fetchMissing ? "?fetch=1" : ""}`, undefined, fetchMissing ? Math.max(this.timeoutMs, 30_000) : this.timeoutMs);
  }
  // ---- Data Room (DATA-ROOM-1) ----
  room(channel: string, all = false) {
    return this.request<{ files: RoomFileView[]; limits: { files: number; versions: number } }>("GET", `/v1/projects/${encodeURIComponent(channel)}/room${all ? "?all=1" : ""}`);
  }
  roomFile(channel: string, file: string) {
    return this.request<RoomFileDetail>("GET", `/v1/projects/${encodeURIComponent(channel)}/room/${encodeURIComponent(file)}`);
  }
  roomChange(channel: string, file: string, body: { name?: string; pin?: boolean; state?: "active" | "removed"; attach?: string[]; detach?: string[] }) {
    return this.request<{ file: RoomFileView }>("POST", `/v1/projects/${encodeURIComponent(channel)}/room/${encodeURIComponent(file)}`, body);
  }
  /** Adds a file (or a new version of the live file with that name) to a project's Data Room. */
  async roomAdd(channel: string, bytes: Uint8Array, meta: { name: string; mime?: string; card?: string; pin?: boolean; file?: string; allowSecrets?: boolean }) {
    const h = this.headers({
      "Content-Type": "application/octet-stream",
      "X-Walkie-Name": encodeURIComponent(meta.name),
      "X-Walkie-Mime": meta.mime ?? "application/octet-stream",
      ...(meta.card ? { "X-Walkie-Card": encodeURIComponent(meta.card) } : {}),
      ...(meta.pin ? { "X-Walkie-Pin": "1" } : {}),
      ...(meta.file ? { "X-Walkie-File": meta.file } : {}),
      ...(meta.allowSecrets ? { "X-Walkie-Allow-Secrets": "1" } : {}),
    });
    let res: Response;
    try {
      res = await fetch(`http://walkie/v1/projects/${encodeURIComponent(channel)}/room`, { method: "POST", unix: this.socket, headers: h, body: bytes, signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120_000)) } as RequestInit);
    } catch {
      throw new WalkieError("daemon_unreachable", `walkie daemon not reachable at ${this.socket} (run: walkie daemon start)`, 0);
    }
    const text = await res.text();
    const data = (text ? JSON.parse(text) : {}) as { file?: RoomFileView; version?: number; created?: boolean; unchanged?: boolean; warnings?: string[]; error?: Record<string, unknown> };
    if (!res.ok || !data.file) {
      const { code, message, ...details } = (data.error ?? {}) as { code?: string; message?: string };
      throw new WalkieError(code ?? `http_${res.status}`, message ?? "the upload failed", res.status, details as Partial<PlanLimitDetails>);
    }
    return data as { file: RoomFileView; version: number; created: boolean; unchanged?: boolean; warnings?: string[] };
  }
  /** A version's bytes (the current one by default). */
  async roomContent(channel: string, file: string, v?: number): Promise<{ bytes: Uint8Array; mime: string; version: number }> {
    const res = await fetch(`http://walkie/v1/projects/${encodeURIComponent(channel)}/room/${encodeURIComponent(file)}/content${v ? `?v=${v}` : ""}`, { unix: this.socket, headers: this.headers(), signal: AbortSignal.timeout(Math.max(this.timeoutMs, 120_000)) } as RequestInit);
    if (!res.ok) {
      const text = await res.text();
      const e = (text ? (JSON.parse(text) as { error?: { code?: string; message?: string } }) : {}).error ?? {};
      throw new WalkieError(e.code ?? `http_${res.status}`, e.message ?? res.statusText, res.status);
    }
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get("x-walkie-mime") ?? "application/octet-stream", version: Number(res.headers.get("x-walkie-version") ?? "0") };
  }
  createTask(body: Record<string, unknown>) { return this.request<{ task: CardView }>("POST", "/v1/tasks", body); }
  updateTask(ref: string, body: Record<string, unknown>) { return this.request<{ task: CardView }>("POST", `/v1/tasks/${encodeURIComponent(ref)}`, body); }
  taskAction(ref: string, action: "start" | "review" | "done" | "block" | "unblock", reason?: string) {
    return this.request<{ task: CardView }>("POST", `/v1/tasks/${encodeURIComponent(ref)}/${action}`, reason ? { reason } : {});
  }
  commentTask(ref: string, text: string) { return this.request<{ event: Event; task: CardView }>("POST", `/v1/tasks/${encodeURIComponent(ref)}/comment`, { text }); }
  taskAutomation(event: "pr_opened" | "pr_merged", task: string) {
    return this.request<{ task: CardView | null }>("POST", "/v1/tasks/automation", { event, task });
  }

  peers() { return this.request<{ nodes: NodeView[] }>("GET", "/v1/peers"); }
  /** The team's provider accounts and usage left (ACCOUNTS-1, watch-only). */
  /** `pool` (COMPANY POOL): the team accounts policy; absent from a pre-RESET-CLOCK daemon. */
  accounts() { return this.request<{ accounts: AccountView[]; pool?: { policy: "company" | "per-account"; at: number | null; by: string | null } }>("GET", "/v1/accounts"); }
  /** Walkie on your phone (WALKIE-PWA-1): the relay link, pairing and paired devices. */
  mobile() { return this.request<MobileStatus>("GET", "/v1/mobile"); }
  mobilePair() { return this.request<PairView>("POST", "/v1/mobile/pair", {}, 15_000); }
  mobileRevoke(id: string) { return this.request<{ revoked: true }>("DELETE", `/v1/mobile/devices/${encodeURIComponent(id)}`); }
  mobileRevokeAll() { return this.request<{ revoked: number }>("DELETE", "/v1/mobile/devices"); }

  // ---- rental compute (RENT-2; prices only) ----
  computeQuotes() { return this.request<Quotes>("GET", "/v1/compute/quotes", undefined, Math.max(this.timeoutMs, 25_000)); }
  computeState() { return this.request<LocalComputeState>("GET", "/v1/compute/state", undefined, Math.max(this.timeoutMs, 25_000)); }
  computeHandoverObject() { return this.request<{ objected: true }>('POST', '/v1/compute/handover/object', {}); }
  /** Rents machines (any mix of tiers): what fits starts now, the rest queue. Minting one code per machine can take a while. */
  computeRent(b: LocalRentReq) { return this.request<RentResult>("POST", "/v1/compute/rent", b, Math.max(this.timeoutMs, 90_000)); }
  computeStop(b: { rental_id: string; account_id?: string } | { all: true; account_id?: string }) {
    return this.request<{ stopped: number; rentals: RentalView[] }>("POST", "/v1/compute/stop", b, Math.max(this.timeoutMs, 45_000));
  }
  computeCredit(block: CreditBlock, account_id?: string) { return this.request<{ url: string }>("POST", "/v1/compute/credit", { block, ...(account_id ? { account_id } : {}) }, Math.max(this.timeoutMs, 25_000)); }

  // ---- remote seats (PROTOCOL §11) ----
  seats(seat?: string) { return this.request<SeatsView>("GET", `/v1/seats${seat ? `?seat=${encodeURIComponent(seat)}` : ""}`); }
  seatsConfig(body: {
    allow: boolean; launchers?: string[] | null; max?: number | null; runtimes?: SeatRuntime[] | null; dir?: string | null; env?: string[] | null;
    ephemeral?: boolean | null; admin?: string | null; runner?: string | null; runtime_dir?: string | null; same_user?: boolean; accept_readable_home?: boolean;
  }) {
    return this.request<{ local: SeatsLocalView }>("POST", "/v1/seats/config", body, 60_000);
  }
  seatRun(body: {
    machine: string; runtime: SeatRuntime; model?: string; permission_mode?: SeatMode; prompt?: string; bundle?: string;
    timeout_s?: number; max_concurrent?: number;
    /** v2 (FO-2): any of these makes a v2 request (hosts announcing seats_v2 only). */
    v?: 2; brief?: string; label?: string; workspace?: SeatWorkspace; account?: string; result_file?: string;
  }) {
    return this.request<{ event: Event; seat: string; host: { node: string; hostname: string; channel: string; availability?: HostAvailability } }>("POST", "/v1/seats/run", body);
  }
  /** FO-2: this machine's repo clones for v2 seats (config.json `fleet.repos`). */
  seatsRepos() { return this.request<{ repos: Record<string, string> }>("GET", "/v1/seats/repos"); }
  seatsRepoSet(id: string, path: string | null) { return this.request<{ repos: Record<string, string> }>("POST", "/v1/seats/repos", { id, path }); }
  /** A repo bundle for a seat request, stored on this machine (POST /v1/seats/bundle) → its hash. */
  async seatsBundle(bytes: Uint8Array) {
    const h = this.headers({ "Content-Type": "application/octet-stream" });
    const res = await fetch("http://walkie/v1/seats/bundle", { method: "POST", unix: this.socket, headers: h, body: bytes } as RequestInit);
    const data = await res.json() as { hash?: string; error?: { code: string; message: string } };
    if (!res.ok || !data.hash) throw new WalkieError(data.error?.code ?? "http_" + res.status, data.error?.message ?? "the bundle could not be stored", res.status);
    return { hash: data.hash };
  }
  seatStop(seat: string) {
    return this.request<{ stopped: "local" | "requested" | "none"; verified?: boolean; why?: string; event?: Event }>("POST", "/v1/seats/stop", { seat }, 30_000);
  }
  /** "I'm using this computer" (the machine's person): at most `max` seats run here (default 1), for `for_s` if given. */
  seatsBusy(body: { max?: number; for_s?: number } = {}) { return this.request<{ local: SeatsLocalView }>("POST", "/v1/seats/busy", body); }
  /** A Claude token only this machine's seats use (null clears it: they use the machine's own login). */
  seatsToken(token: string | null) { return this.request<{ local: SeatsLocalView }>("POST", "/v1/seats/token", { token }); }
  /** "I'm done": paused seats continue, queued ones start. */
  seatsResume() { return this.request<{ local: SeatsLocalView }>("POST", "/v1/seats/resume", {}); }

  // ---- orchestrator (PROTOCOL §8) ----
  orchestrator() { return this.request<OrchestratorView>("GET", "/v1/orchestrator"); }
  schedules() { return this.request<{ schedules: Schedule[] }>("GET", "/v1/orchestrator/schedules"); }
  scheduleUnresolved(after?: string, limit = 100) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (after !== undefined) query.set("after", after);
    return this.request<{ total: number; entries: Array<{ id: string; name: string; run: string;
      local_id?: string; slot?: number | null; claim?: { term: number; seq: number; generation: number } }>;
      next_cursor: string | null }>("GET", `/v1/orchestrator/schedules/unresolved?${query}`);
  }
  scheduleNext(cron: string) { return this.request<{ times: number[] }>("GET", `/v1/orchestrator/schedules/next?cron=${encodeURIComponent(cron)}`); }
  scheduleAdd(body: Pick<Schedule, "name" | "cron" | "task">) { return this.request<{ schedule: Schedule }>("POST", "/v1/orchestrator/schedules", body); }
  scheduleEdit(id: string, body: Partial<Pick<Schedule, "name" | "cron" | "task" | "enabled">>) { return this.request<{ schedule: Schedule }>("PATCH", `/v1/orchestrator/schedules/${encodeURIComponent(id)}`, body); }
  scheduleRemove(id: string) { return this.request<{ removed: boolean; schedule?: Schedule }>("DELETE", `/v1/orchestrator/schedules/${encodeURIComponent(id)}`); }
  scheduleRunNow(id: string) { return this.request<{ run_id: string }>("POST", `/v1/orchestrator/schedules/${encodeURIComponent(id)}/run-now`, {}); }
  scheduleReset(id: string) { return this.request<{ schedule: Schedule }>("POST", `/v1/orchestrator/schedules/${encodeURIComponent(id)}/reset`, { confirm: id }); }
  /** ORCH-2: switches this machine's orchestrator to `model` (default, an alias or a full id), keeping the conversation. */
  orchestratorModel(model: string) { return this.request<OrchestratorView>("POST", "/v1/orchestrator/model", { model }, 60_000); }
  /** ORCH-2: platform (Walkie tools) or full access, keeping the conversation. */
  orchestratorAccess(access: OrchestratorAccess) { return this.request<OrchestratorView>("POST", "/v1/orchestrator/access", { access }, 60_000); }
  /** pre.8: back to automatic (clears a start or a stop by hand). */
  orchestratorAuto() { return this.request<OrchestratorView>("POST", "/v1/orchestrator/auto", {}, 30_000); }
  orchestratorLeadEligible(eligible: boolean) { return this.request<{ eligible: boolean }>("POST", "/v1/orchestrator/lead-eligible", { eligible }); }
  orchestratorStart(body: { model?: string; cwd?: string; permission_mode?: PermissionMode; access?: OrchestratorAccess; claude?: string; path?: string }) {
    return this.request<OrchestratorView>("POST", "/v1/orchestrator/start", body, 60_000);
  }
  orchestratorStop() {
    return this.request<OrchestratorView & { stopped: "local" | "none" }>("POST", "/v1/orchestrator/stop", {}, 30_000);
  }
  orchestratorCleanupRepaired() {
    return this.request<{ stopped_monitor: boolean }>("POST", "/v1/orchestrator/cleanup-repaired", {}, 30_000);
  }
  /** Sends the person's message to this machine's orchestrator (ORCH-FIX-11: the conversation is local). */
  orchestratorSay(text: string, thread?: string) {
    return this.request<{ message: OrchMessage }>("POST", "/v1/orchestrator/say", { text, ...(thread ? { thread } : {}) });
  }
  /** The stop button: the reply in progress in `thread` stops and its queued messages are dropped. */
  orchestratorStopReply(thread: string) {
    return this.request<OrchestratorView & { stopped: boolean }>("POST", "/v1/orchestrator/stop-reply", { thread });
  }
  /** This machine's orchestrator conversation, oldest first (one conversation's with `thread`). */
  orchestratorMessages(q: { thread?: string; limit?: number } = {}) {
    const qs = new URLSearchParams({ ...(q.thread ? { thread: q.thread } : {}), ...(q.limit ? { limit: String(q.limit) } : {}) });
    return this.request<{ messages: OrchMessage[] }>("GET", `/v1/orchestrator/messages${qs.size ? `?${qs}` : ""}`);
  }
  /**
   * ACCOUNTS-2 phase 3: a Claude setup-token from another machine's vault, for one launch (unix socket only; the
   * owner's machine checks its policy, the reply is sealed to a key this daemon made for this request).
   */
  /** A hand-out: Claude → `token` (a setup-token); Codex → `codex_auth` (an access-only auth.json, COMPANY POOL). */
  vaultLease(body: { account: string; node: string; agent?: string; provider?: "claude" | "codex" }) {
    return this.request<{ token?: string; codex_auth?: string; expires_at?: number | null; owner: string; grant: string; gen: string }>("POST", "/v1/vault/lease", body, 15_000);
  }

  async share(bytes: Uint8Array, meta: { name: string; mime: string; note?: string; channel?: string; thread?: string }) {
    const h = this.headers({
      "Content-Type": "application/octet-stream",
      "X-Walkie-Name": encodeURIComponent(meta.name),
      "X-Walkie-Mime": meta.mime,
      ...(meta.note ? { "X-Walkie-Note": encodeURIComponent(meta.note) } : {}),
      ...(meta.channel ? { "X-Walkie-Channel": meta.channel } : {}),
      ...(meta.thread ? { "X-Walkie-Thread": meta.thread } : {}),
    });
    const res = await fetch("http://walkie/v1/artifacts", { method: "POST", unix: this.socket, headers: h, body: bytes } as RequestInit);
    const data = await res.json() as { event?: Event; error?: { code: string; message: string } };
    if (!res.ok || !data.event) throw new WalkieError(data.error?.code ?? "http_" + res.status, data.error?.message ?? "share failed", res.status);
    return { event: data.event };
  }
  async fetchArtifact(hash: string): Promise<Uint8Array> {
    const res = await fetch(`http://walkie/v1/artifacts/${hash}`, { unix: this.socket, headers: this.headers() } as RequestInit);
    if (!res.ok) throw new WalkieError("artifact_" + res.status, `artifact ${hash} not available`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Async iterator over SSE stream messages. Abort via the signal. */
  async *stream(channels?: string[], signal?: AbortSignal): AsyncGenerator<StreamMessage> {
    const qs = channels?.length ? `?channels=${channels.join(",")}` : "";
    const res = await fetch(`http://walkie/v1/stream${qs}`, { unix: this.socket, headers: this.headers(), signal } as RequestInit);
    if (!res.ok || !res.body) throw new WalkieError("stream_" + res.status, "stream failed", res.status);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += value;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (data) yield JSON.parse(data) as StreamMessage;
      }
    }
  }
}

export interface AdminView {
  agent_admin: boolean; remote_admin: boolean; machine: string;
  audit: { ts: number; actor: string; action: string; machine: string; via: string; refused?: string }[];
}
export interface AdminMachine {
  hostname: string; node_id: string; handle: string | null; self: boolean; online: boolean; can_admin: boolean; why?: string;
  agent_admin?: boolean; remote_admin?: boolean; last_result?: string; last_at?: number;
  stats?: MachineStats;
}
export interface AdminMachines { machines: AdminMachine[]; role: string; handle: string }
export type AdminRunOne = Partial<Omit<RemoteRunRes, "machine">> & {
  machine: string; node_id: string; ok: boolean; exit?: number; stdout?: string; stderr?: string; error?: { code: string; message: string };
};
export interface AdminRunResult { ok: boolean; results: AdminRunOne[] }
