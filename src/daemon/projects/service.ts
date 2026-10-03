// Writing to boards (WALKIE-PROJECTS-1): every change is one signed `msg.post` in the project's channel carrying a
// board op (schema.ts), emitted through Core like any post, so it replicates, is judged and is stubbed for
// non-members exactly like channel messages. The fold (fold.ts) decides what the op does on every replica; the checks
// here refuse early, with a clear error, what the fold would ignore (person-only actions, a person's card).
// A named agent may create a project and add boards for its person (AGENT-PROJECTS, pre.5; Linear parity): the ops are
// signed with its name, the project's creator is its person. Settings, visibility, archive / delete / restore, board
// changes and export stay people-only.
import { randomBytes } from "node:crypto";
import { redactSecrets } from "../../protocol/safety.ts";
import { Address, type BodyOf, type Event } from "../../protocol/schemas.ts";
import { effectiveFor, PlanLimitError, peopleUsed } from "../../license/enforce.ts";
import { upgradeUrl } from "../../license/plans.ts";
import { boardAddonUrl } from "../../license/site.ts";
import { isPersonAddress } from "../../protocol/projects/fold.ts";
import { cardOpText } from "../../protocol/projects/format.ts";
import { escalationContactDenial, escalationContactOf, isEscalationContact } from "../../protocol/projects/escalation.ts";
import { statusReportDenial } from "../../protocol/projects/status-report.ts";
import { keyBetween } from "../../protocol/projects/position.ts";
import {
  BOARDS_INCLUDED, boardBodyFits, CardOp, DEFAULT_COLUMNS, MAX_BOARD_OP_BYTES, FREE_PROJECTS, MAX_CARDS_PER_PROJECT, MAX_LIVE_CARDS_PER_BOARD, MAX_PROJECTS,
  type Automations, type BoardView, type CardOpT, type CardView, type Column, type ColumnRole,
  type PathRule, type ProjectView,
} from "../../protocol/projects/schema.ts";
import type { Ext } from "../../protocol/projects/batch.ts";
import type { Core } from "../core.ts";
import { parseAddress } from "../asks.ts";
import { HttpError } from "../http.ts";
import { canSeeChannel, memberByHandle } from "../roster.ts";
import { submitRequest, type CatchUp } from "../requests.ts";
import type { PeerClient } from "../peer-client.ts";
import type { ProjectsIndex } from "./index.ts";

export interface WriteCtx {
  readonly core: Core; readonly idx: ProjectsIndex; readonly client: PeerClient; readonly catchUp: CatchUp;
  /** The calling agent (X-Walkie-Agent); absent = a person (CLI or dashboard), unless `underAgent`. */
  readonly agent?: string;
  /**
   * The caller says it runs under an agent (X-Walkie-Under-Agent, pre.3's CLI marker) without naming it: treated as
   * an agent by every rule here (never a person), and it can't write (a post must name its agent). PRE4 RC, Codex 2.
   */
  readonly underAgent?: boolean;
  /**
   * FO-6: this daemon's own board steward is writing (steward-run.ts; never set from a request: the local API refuses
   * the agent name). It may move any card, a person's included, and close cards whatever agents_can_close says.
   */
  readonly steward?: true;
  /** The write-limit key, when it is not the agent name (`RouteCtx.rateKey`). Absent: the agent, or `human`. */
  readonly rateKey?: string;
}

/** An agent is calling, named or not. */
export function isAgentCaller(w: Pick<WriteCtx, "agent" | "underAgent">): boolean {
  return !!w.agent || !!w.underAgent;
}

// ---- guards -------------------------------------------------------------------------------------------------------

export function requirePerson(w: Pick<WriteCtx, "agent" | "underAgent">, what: string): void {
  if (isAgentCaller(w)) throw new HttpError(403, "forbidden", `${what} is for people only (an agent can't do it; ask your person)`);
}

/** An agent caller must name itself before it creates anything (checked before any side effect, e.g. the channel). */
function requireNamedAgent(w: Pick<WriteCtx, "agent" | "underAgent">): void {
  if (w.underAgent && !w.agent) {
    throw new HttpError(403, "agent_unnamed", "a board change from an agent must name it (WALKIE_AGENT=<name>, or --agent)");
  }
}

function me(w: WriteCtx): { handle: string; role: string } {
  const m = w.core.me();
  if (!m || m.role === "removed") throw new HttpError(403, "forbidden", "this node is not an admitted member");
  return m;
}

function isAdmin(w: WriteCtx, p: ProjectView): boolean {
  const m = me(w);
  return !isAgentCaller(w) && (m.role === "owner" || p.creator === m.handle);
}

/** The caller's own address: `@handle/machine/agent` for an agent, `@handle` for a person. */
export function selfAddress(w: Pick<WriteCtx, "core" | "agent">): string {
  const h = w.core.myHandle() ?? "";
  return w.agent ? `@${h}/${w.core.hostname}/${w.agent}` : `@${h}`;
}

