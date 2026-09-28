// The dry-run plan (pure): which Linear projects become which Walkie projects, where every issue lands, and what looks
// irrelevant (closed projects, stale backlog, near-duplicate titles). The plan is a SELECTION the person edits and
// hands back (`walkie import linear --plan plan.json`): the run re-reads Linear and re-validates everything.
import { z } from "zod";
import { MAX_LIVE_CARDS_PER_BOARD, Prefix } from "../../protocol/projects/schema.ts";
import type { LIssue, LProject, LTeam } from "./schemas.ts";
import { memberFor, parseDuration, parseMapUsers, placeOf, prefixFor, similarKeys, titleKey, type Member, type TitleKey } from "./mapping.ts";

export const PlanOptions = z.object({
  /** Only issues updated within this window ("45d"). */
  since: z.string().max(12).optional(),
  include_closed: z.boolean().default(false),
  /** A Linear team key. */
  team: z.string().max(20).optional(),
  /** Linear project names or ids (and "none" for issues without a project). */
  projects: z.array(z.string().min(1).max(300)).max(500).optional(),
  stale_days: z.number().int().min(1).max(3650).default(60),
  skip_stale: z.boolean().default(false),
  skip_duplicates: z.boolean().default(false),
  folder_by: z.enum(["initiative", "team"]).default("initiative"),
  map_users: z.string().max(4_000).optional(),
}).strict();
export type PlanOptions = z.infer<typeof PlanOptions>;

export const COLUMN_IDS = ["backlog", "todo", "doing", "review", "done", "canceled"] as const;
export type ColumnCounts = Record<(typeof COLUMN_IDS)[number], number>;

export interface PlanIssue {
  id: string; identifier: string; title: string; column: string; archived: boolean; updated_at: string;
  include: boolean; flags: string[];
  /** The member the Linear assignee maps to (null: unassigned or unmapped). */
  assignee: string | null;
  /** Already in Walkie (imported before, or adopted from an earlier import): the run updates it. */
  existing?: { card: string; key: string };
}
export interface PlanProject {
  /** The Linear project id, or "none:<team id>" for a team's issues without a project. */
  key: string; linear_id: string | null; team_id: string; team_key: string;
  name: string; state: string; url: string | null; updated_at: string | null;
  include: boolean;
  /** An existing Walkie project it goes into (imported before, or adopted). */
  target: { channel: string; prefix: string; name: string } | null;
  prefix: string; folder: string;
  counts: ColumnCounts; flags: string[];
  issues: PlanIssue[];
}
export interface Plan {
  v: 1; generated_at: string; options: PlanOptions;
  teams: Array<{ id: string; key: string; name: string }>;
  projects: PlanProject[];
  totals: { projects: number; included_projects: number; issues: number; included_issues: number; creates: number; updates: number; by_column: ColumnCounts; flagged: Record<string, number> };
  /** Linear assignees no member matched (kept in card bodies; map them with --map-users). */
  unmapped_users: string[];
}

/** What the run needs from an edited plan: per project the include flag, overrides and the unticked issues. */
export const Selection = z.object({
  v: z.literal(1),
  options: PlanOptions,
  projects: z.array(z.object({
    key: z.string().min(1).max(120),
    include: z.boolean(),
    name: z.string().trim().min(1).max(60).optional(),
    prefix: Prefix.optional(),
    folder: z.string().max(40).optional(),
    target: z.string().regex(/^p-[0-9a-f]{8}$/).nullable().optional(),
    exclude: z.array(z.string().min(1).max(100)).max(20_000).default([]),
  }).strict()).max(1_000),
}).strict();
export type Selection = z.infer<typeof Selection>;

export interface WalkieSide {
  members: readonly Member[];
  projects: ReadonlyArray<{ channel: string; name: string; prefix: string; state: string }>;
  /** Linear project key (id or none:<team>) → the channel it was imported into. */
  importedProjects: ReadonlyMap<string, string>;
  /** Linear issue id → its card (imported before). */
  importedIssues: ReadonlyMap<string, { card: string; key: string; channel: string }>;
  /** Linear identifier (ALE-12) → a card of an earlier import (title `[ALE-12] …` or body "Linear ALE-12"), by this person. */
  adopted: ReadonlyMap<string, { card: string; key: string; channel: string }>;
}

