// LINEAR-IMPORT-1: the dry-run plan (pure): scope filters, targets, prefixes, relevance flags, defaults, the selection
// the run takes, and the readable table.
import { describe, expect, test } from "bun:test";
import type { LIssue, LProject, LTeam } from "../../src/integrations/linear-import/api.ts";
import { buildPlan, PlanOptions, planTable, Selection, selectionOf, type WalkieSide } from "../../src/integrations/linear-import/plan.ts";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const DAY = 86_400_000;
const T: LTeam = { id: "t1", key: "KES", name: "Kestrel" };
const T2: LTeam = { id: "t2", key: "OPS", name: "Operations" };

function proj(id: string, name: string, over: Partial<LProject> = {}): LProject {
  return { id, name, state: "started", url: `https://linear.app/k/project/${id}`, description: "", updatedAt: new Date(NOW - DAY).toISOString(), completedAt: null, canceledAt: null, teams: { nodes: [T] }, initiatives: { nodes: [] }, ...over };
}
let n = 0;
function iss(project: string | null, title: string, type = "unstarted", over: Partial<LIssue> = {}): LIssue {
  n++;
  return {
    id: `i${n}`, identifier: `KES-${n}`, title, url: `https://linear.app/k/issue/KES-${n}`, priority: 0, estimate: null, dueDate: null,
    createdAt: new Date(NOW - 100 * DAY + n * 1000).toISOString(), updatedAt: new Date(NOW - DAY).toISOString(), completedAt: null, canceledAt: null,
    state: { id: `s-${type}`, name: type === "started" ? "In Progress" : type, type }, labels: { nodes: [] }, assignee: null, parent: null,
    project: project ? { id: project } : null, team: T, ...over,
  };
}
const empty: WalkieSide = { members: [{ handle: "alex", login: "alex@example.com" }], projects: [], importedProjects: new Map(), importedIssues: new Map(), adopted: new Map() };
const opts = (o: Partial<PlanOptions> = {}) => PlanOptions.parse(o);

