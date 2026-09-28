// Linear reads for the import (teams, projects, issues, workflow states, users) and the one write two-way sync makes
// (an issue's state). Every response is validated (zod), byte-capped and scrubbed of the key by `graphql()`
// (src/integrations/http.ts). Queries are named `WalkieImport*` so a fake Linear (tests) can answer by name.
import { z } from "zod";
import { graphql } from "../http.ts";
import { LINEAR_URL } from "../linear.ts";
import type { FetchLike } from "../types.ts";

export interface ImportApi {
  fetch: FetchLike; key: string;
  /** Every other credential the operation may have used (scrubbed from every response and error). */
  secrets?: () => readonly (string | null | undefined)[];
  /** Tests: another GraphQL endpoint. */
  url?: string;
  /** Aborted when the job is cancelled or the daemon stops. */
  signal?: AbortSignal;
}

/** Issues per page; a page with comments and history costs ~150 complexity points (measured 2026-09-27). */
export const ISSUE_PAGE = 50;
/** Pages read per query stream: 200 × 50 = 10 000 issues. */
export const MAX_PAGES = 200;

import { Id, LIssue, LProject, LState, LTeam, LUser, PageInfo } from "./schemas.ts";
export { LIssue, LProject, LState, LTeam, LUser };

function q<T>(api: ImportApi, query: string, variables: Record<string, unknown>, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  if (api.signal?.aborted) return Promise.reject(new Error("linear: cancelled"));
  const fetch: FetchLike = api.signal ? (url, init) => api.fetch(url, { ...init, signal: AbortSignal.any([api.signal as AbortSignal, ...(init?.signal ? [init.signal] : [])]) }) : api.fetch;
  return graphql({ fetch, url: api.url ?? LINEAR_URL, auth: api.key, service: "linear", query, variables, timeoutMs: 45_000, ...(api.secrets ? { secrets: api.secrets } : {}) }, schema);
}

/** Every node of a paged connection (at most MAX_PAGES pages). */
async function all<T>(api: ImportApi, query: string, variables: Record<string, unknown>, pick: (d: unknown) => { nodes: T[]; pageInfo: z.infer<typeof PageInfo> }, schema: z.ZodType<unknown, z.ZodTypeDef, unknown>, onPage?: (n: number) => void): Promise<T[]> {
  const out: T[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const conn = pick(await q(api, query, { ...variables, after }, schema));
    out.push(...conn.nodes);
    onPage?.(out.length);
    if (!conn.pageInfo.hasNextPage || !conn.pageInfo.endCursor) return out;
    after = conn.pageInfo.endCursor;
  }
  throw new Error(`linear: more than ${MAX_PAGES} pages; narrow the import (--projects, --team, --since)`);
}

const TeamsData = z.object({ teams: z.object({ nodes: z.array(LTeam).max(250), pageInfo: PageInfo }) });
export function teams(api: ImportApi): Promise<LTeam[]> {
  return all(api, `query WalkieImportTeams($after: String) { teams(first: 100, after: $after) { nodes { id key name } pageInfo { hasNextPage endCursor } } }`,
    {}, (d) => (d as z.infer<typeof TeamsData>).teams, TeamsData);
}

const ProjectsData = z.object({ projects: z.object({ nodes: z.array(LProject).max(100), pageInfo: PageInfo }) });
export function projects(api: ImportApi, opts: { initiatives?: boolean } = {}): Promise<LProject[]> {
  const init = opts.initiatives ? "initiatives(first: 1) { nodes { name } }" : "";
  return all(api, `query WalkieImportProjects($after: String) { projects(first: 50, after: $after) { nodes {
      id name state url description updatedAt completedAt canceledAt teams(first: 10) { nodes { id key name } } ${init}
    } pageInfo { hasNextPage endCursor } } }`, {}, (d) => (d as z.infer<typeof ProjectsData>).projects, ProjectsData);
}

const ISSUE_LITE = `id identifier title url priority estimate dueDate createdAt updatedAt completedAt canceledAt
  state { id name type } labels(first: 10) { nodes { name } } assignee { id name displayName email } parent { id identifier }
  project { id } team { id key name }`;