export function clean(w: Pick<WriteCtx, "core">, s: string): string {
  return w.core.config.redact ? redactSecrets(s).text : s;
}
function cleanOpt(w: WriteCtx, s: string | null | undefined): string | null | undefined {
  return typeof s === "string" ? clean(w, s) : s;
}

/** A project this member can see (404 for anything else, a private project of others included: nothing leaks). */
export function visibleProject(w: Pick<WriteCtx, "core" | "idx">, channel: string): ProjectView {
  if (!w.core.isProjectChannel(channel) || !w.core.roster.channels.has(channel) || !w.core.visible({ channel })) {
    throw new HttpError(404, "not_found", `no project ${channel}`);
  }
  const p = w.idx.project(channel);
  if (!p) throw new HttpError(404, "not_found", `no project ${channel} (not synced yet?)`);
  return p;
}

/** Projects this member can see. */
export function visibleProjects(w: Pick<WriteCtx, "core" | "idx">): ProjectView[] {
  return w.idx.projects().filter((p) => w.core.isProjectChannel(p.channel) && w.core.visible({ channel: p.channel }));
}

/** A project by channel, prefix or name (case-insensitive), among those this member can see. */
export function findProject(w: Pick<WriteCtx, "core" | "idx">, ref: string): ProjectView {
  if (/^p-[0-9a-f]{8}$/.test(ref)) return visibleProject(w, ref);
  const all = visibleProjects(w).filter((p) => p.state !== "deleted");
  const up = ref.toUpperCase();
  const hits = all.filter((p) => p.prefix === up);
  const named = hits.length ? hits : all.filter((p) => p.name.toLowerCase() === ref.toLowerCase());
  // Two projects can share a prefix (a member can't see a private project's): the earliest created answers to it; the
  // other stays reachable by its channel and its cards by id (round-1 audit LOW).
  const first = [...named].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))[0];
  if (first) return first;
  throw new HttpError(404, "not_found", `no project ${ref}`);
}

type Found = { project: ProjectView; card: CardView };

/**
 * A card by root event id, by reference (`WEB-12-7f3a09c1`: key + short id), or by key alone (`WEB-12`).
 *  - A reference resolves by its short id alone (8 hex of sha256 of the card id), in every project this member can
 *    see: the key part is advisory (the number may have moved, the prefix may have been renamed), and the card comes
 *    back with its current key. Two visible cards with that short id (a ground collision) are refused with both.
 *  - A key alone is a label: it resolves only when exactly one card holds it now, proposed it, or held it on this
 *    node before (round-6 audits: keys move when cards are created concurrently or offline); otherwise the call is
 *    refused (409) with the candidates' references and ids.
 */
export function findCard(w: Pick<WriteCtx, "core" | "idx">, ref: string): Found {
  const byId = /^[0-9a-f]{16}:[1-9][0-9]*$/.test(ref) ? w.idx.db.card(ref) : null;
  if (byId) return { project: visibleProject(w, byId.channel), card: byId };
  const m = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,7})(?:-([0-9a-fA-F]{8}))?$/.exec(ref);
  if (!m) throw new HttpError(404, "not_found", `no card ${ref} (a reference such as WEB-12-7f3a09c1, a key such as WEB-12, or an event id)`);
  const prefix = (m[1] as string).toUpperCase();
  const n = Number(m[2]);
  const short = m[3]?.toLowerCase();
  const visible = visibleProjects(w);
  const found = (cards: readonly CardView[]): Found[] => {
    const seen = new Set<string>();
    const out: Found[] = [];
    for (const card of cards) {
      const project = visible.find((p) => p.channel === card.channel);
      if (project && !seen.has(card.id)) { seen.add(card.id); out.push({ project, card }); }
    }
    return out;
  };
  if (short) {
    const hits = found(w.idx.db.cardsByShort(short));
    if (hits.length === 1) return hits[0] as Found;
    if (hits.length > 1) throw ambiguous(ref, hits.map((x) => x.card));
    throw new HttpError(404, "not_found", `no card ${ref}`);
  }
  const projects = visible.filter((p) => p.state !== "deleted" && (p.prefix === prefix || (p.prior_prefixes ?? []).includes(prefix)));
  const candidates = found(projects.flatMap((p) => w.idx.db.keyCandidates(p.channel, n)));
  if (candidates.length === 1) return candidates[0] as Found;
  if (candidates.length > 1) throw ambiguous(ref, candidates.map((x) => x.card));
  throw new HttpError(404, "not_found", `no card ${ref.toUpperCase()}`);
}

function ambiguous(ref: string, cards: readonly CardView[]): HttpError {
  const list = cards.map((c) => `${c.ref} (id ${c.id}) "${c.title.slice(0, 60)}"`).join(", ");
  return new HttpError(409, "ambiguous", `${ref.toUpperCase()} could mean ${cards.length} cards (keys can change when cards are created at the same time): ${list}; use one of these references or ids`);
}

