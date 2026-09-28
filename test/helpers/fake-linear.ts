// A fake Linear GraphQL API for the import (LINEAR-IMPORT-1): answers the `WalkieImport*` operations from an in-memory
// workspace with Linear's filter and cursor semantics (the subset the importer uses), over real HTTP (`serve()`) or as
// a FetchLike. Every request is recorded (operation, auth header, variables). All content is fictional.
import type { FetchLike } from "../../src/integrations/types.ts";

export interface FTeam { id: string; key: string; name: string }
export interface FState { id: string; name: string; type: string; position: number; team: { id: string; key: string } }
export interface FProject {
  id: string; name: string; state: string; url: string; description: string; updatedAt: string; completedAt: string | null; canceledAt: string | null;
  teams: { nodes: FTeam[] }; initiatives: { nodes: Array<{ name: string }> };
}
export interface FIssue {
  id: string; identifier: string; title: string; url: string; description: string; priority: number; estimate: number | null; dueDate: string | null;
  createdAt: string; updatedAt: string; completedAt: string | null; canceledAt: string | null;
  state: { id: string; name: string; type: string };
  labels: { nodes: Array<{ name: string }> };
  assignee: { id: string; name: string; displayName: string; email: string } | null;
  creator: { name: string } | null;
  parent: { id: string; identifier: string } | null;
  project: { id: string } | null;
  team: FTeam;
  comments: { nodes: Array<{ body: string; createdAt: string; user: { name: string } | null }> };
  history: { nodes: Array<{ createdAt: string; actor: { name: string } | null; fromState: { name: string } | null; toState: { name: string } | null; fromAssignee: null; toAssignee: null }> };
}
export interface Call { op: string; auth: string | null; variables: Record<string, unknown> }

const STATE_DEFS: Array<[string, string, number]> = [
  ["Backlog", "backlog", 0], ["Todo", "unstarted", 1], ["In Progress", "started", 2], ["In Review", "started", 3],
  ["Done", "completed", 4], ["Canceled", "canceled", 5], ["Duplicate", "duplicate", 6],
];

export class FakeLinear {
  readonly calls: Call[] = [];
  teams: FTeam[] = [];
  states: FState[] = [];
  projects: FProject[] = [];
  issues: FIssue[] = [];
  users = [
    { id: "u-maren", name: "Maren Okafor", displayName: "maren", email: "maren@kestrel.example", active: true },
    { id: "u-kira", name: "Kira Rowe", displayName: "kira", email: "kira@example.com", active: true },
    { id: "u-ghost", name: "Ghost Contractor", displayName: "ghost", email: "ghost@elsewhere.example", active: true },
  ];
  /** Every response carries this in a field when set (a hostile upstream echoing the key, for scrub tests). */
  echoAuth = false;
  /** Answer every call with this HTTP status. */
  failWith: number | null = null;
  /** Requests of this operation whose variables match `gateWhen` wait for `gate` (a barrier: interrupt a job mid-way). */
  gateOp: string | null = null;
  gateWhen: ((v: Record<string, unknown>) => boolean) | null = null;
  gate: Promise<void> | null = null;
  onGate: (() => void) | null = null;
  /** Linear's clock: an hour ago at start; a change is never earlier than the real clock (the importer compares with it). */
  private clock = Date.now() - 3_600_000;
  private server: ReturnType<typeof Bun.serve> | null = null;

  constructor(readonly workspace = "kestrel") {}

  tick(ms = 60_000): string { this.clock = Math.max(this.clock + ms, Date.now()); return new Date(this.clock).toISOString(); }
  now(): string { return new Date(this.clock).toISOString(); }
  setNow(iso: string): void { this.clock = Date.parse(iso); }

  team(key: string, name: string): FTeam {
    const t = { id: `team-${key.toLowerCase()}`, key, name };
    this.teams.push(t);
    for (const [n, type, position] of STATE_DEFS) this.states.push({ id: `st-${key.toLowerCase()}-${n.toLowerCase().replace(/\s+/g, "-")}`, name: n, type, position, team: { id: t.id, key } });
    return t;
  }

  stateOf(team: FTeam, name: string): { id: string; name: string; type: string } {
    const s = this.states.find((x) => x.team.id === team.id && x.name === name);
    if (!s) throw new Error(`no state ${name}`);
    return { id: s.id, name: s.name, type: s.type };
  }

  project(team: FTeam, name: string, over: Partial<FProject> = {}): FProject {
    const id = `proj-${this.projects.length + 1}`;
    const p: FProject = {
      id, name, state: "started", url: `https://linear.app/${this.workspace}/project/${id}`, description: `The ${name} project.`, updatedAt: this.now(),
      completedAt: null, canceledAt: null, teams: { nodes: [team] }, initiatives: { nodes: [] }, ...over,
    };
    this.projects.push(p);
    return p;
  }

  issue(team: FTeam, project: FProject | null, title: string, state: string, over: Partial<FIssue> = {}): FIssue {
    const n = this.issues.filter((i) => i.team.id === team.id).length + 1;
    const identifier = `${team.key}-${n}`;
    const i: FIssue = {
      id: `iss-${team.key.toLowerCase()}-${n}`, identifier, title, url: `https://linear.app/${this.workspace}/issue/${identifier}`,
      description: `Fictional description of ${identifier}.`, priority: 0, estimate: null, dueDate: null,
      createdAt: this.tick(1_000), updatedAt: this.now(), completedAt: null, canceledAt: null, state: this.stateOf(team, state),
      labels: { nodes: [] }, assignee: null, creator: { name: "Maren Okafor" }, parent: null, project: project ? { id: project.id } : null, team,
      comments: { nodes: [] }, history: { nodes: [] }, ...over,
    };
    this.issues.push(i);
    return i;
  }

