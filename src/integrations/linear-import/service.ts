// The Linear import (LINEAR-IMPORT-1): plans (dry runs), import jobs, sync passes and the sync schedule. Runs in the
// person's daemon. Every Walkie write goes through the board ops batch (src/daemon/projects/batch.ts: one transaction
// per batch, the import budget); every Linear call through api.ts (validated, byte-capped, key-scrubbed). The Linear
// key is held in memory for the operation only; a schedule keeps a key FILE PATH (or uses the integration's key).
import { randomBytes } from "node:crypto";
import type { BatchOpT, BatchResult } from "../../protocol/projects/batch.ts";
import type { BoardView, CardView, Column, ColumnRole, ProjectView } from "../../protocol/projects/schema.ts";
import type { Core } from "../../daemon/core.ts";
import { HttpError } from "../../daemon/http.ts";
import type { Logger } from "../../daemon/logger.ts";
import type { PeerClient } from "../../daemon/peer-client.ts";
import { applyBatch, importBudgetKey } from "../../daemon/projects/batch.ts";
import type { ProjectsIndex } from "../../daemon/projects/index.ts";
import { createProject, visibleProject, visibleProjects, type WriteCtx } from "../../daemon/projects/service.ts";
import type { CatchUp } from "../../daemon/requests.ts";
import { ExternalError } from "../http.ts";
import type { IntegrationManager } from "../manager.ts";
import { SecretError, readKeyFile, validKey } from "../secrets.ts";
import type { FetchLike } from "../types.ts";
import * as L from "./api.ts";
import {
  IMPORT_COLUMNS, bodyBudget, bodyOf, digestOf, dueOf, estimateOf, labelsOf, memberFor, parseDuration, parseMapUsers,
  placeOf, prefixFor, stateForRole, titleOf, type Member,
} from "./mapping.ts";
import { buildPlan, projectKeyOf, type Plan, type PlanOptions, type Selection, type WalkieSide } from "./plan.ts";
import { emptyState, loadState, saveState, type CardEntry, type ImportState, type SyncSettings } from "./store.ts";
import { conflictNote, decide, FIELD_NAMES, type Fields, type Snap } from "./sync.ts";
import type { ImportError, ImportStatus, JobView, SyncResult, SyncView } from "./views.ts";

export interface ImportDeps {
  core: Core; idx: ProjectsIndex; manager: IntegrationManager; client: PeerClient; catchUp: CatchUp; log: Logger;
  /** Tests: the Linear HTTP layer (default: the integration manager's fetch). */
  fetch?: FetchLike;
  /** Tests: another GraphQL endpoint. */
  url?: string;
  /** How often the schedule checks whether a sync is due (default 60 s). */
  tickMs?: number;
}

export interface KeyReq { key?: string; key_file?: string }
interface Key { key: string; source: "integration" | "env" | "key_file"; keyFile?: string }

/** Ops per batch the runner sends (a card and its digest comment always travel together). */
export const RUN_BATCH_OPS = 200;
/** A sync re-reads this much before its watermark (late updates, clock skew). */
export const SYNC_OVERLAP_MS = 10 * 60_000;
/** Linear writes per project in one sync pass (two-way); unconfirmed writes keep their old snap and retry next pass. */
export const MAX_LINEAR_WRITES = 200;
/** Issue ids a sync remembers to read again after a failed project; beyond it the watermark stays where it was. */
export const MAX_RETRY = 5_000;
/** Errors kept per job / sync (the rest are counted). */
const MAX_ERRORS = 200;
const ID_CHUNK = 50;

/** An earlier import's card: `[ALE-12] …` titles, or a body starting "Imported from Linear ALE-12" / "Linear ALE-12". */
const ADOPT_TITLE = /^\[([A-Z][A-Z0-9]{0,9}-\d{1,7})\]/;
const ADOPT_BODY = /^(?:Imported from Linear|Linear) ([A-Z][A-Z0-9]{0,9}-\d{1,7})\b/;

type Job = JobView & { ctrl: AbortController };

function iso(ms: number): string { return new Date(ms).toISOString(); }
function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/** Parents before their children (issues whose parent isn't in the list keep their place); stable. */
export function parentFirst<T extends { id: string; parent?: { id: string } | null }>(xs: readonly T[]): T[] {
  const byId = new Map(xs.map((x) => [x.id, x]));
  const out: T[] = [];
  const done = new Set<string>();
  const visit = (x: T, depth: number) => {
    if (done.has(x.id)) return;
    const p = x.parent ? byId.get(x.parent.id) : undefined;
    if (p && depth < 50) visit(p, depth + 1);
    if (!done.has(x.id)) { done.add(x.id); out.push(x); }
  };
  for (const x of xs) visit(x, 0);
  return out;
}

/** A column of the role on the board (a board without one falls back to its nearest: canceled cards to the backlog). */
export function columnForRole(b: { readonly columns: readonly Column[] }, role: ColumnRole): string {
  const order: Record<ColumnRole, ColumnRole[]> = {
    backlog: ["backlog", "todo"], todo: ["todo", "backlog"], active: ["active", "todo"], review: ["review", "active", "todo"],
    done: ["done"], cancelled: ["cancelled", "backlog", "todo"],
  };
  for (const r of order[role]) { const c = b.columns.find((x) => x.role === r); if (c) return c.id; }
  return (b.columns[b.columns.length - 1] ?? b.columns[0])?.id ?? "todo";
}