// ---- emission -----------------------------------------------------------------------------------------------------

/** `board` null: a plain post (a comment in a card's thread). */
export function post(w: WriteCtx, channel: string, text: string, board: Record<string, unknown> | null, extra: { thread?: string; mentions?: string[] } = {}): Event {
  const make = (t: string) => ({
    text: t || "board update", ...(board ? { board } : {}),
    ...(extra.thread ? { thread: extra.thread } : {}), ...(extra.mentions?.length ? { mentions: extra.mentions } : {}),
  } as BodyOf<"msg.post">);
  let body = make(text.slice(0, 32_000));
  // A board op's body is at most MAX_BOARD_OP_BYTES (larger is an ordinary post, not an op): the summary text gives way
  // first, then the change is refused.
  if (board && !boardBodyFits(body)) body = make(text.slice(0, 200));
  if (board && !boardBodyFits(body)) {
    throw new HttpError(413, "too_large", `a board change is at most ${MAX_BOARD_OP_BYTES / 1024} KB (description included); shorten it`);
  }
  requireNamedAgent(w);
  return w.core.emit("msg.post", body, { channel, agent: w.agent });
}

/** The channel exists (created through the roster authority, as every channel is) or the call fails with why. */
async function createChannel(w: WriteCtx, name: string, members: string[] | undefined): Promise<void> {
  const body = { name, topic: "Walkie project", project: true as const, ...(members ? { members } : {}) };
  if (w.core.isAuthority()) {
    w.core.emit("channel.upsert", body);
    return;
  }
  const res = await submitRequest(w.core, w.client, w.catchUp, "channel.upsert", body);
  if (!w.core.roster.channels.has(name)) {
    const why = "queued" in res ? "the roster authority is offline; its channel creation is queued" : "not synced from the roster authority yet";
    throw new HttpError(409, "channel_pending", `the project couldn't be created now (${why}); try again once the authority is reachable`);
  }
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function opaquePrefix(taken: ReadonlySet<string>): string {
  for (;;) {
    const p = `P${[...randomBytes(3)].map((x) => B32[x % 32]).join("")}`;
    if (!taken.has(p)) return p;
  }
}

export function derivePrefix(name: string, taken: ReadonlySet<string>): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").trim();
  const words = letters.split(/\s+/).filter(Boolean);
  let base = (words.length > 1 ? words.map((x) => x[0]).join("") : letters.replace(/\s/g, "")).replace(/^[0-9]+/, "").slice(0, 4);
  if (base.length < 2) base = (base + "PRJ").slice(0, 3);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base.slice(0, 8)}${i}`)) return `${base.slice(0, 8)}${i}`;
  return `P${randomBytes(3).toString("hex").toUpperCase()}`.slice(0, 10);
}

/** Projects the team has, as this node can count them: every project channel except those it knows were deleted. */
function projectsInUse(w: Pick<WriteCtx, "core" | "idx">): number {
  const deleted = new Set(w.idx.projects().filter((p) => p.state === "deleted").map((p) => p.channel));
  let n = 0;
  for (const [name, ch] of w.core.roster.channels) if (w.core.isProjectChannel(name) && !ch.archived && !deleted.has(name)) n++;
  return n;
}

/**
 * On the roster authority, when it is about to create a project channel (its own project, or a member's request,
 * crafted or not): the team's project quota is enforced there too (round-2 audits, Codex M6 / Opus LOW). Soft like
 * every plan limit: an older authority doesn't check.
 */
export function authorityProjectQuota(core: Core, idx: ProjectsIndex): void {
  checkProjectQuota({ core, idx });
}

/** Project creations and restores on this node run one at a time, so two concurrent requests can't both see a free slot. */
const queues = new WeakMap<Core, Promise<unknown>>();
function serial<T>(core: Core, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(core) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  queues.set(core, next.catch(() => undefined));
  return next;
}

/** One more project in use: at most MAX_PROJECTS; on Free, FREE_PROJECTS (402 plan_limit). */
function checkProjectQuota(w: Pick<WriteCtx, "core" | "idx">): void {
  const used = projectsInUse(w);
  if (used >= MAX_PROJECTS) throw new HttpError(409, "project_limit", `a team has at most ${MAX_PROJECTS} projects`);
  const e = effectiveFor(w.core.roster, w.core.planNow(), w.core.clock());
  if (e.plan === "free" && used >= FREE_PROJECTS) {
    throw new PlanLimitError({
      resource: "projects", limit: FREE_PROJECTS, used, plan: e.plan, subscribed: false,
      upgrade_url: upgradeUrl(e, peopleUsed(w.core.roster), w.core.roster.license),
    });
  }
}

export interface CreateProject {
  name: string; prefix?: string; folder?: string; description?: string; private?: boolean;
  paths?: PathRule[]; columns?: Column[]; meter?: "count" | "points"; automations?: Automations; board?: string;
  /** Where the project came from (LINEAR-IMPORT-1; set by the importer only, never by the API body). */
  ext?: Ext;
}

/**
 * A new project: its channel through the roster authority (restricted to the team's owners when private, which the
 * Team plan allows), then the project root and its first board. Free plan: one project. A person, or a named agent
 * acting for its person (the same checks: an owner's agent may create a private project; the creator is the person).
 * An agent can't set the automations or the path rules (changing them is a person's call, before or after creation).
 */
export function createProject(w: WriteCtx, req: CreateProject): Promise<ProjectView> {
  requireNamedAgent(w);
  if (isAgentCaller(w) && req.automations) {
    throw new HttpError(403, "forbidden", "a project's automations are set by people only (create it without them; ask your person to change them)");
  }
  // Its path / repo rules (which folders' agents it claims) are a person's setting too (PRE5 RC LOW), refused like automations.
  if (isAgentCaller(w) && req.paths?.length) {
    throw new HttpError(403, "forbidden", "a project's path rules are set by people only (create it without them; ask your person to add them)");
  }
  return serial(w.core, () => createProjectNow(w, req));
}

async function createProjectNow(w: WriteCtx, req: CreateProject): Promise<ProjectView> {
  const m = me(w);
  checkProjectQuota(w);
  const owners = [...w.core.roster.members.values()].filter((x) => x.role === "owner").map((x) => x.handle);
  if (req.private && m.role !== "owner") throw new HttpError(403, "forbidden", "only an owner can create a private project (private projects are for the team's owners)");
  const taken = new Set(visibleProjects(w).filter((p) => p.state !== "deleted").map((p) => p.prefix));
  if (req.prefix && taken.has(req.prefix)) throw new HttpError(409, "conflict", `another project already uses the prefix ${req.prefix}`);
  // A private project's keys must reveal nothing where they escape the status scrub (a commit message, `layoff-4b`):
  // by default its prefix is opaque, "P" + 3 random base-32 characters (round-4 audit, Opus M5). A person may still
  // choose a readable one.
  const prefix = req.prefix ?? (req.private ? opaquePrefix(taken) : derivePrefix(req.name, taken));
  let channel = "";
  do channel = `p-${randomBytes(4).toString("hex")}`; while (w.core.roster.channels.has(channel));
  await createChannel(w, channel, req.private ? owners.slice(0, 50) : undefined);
  if (!w.core.isProjectChannel(channel)) {
    throw new HttpError(409, "conflict", "the team's roster authority runs a Walkie without Projects (the channel was created without the project marker); upgrade that machine first");
  }
  const name = clean(w, req.name);
  post(w, channel, `Project "${name}" (${prefix}) created`, {
    v: 1, rev: 0, op: "project", name, prefix, ...(req.folder ? { folder: clean(w, req.folder) } : {}),
    ...(req.description ? { description: clean(w, req.description) } : {}), ...(req.paths?.length ? { paths: req.paths } : {}),
    ...(req.meter ? { meter: req.meter } : {}), ...(req.automations ? { automations: req.automations } : {}),
    ...(req.ext ? { ext: req.ext } : {}),
  });
  post(w, channel, `Board "${req.board ?? "Board"}" added`, { v: 1, rev: 0, op: "board", name: req.board ?? "Board", columns: req.columns ?? DEFAULT_COLUMNS });
  w.idx.markFull(channel);
  w.idx.flushAll();
  return visibleProject(w, channel);
}

export interface UpdateProject {
  name?: string; folder?: string; description?: string; prefix?: string; paths?: PathRule[]; meter?: "count" | "points";
  automations?: Automations; state?: "active" | "archived" | "deleted"; private?: boolean;
  /** FO-6: the board steward on or off for this project, and the machine whose loop keeps it. */
  steward?: "on" | "off"; steward_node?: string;
  /** PROJECT-REPORTS-1: WalkieTalkie's hourly status report for this project, on or off. */
  status_report?: "hourly" | "off";
  /** WALK-73: who resolves a dispute (`@handle` or `@handle/machine`); null or "" clears it. */
  escalation_contact?: string | null;
}

/**
 * The contact to store, or null to clear. A bad address, an agent, a cloud guest, and anyone who is not a posting
 * member that can see the project are refused here; the fold also drops a value it cannot use.
 */
function normalizeEscalationContact(w: WriteCtx, channel: string, raw: string | null): string | null {
  if (raw === null) return null;
  const v = raw.trim();
  if (v === "") return null;
  if (!isEscalationContact(v) || !Address.safeParse(v).success) {
    throw new HttpError(400, "invalid", "escalation contact must be a person (@handle or @handle/machine)");
  }
  const parsed = parseAddress(v);
  if (parsed.machine === "cloud") throw new HttpError(400, "invalid", "cloud guests can't be an escalation contact");
  const member = memberByHandle(w.core.roster, parsed.handle);
  if (!member || member.role === "removed") throw new HttpError(400, "invalid", `no member @${parsed.handle}`);
  if (parsed.machine) {
    const known = [...w.core.roster.nodes.values()].some((n) => n.login === member.login && n.hostname === parsed.machine);
    if (!known) throw new HttpError(400, "invalid", `no machine ${parsed.machine} for @${parsed.handle}`);
  }
  if (member.role === "observer") throw new HttpError(400, "invalid", "observers can't resolve a dispute");
  if (!canSeeChannel(w.core.roster, channel, parsed.handle)) throw new HttpError(400, "invalid", `@${parsed.handle} can't see this project`);
  return v;
}

