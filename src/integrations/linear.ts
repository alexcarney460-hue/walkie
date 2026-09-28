// Linear: GraphQL client (read issues by key, issues updated since a cursor, create an issue) and the
// activity connector, which posts state transitions of issues agents report as their task (and,
// optionally, of whole teams). Personal API keys go in `Authorization` without a Bearer prefix.
import { z } from "zod";
import { DEFAULTS } from "./config.ts";
import { graphql } from "./http.ts";
import { drainBacklinks } from "./linear-backlink.ts";
import type { Connector, FetchLike, LinearIssueInfo, RunCtx, RunResult } from "./types.ts";

export const LINEAR_URL = "https://api.linear.app/graphql";
/** "ALE-5156": team key, dash, issue number. */
export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,6}$/;
const ISSUE_KEY_SCAN = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,6})(?![A-Za-z0-9])/g;
export const MAX_KEYS_PER_REQUEST = 50;
const TEAM_PAGE = 50;

const ISSUE_FIELDS = `id identifier title url priority priorityLabel updatedAt
  state { id name type } assignee { name displayName } team { key }`;
const HISTORY_NODE = `id createdAt fromState { name } toState { id name } actor { name }`;
const HISTORY_FIELDS = `history(first: 25) { nodes { ${HISTORY_NODE} } pageInfo { hasNextPage endCursor } }`;
/** Further history pages read per issue per poll (50 entries each) when the first page was full (#7). */
const MAX_HISTORY_PAGES = 8;
const HISTORY_PAGE = 50;

const Str = z.string().max(10_000);
export const LinearIssue = z.object({
  id: z.string().min(1).max(100),
  identifier: z.string().regex(ISSUE_KEY_RE),
  title: Str,
  url: Str,
  priority: z.number().nullish(),
  priorityLabel: Str.nullish(),
  updatedAt: Str,
  state: z.object({ id: z.string().max(100), name: Str, type: Str.nullish() }),
  assignee: z.object({ name: Str.nullish(), displayName: Str.nullish() }).nullish(),
  team: z.object({ key: Str }).nullish(),
  history: z.object({
    nodes: z.array(z.object({
      id: z.string().max(100), createdAt: Str,
      fromState: z.object({ name: Str }).nullish(), toState: z.object({ id: z.string().max(100), name: Str }).nullish(),
      actor: z.object({ name: Str.nullish() }).nullish(),
    })).max(100),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().max(500).nullish() }).nullish(),
  }).nullish(),
});
export type LinearIssue = z.infer<typeof LinearIssue>;
const HistoryPage = z.object({ issue: z.object({ history: LinearIssue.shape.history }).nullable() });
const IssuesData = z.object({ issues: z.object({ nodes: z.array(LinearIssue).max(250) }) });

/** `secrets`: every credential the calling operation may have used, scrubbed from every response field. */
export interface LinearApi { fetch: FetchLike; key: string; secrets?: () => readonly (string | null | undefined)[] }

function gql<T>(api: LinearApi, query: string, variables: Record<string, unknown>, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  return graphql({ fetch: api.fetch, url: LINEAR_URL, auth: api.key, service: "linear", query, variables, ...(api.secrets ? { secrets: api.secrets } : {}) }, schema);
}

/** Issue keys mentioned in free text (deduplicated, capped). */
export function issueKeysIn(text: string, max = 20): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ISSUE_KEY_SCAN)) {
    out.add(m[1] as string);
    if (out.size >= max) break;
  }
  return [...out];
}

export function toInfo(i: LinearIssue): LinearIssueInfo {
  return {
    key: i.identifier, title: i.title.slice(0, 300), state: i.state.name.slice(0, 60), state_type: (i.state.type ?? "").slice(0, 30),
    assignee: (i.assignee?.displayName || i.assignee?.name || null)?.slice(0, 80) ?? null,
    priority: i.priority ?? 0, priority_label: (i.priorityLabel ?? "").slice(0, 30),
    url: safeLinearUrl(i.url) ?? "",
  };
}