describe("plan", () => {
  test("scope, defaults and flags", () => {
    const projects = [proj("p1", "Website relaunch"), proj("p2", "Old CRM", { state: "completed", completedAt: new Date(NOW).toISOString() }),
      proj("p3", "Dormant", { updatedAt: new Date(NOW - 200 * DAY).toISOString() }), proj("p4", "Nothing open"), proj("p5", "Scrapped", { canceledAt: new Date(NOW).toISOString() })];
    const issues = [
      iss("p1", "Hero video", "backlog", { updatedAt: new Date(NOW - 90 * DAY).toISOString() }),
      iss("p1", "Hero  video!", "backlog"),
      iss("p1", "Checkout", "started", { assignee: { id: "u", name: "Ghost Contractor", displayName: "ghost", email: "g@x" } }),
      iss("p1", "Review me", "started", { state: { id: "s", name: "In Review", type: "started" }, assignee: { id: "a", name: "A", displayName: "a", email: "alex@example.com" } }),
      iss("p2", "CRM leftover"), iss("p3", "Old thing", "backlog"), iss(null, "Loose"),
      iss("p5", "Nope"),
    ];
    const plan = buildPlan({ now: NOW, options: opts(), teams: [T], projects, issues, walkie: empty });
    const by = (name: string) => plan.projects.find((p) => p.name === name)!;
    expect(by("Website relaunch").include).toBe(true);
    expect(by("Website relaunch").counts).toEqual({ backlog: 2, todo: 0, doing: 1, review: 1, done: 0, canceled: 0 });
    expect(by("Website relaunch").issues[0]!.flags).toContain("stale");
    expect(by("Website relaunch").issues[1]!.flags).toContain("duplicate_of:KES-1");
    expect(by("Website relaunch").issues[3]!.assignee).toBe("alex");
    expect(by("Old CRM")).toMatchObject({ include: false, state: "completed" });
    expect(by("Old CRM").flags).toContain("completed");
    expect(by("Scrapped").include).toBe(false);
    expect(by("Dormant").flags).toContain("stale");
    expect(by("Dormant").include).toBe(true);
    expect(by("Nothing open")).toMatchObject({ include: false });
    expect(by("Nothing open").flags).toContain("empty");
    expect(by("Kestrel: no project").flags).toContain("no_project");
    expect(plan.unmapped_users).toEqual(["Ghost Contractor"]);
    expect(plan.totals.included_issues).toBe(6); // Website 4 + Dormant 1 + Loose 1
    expect(plan.totals.creates).toBe(6);
    expect(plan.totals.flagged.stale).toBe(1);
    expect(new Set(plan.projects.map((p) => p.prefix)).size).toBe(plan.projects.length);
  });

  test("--skip-stale and --skip-duplicates untick; --since drops old issues; --team and --projects scope", () => {
    const projects = [proj("p1", "Web"), proj("q1", "Ops board", { teams: { nodes: [T2] } })];
    const old = iss("p1", "Old one", "backlog", { updatedAt: new Date(NOW - 100 * DAY).toISOString() });
    const issues = [old, iss("p1", "Dup"), iss("p1", "dup"), iss("q1", "Ops thing", "unstarted", { team: T2 })];
    const skip = buildPlan({ now: NOW, options: opts({ skip_stale: true, skip_duplicates: true }), teams: [T, T2], projects, issues, walkie: empty });
    const web = skip.projects.find((p) => p.name === "Web")!;
    expect(web.issues.map((i) => i.include)).toEqual([false, true, false]);
    const since = buildPlan({ now: NOW, options: opts({ since: "30d" }), teams: [T, T2], projects, issues, walkie: empty });
    expect(since.projects.find((p) => p.name === "Web")!.issues.map((i) => i.title)).toEqual(["Dup", "dup"]);
    const ops = buildPlan({ now: NOW, options: opts({ team: "ops" }), teams: [T, T2], projects, issues, walkie: empty });
    expect(ops.projects.map((p) => p.name).sort()).toEqual(["Operations: no project", "Ops board"]);
    const only = buildPlan({ now: NOW, options: opts({ projects: ["web", "none"] }), teams: [T, T2], projects, issues, walkie: empty });
    expect(only.projects.map((p) => p.name).sort()).toEqual(["Kestrel: no project", "Operations: no project", "Web"]);
    expect(() => buildPlan({ now: NOW, options: opts({ team: "NOPE" }), teams: [T], projects, issues, walkie: empty })).toThrow("no Linear team");
  });

  test("targets: imported before (exists), adopted from an earlier import, name taken; prefixes avoid existing ones", () => {
    const projects = [proj("p1", "Walkie"), proj("p2", "Sequence platform"), proj("p3", "Website relaunch")];
    const a = iss("p1", "Import"), b = iss("p2", "Billing"), c = iss("p2", "Rails"), d = iss("p3", "Hero");
    const walkie: WalkieSide = {
      ...empty,
      projects: [{ channel: "p-00000001", name: "Walkie", prefix: "WALK", state: "active" }, { channel: "p-00000002", name: "sequence platform", prefix: "SP", state: "active" },
        { channel: "p-00000003", name: "Other", prefix: "WR", state: "active" }],
      importedProjects: new Map([["p1", "p-00000001"]]),
      importedIssues: new Map([[a.id, { card: "c1", key: "WALK-1", channel: "p-00000001" }]]),
      adopted: new Map([[b.identifier, { card: "c2", key: "SP-4", channel: "p-00000002" }], [c.identifier, { card: "c3", key: "SP-5", channel: "p-00000002" }]]),
    };
    const plan = buildPlan({ now: NOW, options: opts(), teams: [T], projects, issues: [a, b, c, d], walkie });
    const by = (name: string) => plan.projects.find((p) => p.name === name)!;
    expect(by("Walkie")).toMatchObject({ target: { channel: "p-00000001", prefix: "WALK" }, prefix: "WALK" });
    expect(by("Walkie").flags).toContain("exists");
    expect(by("Walkie").issues[0]).toMatchObject({ existing: { card: "c1" }, flags: ["imported"] });
    expect(by("Sequence platform")).toMatchObject({ target: { channel: "p-00000002", prefix: "SP" } });
    expect(by("Sequence platform").flags).toContain("adopt:2");
    expect(by("Website relaunch").prefix).toBe("WR2");
    expect(plan.totals).toMatchObject({ creates: 1, updates: 3 });
  });

  test("over the open-card cap per board is flagged", () => {
    const many = Array.from({ length: 2_001 }, (_, i) => iss("p1", `Card ${i} ${"w".repeat(i % 7)}`));
    const plan = buildPlan({ now: NOW, options: opts(), teams: [T], projects: [proj("p1", "Huge")], issues: many, walkie: empty });
    expect(plan.projects.find((p) => p.name === "Huge")!.flags).toContain("over_board_cap");
  });

  test("the selection is what the person left ticked; an edited plan parses; the table reads", () => {
    const plan = buildPlan({ now: NOW, options: opts(), teams: [T], projects: [proj("p1", "Web"), proj("p2", "Api")], issues: [iss("p1", "A"), iss("p1", "B"), iss("p2", "C")], walkie: empty });
    const edited = { ...plan, projects: plan.projects.map((p) => (p.name === "Api" ? { ...p, include: false } : { ...p, prefix: "WEBX", issues: p.issues.map((i, j) => ({ ...i, include: j !== 0 })) })) };
    const sel = Selection.parse(JSON.parse(JSON.stringify(selectionOf(edited))));
    expect(sel.projects.find((p) => p.name === "Api")!.include).toBe(false);
    const web = sel.projects.find((p) => p.name === "Web")!;
    expect(web.prefix).toBe("WEBX");
    expect(web.exclude.length).toBe(1);
    const table = planTable(plan);
    expect(table).toContain("[x] ");
    expect(table).toMatch(/projects, 3\/3 issues \(3 new cards, 0 updates\)/);
    expect(() => Selection.parse({ ...sel, projects: [{ ...web, prefix: "bad prefix" }] })).toThrow();
  });
});