/** Settings, archive / delete, visibility: the project's admins (owners and its creator), people only. */
export function updateProject(w: WriteCtx, channel: string, req: UpdateProject): Promise<ProjectView> {
  requirePerson(w, "changing a project's settings");
  return serial(w.core, () => updateProjectNow(w, channel, req));
}

async function updateProjectNow(w: WriteCtx, channel: string, req: UpdateProject): Promise<ProjectView> {
  // The "same contact again" check below compares with the folded view: fold what has arrived first (WALK-73 r5 review LOW-a).
  w.idx.flushAll();
  const p = visibleProject(w, channel);
  if (req.status_report !== undefined) {
    // The status report's switch says why it refuses (an observer's reason differs from another member's).
    const why = statusReportDenial(me(w).role, me(w).handle, p.creator);
    if (why) throw new HttpError(403, "forbidden", why);
  }
  if (req.escalation_contact !== undefined) {
    // Same order as the status report: an observer hears why, before the generic settings refusal.
    const why = escalationContactDenial(me(w).role, me(w).handle, p.creator);
    if (why) throw new HttpError(403, "forbidden", why);
  }
  if (!isAdmin(w, p)) throw new HttpError(403, "forbidden", "only the project's creator or an owner can change its settings");
  if (req.prefix && req.prefix !== p.prefix && visibleProjects(w).some((x) => x.prefix === req.prefix && x.state !== "deleted")) {
    throw new HttpError(409, "conflict", `another project already uses the prefix ${req.prefix}`);
  }
  // Bringing a deleted project back counts against the plan like creating one (round-1 audit M5).
  if (p.state === "deleted" && req.state !== undefined && req.state !== "deleted") checkProjectQuota(w);
  if (req.private !== undefined && req.private !== p.private) {
    // Visibility is the channel's membership (a roster change): owners only, as for any restricted channel.
    if (me(w).role !== "owner") throw new HttpError(403, "forbidden", "only an owner can change a project's visibility");
    const owners = [...w.core.roster.members.values()].filter((x) => x.role === "owner").map((x) => x.handle);
    const body = req.private ? { name: channel, members: owners.slice(0, 50) } : { name: channel, public: true };
    if (w.core.isAuthority()) w.core.emit("channel.upsert", body);
    else {
      const res = await submitRequest(w.core, w.client, w.catchUp, "channel.upsert", body);
      if ("queued" in res) throw new HttpError(409, "channel_pending", "the roster authority is offline; the visibility change is queued");
    }
  }
  const { private: _p, escalation_contact: rawContact, ...fields } = req;
  // Null and "" clear. The same contact again is left out, so a contact-only request that changes nothing is not signed.
  let contact: string | null | undefined;
  if (rawContact !== undefined) {
    const next = normalizeEscalationContact(w, channel, rawContact);
    if ((next ?? "") !== escalationContactOf(p)) contact = next;
  }
  const changes = Object.fromEntries(Object.entries({
    ...fields, ...(fields.name ? { name: clean(w, fields.name) } : {}), ...(fields.folder !== undefined ? { folder: clean(w, fields.folder) } : {}),
    ...(fields.description !== undefined ? { description: clean(w, fields.description) } : {}),
    ...(contact !== undefined ? { escalation_contact: contact } : {}),
  }).filter(([, v]) => v !== undefined));
  if (Object.keys(changes).length) {
    const s = w.idx.settingsOf(channel);
    const rev = (s.project?.rev ?? 0) + 1;
    const after = s.project?.head;
    const what = changes.state === "deleted" ? "deleted" : changes.state === "archived" ? "archived" : changes.state === "active" ? "restored"
      : Object.keys(changes).length === 1 && changes.steward ? `board steward turned ${String(changes.steward)}`
      : Object.keys(changes).length === 1 && changes.status_report ? `status report turned ${changes.status_report === "hourly" ? "on" : "off"}`
      : Object.keys(changes).length === 1 && changes.escalation_contact !== undefined ? (changes.escalation_contact ? "escalation contact set" : "escalation contact cleared")
      : Object.keys(changes).length === 1 && changes.steward_node !== undefined ? "board steward machine set" : `settings changed (${Object.keys(changes).join(", ")})`;
    post(w, channel, `Project "${p.name}" ${what}`, { v: 1, rev, op: "project", ...(after ? { after } : {}), ...changes }, { thread: p.id });
  }
  w.idx.touchSettings(channel);
  return visibleProject(w, channel);
}