/** Only https links on linear.app are passed on to the dashboard. */
export function safeLinearUrl(u: string): string | null {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && (url.hostname === "linear.app" || url.hostname.endsWith(".linear.app")) ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Issues by key, one query per team (unknown numbers simply don't match; a batch never fails on one key). */
export async function issuesByKeys(api: LinearApi, keys: readonly string[], withHistory = false): Promise<LinearIssue[]> {
  const byTeam = new Map<string, number[]>();
  for (const k of keys) {
    if (!ISSUE_KEY_RE.test(k)) continue;
    const [team, num] = k.split("-") as [string, string];
    byTeam.set(team, [...(byTeam.get(team) ?? []), Number(num)]);
  }
  const out: LinearIssue[] = [];
  for (const [team, numbers] of byTeam) {
    const data = await gql(api, `query WalkieIssues($team: String!, $numbers: [Float!]!) {
      issues(first: 100, filter: { team: { key: { eq: $team } }, number: { in: $numbers } }) { nodes { ${ISSUE_FIELDS} ${withHistory ? HISTORY_FIELDS : ""} } }
    }`, { team, numbers }, IssuesData);
    out.push(...data.issues.nodes);
  }
  return out;
}

/**
 * The issue with its WHOLE recent history (#7): an issue whose first history page was full is paged
 * further (up to MAX_HISTORY_PAGES × 50 entries) before its transitions are judged, so a burst of
 * changes between two polls loses nothing. Past the cap the rest is logged and skipped.
 */
export async function withFullHistory(api: LinearApi, issue: LinearIssue, warn: (n: number) => void = () => undefined): Promise<LinearIssue> {
  const h = issue.history;
  if (!h?.pageInfo?.hasNextPage) return issue;
  const nodes = [...h.nodes];
  let after = h.pageInfo.endCursor ?? null;
  for (let page = 0; after && page < MAX_HISTORY_PAGES; page++) {
    const data = await gql(api, `query WalkieIssueHistory($id: String!, $after: String) {
      issue(id: $id) { history(first: ${HISTORY_PAGE}, after: $after) { nodes { ${HISTORY_NODE} } pageInfo { hasNextPage endCursor } } }
    }`, { id: issue.id, after }, HistoryPage);
    const more = data.issue?.history;
    if (!more) break;
    nodes.push(...more.nodes);
    after = more.pageInfo?.hasNextPage ? more.pageInfo.endCursor ?? null : null;
    if (after && page === MAX_HISTORY_PAGES - 1) warn(nodes.length);
  }
  return { ...issue, history: { nodes } };
}

const IssuesPage = z.object({
  issues: z.object({
    nodes: z.array(LinearIssue).max(250),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().max(500).nullish() }),
  }),
});

/**
 * One page of a team's issues updated in (since, until] (ISO), with their recent history. `next` is the
 * cursor of the following page, null after the last one.
 */
export async function teamIssuesPage(api: LinearApi, team: string, since: string, until: string, after: string | null): Promise<{ nodes: LinearIssue[]; next: string | null }> {
  const data = await gql(api, `query WalkieTeamIssues($team: String!, $since: DateTimeOrDuration!, $until: DateTimeOrDuration!, $after: String) {
    issues(first: ${TEAM_PAGE}, after: $after, orderBy: updatedAt, filter: { team: { key: { eq: $team } }, updatedAt: { gt: $since, lte: $until } }) {
      nodes { ${ISSUE_FIELDS} ${HISTORY_FIELDS} } pageInfo { hasNextPage endCursor }
    }
  }`, { team, since, until, after }, IssuesPage);
  const next = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor ?? null : null;
  return { nodes: data.issues.nodes, next };
}

const TeamsData = z.object({ teams: z.object({ nodes: z.array(z.object({ id: z.string().max(100), key: Str, name: Str })).max(250) }) });

export async function teamByKey(api: LinearApi, key: string): Promise<{ id: string; key: string; name: string } | null> {
  const data = await gql(api, `query WalkieTeam($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name } } }`, { key }, TeamsData);
  return data.teams.nodes[0] ?? null;
}

export async function firstTeam(api: LinearApi): Promise<{ id: string; key: string; name: string } | null> {
  const data = await gql(api, `query WalkieTeams { teams(first: 1) { nodes { id key name } } }`, {}, TeamsData);
  return data.teams.nodes[0] ?? null;
}

export const CREATE_MUTATION = `mutation WalkieCreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier title url } }
}`;
const CreateData = z.object({
  issueCreate: z.object({ success: z.boolean(), issue: z.object({ id: z.string(), identifier: z.string().regex(ISSUE_KEY_RE), title: Str, url: Str }).nullish() }),
});

