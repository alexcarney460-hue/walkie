// Mock Linear import (LINEAR-IMPORT-1): a fictional Linear workspace planned with the real pure planner, an import job
// that progresses with time, sync passes and settings. Serves /v1/import/linear/* like the daemon. No Linear calls.
import { buildPlan, PlanOptions, type Plan, type Selection } from "../../src/integrations/linear-import/plan.ts";
import type { LIssue, LProject, LTeam } from "../../src/integrations/linear-import/schemas.ts";
import type { ImportStatus, JobView, SyncResult, SyncView } from "../../src/integrations/linear-import/views.ts";

const DAY = 86_400_000;
const T1: LTeam = { id: "t-web", key: "HAR", name: "Harbor" };
const T2: LTeam = { id: "t-plt", key: "PLT", name: "Platform" };

const PROJECTS: Array<[string, LTeam, string | null, number, Partial<LProject>]> = [
  ["Website relaunch", T1, "Growth", 34, {}],
  ["Pricing experiments", T1, "Growth", 12, {}],
  ["Onboarding emails", T1, "Growth", 9, { updatedAt: new Date(Date.now() - 140 * DAY).toISOString() }],
  ["Mobile app 2.0", T1, "Mobile", 41, {}],
  ["Public API", T2, "Reliability", 27, {}],
  ["Postgres 18 upgrade", T2, "Reliability", 15, {}],
  ["Status page", T2, "Reliability", 6, {}],
  ["Old CRM migration", T2, null, 4, { state: "completed", completedAt: new Date(Date.now() - 30 * DAY).toISOString() }],
];
const WORDS = ["checkout", "hero video", "rate limits", "webhooks", "SSO login", "billing export", "search index", "dark mode", "invoice PDFs", "audit log",
  "retry queue", "push notifications", "CSV import", "team roles", "usage meter", "sitemap", "cookie banner", "error pages", "API keys", "backups"];
const VERBS = ["Ship", "Fix", "Design", "Spec", "Test", "Migrate", "Add", "Polish"];
const STATES: Array<[string, string, number]> = [["Backlog", "backlog", 5], ["Todo", "unstarted", 5], ["In Progress", "started", 4], ["In Review", "started", 2]];

function workspace(): { projects: LProject[]; issues: LIssue[] } {
  const projects: LProject[] = [];
  const issues: LIssue[] = [];
  let n = 0;
  PROJECTS.forEach(([name, team, initiative, count, over], pi) => {
    const id = `proj-${pi + 1}`;
    projects.push({
      id, name, state: "started", url: `https://linear.app/harbor/project/${id}`, description: "", updatedAt: new Date(Date.now() - DAY).toISOString(),
      completedAt: null, canceledAt: null, teams: { nodes: [team] }, initiatives: { nodes: initiative ? [{ name: initiative }] : [] }, ...over,
    });
    for (let i = 0; i < count; i++) {
      n++;
      const pick = STATES.flatMap(([s, type, w]) => Array.from({ length: w }, () => [s, type] as const))[(n * 37 + i * 11 + pi * 5 + Math.floor(n / 3)) % 16] as readonly [string, string];
      const stale = pick[1] === "backlog" && i % 3 === 0;
      const base = (k: number) => `${VERBS[k % VERBS.length]} ${WORDS[(k * 3 + pi) % WORDS.length]}${k % 4 === 0 ? " for enterprise" : ""}`;
      const title = i === 6 ? `${base(n - 4)}!` : base(n); // the 7th issue of each project repeats the 3rd (a likely duplicate)
      issues.push({
        id: `iss-${n}`, identifier: `${team.key}-${100 + n}`, title, url: `https://linear.app/harbor/issue/${team.key}-${100 + n}`, priority: (n % 5), estimate: n % 3 ? n % 8 : null,
        dueDate: null, createdAt: new Date(Date.now() - (200 - n) * DAY / 2).toISOString(), updatedAt: new Date(Date.now() - (stale ? 120 : n % 20) * DAY).toISOString(),
        completedAt: null, canceledAt: null, state: { id: `st-${pick[0]}`, name: pick[0], type: pick[1] }, labels: { nodes: n % 4 ? [{ name: ["frontend", "backend", "design", "infra"][n % 4] as string }] : [] },
        assignee: n % 6 === 0 ? { id: "u-x", name: "Jonas Contractor", displayName: "jonas", email: "jonas@agency.example" } : n % 2 ? { id: "u-m", name: "Maren Okafor", displayName: "maren", email: "maren@harbor.example" } : null,
        parent: null, project: { id }, team,
      });
    }
  });
  // two issues without a project
  for (const t of ["Look into flaky deploys", "Customer asked about SAML"]) {
    n++;
    issues.push({ id: `iss-${n}`, identifier: `PLT-${100 + n}`, title: t, url: `https://linear.app/harbor/issue/PLT-${100 + n}`, priority: 0, estimate: null, dueDate: null,
      createdAt: new Date(Date.now() - 20 * DAY).toISOString(), updatedAt: new Date(Date.now() - 2 * DAY).toISOString(), completedAt: null, canceledAt: null,
      state: { id: "st-Todo", name: "Todo", type: "unstarted" }, labels: { nodes: [] }, assignee: null, parent: null, project: null, team: T2 });
  }
  return { projects, issues };
}