/** Boards beyond BOARDS_INCLUDED in each project this node knows, summed: the team's extra boards in use. */
function extraBoardsInUse(w: WriteCtx): number {
  return w.idx.projects().filter((p) => p.state !== "deleted").reduce((n, p) => n + Math.max(0, p.boards.length - BOARDS_INCLUDED), 0);
}

/**
 * A new board (a person, or a named agent for its person). Three per project are included; each one beyond needs a
 * bought extra board (the license's `extra_boards`, a $15/month add-on): otherwise 402 plan_limit with the add-on's
 * checkout link.
 */
export function createBoard(w: WriteCtx, channel: string, req: { name: string; columns?: Column[] }): BoardView {
  requireNamedAgent(w);
  const p = visibleProject(w, channel);
  if (p.boards.length >= BOARDS_INCLUDED) {
    const e = effectiveFor(w.core.roster, w.core.planNow(), w.core.clock());
    const lic = w.core.roster.license;
    const bought = e.status === "active" || e.status === "grace" ? lic?.payload.extra_boards ?? 0 : 0;
    const inUse = extraBoardsInUse(w);
    if (inUse + 1 > bought) {
      throw new PlanLimitError({
        resource: "boards", limit: BOARDS_INCLUDED, used: p.boards.length, plan: e.plan, subscribed: e.status === "active",
        upgrade_url: boardAddonUrl(inUse + 1, lic?.payload.lic_id),
      });
    }
  }
  const name = clean(w, req.name);
  const ev = post(w, channel, `Board "${name}" added`, { v: 1, rev: 0, op: "board", name, columns: req.columns ?? DEFAULT_COLUMNS });
  w.idx.touchSettings(channel);
  const b = visibleProject(w, channel).boards.find((x) => x.id === ev.id);
  if (!b) throw new HttpError(500, "internal", "the board wasn't folded");
  return b;
}