export async function createIssue(api: LinearApi, input: { teamId: string; title: string; description: string }): Promise<{ identifier: string; title: string; url: string }> {
  const data = await gql(api, CREATE_MUTATION, { input }, CreateData);
  const issue = data.issueCreate.issue;
  if (!data.issueCreate.success || !issue) throw new Error("linear: issueCreate did not succeed");
  return { identifier: issue.identifier, title: issue.title, url: safeLinearUrl(issue.url) ?? issue.url };
}

// ---- activity connector ------------------------------------------------------------------

interface Transition { ext: string; key: string; from: string | null; to: string; actor: string | null; at: number }

/** State transitions of one issue since the last snapshot (or the cursor for an unseen issue). */
export function transitionsOf(issue: LinearIssue, snap: { state_id: string; state_name: string; updated_at: string } | null, cursorMs: number): Transition[] {
  const since = snap ? Date.parse(snap.updated_at) : cursorMs;
  const fromHistory = (issue.history?.nodes ?? [])
    .filter((h) => h.toState && Date.parse(h.createdAt) > since)
    .map((h) => ({
      ext: `h:${h.id}`, key: issue.identifier, from: h.fromState?.name ?? null, to: (h.toState as { name: string }).name,
      actor: h.actor?.name ?? null, at: Date.parse(h.createdAt),
    }))
    .sort((a, b) => a.at - b.at);
  if (fromHistory.length) return fromHistory;
  if (snap && snap.state_id !== issue.state.id) {
    return [{ ext: `s:${issue.id}:${snap.state_id}>${issue.state.id}:${issue.updatedAt}`, key: issue.identifier, from: snap.state_name, to: issue.state.name, actor: null, at: Date.parse(issue.updatedAt) }];
  }
  return [];
}

export function formatTransition(t: Transition, issue: LinearIssue): string {
  const url = safeLinearUrl(issue.url);
  return `**${t.key}** ${t.from ?? "(new)"} → ${t.to}${t.actor ? ` (by ${t.actor})` : ""}\n${issue.title}${url ? `\n${url}` : ""}`;
}

/** Issue keys the team's agents currently report as their task. */
export type TaskKeys = () => string[];

/** Re-read window before the watermark for team watching (late updates, clock skew); dedup absorbs repeats. */
export const LINEAR_OVERLAP_MS = 10 * 60_000;
/** Team pages read per run; the rest continues next run from the persisted page. */
const MAX_TEAM_PAGES_PER_RUN = 40;

const TeamPage = z.object({
  since: z.string(), until: z.string(),
  /** Teams whose pages are all done in this interval. */
  done: z.array(z.string()),
  /** The team being paged and the cursor of its next page. */
  team: z.string().nullable(), after: z.string().nullable(),
  /** Some transition of this interval is still held by another attempt: the watermark must not pass it (#5). */
  unfinished: z.boolean().optional(),
});
type TeamPage = z.infer<typeof TeamPage>;
const LinearCursor = z.object({ watermark: z.string(), page: TeamPage.optional() });
export type LinearCursor = z.infer<typeof LinearCursor>;