const ISSUE_FULL = `${ISSUE_LITE} description creator { name }
  comments(first: 20) { nodes { body createdAt user { name } } }
  history(first: 20) { nodes { createdAt actor { name } fromState { name } toState { name } fromAssignee { name } toAssignee { name } } }`;

export interface IssueFilterOpts {
  /** Linear project ids; "none" = issues without a project. */
  projectIds?: readonly string[] | "none";
  teamId?: string;
  includeClosed?: boolean;
  /** ISO: only issues updated after it. */
  since?: string;
  ids?: readonly string[];
}

/** Closed state types (not imported unless --include-closed). Linear's "duplicate" type counts as closed. */
export const CLOSED_TYPES = ["completed", "canceled", "duplicate"] as const;

export function issueFilter(o: IssueFilterOpts): Record<string, unknown> {
  return {
    ...(o.projectIds === "none" ? { project: { null: true } } : o.projectIds ? { project: { id: { in: [...o.projectIds] } } } : {}),
    ...(o.teamId ? { team: { id: { eq: o.teamId } } } : {}),
    ...(o.includeClosed ? {} : { state: { type: { nin: [...CLOSED_TYPES] } } }),
    ...(o.since ? { updatedAt: { gt: o.since } } : {}),
    ...(o.ids ? { id: { in: [...o.ids] } } : {}),
  };
}

const IssuesData = z.object({ issues: z.object({ nodes: z.array(LIssue).max(250), pageInfo: PageInfo }) });
/** Issues matching the filter; `full` adds description, creator, comments and history (the run; the plan reads less). */
export function issues(api: ImportApi, filter: IssueFilterOpts, opts: { full?: boolean; onPage?: (n: number) => void } = {}): Promise<LIssue[]> {
  return all(api, `query ${opts.full ? "WalkieImportIssuesFull" : "WalkieImportIssues"}($after: String, $filter: IssueFilter) {
      issues(first: ${ISSUE_PAGE}, after: $after, filter: $filter) { nodes { ${opts.full ? ISSUE_FULL : ISSUE_LITE} } pageInfo { hasNextPage endCursor } } }`,
  { filter: issueFilter(filter) }, (d) => (d as z.infer<typeof IssuesData>).issues, IssuesData, opts.onPage);
}

const StatesData = z.object({ workflowStates: z.object({ nodes: z.array(LState).max(250), pageInfo: PageInfo }) });
export function workflowStates(api: ImportApi): Promise<LState[]> {
  return all(api, `query WalkieImportStates($after: String) { workflowStates(first: 100, after: $after) { nodes { id name type position team { id key } } pageInfo { hasNextPage endCursor } } }`,
    {}, (d) => (d as z.infer<typeof StatesData>).workflowStates, StatesData);
}

const UsersData = z.object({ users: z.object({ nodes: z.array(LUser).max(250), pageInfo: PageInfo }) });
export function users(api: ImportApi): Promise<LUser[]> {
  return all(api, `query WalkieImportUsers($after: String) { users(first: 100, after: $after) { nodes { id name displayName email active } pageInfo { hasNextPage endCursor } } }`,
    {}, (d) => (d as z.infer<typeof UsersData>).users, UsersData);
}

const UpdateData = z.object({ issueUpdate: z.object({ success: z.boolean(), issue: z.object({ id: Id, updatedAt: z.string().max(40), state: z.object({ id: Id, name: z.string().max(200), type: z.string().max(40) }) }).nullish() }) });
/** Two-way sync's only write: the issue's workflow state. */
export async function setIssueState(api: ImportApi, issueId: string, stateId: string): Promise<{ updatedAt: string; state: { id: string; name: string; type: string } }> {
  const d = await q(api, `mutation WalkieImportSetState($id: String!, $stateId: String!) {
      issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { id updatedAt state { id name type } } } }`, { id: issueId, stateId }, UpdateData);
  if (!d.issueUpdate.success || !d.issueUpdate.issue) throw new Error("linear: issueUpdate did not succeed");
  return { updatedAt: d.issueUpdate.issue.updatedAt, state: d.issueUpdate.issue.state };
}