export function updateBoard(w: WriteCtx, channel: string, boardId: string, req: { name?: string; columns?: Column[]; state?: "active" | "archived" }): BoardView {
  requirePerson(w, "changing a board");
  const p = visibleProject(w, channel);
  const b = p.boards.find((x) => x.id === boardId);
  if (!b) throw new HttpError(404, "not_found", "no such board");
  if (!isAdmin(w, p) && b.created_by.handle !== me(w).handle) throw new HttpError(403, "forbidden", "only the board's creator, the project's creator or an owner can change it");
  const s = w.idx.settingsOf(channel);
  const bs = s.boards.find((x) => x.id === boardId);
  const rev = (bs?.rev ?? 0) + 1;
  const changes = Object.fromEntries(Object.entries({ ...req, ...(req.name ? { name: clean(w, req.name) } : {}) }).filter(([, v]) => v !== undefined));
  post(w, channel, `Board "${b.name}" changed (${Object.keys(changes).join(", ")})`, { v: 1, rev, op: "board", ...(bs ? { after: bs.head } : {}), ...changes }, { thread: boardId });
  w.idx.touchSettings(channel);
  const out = visibleProject(w, channel).boards.find((x) => x.id === boardId);
  if (!out) throw new HttpError(500, "internal", "the board wasn't folded");
  return out;
}

// ---- cards --------------------------------------------------------------------------------------------------------

export function boardOf(p: ProjectView, id?: string): BoardView {
  const b = id ? p.boards.find((x) => x.id === id) : p.boards.find((x) => x.state === "active") ?? p.boards[0];
  if (!b) throw new HttpError(404, "not_found", id ? "no such board in this project" : "the project has no board");
  return b;
}

/** A column by id, by name (case-insensitive) or by number (1-based). */
export function columnOf(b: BoardView, ref: string): Column {
  const n = /^\d{1,2}$/.test(ref) ? b.columns[Number(ref) - 1] : undefined;
  const c = n ?? b.columns.find((x) => x.id === ref) ?? b.columns.find((x) => x.name.toLowerCase() === ref.toLowerCase());
  if (!c) throw new HttpError(400, "invalid", `no column ${ref} on board ${b.name} (${b.columns.map((x) => x.name).join(", ")})`);
  return c;
}

export function firstOfRole(b: BoardView, role: ColumnRole): Column {
  const c = b.columns.find((x) => x.role === role);
  if (!c) throw new HttpError(409, "conflict", `board ${b.name} has no ${role} column`);
  return c;
}