/** The stored cursor; a pre-FIX-1 cursor (a bare ISO time) is the watermark. */
export function parseLinearCursor(raw: string | null): LinearCursor | null {
  if (!raw) return null;
  if (!raw.startsWith("{")) return Number.isNaN(Date.parse(raw)) ? null : { watermark: raw };
  try {
    const parsed = LinearCursor.safeParse(JSON.parse(raw));
    return parsed.success && !Number.isNaN(Date.parse(parsed.data.watermark)) ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Activity: transitions of the issues agents report as their task (every run, all of them), and with
 * `teams` of every issue of those teams updated in the interval (watermark − overlap, run start],
 * read page by page. The page reached is persisted; the watermark moves to the interval's end only
 * when every page of every team was read and handled.
 */
export function makeLinear(taskKeys: TaskKeys): Connector {
  return {
    id: "linear",
    name: "Linear",
    needsKey: true,
    async run(ctx: RunCtx): Promise<RunResult> {
      if (!ctx.key) throw new Error("linear: no API key configured");
      const backlinks = await drainBacklinks(ctx); // backlinks of issues created while their thread couldn't be posted to (FINAL Codex 6)
      if (ctx.settings.activity === false) return { posted: backlinks };
      const api: LinearApi = { fetch: ctx.fetch, key: ctx.key, secrets: ctx.secrets };
      const now = ctx.now();
      const stored = parseLinearCursor(ctx.state.cursor("linear"));
      const cur = stored ?? { watermark: new Date(now).toISOString() };
      const save = (next: LinearCursor) => ctx.state.setCursor("linear", JSON.stringify(next));
      if (!stored) save(cur);
      const cursorMs = Date.parse(cur.watermark);
      const channel = ctx.settings.channel ?? DEFAULTS.linear.channel;
      let posted = 0;
      /** A transition of this run is held by another attempt: no snapshot or watermark moves past it (#5). */
      let unfinished = false;

      /** Posts the new transitions of `issues`; false = the rate cap stopped it. */
      const handle = async (issues: readonly LinearIssue[], unseenSince: number): Promise<boolean> => {
        for (const partial of [...issues].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))) {
          const issue = await withFullHistory(api, partial, (n) => ctx.log.warn("linear_history_capped", { issue: partial.identifier, read: n }));
          const snap = ctx.state.snapshot(issue.id);
          let complete = true;
          for (const t of transitionsOf(issue, snap, unseenSince)) {
            if (ctx.state.posted("linear", t.ext)) continue;
            if (!ctx.take()) return false;
            if (!ctx.state.claim("linear", t.ext, ctx.now())) { complete = false; continue; } // a live claim: not ours to post
            try {
              await ctx.poster.deliver({ connector: "linear", channel, externalId: t.ext, text: formatTransition(t, issue) });
              posted++;
            } catch (err) {
              ctx.state.release("linear", t.ext);
              throw err;
            }
          }
          if (complete) ctx.state.setSnapshot({ issue_id: issue.id, key: issue.identifier, state_id: issue.state.id, state_name: issue.state.name, updated_at: issue.updatedAt, seen_at: ctx.now() });
          else unfinished = true;
          ctx.state.cacheLinear(issue.identifier, JSON.stringify(toInfo(issue)), ctx.now());
        }
        return true;
      };

      const keys = taskKeys().filter((k) => ISSUE_KEY_RE.test(k)).slice(0, 100);
      if (keys.length && !(await handle(await issuesByKeys(api, keys, true), cursorMs))) return { posted, capped: true };

      const teams = ctx.settings.teams ?? [];
      if (!teams.length) {
        // Task keys only: an issue first seen after this run reports only transitions after it. An
        // unfinished transition keeps the watermark, so it is still "after" the next time (#5).
        if (!unfinished && now > cursorMs) save({ watermark: new Date(now).toISOString() });
        return { posted };
      }
      // No overlap on the very first run: nothing from before the connector was enabled is reported.
      const overlap = stored ? LINEAR_OVERLAP_MS : 0;
      let page: TeamPage = cur.page ?? {
        since: new Date(Math.max(0, cursorMs - overlap)).toISOString(), until: new Date(Math.max(now, cursorMs)).toISOString(),
        done: [], team: null, after: null,
      };
      save({ watermark: cur.watermark, page });
      const sinceMs = Date.parse(page.since);
      let pages = 0;
      /** The page state with this run's unfinished flag folded in (it persists across runs). */
      const mark = (p: TeamPage): TeamPage => (unfinished && !p.unfinished ? { ...p, unfinished: true } : p);
      for (const team of teams) {
        if (page.done.includes(team)) continue;
        let after = page.team === team ? page.after : null;
        for (;;) {
          if (pages++ >= MAX_TEAM_PAGES_PER_RUN) { save({ watermark: cur.watermark, page: mark(page) }); return { posted }; } // continues from the persisted page
          const res = await teamIssuesPage(api, team, page.since, page.until, after);
          const ok = await handle(res.nodes, sinceMs);
          page = mark(page);
          if (!ok) { save({ watermark: cur.watermark, page }); return { posted, capped: true }; } // this page is re-read
          if (!res.next) break;
          after = res.next;
          page = { ...page, team, after };
          save({ watermark: cur.watermark, page });
        }
        page = { ...page, done: [...page.done, team], team: null, after: null };
        save({ watermark: cur.watermark, page });
      }
      // Every page of every team is done: the watermark moves to the interval's end, unless a
      // transition in it is still held by another attempt (the next run re-reads the interval, #5).
      save({ watermark: page.unfinished ? cur.watermark : page.until });
      return { posted };
    },
  };
}
