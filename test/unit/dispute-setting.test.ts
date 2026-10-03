// WALK-73: the optional `escalation_contact` project setting. A not-strict field, so an older peer drops it and keeps
// the op's other fields. Owners and the project's creator set it, as people; an observer, another member and an agent
// are refused. A view stored before the field existed is re-folded once (fold version 13).
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { FOLD_VERSION, ProjectsIndex } from "../../src/daemon/projects/index.ts";
import "../../src/daemon/projects/routes.ts";
import { updateProject, type WriteCtx } from "../../src/daemon/projects/service.ts";
import { escalationContactDenial, escalationContactOf } from "../../src/protocol/projects/escalation.ts";
import { settingsHeadState } from "../../src/protocol/projects/dispute.ts";
import { foldProject, refOf, type OpEvent } from "../../src/protocol/projects/fold.ts";
import { DEFAULT_COLUMNS, PROJECT_FIELDS, ProjectOp, type ProjectView } from "../../src/protocol/projects/schema.ts";
import type { BodyOf } from "../../src/protocol/schemas.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, ev as signed, memberEv, nodeEv, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const CH = "p-5e7a7e01";

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
  const set = (r: OpEvent, who: string, value: string | null, extra: { agent?: string; after?: string } = {}) =>
    op(who, { v: 1, rev: 1, op: "project", after: extra.after ?? refOf(r), escalation_contact: value }, { thread: r.id, ...(extra.agent ? { agent: extra.agent } : {}) });

  test("the field is an optional person address or null, listed with the other project settings", () => {
    expect(ProjectOp.safeParse({ v: 1, rev: 1, op: "project", escalation_contact: "@kira" }).success).toBe(true);
    expect(ProjectOp.safeParse({ v: 1, rev: 1, op: "project", escalation_contact: "@kira/kiras-mbp" }).success).toBe(true);
    expect(ProjectOp.safeParse({ v: 1, rev: 1, op: "project", escalation_contact: null }).success).toBe(true);
    // Lenient on purpose: a bad value must not fail the whole settings op (the fold drops just that field).
    expect(ProjectOp.safeParse({ v: 1, rev: 1, op: "project", escalation_contact: "not-an-address", name: "Renamed" }).success).toBe(true);
    expect(ProjectOp.safeParse({ v: 1, rev: 1, op: "project", escalation_contact: "x".repeat(201) }).success).toBe(false);
    expect(PROJECT_FIELDS).toContain("escalation_contact");
  });

  test("a project reads unset until an admin sets it; the last writer wins; null clears it", () => {
    const r = root();
    expect(foldProject([r], env)?.escalation_contact).toBe("");
    const on = set(r, "alex", "@kira");
    expect(foldProject([r, on], env)?.escalation_contact).toBe("@kira");
    const next = set(r, "alex", "@alex/alex-mbp", { after: refOf(on) });
    expect(foldProject([r, on, next], env)?.escalation_contact).toBe("@alex/alex-mbp");
    const cleared = set(r, "alex", null, { after: refOf(next) });
    expect(foldProject([r, on, next, cleared], env)?.escalation_contact).toBe("");
  });

  test("a contact set by an op that is not an ancestor of the head does not take effect, whatever order the ops arrive in", () => {
    const r = root();
    const asNoor = set(r, "alex", "@noor");
    // Both owners saw asNoor and edit offline, concurrently. Kira's origin sorts first, so the contact op is folded
    // BEFORE the description edit, and the description edit is the project's head (the op a new change names).
    const own = (who: string, origin: string, fields: Record<string, unknown>): OpEvent => {
      const e = op(who, { v: 1, rev: 2, op: "project", after: refOf(asNoor), ...fields }, { thread: r.id });
      return { ...e, id: `${origin}:${e.seq}`, origin, h: hashOf(`${origin}:${e.seq}`) };
    };
    const owners = { creator: "alex", roleOf: (e: OpEvent) => ({ alex: "owner", pat: "owner", olive: "owner" } as const)[e.author.handle as "alex" | "pat" | "olive"] ?? null };
    const contactOp = own("pat", "a000000000000001", { escalation_contact: "@kira" });
    const edit = own("olive", "d000000000000001", { description: "Q4 site" });
    const posts = [r, asNoor, contactOp, edit];
    const folded = foldProject(posts, owners);
    expect(folded?.head).toBe(refOf(edit));
    expect(folded?.description).toBe("Q4 site");
    // Pat's op was applied, and still says so in the timeline, but it is not on the head's chain: the contact stays @noor.
    expect(folded?.timeline.find((t) => t.id === contactOp.id)?.ignored).toBeUndefined();
    expect(folded?.escalation_contact).toBe("@noor");
    // Every arrival order folds the same.
    for (const shuffled of [[edit, contactOp, asNoor, r], [contactOp, r, edit, asNoor], [asNoor, edit, r, contactOp]]) {
      expect(foldProject(shuffled, owners)?.escalation_contact).toBe("@noor");
    }
    // When the contact op is the head instead, it is on the head's chain and counts.
    const later = own("pat", "f000000000000001", { escalation_contact: "@kira" });
    expect(foldProject([r, asNoor, edit, later], owners)).toMatchObject({ head: refOf(later), escalation_contact: "@kira" });
    // The owner who then sets it again names the head (the edit), so the new op is on a chain that carries it.
    const again = op("alex", { v: 1, rev: 3, op: "project", after: refOf(edit), escalation_contact: "@kira" }, { thread: r.id });
    expect(foldProject([...posts, again], owners)).toMatchObject({ head: refOf(again), escalation_contact: "@kira" });
    // A later edit that names the head keeps the contact in effect; it does not pick up the one that lost.
    const next = op("olive", { v: 1, rev: 3, op: "project", after: refOf(edit), name: "Renamed" }, { thread: r.id });
    expect(foldProject([...posts, next], owners)).toMatchObject({ head: refOf(next), name: "Renamed", escalation_contact: "@noor" });
  });

  test("over random settings DAGs the contact is the one on the head's own chain, whatever order the posts arrive in", () => {
    const roles: Record<string, "owner" | "member"> = { alex: "owner", pat: "owner", olive: "owner", noor: "member" };
    const owners = { creator: "alex", roleOf: (e: OpEvent) => roles[e.author.handle] ?? null };
    const origins = ["a000000000000001", "b000000000000001", "c000000000000001", "d000000000000001"];
    let state = 20_261_002;
    const rnd = (): number => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    let n = 1_000;
    const mk = (who: string, board: unknown, thread?: string): OpEvent => {
      const origin = pick(origins);
      n++;
      const id = `${origin}:${n}`;
      return { id, origin, seq: n, ts: 1_800_000_000_000 + n, h: hashOf(id), author: { handle: who, node: origin }, ...(thread ? { thread } : {}), text: "op", board };
    };
    let lost = 0;
    for (let run = 0; run < 400; run++) {
      const r = mk("alex", { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB", ...(rnd() < 0.3 ? { escalation_contact: "@noor" } : {}) });
      const posts: OpEvent[] = [r];
      const total = 2 + Math.floor(rnd() * 14);
      for (let i = 0; i < total; i++) {
        const parent = pick(posts);
        const fields = rnd() < 0.6 ? { escalation_contact: pick(["@noor", "@kira", "@bea", "", null, "not-an-address"]) } : { description: `d${i}` };
        const after = rnd() < 0.1 ? undefined : refOf(parent);
        posts.push(mk(pick(["alex", "pat", "olive", "olive", "noor"]), { v: 1, rev: 1, op: "project", ...(after ? { after } : {}), ...fields }, r.id));
      }
      const folded = foldProject(posts, owners);
      expect(folded).not.toBeNull();
      const head = folded?.head as string;
      // The oracle: walk the head's explicit parent chain (no `after` means the root), then fold just that chain.
      const byId = new Map(posts.map((x) => [x.id, x]));
      const chain: OpEvent[] = [];
      for (let cur = byId.get(head.split("#")[0] as string); cur && cur.id !== r.id;) {
        chain.push(cur);
        const after = (cur.board as { after?: string }).after;
        cur = after ? byId.get(after.split("#")[0] as string) : r;
      }
      const alone = foldProject([r, ...chain], owners);
      expect(alone?.head).toBe(head);
      expect(folded?.escalation_contact).toBe(alone?.escalation_contact);
      expect(settingsHeadState(posts, head, owners)).toBe("known");
      for (let k = 0; k < 3; k++) {
        const shuffled = [...posts].sort(() => rnd() - 0.5);
        expect(foldProject(shuffled, owners)).toMatchObject({ head, escalation_contact: folded?.escalation_contact });
      }
      // The case under test: an admin op that is not on the head's chain carries a contact other than the one in effect.
      const onChain = new Set(chain.map((x) => x.id));
      const offChain = posts.slice(1).filter((x) => !onChain.has(x.id) && roles[x.author.handle] === "owner")
        .map((x) => (x.board as { escalation_contact?: string | null }).escalation_contact)
        .filter((v) => v === null || v === "" || v === "@noor" || v === "@kira" || v === "@bea");
      if (offChain.some((v) => (v ?? "") !== folded?.escalation_contact)) lost++;
    }
    // Sanity that the generator reaches it often.
    expect(lost).toBeGreaterThan(100);
  });

  test("a creator who is a member may set it; another member, an observer and an agent are ignored", () => {
    const r = op("kira", { v: 1, rev: 0, op: "project", name: "Kira's", prefix: "KIR" });
    const kira = { creator: "kira", roleOf: env.roleOf };
    expect(foldProject([r, set(r, "kira", "@alex")], kira)?.escalation_contact).toBe("@alex");
    const mine = root();
    const other = set(mine, "kira", "@bob");
    const watcher = set(mine, "bob", "@bob");
    const agent = set(mine, "alex", "@kira", { agent: "cc-1" });
    const folded = foldProject([mine, other, watcher, agent], env);
    expect(folded?.escalation_contact).toBe("");
    expect(folded?.timeline.filter((t) => t.ignored).map((t) => t.ignored)).toEqual(["not_admin", "not_admin", "not_admin"]);
  });

  test("a project root signed by an agent cannot carry the contact; a person's root can", () => {
    const body = { v: 1, rev: 0, op: "project", name: "Sneaky", prefix: "SNK", escalation_contact: "@kira" };
    const byAgent = op("alex", body, { agent: "cc-evil" });
    expect(foldProject([byAgent], env)?.escalation_contact).toBe("");
    expect(foldProject([byAgent], env)).toMatchObject({ name: "Sneaky", prefix: "SNK", creator: "alex" });
    expect(foldProject([op("alex", body)], env)?.escalation_contact).toBe("@kira");
    expect(foldProject([byAgent, set(byAgent, "alex", "@kira")], env)?.escalation_contact).toBe("@kira");
  });

  test("a bad contact is dropped and the op's other fields still apply", () => {
    const r = root();
    const both = op("alex", { v: 1, rev: 1, op: "project", after: refOf(r), escalation_contact: "nope", name: "Renamed" }, { thread: r.id });
    const agentAddr = op("alex", { v: 1, rev: 2, op: "project", after: refOf(both), escalation_contact: "@alex/mbp/cc-1", name: "Again" }, { thread: r.id });
    const p = foldProject([r, both, agentAddr], env);
    expect(p?.name).toBe("Again");
    expect(p?.escalation_contact).toBe("");
  });

  test("an older schema drops the field and keeps the op's other fields", () => {
    const settings = { v: 1, rev: 1, op: "project", escalation_contact: "@kira", name: "Renamed" };
    const before = ProjectOp.omit({ escalation_contact: true }).safeParse(settings);
    expect(before.success && before.data).toEqual({ v: 1, rev: 1, op: "project", name: "Renamed" });
    const r = root();
    const both = op("alex", { ...settings, after: refOf(r) }, { thread: r.id });
    const p = foldProject([r, both], env);
    expect([p?.escalation_contact, p?.name]).toEqual(["@kira", "Renamed"]);
  });

  test("escalationContactOf treats a missing, empty or non-person value as unset", () => {
    expect(escalationContactOf({})).toBe("");
    expect(escalationContactOf({ escalation_contact: "" })).toBe("");
    expect(escalationContactOf({ escalation_contact: "@kira" })).toBe("@kira");
    expect(escalationContactOf({ escalation_contact: "@kira/kiras-mbp" })).toBe("@kira/kiras-mbp");
    expect(escalationContactOf({ escalation_contact: "@kira/kiras-mbp/cc-1" })).toBe("");
    expect(escalationContactOf({ escalation_contact: "kira" })).toBe("");
    expect(escalationContactOf({ escalation_contact: null })).toBe("");
  });
});