/** A position in `column`: before `before`, after `after`, else at the end. */
export function positionIn(w: WriteCtx, p: ProjectView, board: string, column: string, opts: { before?: string; after?: string; self?: string }): string {
  const cards = w.idx.db.cards(p.channel, { board, states: ["open"], limit: MAX_LIVE_CARDS_PER_BOARD })
    .filter((c) => c.column === column && c.id !== opts.self)
    .sort((a, b) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.n - b.n));
  const idx = opts.before ? cards.findIndex((c) => c.id === opts.before) : opts.after ? cards.findIndex((c) => c.id === opts.after) + 1 : -1;
  if (idx < 0) return keyBetween(cards[cards.length - 1]?.pos ?? null, null);
  return keyBetween(cards[idx - 1]?.pos ?? null, cards[idx]?.pos ?? null);
}

export interface CreateCard {
  board?: string; title: string; body?: string; column?: string; assignee?: string | null; reviewer?: string | null;
  labels?: string[]; estimate?: number | null; due?: string | null;
}

export function createCard(w: WriteCtx, channel: string, req: CreateCard): CardView {
  const p = visibleProject(w, channel);
  if (p.state !== "active") throw new HttpError(409, "conflict", `project ${p.name} is ${p.state}`);
  const b = boardOf(p, req.board);
  if (b.state !== "active") throw new HttpError(409, "conflict", `board ${b.name} is archived`);
  if (p.cards >= MAX_CARDS_PER_PROJECT) throw new HttpError(409, "card_limit", `a project holds at most ${MAX_CARDS_PER_PROJECT} cards`);
  if (b.live_cards >= MAX_LIVE_CARDS_PER_BOARD) throw new HttpError(409, "card_limit", `a board holds at most ${MAX_LIVE_CARDS_PER_BOARD} open cards; archive some`);
  const col = req.column ? columnOf(b, req.column) : b.columns.find((c) => c.role === "todo") ?? b.columns[0] as Column;
  if (isAgentCaller(w) && col.role === "done" && !p.automations.agents_can_close) {
    throw new HttpError(403, "forbidden", `agents can't close cards in ${p.name} (automations.agents_can_close is off), so they can't create one in ${col.name} either`);
  }
  // Fold what already arrived first: a card a peer created a moment ago must not be given the same number here.
  w.idx.flushAll();
  const n = w.idx.db.maxN(channel) + 1;
  const title = clean(w, req.title);
  const op: CardOpT = {
    v: 1, rev: 0, op: "card", board: b.id, title, column: col.id, pos: positionIn(w, p, b.id, col.id, {}), n,
    ...(req.body ? { body: clean(w, req.body) } : {}), ...(req.assignee ? { assignee: req.assignee } : {}),
    ...(req.reviewer ? { reviewer: req.reviewer } : {}), ...(req.labels?.length ? { labels: req.labels.map((l) => clean(w, l)) } : {}),
    ...(req.estimate !== undefined && req.estimate !== null ? { estimate: req.estimate } : {}), ...(req.due ? { due: req.due } : {}),
  };
  // Checked BEFORE anything is signed: a refused op must not leave a junk post behind (round-1 audit, Codex HIGH 2).
  if (!CardOp.safeParse(op).success) throw new HttpError(409, "conflict", "this card can't be created (its key number or a field is out of range)");
  const who = [req.assignee, req.reviewer].filter((x): x is string => !!x);
  const ev = post(w, channel, `New card ${p.prefix}-${n}: ${title}${req.assignee ? ` (assigned to ${req.assignee})` : ""}`, op as Record<string, unknown>, { mentions: who });
  w.idx.flushAll();
  const card = w.idx.db.card(ev.id);
  if (!card) throw new HttpError(500, "internal", "the card wasn't folded");
  return card;
}

export interface UpdateCard {
  title?: string; body?: string; board?: string; column?: string; before?: string; after?: string;
  assignee?: string | null; reviewer?: string | null; labels?: string[]; estimate?: number | null; due?: string | null;
  blocked?: boolean; blocked_reason?: string | null; state?: "open" | "archived" | "deleted";
}