  /** A change made in Linear (updatedAt moves). */
  update(identifier: string, change: (i: FIssue) => Partial<FIssue>): FIssue {
    const i = this.issues.find((x) => x.identifier === identifier);
    if (!i) throw new Error(`no issue ${identifier}`);
    Object.assign(i, change(i), { updatedAt: this.tick(1_000) });
    return i;
  }

  move(identifier: string, state: string): FIssue {
    return this.update(identifier, (i) => ({ state: this.stateOf(i.team, state) }));
  }

  count(op: string): number { return this.calls.filter((c) => c.op === op).length; }

  private matches(i: FIssue, f: Record<string, any>): boolean {
    if (f.project?.null === true && i.project) return false;
    if (f.project?.id?.in && !(i.project && f.project.id.in.includes(i.project.id))) return false;
    if (f.team?.id?.eq && i.team.id !== f.team.id.eq) return false;
    if (f.state?.type?.nin && f.state.type.nin.includes(i.state.type)) return false;
    if (f.updatedAt?.gt && !(i.updatedAt > f.updatedAt.gt)) return false;
    if (f.id?.in && !f.id.in.includes(i.id)) return false;
    return true;
  }

  private page<T>(all: T[], first: number, after: unknown): { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
    const start = typeof after === "string" ? Number(after) : 0;
    const nodes = all.slice(start, start + first);
    const end = start + nodes.length;
    return { nodes, pageInfo: { hasNextPage: end < all.length, endCursor: end < all.length ? String(end) : null } };
  }

  answer(query: string, variables: Record<string, any>): unknown {
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "anonymous";
    const first = Number(/\(first:\s*(\d+)/.exec(query)?.[1] ?? 50);
    const full = op === "WalkieImportIssuesFull";
    switch (op) {
      case "WalkieImportTeams": return { teams: this.page(this.teams, first, variables.after) };
      case "WalkieImportProjects": {
        const withInit = /initiatives/.test(query);
        const ps = this.projects.map((p) => { const { initiatives, ...rest } = p; return withInit ? { ...rest, initiatives } : rest; });
        return { projects: this.page(ps, first, variables.after) };
      }
      case "WalkieImportIssues": case "WalkieImportIssuesFull": {
        const f = (variables.filter ?? {}) as Record<string, unknown>;
        const list = this.issues.filter((i) => this.matches(i, f)).map((i) => {
          if (full) return i;
          const { description: _d, creator: _c, comments: _m, history: _h, ...lite } = i;
          return lite;
        });
        return { issues: this.page(list, first, variables.after) };
      }
      case "WalkieImportStates": return { workflowStates: this.page(this.states, first, variables.after) };
      case "WalkieImportUsers": return { users: this.page(this.users, first, variables.after) };
      case "WalkieImportSetState": {
        const i = this.issues.find((x) => x.id === variables.id);
        const s = this.states.find((x) => x.id === variables.stateId);
        if (!i || !s || s.team.id !== i.team.id) return { issueUpdate: { success: false, issue: null } };
        i.state = { id: s.id, name: s.name, type: s.type };
        i.updatedAt = this.tick(1_000);
        return { issueUpdate: { success: true, issue: { id: i.id, updatedAt: i.updatedAt, state: i.state } } };
      }
      default: throw new Error(`fake Linear: unknown operation ${op}`);
    }
  }

  private async respond(body: string, auth: string | null): Promise<Response> {
    const b = JSON.parse(body) as { query: string; variables?: Record<string, unknown> };
    const op = /(?:query|mutation)\s+(\w+)/.exec(b.query)?.[1] ?? "anonymous";
    this.calls.push({ op, auth, variables: b.variables ?? {} });
    if (this.gate && op === this.gateOp && (!this.gateWhen || this.gateWhen(b.variables ?? {}))) { this.onGate?.(); await this.gate; }
    if (this.failWith) return new Response(JSON.stringify({ errors: [{ message: `denied for ${auth}` }] }), { status: this.failWith, headers: { "Content-Type": "application/json" } });
    try {
      const data = this.answer(b.query, b.variables ?? {});
      if (this.echoAuth && auth) return Response.json({ data, errors: [{ message: `saw ${auth}` }] });
      return Response.json({ data });
    } catch (err) {
      return Response.json({ errors: [{ message: (err as Error).message }] }, { status: 400 });
    }
  }

  readonly fetch: FetchLike = async (_url, init) => {
    const headers = new Headers(init?.headers);
    return this.respond(String(init?.body ?? "{}"), headers.get("authorization"));
  };

  /** A real HTTP endpoint (the daemon's own fetch talks to it: `linearImport.url`). */
  serve(): string {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => this.respond(await req.text(), req.headers.get("authorization")) });
    return `http://127.0.0.1:${this.server.port}/graphql`;
  }

  stop(): void { void this.server?.stop(true); this.server = null; }
}