/** A card's fields as sync compares them. */
export function walkieFields(card: CardView, board: { readonly columns: readonly Column[] } | undefined): Fields {
  const role = board?.columns.find((c) => c.id === card.column)?.role ?? "todo";
  return {
    title: card.title, place: card.state === "archived" && role !== "done" ? "cancelled" : role, labels: [...card.labels],
    estimate: card.estimate, due: card.due, assignee: card.assignee,
  };
}

export class LinearImportService {
  private st: ImportState;
  private job: Job | null = null;
  private syncing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** The running sync pass's controller: stop() and cancel() abort it (no Linear write starts after that). */
  private syncCtrl: AbortController | null = null;

  constructor(private readonly d: ImportDeps) {
    const { state, error } = loadState(d.core.paths.home);
    this.st = state;
    if (error) d.log.warn("linear_import_state_unreadable", { err: error });
  }

  start(): void {
    this.stopped = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { void this.tick(); }, this.d.tickMs ?? 60_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.job?.ctrl.abort();
    this.syncCtrl?.abort();
  }

  private save(): void {
    if (this.stopped) return; // a stopped daemon's late work must not overwrite what the next one wrote (the map is a cache)
    try {
      saveState(this.d.core.paths.home, this.st);
    } catch (err) {
      this.d.log.warn("linear_import_state_write_failed", { err: err instanceof Error ? err.message.slice(0, 200) : "error" });
    }
  }

  private w(): WriteCtx { return { core: this.d.core, idx: this.d.idx, client: this.d.client, catchUp: this.d.catchUp }; }

  // ---- keys -------------------------------------------------------------------------------------------------------

  /** The key: an explicit key file, else the Linear integration's (when it is on), else the CLI's LINEAR_API_KEY. */
  resolveKey(req: KeyReq): Key {
    if (req.key_file) {
      try {
        return { key: readKeyFile(req.key_file), source: "key_file", keyFile: req.key_file };
      } catch (err) {
        throw new HttpError(400, "invalid", err instanceof SecretError ? err.message : "the key file can't be read");
      }
    }
    const m = this.d.manager;
    if (m.settings("linear").enabled) {
      try {
        const k = m.key("linear");
        if (k) return { key: k, source: "integration" };
      } catch (err) {
        if (!req.key) throw new HttpError(409, "not_configured", m.safeMessage(err));
      }
    }
    if (req.key) {
      if (!validKey(req.key)) throw new HttpError(400, "invalid", "LINEAR_API_KEY is not a single API key token");
      return { key: req.key, source: "env" };
    }
    throw new HttpError(409, "not_configured", "no Linear key: turn the Linear integration on (walkie integrations enable linear --key-path …), set LINEAR_API_KEY, or pass --key-file <path>");
  }

  private integrationOn(): boolean {
    const m = this.d.manager;
    if (!m.settings("linear").enabled) return false;
    try { return !!m.key("linear"); } catch { return false; }
  }

  private api(k: Key, signal?: AbortSignal): L.ImportApi {
    return {
      fetch: this.d.fetch ?? this.d.manager.fetch, key: k.key, secrets: () => [...this.d.manager.knownSecrets(), k.key],
      ...(this.d.url ? { url: this.d.url } : {}), ...(signal ? { signal } : {}),
    };
  }

  /** A message safe to show or log: every known key and the operation's own scrubbed. */
  private safe(err: unknown, k?: Key | null): string {
    return this.d.manager.safeMessage(err, [k?.key ?? null], 300);
  }

  private upstream(err: unknown, k: Key): HttpError {
    return err instanceof HttpError ? err : new HttpError(502, "upstream", err instanceof ExternalError ? this.safe(err, k) : `linear: ${this.safe(err, k)}`);
  }

  // ---- what Walkie already has --------------------------------------------------------------------------------------

  private members(): Member[] {
    return [...this.d.core.roster.members.values()].filter((m) => m.role !== "removed")
      .map((m) => ({ handle: m.handle, login: m.login, ...(m.display_name ? { display_name: m.display_name } : {}) }));
  }

  /**
   * The Walkie side of a plan or run: visible projects, and what this person imported before (the map, then the signed
   * log's `ext` on their own roots), and cards of earlier imports matched by `[ALE-12]` titles (their own cards only).
   */
  private walkieSide(): WalkieSide {
    this.d.idx.flushAll();
    const w = this.w();
    const handle = this.d.core.myHandle() ?? "";
    const projects = visibleProjects(w);
    const visible = new Map(projects.map((p) => [p.channel, p]));
    const importedProjects = new Map<string, string>();
    for (const [k, e] of Object.entries(this.st.projects)) if (visible.get(e.channel)?.state !== "deleted" && visible.has(e.channel)) importedProjects.set(k, e.channel);
    const importedIssues = new Map<string, { card: string; key: string; channel: string }>();
    const live = (id: string): CardView | null => { const c = this.d.idx.db.card(id); return c && c.state !== "deleted" && visible.has(c.channel) ? c : null; };
    for (const [id, e] of Object.entries(this.st.cards)) { const c = live(e.card); if (c) importedIssues.set(id, { card: c.id, key: c.key, channel: c.channel }); }
    for (const r of this.d.idx.db.extRoots("linear", handle)) {
      if (!visible.has(r.channel)) continue;
      if (r.op === "project") {
        const key = r.ext_id.startsWith("none-") ? `none:${r.ext_id.slice(5)}` : r.ext_id;
        if (!importedProjects.has(key) && visible.get(r.channel)?.state !== "deleted") importedProjects.set(key, r.channel);
      } else if (!importedIssues.has(r.ext_id)) {
        const c = live(r.id);
        if (c) importedIssues.set(r.ext_id, { card: c.id, key: c.key, channel: c.channel });
      }
    }
    const claimed = new Set([...importedIssues.values()].map((x) => x.card));
    const adopted = new Map<string, { card: string; key: string; channel: string }>();
    for (const p of projects) {
      if (p.state === "deleted") continue;
      for (const r of this.d.idx.db.authoredCardRoots(p.channel, handle)) {
        if (claimed.has(r.id)) continue;
        const ident = ADOPT_TITLE.exec(r.title)?.[1] ?? ADOPT_BODY.exec(r.body)?.[1];
        const c = ident && !adopted.has(ident) ? live(r.id) : null;
        if (ident && c) adopted.set(ident, { card: c.id, key: c.key, channel: c.channel });
      }
    }
    return {
      members: this.members(), projects: projects.map((p) => ({ channel: p.channel, name: p.name, prefix: p.prefix, state: p.state })),
      importedProjects, importedIssues, adopted,
    };
  }

