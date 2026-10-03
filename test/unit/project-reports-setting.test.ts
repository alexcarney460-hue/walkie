// PROJECT-REPORTS-1: the `status_report` project setting. The schema and fold (a not-strict project op field, so an older
// peer drops it and keeps the rest), who may set it (owners and the project's creator, people only; an observer, another
// member and an agent are refused with a plain reason), the stored view an older fold left behind, and the route guard.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { FOLD_VERSION, ProjectsIndex } from "../../src/daemon/projects/index.ts";
import "../../src/daemon/projects/routes.ts";
import { updateProject, type WriteCtx } from "../../src/daemon/projects/service.ts";
import { foldProject, refOf, type OpEvent } from "../../src/protocol/projects/fold.ts";
import { DEFAULT_COLUMNS, PROJECT_FIELDS, ProjectOp, type ProjectView } from "../../src/protocol/projects/schema.ts";
import { reportMode, statusReportDenial } from "../../src/protocol/projects/status-report.ts";
import type { BodyOf } from "../../src/protocol/schemas.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, ev as signed, memberEv, nodeEv, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const CH = "p-5e7a7e01";

// ---- schema and fold ----------------------------------------------------------------------------------------------

const hashOf = (id: string) => createHash("sha256").update(`sig-${id}`).digest("hex").slice(0, 16);
let seq = 0;
function op(handle: string, board: unknown, opts: { thread?: string; agent?: string } = {}): OpEvent {
  seq++;
  const origin = "a000000000000001";
  const id = `${origin}:${seq}`;
  return {
    id, origin, seq, ts: 1_700_000_000_000 + seq * 1000, h: hashOf(id), author: { handle, node: origin, ...(opts.agent ? { agent: opts.agent } : {}) },
    ...(opts.thread ? { thread: opts.thread } : {}), text: "op", board,
  };
}