export function emptyCounts(): ColumnCounts {
  return { backlog: 0, todo: 0, doing: 0, review: 0, done: 0, canceled: 0 };
}

const DAY = 86_400_000;

/** The Linear project key an issue belongs to. */
export function projectKeyOf(i: Pick<LIssue, "project" | "team">): string {
  return i.project?.id ?? `none:${i.team.id}`;
}

function wanted(filter: readonly string[] | undefined, p: { id: string | null; name: string; none: boolean }): boolean {
  if (!filter?.length) return true;
  const f = filter.map((x) => x.trim().toLowerCase());
  if (p.none) return f.includes("none") || f.includes("no project");
  return f.includes(p.name.toLowerCase()) || (!!p.id && f.includes(p.id.toLowerCase()));
}

function nameFor(p: { name: string }): string {
  const n = p.name.replace(/\s+/g, " ").trim();
  return n.length > 60 ? `${n.slice(0, 59)}…` : n;
}

/** Builds the plan. `issues` are the lite issues matching the options' filters. */
export function buildPlan(input: {
  now: number; options: PlanOptions; teams: readonly LTeam[]; projects: readonly LProject[]; issues: readonly LIssue[]; walkie: WalkieSide;
}): Plan {
  const { now, options: o, walkie } = input;
  const explicit = parseMapUsers(o.map_users);
  const team = o.team ? input.teams.find((t) => t.key.toLowerCase() === o.team?.toLowerCase()) : undefined;
  if (o.team && !team) throw new Error(`no Linear team with key ${o.team}`);
  const sinceMs = o.since ? now - parseDuration(o.since) : null;

  // Projects (and each team's "no project" bucket) in scope.
  const scoped = new Map<string, { linear: LProject | null; team: LTeam }>();
  for (const p of input.projects) {
    const t = p.teams.nodes[0];
    if (!t) continue;
    if (team && !p.teams.nodes.some((x) => x.id === team.id)) continue;
    if (!wanted(o.projects, { id: p.id, name: p.name, none: false })) continue;
    scoped.set(p.id, { linear: p, team: t });
  }
  for (const t of input.teams) {
    if (team && t.id !== team.id) continue;
    if (!wanted(o.projects, { id: null, name: "", none: true })) continue;
    scoped.set(`none:${t.id}`, { linear: null, team: t });
  }

  const byProject = new Map<string, LIssue[]>();
  for (const i of input.issues) {
    const k = projectKeyOf(i);
    if (!scoped.has(k)) continue;
    if (sinceMs !== null && Date.parse(i.updatedAt) <= sinceMs) continue;
    byProject.set(k, [...(byProject.get(k) ?? []), i]);
  }

  const taken = new Set(walkie.projects.filter((p) => p.state !== "deleted").map((p) => p.prefix));
  const byChannel = new Map(walkie.projects.map((p) => [p.channel, p]));
  const unmapped = new Set<string>();
  const out: PlanProject[] = [];
  const entries = [...scoped.entries()].map(([key, v]) => ({ key, ...v, folder: folderOf(v.linear, v.team, o.folder_by) }))
    .sort((a, b) => a.folder.localeCompare(b.folder) || (a.linear?.name ?? "").localeCompare(b.linear?.name ?? ""));
  for (const e of entries) {
    const issues = [...(byProject.get(e.key) ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const name = e.linear ? nameFor(e.linear) : nameFor({ name: `${e.team.name}: no project` });
    const flags: string[] = [];
    // Target: imported before; else where most of its adopted cards are.
    let targetChannel = walkie.importedProjects.get(e.key) ?? null;
    if (targetChannel && !byChannel.has(targetChannel)) targetChannel = null;
    if (targetChannel) flags.push("exists");
    if (!targetChannel) {
      const votes = new Map<string, number>();
      for (const i of issues) { const a = walkie.adopted.get(i.identifier); if (a) votes.set(a.channel, (votes.get(a.channel) ?? 0) + 1); }
      const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best && byChannel.has(best[0])) { targetChannel = best[0]; flags.push(`adopt:${best[1]}`); }
    }
    const target = targetChannel ? byChannel.get(targetChannel) ?? null : null;
    if (!target && walkie.projects.some((p) => p.state !== "deleted" && p.name.toLowerCase() === name.toLowerCase())) flags.push("name_taken");
    const state = e.linear ? projectState(e.linear) : "none";
    if (state === "completed" || state === "canceled") flags.push(state);
    if (e.linear && Date.parse(e.linear.updatedAt) < now - o.stale_days * DAY) flags.push("stale");
    if (!e.linear) flags.push("no_project");
    const prefix = target?.prefix ?? prefixFor(name, taken, e.linear ? "LIN" : e.team.key);
    if (!target) taken.add(prefix);

    const planIssues: PlanIssue[] = [];
    const counts = emptyCounts();
    const kept: Array<{ i: LIssue; k: TitleKey }> = [];
    const exact = new Map<string, LIssue>();
    for (const i of issues) {
      const place = placeOf(i.state);
      const f: string[] = [];
      const existing = walkie.importedIssues.get(i.id) ?? walkie.adopted.get(i.identifier);
      if (existing) f.push(walkie.importedIssues.has(i.id) ? "imported" : "adopted");
      if ((place.role === "backlog" || place.role === "todo") && Date.parse(i.updatedAt) < now - o.stale_days * DAY) f.push("stale");
      if (i.state.type === "duplicate") f.push("linear_duplicate");
      const k = titleKey(i.title);
      const dup = (k.norm ? exact.get(k.norm) : undefined) ?? kept.find((x) => similarKeys(x.k, k))?.i;
      if (dup) f.push(`duplicate_of:${dup.identifier}`);
      kept.push({ i, k });
      if (k.norm && !exact.has(k.norm)) exact.set(k.norm, i);
      const who = memberFor(i.assignee, walkie.members, explicit);
      if (i.assignee && !who) unmapped.add(i.assignee.name ?? i.assignee.displayName ?? i.assignee.email ?? "?");
      const include = !(o.skip_stale && f.includes("stale")) && !(o.skip_duplicates && !!dup);
      planIssues.push({
        id: i.id, identifier: i.identifier, title: i.title.slice(0, 300), column: place.column, archived: place.archived,
        updated_at: i.updatedAt, include, flags: f, assignee: who, ...(existing ? { existing: { card: existing.card, key: existing.key } } : {}),
      });
      if (include) counts[place.column as keyof ColumnCounts]++;
    }
    const open = planIssues.filter((x) => x.include && !x.archived).length;
    if (open > MAX_LIVE_CARDS_PER_BOARD) flags.push("over_board_cap");
    if (!issues.length) flags.push("empty");
    out.push({
      key: e.key, linear_id: e.linear?.id ?? null, team_id: e.team.id, team_key: e.team.key, name, state,
      url: e.linear?.url ?? null, updated_at: e.linear?.updatedAt ?? null,
      include: !flags.includes("completed") && !flags.includes("canceled") && issues.length > 0,
      target: target ? { channel: target.channel, prefix: target.prefix, name: target.name } : null,
      prefix, folder: e.folder, counts, flags, issues: planIssues,
    });
  }
  return { v: 1, generated_at: new Date(now).toISOString(), options: o, teams: input.teams.map((t) => ({ id: t.id, key: t.key, name: t.name })), projects: out, totals: totalsOf(out), unmapped_users: [...unmapped].sort() };
}

export function projectState(p: LProject): string {
  if (p.completedAt || p.state === "completed") return "completed";
  if (p.canceledAt || p.state === "canceled") return "canceled";
  return p.state ?? "unknown";
}

function folderOf(p: LProject | null, t: LTeam, by: "initiative" | "team"): string {
  const f = (by === "initiative" ? p?.initiatives?.nodes[0]?.name : undefined) ?? t.name;
  return f.replace(/\s+/g, " ").trim().slice(0, 40);
}

/** Totals over the plan (what an edited plan would do is recomputed the same way). */
export function totalsOf(projects: readonly PlanProject[]): Plan["totals"] {
  const by = emptyCounts();
  const flagged: Record<string, number> = {};
  let issues = 0; let included = 0; let creates = 0; let updates = 0;
  for (const p of projects) {
    for (const f of p.flags) { const k = f.split(":")[0] as string; flagged[`project_${k}`] = (flagged[`project_${k}`] ?? 0) + 1; }
    for (const i of p.issues) {
      issues++;
      for (const f of i.flags) { const k = f.split(":")[0] as string; flagged[k] = (flagged[k] ?? 0) + 1; }
      if (!p.include || !i.include) continue;
      included++;
      by[i.column as keyof ColumnCounts]++;
      if (i.existing) updates++; else creates++;
    }
  }
  return { projects: projects.length, included_projects: projects.filter((p) => p.include).length, issues, included_issues: included, creates, updates, by_column: by, flagged };
}

/** The run's input from a (possibly edited) plan: only what the person chose. */
export function selectionOf(plan: Pick<Plan, "options" | "projects">): Selection {
  return {
    v: 1, options: plan.options,
    projects: plan.projects.map((p) => ({
      key: p.key, include: p.include, name: p.name, prefix: p.prefix, folder: p.folder, target: p.target?.channel ?? null,
      exclude: p.issues.filter((i) => !i.include).map((i) => i.id),
    })),
  };
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const rpad = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);

/** The plan as a readable table (the CLI prints it and writes it next to the JSON). */
export function planTable(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`${pad("", 5)}${pad("PREFIX", 8)}${pad("PROJECT", 44)}${rpad("BKLG", 6)}${rpad("TODO", 6)}${rpad("DOING", 6)}${rpad("REVW", 6)}${rpad("DONE", 6)}${rpad("CANC", 6)}  FLAGS`);
  let folder: string | null = null;
  for (const p of plan.projects) {
    if (p.folder !== folder) { folder = p.folder; lines.push(`${folder || "(no folder)"}`); }
    const c = p.counts;
    const stale = p.issues.filter((i) => i.flags.includes("stale")).length;
    const dups = p.issues.filter((i) => i.flags.some((f) => f.startsWith("duplicate_of:"))).length;
    const off = p.issues.filter((i) => !i.include).length;
    const flags = [...p.flags.map((f) => (f === "stale" ? "project stale" : f)), ...(stale ? [`${stale} stale issue${stale === 1 ? "" : "s"}`] : []),
      ...(dups ? [`${dups} possible duplicate${dups === 1 ? "" : "s"}`] : []), ...(off ? [`${off} unticked`] : []),
      ...(p.target ? [`→ ${p.target.prefix} (existing)`] : [])].join(", ");
    lines.push(`${pad(p.include ? " [x]" : " [ ]", 5)}${pad(p.prefix, 8)}${pad(p.name, 44)}${rpad(String(c.backlog), 6)}${rpad(String(c.todo), 6)}${rpad(String(c.doing), 6)}${rpad(String(c.review), 6)}${rpad(String(c.done), 6)}${rpad(String(c.canceled), 6)}  ${flags}`);
  }
  const t = plan.totals;
  lines.push("");
  lines.push(`${t.included_projects}/${t.projects} projects, ${t.included_issues}/${t.issues} issues (${t.creates} new cards, ${t.updates} updates) · backlog ${t.by_column.backlog}, to do ${t.by_column.todo}, in progress ${t.by_column.doing}, in review ${t.by_column.review}, done ${t.by_column.done}, canceled ${t.by_column.canceled}`);
  const f = Object.entries(t.flagged).sort().map(([k, v]) => `${k} ${v}`).join(", ");
  if (f) lines.push(`flags: ${f}`);
  if (plan.unmapped_users.length) lines.push(`unmapped Linear assignees (kept in card bodies; --map-users @handle=Name): ${plan.unmapped_users.join(", ")}`);
  return lines.join("\n");
}