describe("who may set it", () => {
  test("owners, and a creator who is still a member; nobody else, with a plain reason", () => {
    expect(escalationContactDenial("owner", "alex", "kira")).toBeNull();
    expect(escalationContactDenial("member", "kira", "kira")).toBeNull();
    expect(escalationContactDenial("member", "bob", "kira")).toBe("only the project's creator or an owner can change its escalation contact");
    expect(escalationContactDenial("observer", "kira", "kira")).toBe("observers can't change a project's escalation contact");
    expect(escalationContactDenial("observer", "bob", "kira")).toBe("observers can't change a project's escalation contact");
    expect(escalationContactDenial(null, null, "kira")).toBe("only the project's creator or an owner can change its escalation contact");
  });
});

function world(role: "owner" | "member" | "observer" = "owner", opts: { dave?: boolean; members?: string[] } = {}) {
  const alex = tnode("alex"), dave = tnode("dave");
  const { team, create } = createTeam(alex);
  // People before the channel, so each event's seq is the order it is ingested (a gap never joins the chain).
  const people = role === "owner"
    ? (opts.dave ? [memberEv(team, alex, dave, "member"), nodeEv(team, alex, dave)] : [])
    : [memberEv(team, alex, dave, role), nodeEv(team, alex, dave)];
  const channel = signed(team, alex, "channel.upsert", {
    name: CH, project: true, ...(opts.members ? { members: opts.members } : {}),
  });
  const root = signed(team, alex, "msg.post", { text: "Project", board: { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB" } } as BodyOf<"msg.post">, { channel: CH });
  const board = signed(team, alex, "msg.post", { text: "Board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } } as BodyOf<"msg.post">, { channel: CH });
  const self = role === "owner" ? alex : dave;
  const core = makeCore(self, team, cleanups);
  const idx = new ProjectsIndex(core, createLogger({}));
  cleanups.push(() => idx.stop());
  core.onPostChange = (e, change) => idx.onPost(e, change);
  core.onRosterChange = () => idx.rosterChanged();
  const events = [create, ...people, channel, root, board];
  if (role === "owner") for (const e of events) core.ingest(e, "local"); else feed(core, events);
  idx.flushAll();
  const w: WriteCtx = { core, idx, client: {} as WriteCtx["client"], catchUp: async () => {} };
  return { core, idx, w, team, alex, dave };
}

describe("the service", () => {
  test("the owner sets it and clears it; the view and the project's own post say so", async () => {
    const { w, idx } = world();
    expect(escalationContactOf(idx.project(CH) ?? {})).toBe("");
    const on = await updateProject(w, CH, { escalation_contact: "@alex" });
    expect(on.escalation_contact).toBe("@alex");
    const last = w.core.store.queryEvents({ channel: CH, kinds: ["msg.post"], limit: 1 })[0];
    expect(JSON.parse(last?.json ?? "{}").body.text).toBe('Project "Website" escalation contact set');
    expect((await updateProject(w, CH, { escalation_contact: null })).escalation_contact).toBe("");
    const again = w.core.store.queryEvents({ channel: CH, kinds: ["msg.post"], limit: 1 })[0];
    expect(JSON.parse(again?.json ?? "{}").body.text).toBe('Project "Website" escalation contact cleared');
  });

  test("setting the same contact again signs nothing", async () => {
    const { w } = world();
    await updateProject(w, CH, { escalation_contact: "@alex" });
    const before = w.core.store.allocatedSelfSeq(w.core.nodeId);
    const again = await updateProject(w, CH, { escalation_contact: "@alex" });
    expect(again.escalation_contact).toBe("@alex");
    expect(w.core.store.allocatedSelfSeq(w.core.nodeId)).toBe(before);
  });

  test("another member is refused, and an observer is refused with its own reason", async () => {
    await expect(updateProject(world("member").w, CH, { escalation_contact: "@alex" }))
      .rejects.toMatchObject({ status: 403, message: "only the project's creator or an owner can change its escalation contact" });
    await expect(updateProject(world("observer").w, CH, { escalation_contact: "@alex" }))
      .rejects.toMatchObject({ status: 403, message: "observers can't change a project's escalation contact" });
  });

  test("an agent is refused: the contact is a person's", () => {
    const { w, idx } = world();
    expect(() => updateProject({ ...w, agent: "cc-1" }, CH, { escalation_contact: "@alex" })).toThrow("people only");
    expect(escalationContactOf(idx.project(CH) ?? {})).toBe("");
  });

  test("a contact must be a person on the project who can see it", async () => {
    const { w } = world("owner", { dave: true });
    await expect(updateProject(w, CH, { escalation_contact: "dave" })).rejects.toMatchObject({ status: 400 });
    await expect(updateProject(w, CH, { escalation_contact: "@alex/alex-mbp/cc-1" })).rejects.toMatchObject({ status: 400 });
    await expect(updateProject(w, CH, { escalation_contact: "@alex/cloud" })).rejects.toMatchObject({ status: 400 });
    await expect(updateProject(w, CH, { escalation_contact: "@nobody" })).rejects.toMatchObject({ status: 400 });
    await expect(updateProject(w, CH, { escalation_contact: "@bob" })).rejects.toMatchObject({ status: 400 });
    const hidden = world("owner", { dave: true, members: ["alex"] });
    await expect(updateProject(hidden.w, CH, { escalation_contact: "@dave" })).rejects.toMatchObject({ status: 400, message: "@dave can't see this project" });
    expect((await updateProject(w, CH, { escalation_contact: "@dave" })).escalation_contact).toBe("@dave");
    expect((await updateProject(w, CH, { escalation_contact: "@dave/dave-mbp" })).escalation_contact).toBe("@dave/dave-mbp");
  });

  test("a machine that is not on the roster is refused, and a handle alone still stands", async () => {
    const { w } = world("owner", { dave: true });
    await expect(updateProject(w, CH, { escalation_contact: "@dave/no-such-machine" })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("no-such-machine") });
    expect((await updateProject(w, CH, { escalation_contact: "@dave" })).escalation_contact).toBe("@dave");
    expect((await updateProject(w, CH, { escalation_contact: "@dave/dave-mbp" })).escalation_contact).toBe("@dave/dave-mbp");
  });
});

describe("a view stored before the field existed", () => {
  test("the fold-version bump re-folds the log so a contact set meanwhile shows", async () => {
    expect(FOLD_VERSION).toBe("13");
    const { w, core, idx } = world();
    await updateProject(w, CH, { escalation_contact: "@alex" });
    idx.flushAll();
    const { escalation_contact: _gone, ...old } = idx.project(CH) as ProjectView;
    idx.db.saveProject(CH, old.id, JSON.stringify(old), old.last_activity);
    core.store.setMeta("projects_fold", "11");
    expect(escalationContactOf(idx.project(CH) as ProjectView)).toBe("");
    idx.start();
    idx.flushAll();
    expect(idx.project(CH)?.escalation_contact).toBe("@alex");
  });
});

describe("the route", () => {
  function request(h: ReturnType<typeof world>, agent: string | undefined, body: unknown) {
    const req = new Request(`http://localhost/v1/projects/${CH}`, { method: "POST", body: JSON.stringify(body) });
    return dispatch({ core: h.core, sync: { requestCatchUp: async () => {} }, client: {}, req, url: new URL(req.url), agent, via: "cli", listener: "unix",
      projects: h.idx, noTimeout: () => {}, orchestratorToken: agent === "orchestrator" ? "valid" : undefined } as unknown as RouteCtx);
  }

  test("a person sets it; an unknown shape is a 400", async () => {
    const h = world();
    const res = await request(h, undefined, { escalation_contact: "@alex" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { project: ProjectView }).project.escalation_contact).toBe("@alex");
    await expect(request(h, undefined, { escalation_contact: "alex" })).rejects.toMatchObject({ status: 400 });
  });

  test("an agent is refused before the agent-admin gate, and nothing is written", async () => {
    const h = world();
    registerHost(h.core, { acceptsToken: () => true } as unknown as OrchestratorHost);
    const before = h.core.store.allocatedSelfSeq(h.core.nodeId);
    for (const agent of ["cc-1", "orchestrator"]) {
      await expect(request(h, agent, { escalation_contact: "@alex" })).rejects.toMatchObject({ status: 403, message: expect.stringContaining("people only") });
    }
    expect(h.core.store.allocatedSelfSeq(h.core.nodeId)).toBe(before);
    expect(escalationContactOf(h.idx.project(CH) ?? {})).toBe("");
  });
});