describe("schema and fold", () => {
  const env = { creator: "alex", roleOf: (e: OpEvent) => ({ alex: "owner", kira: "member", bob: "observer" } as const)[e.author.handle as "alex" | "kira" | "bob"] ?? null };
  const root = () => op("alex", { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB" });
  const set = (r: OpEvent, who: string, value: string, extra: { agent?: string } = {}) =>
    op(who, { v: 1, rev: 1, op: "project", after: refOf(r), status_report: value }, { thread: r.id, ...extra });

  test("the field takes hourly or off, and is a project setting listed with the others", () => {
    expect(ProjectOp.safeParse({ v: 1, rev: 1, op: "project", status_report: "hourly" }).success).toBe(true);
    expect(ProjectOp.safeParse({ v: 1, rev: 1, op: "project", status_report: "off" }).success).toBe(true);
    expect(ProjectOp.safeParse({ v: 1, rev: 1, op: "project", status_report: "daily" }).success).toBe(false);
    expect(PROJECT_FIELDS).toContain("status_report");
  });

  test("a project reads off until an admin sets it; the last writer wins; it clears again", () => {
    const r = root();
    expect(foldProject([r], env)?.status_report).toBe("off");
    const on = set(r, "alex", "hourly");
    expect(foldProject([r, on], env)?.status_report).toBe("hourly");
    const off = op("alex", { v: 1, rev: 2, op: "project", after: refOf(on), status_report: "off" }, { thread: r.id });
    expect(foldProject([r, on, off], env)?.status_report).toBe("off");
  });

  test("a project's creator who is a member may set it; another member, an observer and an agent are ignored", () => {
    const r = op("kira", { v: 1, rev: 0, op: "project", name: "Kira's", prefix: "KIR" });
    const kira = { creator: "kira", roleOf: env.roleOf };
    expect(foldProject([r, set(r, "kira", "hourly")], kira)?.status_report).toBe("hourly");
    const mine = root();
    const other = set(mine, "kira", "hourly");
    const watcher = set(mine, "bob", "hourly");
    const agent = set(mine, "alex", "hourly", { agent: "cc-1" });
    const folded = foldProject([mine, other, watcher, agent], env);
    expect(folded?.status_report).toBe("off");
    expect(folded?.timeline.filter((t) => t.ignored).map((t) => t.ignored)).toEqual(["not_admin", "not_admin", "not_admin"]);
  });

  test("a project root signed by an agent cannot carry the setting: it reads off, whoever the creator is; a person's root can", () => {
    const body = { v: 1, rev: 0, op: "project", name: "Sneaky", prefix: "SNK", status_report: "hourly" };
    const byAgent = op("alex", body, { agent: "cc-evil" });
    expect(foldProject([byAgent], env)?.status_report).toBe("off");
    expect(foldProject([byAgent], { creator: null, roleOf: () => "member" as const })?.status_report).toBe("off");
    // The rest of such a root is still the project (an agent may create one): only the setting is not its to carry.
    expect(foldProject([byAgent], env)).toMatchObject({ name: "Sneaky", prefix: "SNK", creator: "alex" });
    expect(foldProject([op("alex", body)], env)?.status_report).toBe("hourly");
    // An owner, as a person, can still turn it on afterwards.
    expect(foldProject([byAgent, set(byAgent, "alex", "hourly")], env)?.status_report).toBe("hourly");
    // An owner's other agent still cannot.
    expect(foldProject([byAgent, set(byAgent, "alex", "hourly", { agent: "cc-1" })], env)?.status_report).toBe("off");
  });

  test("an older schema drops the field and keeps the op's other fields; the project folds to the same name", () => {
    const settings = { v: 1, rev: 1, op: "project", status_report: "hourly", name: "Renamed" };
    const before = ProjectOp.omit({ status_report: true }).safeParse(settings);
    expect(before.success && before.data).toEqual({ v: 1, rev: 1, op: "project", name: "Renamed" });
    const r = root();
    const both = op("alex", { ...settings, after: refOf(r) }, { thread: r.id });
    const p = foldProject([r, both], env);
    expect([p?.status_report, p?.name]).toEqual(["hourly", "Renamed"]);
  });

  test("reportMode treats a view stored before the field existed as off", () => {
    expect(reportMode({ status_report: "hourly" })).toBe("hourly");
    expect(reportMode({ status_report: "off" })).toBe("off");
    expect(reportMode({})).toBe("off");
  });
});

describe("who may set it", () => {
  test("owners, and a creator who is still a member; nobody else, with a plain reason", () => {
    expect(statusReportDenial("owner", "alex", "kira")).toBeNull();
    expect(statusReportDenial("member", "kira", "kira")).toBeNull();
    expect(statusReportDenial("member", "bob", "kira")).toBe("only the project's creator or an owner can turn its status report on or off");
    expect(statusReportDenial("observer", "kira", "kira")).toBe("observers can't change a project's status report");
    expect(statusReportDenial("observer", "bob", "kira")).toBe("observers can't change a project's status report");
    expect(statusReportDenial(null, null, "kira")).toBe("only the project's creator or an owner can turn its status report on or off");
  });
});

// ---- the daemon: service, upgrade, route --------------------------------------------------------------------------

function world(role: "owner" | "member" | "observer" = "owner") {
  const alex = tnode("alex"), dave = tnode("dave");
  const { team, create } = createTeam(alex);
  const channel = signed(team, alex, "channel.upsert", { name: CH, project: true });
  const root = signed(team, alex, "msg.post", { text: "Project", board: { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB" } } as BodyOf<"msg.post">, { channel: CH });
  const board = signed(team, alex, "msg.post", { text: "Board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } } as BodyOf<"msg.post">, { channel: CH });
  // The core is alex's own (owner, the project's creator and the roster authority) or dave's (a member or an observer).
  const self = role === "owner" ? alex : dave;
  const core = makeCore(self, team, cleanups);
  const idx = new ProjectsIndex(core, createLogger({}));
  cleanups.push(() => idx.stop());
  core.onPostChange = (e, change) => idx.onPost(e, change);
  core.onRosterChange = () => idx.rosterChanged();
  const events = role === "owner"
    ? [create, channel, root, board]
    : [create, memberEv(team, alex, dave, role), nodeEv(team, alex, dave), channel, root, board];
  if (role === "owner") for (const e of events) core.ingest(e, "local"); else feed(core, events);
  idx.flushAll();
  const w: WriteCtx = { core, idx, client: {} as WriteCtx["client"], catchUp: async () => {} };
  return { core, idx, w };
}

describe("the service", () => {
  test("the owner turns it on and off; the view and the project's own post say so", async () => {
    const { w, idx } = world();
    expect(idx.project(CH)?.status_report).toBe("off");
    const on = await updateProject(w, CH, { status_report: "hourly" });
    expect(on.status_report).toBe("hourly");
    expect(idx.project(CH)?.status_report).toBe("hourly");
    const last = w.core.store.queryEvents({ channel: CH, kinds: ["msg.post"], limit: 1 })[0];
    expect(JSON.parse(last?.json ?? "{}").body.text).toBe('Project "Website" status report turned on');
    expect((await updateProject(w, CH, { status_report: "off" })).status_report).toBe("off");
    const again = w.core.store.queryEvents({ channel: CH, kinds: ["msg.post"], limit: 1 })[0];
    expect(JSON.parse(again?.json ?? "{}").body.text).toBe('Project "Website" status report turned off');
  });

  test("another member is refused, and an observer is refused with its own reason", async () => {
    await expect(updateProject(world("member").w, CH, { status_report: "hourly" }))
      .rejects.toMatchObject({ status: 403, message: "only the project's creator or an owner can turn its status report on or off" });
    await expect(updateProject(world("observer").w, CH, { status_report: "hourly" }))
      .rejects.toMatchObject({ status: 403, message: "observers can't change a project's status report" });
  });

  test("an agent is refused: the switch is a person's", () => {
    const { w, idx } = world();
    // requirePerson answers before the work is queued: the call throws instead of returning a rejected promise.
    expect(() => updateProject({ ...w, agent: "cc-1" }, CH, { status_report: "hourly" })).toThrow("people only");
    expect(idx.project(CH)?.status_report).toBe("off");
  });
});

describe("a view stored before the field existed", () => {
  test("it reads as off, and the fold-version bump re-folds the log so a setting made meanwhile shows", async () => {
    expect(FOLD_VERSION).toBe("13");
    const { w, core, idx } = world();
    await updateProject(w, CH, { status_report: "hourly" });
    idx.flushAll();
    // What an older daemon stored: the view without the field, under the previous fold version.
    const { status_report: _gone, ...old } = idx.project(CH) as ProjectView;
    idx.db.saveProject(CH, old.id, JSON.stringify(old), old.last_activity);
    core.store.setMeta("projects_fold", "10");
    expect(reportMode(idx.project(CH) as ProjectView)).toBe("off");
    idx.start();
    idx.flushAll();
    expect(idx.project(CH)?.status_report).toBe("hourly");
  });
});

describe("the route", () => {
  function request(h: ReturnType<typeof world>, agent: string | undefined, body: unknown) {
    const req = new Request(`http://localhost/v1/projects/${CH}`, { method: "POST", body: JSON.stringify(body) });
    return dispatch({ core: h.core, sync: { requestCatchUp: async () => {} }, client: {}, req, url: new URL(req.url), agent, via: "cli", listener: "unix",
      projects: h.idx, noTimeout: () => {}, orchestratorToken: agent === "orchestrator" ? "valid" : undefined } as unknown as RouteCtx);
  }

  test("a person sets it; the project's reply carries it; an unknown value is a 400", async () => {
    const h = world();
    const res = await request(h, undefined, { status_report: "hourly" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { project: ProjectView }).project.status_report).toBe("hourly");
    await expect(request(h, undefined, { status_report: "daily" })).rejects.toMatchObject({ status: 400 });
  });

  test("an agent is refused before the agent-admin gate, WalkieTalkie included, and nothing is written", async () => {
    const h = world();
    registerHost(h.core, { acceptsToken: () => true } as unknown as OrchestratorHost);
    const before = h.core.store.allocatedSelfSeq(h.core.nodeId);
    for (const agent of ["cc-1", "orchestrator"]) {
      await expect(request(h, agent, { status_report: "hourly" })).rejects.toMatchObject({ status: 403, message: expect.stringContaining("people only") });
    }
    expect(h.core.store.allocatedSelfSeq(h.core.nodeId)).toBe(before);
    expect(h.idx.project(CH)?.status_report).toBe("off");
  });
});