  // ---- plan (dry run) -----------------------------------------------------------------------------------------------

  private checkOptions(o: PlanOptions): void {
    try {
      parseMapUsers(o.map_users);
      if (o.since) parseDuration(o.since);
    } catch (err) {
      throw new HttpError(400, "invalid", err instanceof Error ? err.message : "invalid options");
    }
  }

  /** Reads Linear and builds the plan (nothing is written anywhere). */
  async plan(o: PlanOptions, keyReq: KeyReq): Promise<Plan> {
    this.checkOptions(o);
    const k = this.resolveKey(keyReq);
    const api = this.api(k);
    try {
      const [teams, projects] = await Promise.all([L.teams(api), L.projects(api, { initiatives: o.folder_by === "initiative" })]);
      const team = o.team ? teams.find((t) => t.key.toLowerCase() === o.team?.toLowerCase()) : undefined;
      if (o.team && !team) throw new HttpError(404, "not_found", `no Linear team with key ${o.team}`);
      const since = o.since ? iso(Date.now() - parseDuration(o.since)) : undefined;
      const base = { ...(team ? { teamId: team.id } : {}), includeClosed: o.include_closed, ...(since ? { since } : {}) };
      let issues: L.LIssue[];
      const wanted = (o.projects ?? []).map((x) => x.toLowerCase());
      if (wanted.length && !wanted.includes("none") && !wanted.includes("no project")) {
        const ids = projects.filter((p) => wanted.includes(p.name.toLowerCase()) || wanted.includes(p.id.toLowerCase())).map((p) => p.id);
        issues = [];
        for (const c of chunks(ids, ID_CHUNK)) issues.push(...await L.issues(api, { ...base, projectIds: c }));
      } else {
        issues = await L.issues(api, base);
      }
      try {
        return buildPlan({ now: Date.now(), options: o, teams, projects, issues, walkie: this.walkieSide() });
      } catch (err) {
        throw new HttpError(400, "invalid", err instanceof Error ? err.message : "invalid plan options");
      }
    } catch (err) {
      throw this.upstream(err, k);
    }
  }

  // ---- runs ---------------------------------------------------------------------------------------------------------

  private busy(): boolean { return !!this.job && (this.job.state === "running" || this.job.state === "waiting"); }

  /** Starts an import of the selection (people only: the route checks). */
  startRun(sel: Selection, keyReq: KeyReq): JobView {
    if (this.busy()) throw new HttpError(409, "conflict", "an import is already running (walkie import linear --status)");
    if (this.syncing) throw new HttpError(409, "conflict", "a Linear sync is running; try again when it finishes");
    this.checkOptions(sel.options);
    const k = this.resolveKey(keyReq);
    const job: Job = {
      id: randomBytes(6).toString("hex"), state: "running", started_at: Date.now(), finished_at: null, current: "reading Linear",
      projects_total: sel.projects.filter((p) => p.include).length, projects_done: 0, issues_total: 0,
      created: 0, updated: 0, unchanged: 0, comments: 0, skipped: 0, events: 0, waiting_until: null, errors: [], projects: [],
      ctrl: new AbortController(),
    };
    this.job = job;
    this.st = { ...this.st, last_selection: sel };
    this.save();
    this.d.log.info("linear_import_started", { job: job.id, projects: job.projects_total, key: k.source });
    void this.runJob(job, sel, k).catch((err: unknown) => {
      job.state = job.ctrl.signal.aborted ? "cancelled" : "failed";
      this.addError(job.errors, { message: this.safe(err, k) });
      job.finished_at = Date.now();
      this.d.log.warn("linear_import_failed", { job: job.id, err: this.safe(err, k) });
    });
    return this.view(job) as JobView;
  }

  /** The last selection again (a run stopped midway continues: what is imported already is updated, not recreated). */
  resume(keyReq: KeyReq): JobView {
    if (!this.st.last_selection) throw new HttpError(404, "not_found", "nothing to resume (no import has run on this machine)");
    return this.startRun(this.st.last_selection, keyReq);
  }

  cancel(): JobView | null {
    if (this.job && this.busy()) this.job.ctrl.abort();
    this.syncCtrl?.abort();
    return this.view(this.job);
  }

  private view(j: Job | null): JobView | null {
    if (!j) return null;
    const { ctrl: _c, ...v } = j;
    return { ...v, errors: [...v.errors], projects: [...v.projects] };
  }