/** One op on a card (its fields as given). Refuses early what the fold would ignore for this caller. */
export function updateCard(w: WriteCtx, ref: string, req: UpdateCard): CardView {
  const { project: p, card } = findCard(w, ref);
  const moves = req.board !== undefined || req.column !== undefined || req.before !== undefined || req.after !== undefined;
  const reassigns = req.assignee !== undefined || req.reviewer !== undefined;
  if ((req.state === "deleted" || card.state === "deleted") && req.state !== undefined && req.state !== card.state) requirePerson(w, "deleting or restoring a card");
  const steward = !!w.steward && !reassigns;
  if (isAgentCaller(w) && !steward && (moves || reassigns) && isPersonAddress(card.assignee)) {
    throw new HttpError(403, "forbidden", `${card.key} is assigned to ${card.assignee}: only a person can move or reassign it`);
  }
  const b = boardOf(p, req.board ?? card.board);
  const col = req.column ? columnOf(b, req.column) : moves ? b.columns.find((c) => c.id === card.column) ?? b.columns[0] as Column : undefined;
  if (isAgentCaller(w) && !steward && col?.role === "done" && !p.automations.agents_can_close) {
    const was = boardOf(p, card.board).columns.find((c) => c.id === card.column)?.role;
    if (was !== "done") throw new HttpError(403, "forbidden", `agents can't close cards in ${p.name} (automations.agents_can_close is off); a person moves it to done`);
  }
  const fields: Record<string, unknown> = {
    ...(req.title !== undefined ? { title: clean(w, req.title) } : {}),
    ...(req.body !== undefined ? { body: clean(w, req.body) } : {}),
    ...(moves ? { board: b.id, column: (col as Column).id, pos: positionIn(w, p, b.id, (col as Column).id, { before: req.before, after: req.after, self: card.id }) } : {}),
    ...(req.assignee !== undefined ? { assignee: req.assignee } : {}),
    ...(req.reviewer !== undefined ? { reviewer: req.reviewer } : {}),
    ...(req.labels !== undefined ? { labels: req.labels.map((l) => clean(w, l)) } : {}),
    ...(req.estimate !== undefined ? { estimate: req.estimate } : {}),
    ...(req.due !== undefined ? { due: req.due } : {}),
    ...(req.blocked !== undefined ? { blocked: req.blocked } : {}),
    ...(req.blocked_reason !== undefined ? { blocked_reason: cleanOpt(w, req.blocked_reason) } : {}),
    ...(req.state !== undefined ? { state: req.state } : {}),
  };
  if (!Object.keys(fields).length) return card;
  const folded = w.idx.foldCardNow(p.channel, card.id);
  // Informational (the fold ranks by the parent chain): +0 for a follow-up to this machine's own op, like the fold.
  const headOrigin = folded?.state.head.split(":")[0];
  const rev = (folded?.state.rev ?? card.rev) + (headOrigin === w.core.nodeId && folded?.state.head !== `${card.id}` && !folded?.state.head.startsWith(`${card.id}#`) ? 0 : 1);
  // The op names the head this node folded as its parent (fold.ts "Convergence").
  const opBody = { v: 1, rev, op: "card", ...(folded ? { after: folded.state.head } : {}), ...fields };
  if (!CardOp.safeParse(opBody).success) throw new HttpError(400, "invalid", "a field is out of range");
  const who = [req.assignee, req.reviewer].filter((x): x is string => !!x);
  post(w, p.channel, cardOpText(card.key, card.title, fields, b.columns), opBody, { thread: card.id, mentions: who });
  w.idx.flushAll();
  return w.idx.db.card(card.id) ?? card;
}

export type CardAction = "start" | "review" | "done" | "block" | "unblock";

/** start: to the first active column, assigned to the caller; review / done: to the first such column. */
export function cardAction(w: WriteCtx, ref: string, action: CardAction, reason?: string): CardView {
  const { project: p, card } = findCard(w, ref);
  const b = boardOf(p, card.board);
  switch (action) {
    case "start": return updateCard(w, ref, { column: firstOfRole(b, "active").id, ...(card.assignee ? {} : { assignee: selfAddress(w) }) });
    case "review": return updateCard(w, ref, { column: firstOfRole(b, "review").id });
    case "done": return updateCard(w, ref, { column: firstOfRole(b, "done").id, ...(card.blocked ? { blocked: false } : {}) });
    case "block": return updateCard(w, ref, { blocked: true, blocked_reason: reason ?? null });
    case "unblock": return updateCard(w, ref, { blocked: false, blocked_reason: null });
  }
}

export function comment(w: WriteCtx, ref: string, text: string, mentions?: string[]): Event {
  const { project: p, card } = findCard(w, ref);
  const ev = post(w, p.channel, clean(w, text), null, { thread: card.id, ...(mentions?.length ? { mentions } : {}) });
  w.idx.flushAll();
  return ev;
}

/** A pull request an agent opened or merged (the hooks): moves its card when the project's automations say so. */
export function automation(w: WriteCtx, event: "pr_opened" | "pr_merged", key: string): CardView | null {
  let found: { project: ProjectView; card: CardView };
  try { found = findCard(w, key); } catch { return null; }
  const { project: p, card } = found;
  const b = boardOf(p, card.board);
  const role = b.columns.find((c) => c.id === card.column)?.role;
  if (card.state !== "open" || role === "done" || role === "cancelled") return null;
  if (isAgentCaller(w) && isPersonAddress(card.assignee)) return null;
  if (event === "pr_opened" && p.automations.pr_opened && role !== "review" && b.columns.some((c) => c.role === "review")) {
    return updateCard(w, key, { column: firstOfRole(b, "review").id });
  }
  if (event === "pr_merged" && p.automations.pr_merged && (p.automations.agents_can_close || !isAgentCaller(w)) && b.columns.some((c) => c.role === "done")) {
    return updateCard(w, key, { column: firstOfRole(b, "done").id });
  }
  return null;
}