type Json = (d: unknown, s?: number) => Response;
type Fail = (s: number, c: string, m: string) => Response;

export class MockLinearImport {
  private job: (JobView & { cards: number[] }) | null = null;
  private sync: SyncView = { enabled: false, two_way: false, interval_min: 10, key: "integration", last_run: null, last_result: null, last_error: null, running: false };
  private readonly ws = workspace();

  /** The job as of now: one project every ~0.9 s, cards counted as they go. */
  private current(): JobView | null {
    const j = this.job;
    if (!j) return null;
    if (j.state !== "running") return j;
    const done = Math.min(j.projects_total, Math.floor((Date.now() - j.started_at) / 900));
    const created = j.cards.slice(0, done).reduce((a, b) => a + b, 0);
    const finished = done >= j.projects_total;
    const next: JobView & { cards: number[] } = {
      ...j, projects_done: done, created, comments: Math.round(created * 0.6), events: created + Math.round(created * 0.6) + done * 2,
      current: finished ? "" : j.projects[done]?.name ?? "", state: finished ? "done" : "running", finished_at: finished ? Date.now() : null,
    };
    if (finished) this.job = next;
    return next;
  }

  private status(): ImportStatus {
    const job = this.current();
    const { cards: _c, ...view } = (job ?? {}) as JobView & { cards?: number[] };
    return { job: job ? view : null, sync: this.sync, imported: { projects: job?.projects.length ?? 0, cards: job?.created ?? 0 }, integration: true };
  }

  plan(options: unknown): Plan {
    const o = PlanOptions.parse(options ?? {});
    return buildPlan({
      now: Date.now(), options: o, teams: [T1, T2], projects: this.ws.projects, issues: this.ws.issues,
      walkie: {
        members: [{ handle: "maren", login: "maren@harbor.example", display_name: "Maren Okafor" }, { handle: "kira", login: "kira@example.com" }],
        projects: [{ channel: "p-5eed0001", name: "Website relaunch (old board)", prefix: "WEB", state: "active" }],
        importedProjects: new Map(), importedIssues: new Map(), adopted: new Map(),
      },
    });
  }

  async handle(req: Request, path: string, json: Json, fail: Fail): Promise<Response | null> {
    if (!path.startsWith("/v1/import/linear/")) return null;
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
    switch (path) {
      case "/v1/import/linear/status": return json(this.status());
      case "/v1/import/linear/plan": {
        await Bun.sleep(700);
        return json({ plan: this.plan(body.options) });
      }
      case "/v1/import/linear/run": {
        const sel = body.selection as Selection | undefined;
        if (!sel) return fail(400, "invalid", "selection required");
        if (this.job && this.current()?.state === "running") return fail(409, "conflict", "an import is already running");
        const plan = this.plan(sel.options);
        const chosen = sel.projects.filter((p) => p.include);
        const cards = chosen.map((s) => (plan.projects.find((p) => p.key === s.key)?.issues.length ?? 0) - s.exclude.length);
        this.job = {
          id: "a1b2c3d4e5f6", state: "running", started_at: Date.now(), finished_at: null, current: chosen[0]?.name ?? "", projects_total: chosen.length, projects_done: 0,
          issues_total: cards.reduce((a, b) => a + b, 0), created: 0, updated: 0, unchanged: 0, comments: 0, skipped: 0, events: 0, waiting_until: null, errors: [],
          projects: chosen.map((s, i) => ({ key: s.key, channel: `p-5eed01${String(i).padStart(2, "0")}`, prefix: s.prefix ?? "LIN", name: s.name ?? s.key, created: true })),
          cards,
        };
        return json({ job: this.status().job }, 202);
      }
      case "/v1/import/linear/cancel": {
        if (this.job && this.current()?.state === "running") this.job = { ...(this.current() as JobView & { cards: number[] }), cards: this.job.cards, state: "cancelled", finished_at: Date.now() };
        return json({ job: this.status().job });
      }
      case "/v1/import/linear/sync": {
        const two = body.two_way === true || (body.two_way === undefined && this.sync.two_way);
        const result: SyncResult = { at: Date.now(), two_way: two, read: 14, created: 2, updated: 5, conflicts: 1, to_linear: two ? 3 : 0, errors: [] };
        this.sync = { ...this.sync, last_run: Date.now(), last_result: `read 14, created 2, updated 5, conflicts 1, to Linear ${result.to_linear}`, last_error: null };
        return json({ result });
      }
      case "/v1/import/linear/settings": {
        this.sync = {
          ...this.sync, ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}), ...(typeof body.two_way === "boolean" ? { two_way: body.two_way } : {}),
          ...(typeof body.interval_min === "number" ? { interval_min: body.interval_min } : {}),
        };
        return json({ sync: this.sync });
      }
      default: return fail(404, "not_found", `no route ${path}`);
    }
  }
}