  private addError(list: ImportError[], e: ImportError): void {
    if (list.length < MAX_ERRORS) list.push(e);
  }

  private async runJob(job: Job, sel: Selection, k: Key): Promise<void> {
    const signal = job.ctrl.signal;
    const api = this.api(k, signal);
    const [teams, projects] = await Promise.all([L.teams(api), L.projects(api, { initiatives: sel.options.folder_by === "initiative" })]);
    const explicit = parseMapUsers(sel.options.map_users);
    const since = sel.options.since ? iso(Date.now() - parseDuration(sel.options.since)) : undefined;
    const walkie = this.walkieSide();
    const filter = sel.options.team ? teams.find((t) => t.key.toLowerCase() === sel.options.team?.toLowerCase()) : undefined;
    if (sel.options.team && !filter) throw new Error(`no Linear team with key ${sel.options.team} (the plan's team filter)`);
    for (const sp of sel.projects.filter((p) => p.include)) {
      if (signal.aborted) break;
      const none = sp.key.startsWith("none:");
      const lp = none ? null : projects.find((p) => p.id === sp.key) ?? null;
      // A team-filtered plan imports only that team's issues, also from a project several teams share.
      const team = filter && (none ? `none:${filter.id}` === sp.key : lp?.teams.nodes.some((t) => t.id === filter.id)) ? filter
        : filter ? undefined : lp ? lp.teams.nodes[0] : teams.find((t) => `none:${t.id}` === sp.key);
      if (!team || (!none && !lp)) {
        const why = filter && (lp || none) ? `not in the plan's team ${filter.key} (skipped)` : "not found in Linear any more (skipped)";
        this.addError(job.errors, { project: sp.name ?? sp.key, message: why });
        job.projects_done++;
        continue;
      }
      const name = sp.name ?? (lp ? lp.name.slice(0, 60) : `${team.name}: no project`.slice(0, 60));
      job.current = name;
      try {
        const channel = await this.ensureProject(job, sp, lp, team, name, walkie, filter?.id);
        const list = await L.issues(api, {
          ...(lp ? { projectIds: [lp.id], ...(filter ? { teamId: filter.id } : {}) } : { projectIds: "none" as const, teamId: team.id }),
          includeClosed: sel.options.include_closed, ...(since ? { since } : {}),
        }, { full: true });
        const excluded = new Set(sp.exclude);
        const chosen = parentFirst(list.filter((i) => !excluded.has(i.id)));
        job.issues_total += chosen.length;
        await this.applyIssues({ channel, projectKey: sp.key, teamId: team.id }, chosen, {
          create: true, twoWay: false, api, states: [], explicit, walkie, signal, counters: job, errors: job.errors, jobForWait: job,
        });
      } catch (err) {
        if (signal.aborted) break;
        this.addError(job.errors, { project: name, message: err instanceof HttpError ? this.safe(new Error(err.message), k) : this.safe(err, k) });
        this.d.log.warn("linear_import_project_failed", { project: name.slice(0, 60), err: this.safe(err, k) });
      }
      job.projects_done++;
    }
    if (!this.st.sync.watermark) this.st = { ...this.st, sync: { ...this.st.sync, watermark: iso(job.started_at) } };
    this.save();
    job.state = signal.aborted ? "cancelled" : "done";
    job.current = "";
    job.finished_at = Date.now();
    this.d.log.info("linear_import_finished", { job: job.id, state: job.state, created: job.created, updated: job.updated, events: job.events, errors: job.errors.length });
  }

  /** The project an entry imports into: the map, the plan's target, an earlier import (its `ext`), else a new one. */
  private async ensureProject(job: Job, sp: Selection["projects"][number], lp: L.LProject | null, team: L.LTeam, name: string, walkie: WalkieSide, teamFilter?: string): Promise<string> {
    const w = this.w();
    const usable = (ch: string | null | undefined): ProjectView | null => {
      if (!ch) return null;
      try { const p = visibleProject(w, ch); return p.state === "active" ? p : null; } catch { return null; }
    };
    const known = usable(this.st.projects[sp.key]?.channel) ?? usable(sp.target) ?? usable(walkie.importedProjects.get(sp.key));
    let p = known;
    if (!p) {
      const taken = new Set(visibleProjects(w).filter((x) => x.state !== "deleted").map((x) => x.prefix));
      const prefix = sp.prefix && !taken.has(sp.prefix) ? sp.prefix : prefixFor(name, taken, lp ? "LIN" : team.key);
      const description = (lp
        ? `Imported from Linear: ${lp.url ?? lp.name}${lp.description ? `\n\n${lp.description}` : ""}`
        : `Issues of the Linear team ${team.name} without a project.`).slice(0, 2_000);
      p = await createProject(w, {
        name, prefix, ...(sp.folder ? { folder: sp.folder } : {}), description, columns: [...IMPORT_COLUMNS],
        ext: { src: "linear", id: lp ? lp.id : `none-${team.id}` },
      });
    }
    this.st = { ...this.st, projects: { ...this.st.projects, [sp.key]: { channel: p.channel, prefix: p.prefix, name: p.name, team_id: team.id, ...(teamFilter ? { team_filter: teamFilter } : {}) } } };
    this.save();
    if (!job.projects.some((x) => x.channel === p.channel)) job.projects.push({ key: sp.key, channel: p.channel, prefix: p.prefix, name: p.name, created: !known });
    return p.channel;
  }

  /** Linear's side of an issue, as sync compares it. */
  private linearFields(i: L.LIssue, explicit: ReadonlyMap<string, string>, members: readonly Member[]): Fields {
    const who = memberFor(i.assignee, members, explicit);
    return {
      title: titleOf(i), place: placeOf(i.state).role, labels: labelsOf(i), estimate: estimateOf(i.estimate), due: dueOf(i.dueDate),
      assignee: who ? `@${who}` : null,
    };
  }

  /**
   * The Walkie writes for a set of issues of one project: new cards (with their digest comment), updates of imported
   * ones (the sync rule), conflict notes; sent in batches of RUN_BATCH_OPS, the map saved after each. Two-way: the
   * Linear writes, after the Walkie ones.
   */
  private async applyIssues(
    where: { channel: string; projectKey: string; teamId: string },
    issues: readonly L.LIssue[],
    o: {
      create: boolean; twoWay: boolean; api: L.ImportApi; states: readonly L.LState[]; explicit: ReadonlyMap<string, string>;
      walkie: WalkieSide; signal?: AbortSignal; errors: ImportError[];
      counters: { created: number; updated: number; unchanged: number; comments: number; skipped: number; events: number; conflicts?: number; to_linear?: number };
      jobForWait?: Job;
      /** Issues sync must not create (unticked in the last plan). */
      excluded?: ReadonlySet<string>;
      /** Only these closed issues may be created (sync: the import's include_closed). */
      createClosed?: boolean;
    },
  ): Promise<void> {
    const members = o.walkie.members;
    let pending: Array<{ op: BatchOpT; commit?: (r: BatchResult, idx: number) => void }> = [];
    const linearWrites: Array<{ issue: L.LIssue; role: ColumnRole; next: CardEntry }> = [];
    const project = visibleProject(this.w(), where.channel);
    /** Keys the cards of the pending batch will get (a batch numbers its new cards after the highest, in order). */
    const pendingKeys = new Map<string, string>();
    /** Cards the pending batch already updates (a batch updates a card at most once). */
    const pendingCards = new Set<string>();
    let createsPending = 0;
    const flush = async () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      pendingKeys.clear();
      pendingCards.clear();
      createsPending = 0;
      const res = await this.applyWithBudget(where.channel, batch.map((x) => x.op), o.signal, o.jobForWait);
      o.counters.events += res.events;
      o.counters.created += res.created.length;
      o.counters.updated += res.updated.length;
      o.counters.unchanged += res.unchanged.length;
      o.counters.comments += res.comments.length;
      batch.forEach((x, i) => x.commit?.(res, i));
      this.save();
    };
    const seen = new Set<string>();
    for (const issue of issues) {
      if (o.signal?.aborted) break;
      if (seen.has(issue.id)) continue; // a page boundary that moved while paging can repeat an issue
      seen.add(issue.id);
      const lf = this.linearFields(issue, o.explicit, members);
      const entry = this.st.cards[issue.id];
      const known = entry ?? null;
      // Selection gates recovery/adoption too, before looking up any untracked card.
      if (!known && (!o.create || o.excluded?.has(issue.id))) continue;
      const place = placeOf(issue.state);
      if (!known && o.createClosed === false && (place.role === "done" || place.role === "cancelled")) continue;
      const found = known ? { card: known.card } : o.walkie.importedIssues.get(issue.id) ?? o.walkie.adopted.get(issue.identifier) ?? null;
      const card = found ? this.d.idx.db.card(found.card) : null;
      if (found && (!card || card.state === "deleted" || card.channel !== where.channel)) { o.counters.skipped++; continue; }
      if (card) {
        const board = project.boards.find((b) => b.id === card.board);
        const wf = walkieFields(card, board);
        const dec = decide({ snap: known?.snap ?? null, linear: lf, linearAt: Date.parse(issue.updatedAt), walkie: wf, walkieAt: card.updated_at, twoWay: o.twoWay });
        const conflicts = known?.snap ? dec.conflicts : [];
        const ops: BatchOpT[] = [];
        const t = dec.toWalkie;
        if (Object.keys(t).length) {
          const up: BatchOpT = {
            op: "update", card: card.id,
            ...(t.title !== undefined ? { title: t.title } : {}),
            ...(t.labels !== undefined ? { labels: t.labels } : {}),
            ...(t.estimate !== undefined ? { estimate: t.estimate } : {}),
            ...(t.due !== undefined ? { due: t.due } : {}),
            ...(t.assignee !== undefined ? { assignee: t.assignee } : {}),
            ...(t.place !== undefined ? placeFields(board, card, t.place) : {}),
          };
          ops.push(up);
        }
        if (conflicts.length) ops.push({ op: "comment", card: card.id, text: conflictNote(card.key, conflicts, { linear: Date.parse(issue.updatedAt), walkie: card.updated_at }) });
        if (!known?.snap) ops.push({ op: "comment", card: card.id, text: "Linear sync: first adoption. Linear wins this read-only reconciliation; the existing card title is kept. No state is written to Linear on first adoption." });
        if (o.counters.conflicts !== undefined) o.counters.conflicts += conflicts.length ? 1 : 0;
        // The board may lack the requested role's column (review → In progress): record what the card will really show,
        // or the next two-way pass would take the fallback for a person's move and write it to Linear.
        const snapNext = t.place !== undefined ? { ...dec.next, w: { ...dec.next.w, place: appliedPlace(board, t.place) } } : dec.next;
        const next: CardEntry = { card: card.id, channel: card.channel, key: card.key, ident: issue.identifier, project: where.projectKey, team_id: where.teamId, snap: snapNext };
        // A pending Linear write must leave BOTH old snapshots intact, including after a successful Walkie batch.
        // Otherwise a capped, cancelled, unmappable or failed write disappears from the next pass's changed cards.
        const commit = () => {
          if (dec.toLinear) linearWrites.push({ issue, role: dec.toLinear, next });
          else this.st = { ...this.st, cards: { ...this.st.cards, [issue.id]: next } };
        };
        if (!ops.length) { commit(); o.counters.unchanged++; continue; }
        if (pending.length + ops.length > RUN_BATCH_OPS || pendingCards.has(card.id)) await flush();
        pendingCards.add(card.id);
        ops.forEach((op, j) => pending.push({ op, ...(j === 0 ? { commit } : {}) }));
        continue;
      }
      if (!o.create || o.excluded?.has(issue.id)) continue;
      const board = project.boards.find((b) => b.state === "active") ?? project.boards[0];
      if (!board) throw new HttpError(409, "conflict", `project ${project.name} has no board`);
      const parent = issue.parent ? this.st.cards[issue.parent.id] : undefined;
      const parentRef = parent ? this.d.idx.db.card(parent.card)?.ref ?? parent.key : issue.parent ? pendingKeys.get(issue.parent.id) ?? null : null;
      const unmapped = issue.assignee && !lf.assignee ? issue.assignee.name ?? issue.assignee.displayName ?? issue.assignee.email ?? null : null;
      const ext = { src: "linear" as const, id: issue.id, key: issue.identifier };
      const body = bodyOf(issue, { unmappedAssignee: unmapped, parentRef, budget: bodyBudget(lf.title, lf.labels, JSON.stringify(ext).length + 16) });
      const create: BatchOpT = {
        op: "create", board: board.id, title: lf.title, body, column: columnForRole(board, place.role), labels: lf.labels,
        ...(lf.assignee ? { assignee: lf.assignee } : {}), ...(lf.estimate !== null ? { estimate: lf.estimate } : {}), ...(lf.due ? { due: lf.due } : {}),
        ...(place.archived ? { state: "archived" as const } : {}), ext,
      };
      const digest = digestOf(issue);
      const group = digest ? 2 : 1;
      if (pending.length + group > RUN_BATCH_OPS) await flush();
      const at = pending.length;
      createsPending++;
      pendingKeys.set(issue.id, `${project.prefix}-${this.d.idx.db.maxN(where.channel) + createsPending}`);
      pending.push({
        op: create,
        commit: (res) => {
          const c = res.created.find((x) => x.i === at);
          if (!c) return;
          const snap: Snap = { l: { ...lf }, w: { ...lf, place: appliedPlace(board, place.role) } };
          this.st = { ...this.st, cards: { ...this.st.cards, [issue.id]: { card: c.id, channel: where.channel, key: c.key, ident: issue.identifier, project: where.projectKey, team_id: where.teamId, snap } } };
        },
      });
      if (digest) pending.push({ op: { op: "comment", card: `#${at}`, text: digest } });
    }
    await flush();
    if (!linearWrites.length) return;
    for (const lw of linearWrites.slice(0, MAX_LINEAR_WRITES)) {
      if (o.signal?.aborted) break;
      const state = stateForRole(lw.role, o.states.filter((s) => s.team?.id === lw.issue.team.id));
      if (!state) { this.addError(o.errors, { issue: lw.issue.identifier, message: `the Linear team has no state for "${lw.role}"` }); continue; }
      try {
        const written = lw.issue.state.id === state.id ? lw.issue : await L.setIssueState(o.api, lw.issue.id, state.id);
        if (lw.issue.state.id !== state.id && o.counters.to_linear !== undefined) o.counters.to_linear++;
        // Review/backlog can map to a different role: acknowledge what Linear actually returned, not the request.
        const snap = lw.next.snap!;
        const next = { ...lw.next, snap: { ...snap, l: { ...snap.l, place: placeOf(written.state).role } } };
        this.st = { ...this.st, cards: { ...this.st.cards, [lw.issue.id]: next } };
        this.save();
      } catch (err) {
        this.addError(o.errors, { issue: lw.issue.identifier, message: this.d.manager.safeMessage(err, [o.api.key]) });
      }
    }
    this.save();
  }

  /** applyBatch, waiting (cancellably) while the import budget refills. */
  private async applyWithBudget(channel: string, ops: BatchOpT[], signal: AbortSignal | undefined, job: Job | undefined): Promise<BatchResult> {
    for (;;) {
      if (signal?.aborted) throw new Error("cancelled");
      try {
        return applyBatch(this.w(), channel, ops, { budgetKey: importBudgetKey(undefined) });
      } catch (err) {
        if (!(err instanceof HttpError) || err.status !== 429) throw err;
        const s = Number(err.details?.retry_after_s ?? 30);
        const ms = Math.min(Math.max(1, s) * 1000, 60_000);
        if (job) { job.state = "waiting"; job.waiting_until = Date.now() + ms; }
        await sleep(ms, signal);
        if (job) { job.state = "running"; job.waiting_until = null; }
      }
    }
  }

  // ---- sync ---------------------------------------------------------------------------------------------------------

  private scheduledKey(): Key {
    const s = this.st.sync;
    if (s.key_file) return this.resolveKey({ key_file: s.key_file });
    if (this.integrationOn()) return this.resolveKey({});
    throw new HttpError(409, "not_configured", "a scheduled sync needs the Linear integration on, or a key file (--key-file)");
  }

  /**
   * One sync pass: issues of imported projects updated since the watermark (minus an overlap) and imported cards
   * changed in Walkie are compared with what the last pass recorded (sync.ts); new issues become cards; two-way writes
   * card moves back as the issue's state.
   */
  async syncOnce(o: { two_way?: boolean }, keyReq?: KeyReq): Promise<SyncResult> {
    if (this.syncing) throw new HttpError(409, "conflict", "a sync is already running");
    if (this.busy()) throw new HttpError(409, "conflict", "an import is running; sync after it finishes");
    this.syncing = true;
    const ctrl = new AbortController();
    this.syncCtrl = ctrl;
    const signal = ctrl.signal;
    const twoWay = o.two_way ?? this.st.sync.two_way;
    const result: SyncResult = { at: Date.now(), two_way: twoWay, read: 0, created: 0, updated: 0, conflicts: 0, to_linear: 0, errors: [] };
    let k: Key | null = null;
    try {
      k = keyReq ? this.resolveKey(keyReq) : this.scheduledKey();
      const api = this.api(k, signal);
      const started = Date.now();
      const since = this.st.sync.watermark ? iso(Date.parse(this.st.sync.watermark) - SYNC_OVERLAP_MS) : iso(started - 86_400_000);
      const w = this.w();
      this.d.idx.flushAll();
      const synced = Object.entries(this.st.projects).filter(([, e]) => {
        try { return visibleProject(w, e.channel).state === "active"; } catch { return false; }
      });
      const sel = this.st.last_selection;
      const excluded = new Set(sel?.projects.flatMap((p) => p.exclude) ?? []);
      const changed: L.LIssue[] = [];
      // Projects imported by a team-filtered run are read for that team only (grouped per filter).
      const byFilter = new Map<string, string[]>();
      for (const [key, e] of synced) if (!key.startsWith("none:")) byFilter.set(e.team_filter ?? "", [...(byFilter.get(e.team_filter ?? "") ?? []), key]);
      for (const [teamId, ids] of byFilter) {
        for (const c of chunks(ids, ID_CHUNK)) changed.push(...await L.issues(api, { projectIds: c, includeClosed: true, since, ...(teamId ? { teamId } : {}) }, { full: true }));
      }
      for (const [key] of synced.filter(([key]) => key.startsWith("none:"))) {
        changed.push(...await L.issues(api, { projectIds: "none", teamId: key.slice(5), includeClosed: true, since }, { full: true }));
      }
      // Issues a failed pass couldn't apply (their project's batch failed): read again, whatever the watermark says.
      const retryBefore = new Set(this.st.sync.retry ?? []);
      const fetched = new Set(changed.map((i) => i.id));
      const again = [...retryBefore].filter((id) => !fetched.has(id));
      for (const c of chunks(again, ID_CHUNK)) changed.push(...await L.issues(api, { ids: c, includeClosed: true }, { full: true }));
      // Cards changed in Walkie whose issue Linear didn't report: read those issues too.
      const seen = new Set(changed.map((i) => i.id));
      const moved: string[] = [];
      for (const [id, e] of Object.entries(this.st.cards)) {
        if (seen.has(id) || !synced.some(([, p]) => p.channel === e.channel)) continue;
        const card = this.d.idx.db.card(e.card);
        if (!card || card.state === "deleted") continue;
        const board = this.d.idx.project(card.channel)?.boards.find((b) => b.id === card.board);
        const wf = walkieFields(card, board);
        if (!e.snap || FIELD_NAMES.some((f) => JSON.stringify(wf[f]) !== JSON.stringify(e.snap?.w[f]))) moved.push(id);
      }
      for (const c of chunks(moved, ID_CHUNK)) changed.push(...await L.issues(api, { ids: c, includeClosed: true }));
      result.read = changed.length;
      const states = twoWay ? await L.workflowStates(api) : [];
      const walkie = this.walkieSide();
      const explicit = parseMapUsers(sel?.options.map_users);
      const byProject = new Map<string, L.LIssue[]>();
      for (const i of changed) {
        const e = this.st.cards[i.id];
        const key = e?.project ?? projectKeyOf(i);
        if (!synced.some(([k2]) => k2 === key)) continue;
        byProject.set(key, [...(byProject.get(key) ?? []), i]);
      }
      const counters = { created: 0, updated: 0, unchanged: 0, comments: 0, skipped: 0, events: 0, conflicts: 0, to_linear: 0 };
      // Issues read this pass start as "not applied"; each project that finishes clears its own.
      const retry = new Set([...retryBefore, ...changed.map((i) => i.id)]);
      for (const [key, list] of byProject) {
        if (signal.aborted) break;
        const e = this.st.projects[key];
        if (!e) continue;
        try {
          await this.applyIssues({ channel: e.channel, projectKey: key, teamId: e.team_id }, parentFirst(list), {
            create: sel?.projects.find((p) => p.key === key)?.include !== false, twoWay, api, states, explicit, walkie, errors: result.errors, counters, excluded,
            createClosed: sel?.options.include_closed ?? false, signal,
          });
          if (!signal.aborted) for (const i of list) retry.delete(i.id);
        } catch (err) {
          if (signal.aborted) break;
          this.addError(result.errors, { project: e.name, message: err instanceof HttpError ? this.safe(new Error(err.message), k) : this.safe(err, k) });
        }
      }
      if (signal.aborted) throw new HttpError(409, "cancelled", "the sync was cancelled; nothing after the cancel was written, and the next pass reads the same issues again");
      // Issues outside every synced project (or dropped by the selection) need no retry.
      for (const id of [...retry]) {
        const i = changed.find((x) => x.id === id);
        if (!i || !byProject.has(this.st.cards[i.id]?.project ?? projectKeyOf(i))) retry.delete(id); // gone from Linear, or not ours
      }
      // Too many to remember: keep the old watermark instead, so the overlap reads them again.
      const overflow = retry.size > MAX_RETRY;
      result.created = counters.created;
      result.updated = counters.updated;
      result.conflicts = counters.conflicts;
      result.to_linear = counters.to_linear;
      this.st = {
        ...this.st,
        sync: {
          ...this.st.sync, ...(overflow ? {} : { watermark: iso(started) }), retry: overflow ? [] : [...retry], last_run: Date.now(), last_error: undefined,
          last_result: `read ${result.read}, created ${result.created}, updated ${result.updated}, conflicts ${result.conflicts}, to Linear ${result.to_linear}${result.errors.length ? `, ${result.errors.length} errors` : ""}`,
        },
      };
      this.save();
      this.d.log.info("linear_sync_done", { read: result.read, created: result.created, updated: result.updated, conflicts: result.conflicts, to_linear: result.to_linear, errors: result.errors.length });
      return result;
    } catch (err) {
      const msg = err instanceof HttpError ? err.message : this.safe(err, k);
      this.st = { ...this.st, sync: { ...this.st.sync, last_run: Date.now(), last_error: msg.slice(0, 500) } };
      this.save();
      if (err instanceof HttpError) throw err;
      throw k ? this.upstream(err, k) : new HttpError(502, "upstream", msg);
    } finally {
      this.syncing = false;
      if (this.syncCtrl === ctrl) this.syncCtrl = null;
    }
  }

  /** The schedule's check: a pass when enabled and due (errors are recorded in the status, never thrown). */
  async tick(now = Date.now()): Promise<void> {
    const s = this.st.sync;
    if (this.stopped || !s.enabled || this.syncing || this.busy()) return;
    if (s.last_run && now - s.last_run < s.interval_min * 60_000) return;
    try {
      await this.syncOnce({});
    } catch (err) {
      this.d.log.warn("linear_sync_failed", { err: err instanceof HttpError ? err.message.slice(0, 300) : this.safe(err) });
    }
  }

  /** Sync settings (people only: the route checks). Enabling needs a key a schedule can use. */
  settings(req: { enabled?: boolean; two_way?: boolean; interval_min?: number; key_file?: string | null }): SyncView {
    const next: SyncSettings = {
      ...this.st.sync,
      ...(req.enabled !== undefined ? { enabled: req.enabled } : {}),
      ...(req.two_way !== undefined ? { two_way: req.two_way } : {}),
      ...(req.interval_min !== undefined ? { interval_min: req.interval_min } : {}),
    };
    if (req.key_file === null) delete next.key_file;
    else if (req.key_file !== undefined) {
      this.resolveKey({ key_file: req.key_file }); // readable, 0600, one token: or 400 now rather than at 3 a.m.
      next.key_file = req.key_file;
    }
    if (next.enabled && !next.key_file && !this.integrationOn()) {
      throw new HttpError(409, "not_configured", "a scheduled sync needs the Linear integration on, or a key file (--key-file); LINEAR_API_KEY can't be kept");
    }
    if (next.enabled && !Object.keys(this.st.projects).length) throw new HttpError(409, "conflict", "nothing imported yet: import first (walkie import linear)");
    this.st = { ...this.st, sync: next };
    this.save();
    return this.syncView();
  }

  private syncView(): SyncView {
    const s = this.st.sync;
    return {
      enabled: s.enabled, two_way: s.two_way, interval_min: s.interval_min,
      key: s.key_file ? "key_file" : this.integrationOn() ? "integration" : "none", ...(s.key_file ? { key_file: s.key_file } : {}),
      last_run: s.last_run ?? null, last_result: s.last_result ?? null, last_error: s.last_error ?? null, running: this.syncing,
    };
  }

  status(): ImportStatus {
    return {
      job: this.view(this.job), sync: this.syncView(),
      imported: { projects: Object.keys(this.st.projects).length, cards: Object.keys(this.st.cards).length },
      integration: this.integrationOn(),
    };
  }

  /** Tests: the stored map. */
  state(): ImportState { return this.st; }
  /** Tests: forget the map (the next run must find its cards in the signed log). */
  resetState(): void { this.st = emptyState(); this.save(); }
}

/** The place a card shows once put at `place` on this board (the column fallback's role; canceled stays canceled). */
export function appliedPlace(board: { readonly columns: readonly Column[] } | undefined, place: ColumnRole): ColumnRole {
  if (!board || place === "cancelled") return place;
  const id = columnForRole(board, place);
  return board.columns.find((c) => c.id === id)?.role ?? place;
}

/** The update fields that put a card at `place` on its board (archived for canceled; reopened when it comes back). */
function placeFields(board: BoardView | undefined, card: CardView, place: ColumnRole): { column?: string; state?: "open" | "archived" } {
  if (!board) return {};
  const column = columnForRole(board, place);
  if (place === "cancelled") return { column, state: "archived" };
  const role = board.columns.find((c) => c.id === card.column)?.role;
  const reopen = card.state === "archived" && !(place === "done" && role === "done");
  return { column, ...(reopen ? { state: "open" as const } : {}) };
}
