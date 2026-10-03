// WALK-73: raising a dispute posts it on the card and asks the resolver (escalation contact, else the project's
// creator, else the owners). The recorded resolver closes it with one line. An ask expiring does not.
import { afterEach, describe, expect, test } from "bun:test";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { ProjectsIndex } from "../../src/daemon/projects/index.ts";
import "../../src/daemon/projects/routes.ts";
import { createCard, updateCard, updateProject, type WriteCtx } from "../../src/daemon/projects/service.ts";
import { raiseDispute, resolveDispute, showDispute } from "../../src/daemon/projects/dispute.ts";
import { DISPUTE_ASK_TTL_S, disputeAskText, disputeText, resolveText } from "../../src/protocol/projects/dispute.ts";
import { refOf } from "../../src/protocol/projects/fold.ts";
import { DEFAULT_COLUMNS } from "../../src/protocol/projects/schema.ts";
import { DEFAULT_LIMITS, type RateLimits } from "../../src/daemon/ratelimit.ts";
import type { BodyOf, Event } from "../../src/protocol/schemas.ts";
import { opEventOf } from "../../src/daemon/projects/db.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, ev as signed, memberEv, nodeEv, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const CH = "p-5e7a7e01";

function indexFor(core: ReturnType<typeof makeCore>): ProjectsIndex {
  const idx = new ProjectsIndex(core, createLogger({}));
  cleanups.push(() => idx.stop());
  core.onPostChange = (e, change) => idx.onPost(e, change);
  core.onRosterChange = () => idx.rosterChanged();
  return idx;
}

/** Alex owns the team and created the project. Dave is a member when asked. */
function world(opts: { dave?: boolean; clock?: () => number; limits?: RateLimits } = {}) {
  const alex = tnode("alex"), dave = tnode("dave");
  const { team, create } = createTeam(alex);
  // Sign people before the channel: seq has to be contiguous in the order they are ingested, or a later member never joins.
  const people = opts.dave ? [memberEv(team, alex, dave, "member"), nodeEv(team, alex, dave)] : [];
  const channel = signed(team, alex, "channel.upsert", { name: CH, project: true });
  const root = signed(team, alex, "msg.post", { text: "Project", board: { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB" } } as BodyOf<"msg.post">, { channel: CH });
  const board = signed(team, alex, "msg.post", { text: "Board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } } as BodyOf<"msg.post">, { channel: CH });
  const core = makeCore(alex, team, cleanups, { ...(opts.clock ? { clock: opts.clock } : {}), ...(opts.limits ? { limits: opts.limits } : {}) });
  const idx = indexFor(core);
  for (const e of [create, ...people, channel, root, board]) core.ingest(e, "local");
  idx.flushAll();
  const w: WriteCtx = { core, idx, client: {} as WriteCtx["client"], catchUp: async () => {} };
  return { core, idx, w, team, alex, dave };
}

/** Dave created the project; Alex and Kira are owners. Used for the creator and owners routes. */
function cast() {
  const alex = tnode("alex"), kira = tnode("kira"), dave = tnode("dave");
  const { team, create } = createTeam(alex);
  const core = makeCore(alex, team, cleanups);
  const idx = indexFor(core);
  for (const e of [
    create,
    memberEv(team, alex, kira, "owner"), nodeEv(team, alex, kira),
    memberEv(team, alex, dave, "member"), nodeEv(team, alex, dave),
  ]) core.ingest(e, "local");
  core.emit("channel.upsert", { name: CH, project: true, topic: "Walkie project", requested_by: dave.handle });
  const root = signed(team, dave, "msg.post", { text: "Project", board: { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB" } } as BodyOf<"msg.post">, { channel: CH });
  const board = signed(team, dave, "msg.post", { text: "Board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } } as BodyOf<"msg.post">, { channel: CH });
  feed(core, [root, board]);
  idx.flushAll();
  const w: WriteCtx = { core, idx, client: {} as WriteCtx["client"], catchUp: async () => {} };
  return { core, idx, w, alex, kira, dave };
}

function askEvents(core: ReturnType<typeof makeCore>): Event[] {
  return core.store.queryEvents({ channel: CH, kinds: ["ask"], limit: 20 }).map((r) => JSON.parse(r.json) as Event);
}

/** Alex's project plus extra people, ingested locally. A remote feed of Alex's own posts is refused (`self_origin`). */
function teamProject(people: { node: ReturnType<typeof tnode>; role: "owner" | "member" }[], opts: { limits?: RateLimits; clock?: () => number } = {}) {
  const alex = tnode("alex");
  const { team, create } = createTeam(alex);
  const admitted = people.flatMap((p) => [memberEv(team, alex, p.node, p.role), nodeEv(team, alex, p.node)]);
  const channel = signed(team, alex, "channel.upsert", { name: CH, project: true });
  const root = signed(team, alex, "msg.post", { text: "Project", board: { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB" } } as BodyOf<"msg.post">, { channel: CH });
  const board = signed(team, alex, "msg.post", { text: "Board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } } as BodyOf<"msg.post">, { channel: CH });
  const core = makeCore(alex, team, cleanups, { ...(opts.limits ? { limits: opts.limits } : {}), ...(opts.clock ? { clock: opts.clock } : {}) });
  const idx = indexFor(core);
  for (const e of [create, ...admitted, channel, root, board]) core.ingest(e, "local");
  idx.flushAll();
  const w: WriteCtx = { core, idx, client: {} as WriteCtx["client"], catchUp: async () => {} };
  return { core, idx, w, team, alex };
}

describe("routing", () => {
  test("an escalation contact is asked, in the project channel, for one day, and expiry is not an escalation", async () => {
    const { w, core, idx } = world({ dave: true });
    expect(core.store.getMeta("board_ops_class")).toBe("4");
    expect(core.store.getMeta("validity_version")).toBe("11");
    await updateProject(w, CH, { escalation_contact: "@dave/dave-mbp" });
    const card = await createCard(w, CH, { title: "Ship it" });
    const clock = core.clock();
    const res = await raiseDispute(w, card.ref, "Who owns the deploy?");
    expect(res.dispute).toMatchObject({ state: "open", summary: "Who owns the deploy?", ref: card.ref, routed: "contact", resolvers: ["@dave/dave-mbp", "@alex"] });
    expect(res.asks).toEqual([{ id: expect.any(String), to: "@dave/dave-mbp" }]);
    const asks = askEvents(core);
    expect(asks).toHaveLength(1);
    const ask = asks[0] as Event;
    expect(ask.channel).toBe(CH);
    expect(ask.body).toMatchObject({
      to: "@dave/dave-mbp",
      text: disputeAskText(card.key, "Website", "Who owns the deploy?", card.ref),
      expires_at: clock + DISPUTE_ASK_TTL_S * 1000,
    });
    const post = core.store.queryEvents({ channel: CH, kinds: ["msg.post"], limit: 1 })[0];
    const body = JSON.parse(post?.json ?? "{}").body;
    expect(body.text).toBe(disputeText(card.key, "Who owns the deploy?"));
    expect(body.thread).toBe(card.id);
    expect(body.board).toMatchObject({ op: "dispute", state: "open", routed: "contact", resolvers: ["@dave/dave-mbp"] });
    expect(idx.db.card(card.id)).toMatchObject({ rev: card.rev, comments: card.comments, title: "Ship it" });
    const head = idx.foldCardNow(CH, card.id)?.state.head;
    const renamed = await updateCard(w, card.ref, { title: "Renamed" });
    expect(renamed.title).toBe("Renamed");
    const cardOp = core.store.queryEvents({ channel: CH, kinds: ["msg.post"], limit: 5 }).map((r) => JSON.parse(r.json) as Event).find((e) => (e.body as { board?: { title?: string } }).board?.title === "Renamed");
    expect((cardOp?.body as { board?: { after?: string } }).board?.after).toBe(head);
  });

  test("a stale contact falls through to the creator", async () => {
    const { w, core, kira } = cast();
    await updateProject(w, CH, { escalation_contact: "@kira" });
    core.emit("team.member", { login: kira.login, handle: kira.handle, role: "removed" });
    w.idx.rosterChanged();
    w.idx.flushAll();
    const card = await createCard(w, CH, { title: "Ship it" });
    const res = await raiseDispute(w, card.ref, "Who owns the deploy?");
    expect(res.dispute.routed).toBe("creator");
    expect(res.asks.map((a) => a.to)).toEqual(["@dave"]);
    expect(res.dispute.resolvers).toEqual(["@dave", "@alex"]);
  });

  test("the escalation contact is not asked to resolve a dispute they raised; the owners are, not the project's creator", async () => {
    const { w } = cast();
    await updateProject(w, CH, { escalation_contact: "@alex" });
    const card = await createCard(w, CH, { title: "Ship it" });
    const res = await raiseDispute(w, card.ref, "Who owns the deploy?");
    // Alex is the contact and the raiser. Dave created the project but is a member: with a contact in effect only the
    // contact or an owner may resolve, so asking Dave would give him a 403. Kira (the other owner) is asked.
    expect(res.dispute.routed).toBe("owners");
    expect(res.asks.map((a) => a.to)).toEqual(["@kira"]);
    expect(res.dispute.resolvers).toEqual(["@alex", "@kira"]);
  });

  test("with no contact the creator is asked; once the creator is gone, every owner is asked", async () => {
    const { w, core, dave } = cast();
    expect(w.idx.project(CH)?.creator).toBe("dave");
    const card = await createCard(w, CH, { title: "Ship it" });
    const viaCreator = await raiseDispute(w, card.ref, "Who owns the deploy?");
    expect(viaCreator.dispute.routed).toBe("creator");
    expect(viaCreator.asks.map((a) => a.to)).toEqual(["@dave"]);
    core.emit("team.member", { login: dave.login, handle: dave.handle, role: "removed" });
    w.idx.rosterChanged();
    w.idx.flushAll();
    const other = await createCard(w, CH, { title: "After" });
    const viaOwners = await raiseDispute(w, other.ref, "Who owns it now?");
    expect(viaOwners.dispute.routed).toBe("owners");
    // Alex raised this one, so he is not asked while Kira can be. He can still resolve: he is an owner.
    expect(viaOwners.dispute.resolvers).toEqual(["@alex", "@kira"]);
    expect(viaOwners.asks.map((a) => a.to)).toEqual(["@kira"]);
    expect(askEvents(core).map((a) => (a.body as { to: string }).to).sort()).toEqual(["@dave", "@kira"]);
  });

  test("a failed ask rolls the dispute post back with it", async () => {
    const { w, core, dave } = cast();
    core.emit("team.member", { login: dave.login, handle: dave.handle, role: "removed" });
    w.idx.rosterChanged();
    w.idx.flushAll();
    const card = await createCard(w, CH, { title: "Ship it" });
    const before = core.store.allocatedSelfSeq(core.nodeId);
    const spec = core.limits.humanWrite;
    const beforeTokens = core.limiter.available("write:human", spec, Date.now());
    const orig = core.emit.bind(core);
    let n = 0;
    core.emit = ((kind: string, body: unknown, opts?: unknown) => {
      // The raiser is an owner and the other owner is the only person asked, so the first ask is the one that fails.
      if (kind === "ask" && ++n === 1) throw new Error("ask failed");
      return orig(kind as never, body as never, opts as never);
    }) as typeof core.emit;
    await expect(raiseDispute(w, card.ref, "Who owns the deploy?")).rejects.toThrow("ask failed");
    expect(core.store.allocatedSelfSeq(core.nodeId)).toBe(before);
    expect(core.limiter.available("write:human", spec, Date.now())).toBe(beforeTokens);
    expect(askEvents(core)).toEqual([]);
    const posts = core.store.queryEvents({ channel: CH, kinds: ["msg.post"], limit: 20 }).map((r) => JSON.parse(r.json) as Event);
    expect(posts.some((e) => (e.body as { board?: { op?: string } }).board?.op === "dispute")).toBe(false);
    expect(await showDispute(w, card.ref)).toBeNull();
  });
});

describe("resolve", () => {
  test("an owner can close a dispute the contact was asked about; an agent cannot; a new one waits 10 minutes", async () => {
    let t = now();
    const { w, core } = world({ dave: true, clock: () => t });
    t = now(); // world() already ticked the simulated clock; emits stay monotonic with those events
    await updateProject(w, CH, { escalation_contact: "@alex/alex-mbp" });
    const card = await createCard(w, CH, { title: "Ship it" });
    expect(await showDispute(w, card.ref)).toBeNull();
    await raiseDispute(w, card.ref, "Who owns the deploy?");
    await expect(raiseDispute(w, card.ref, "Again")).rejects.toMatchObject({ status: 409, message: "this card already has an open dispute" });
    const other = world({ dave: true });
    await updateProject(other.w, CH, { escalation_contact: "@dave" });
    const otherCard = await createCard(other.w, CH, { title: "Other" });
    await raiseDispute(other.w, otherCard.ref, "Dave's call");
    expect(await resolveDispute(other.w, otherCard.ref, "Alex decides.")).toMatchObject({ state: "resolved", resolved_by: { handle: "alex" } });
    expect(() => resolveDispute({ ...w, agent: "cc-1" }, card.ref, "An agent decides.")).toThrow("people only");
    const done = await resolveDispute(w, card.ref, "Ship Friday.");
    expect(done).toMatchObject({ state: "resolved", reason: "Ship Friday.", resolved_by: { handle: "alex" }, summary: "Who owns the deploy?" });
    const posts = core.store.queryEvents({ channel: CH, kinds: ["msg.post"], limit: 20 }).map((r) => JSON.parse(r.json) as Event);
    expect(posts.some((e) => (e.body as { text?: string }).text === resolveText(card.key, "Ship Friday."))).toBe(true);
    await expect(resolveDispute(w, card.ref, "Again")).rejects.toMatchObject({ status: 409 });
    t += 10 * 60 * 1000;
    const again = await raiseDispute(w, card.ref, "A new one");
    expect(again.dispute).toMatchObject({ state: "open", summary: "A new one" });
  });

  test("a deleted card can still be resolved, and a deleted or archived card cannot be raised", async () => {
    const { w } = world();
    const card = await createCard(w, CH, { title: "Ship it" });
    await raiseDispute(w, card.ref, "Who owns the deploy?");
    await updateCard(w, card.ref, { state: "deleted" });
    expect((await resolveDispute(w, card.ref, "Closed with the card.")).state).toBe("resolved");
    await expect(raiseDispute(w, card.ref, "On a deleted card")).rejects.toMatchObject({ status: 409 });
    const archived = await createCard(w, CH, { title: "Later" });
    await updateCard(w, archived.ref, { state: "archived" });
    await expect(raiseDispute(w, archived.ref, "On an archived card")).rejects.toMatchObject({ status: 409 });
    const still = await createCard(w, CH, { title: "Open" });
    await updateProject(w, CH, { state: "archived" });
    await expect(raiseDispute(w, still.ref, "On an archived project")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("archived") });
  });

  test("a summary or reason that is not one plain line is refused, and a secret in it is redacted", async () => {
    const { w } = world();
    const card = await createCard(w, CH, { title: "Ship it" });
    await expect(raiseDispute(w, card.ref, "one\ntwo")).rejects.toMatchObject({ status: 400 });
    await expect(raiseDispute(w, card.ref, "   ")).rejects.toMatchObject({ status: 400 });
    const res = await raiseDispute(w, card.ref, "key AKIAIOSFODNN7EXAMPLE leaked");
    expect(res.dispute.summary).toContain("[REDACTED:aws_access_key]");
    expect(res.dispute.summary).not.toContain("AKIAIOSFODNN7EXAMPLE");
    await expect(resolveDispute(w, card.ref, "because\nof reasons")).rejects.toMatchObject({ status: 400 });
  });

  test("an agent may raise for its person", async () => {
    const { w } = world();
    const card = await createCard(w, CH, { title: "Ship it" });
    const res = await raiseDispute({ ...w, agent: "cc-1" }, card.ref, "Who owns the deploy?");
    expect(res.dispute.by).toEqual({ handle: "alex", agent: "cc-1" });
    expect(res.dispute.routed).toBe("owners");
    expect(res.asks.map((a) => a.to)).toEqual(["@alex"]);
  });
});

describe("the routes", () => {
  function call(h: ReturnType<typeof world>, method: string, path: string, body?: unknown, agent?: string) {
    const req = new Request(`http://localhost${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    return dispatch({
      core: h.core, sync: { requestCatchUp: async () => {} }, client: {}, req, url: new URL(req.url), agent, via: "cli", listener: "unix",
      projects: h.idx, noTimeout: () => {}, orchestratorToken: agent === "orchestrator" ? "valid" : undefined,
    } as unknown as RouteCtx);
  }

  test("show, raise and resolve over HTTP", async () => {
    const h = world();
    const card = await createCard(h.w, CH, { title: "Ship it" });
    const none = await call(h, "GET", `/v1/tasks/${card.ref}/dispute`);
    expect(await none.json()).toEqual({ dispute: null });
    const raised = await call(h, "POST", `/v1/tasks/${card.ref}/dispute`, { summary: "Who owns the deploy?" });
    expect(raised.status).toBe(200);
    const body = await raised.json() as { dispute: { state: string; routed: string }; asks: { to: string }[] };
    expect(body.dispute).toMatchObject({ state: "open", routed: "owners" });
    expect(body.asks.map((a) => a.to)).toEqual(["@alex"]);
    const resolved = await call(h, "POST", `/v1/tasks/${card.ref}/dispute/resolve`, { reason: "Ship Friday." });
    expect((await resolved.json() as { dispute: { state: string; reason: string } }).dispute).toMatchObject({ state: "resolved", reason: "Ship Friday." });
  });

  test("a forged resolver list does not decide who may resolve", async () => {
    const kira = tnode("kira"), noor = tnode("noor"), olive = tnode("olive");
    const { team, core, idx, w } = teamProject([
      { node: kira, role: "member" }, { node: noor, role: "member" }, { node: olive, role: "owner" },
    ]);
    await updateProject(w, CH, { escalation_contact: "@noor" });
    const card = await createCard(w, CH, { title: "Ship it" });
    const head = idx.disputeOf(CH, card.id).head;
    const settings = idx.settingsOf(CH).project?.head;
    const forged = signed(team, kira, "msg.post", {
      text: `Dispute on ${card.key}: I win`, thread: card.id,
      board: { v: 1, rev: 1, op: "dispute", state: "open", summary: "I win", resolvers: ["@kira"], routed: "contact", after: head, settings },
    } as BodyOf<"msg.post">, { channel: CH });
    feed(core, [forged]);
    idx.flushAll();
    const shown = showDispute(w, card.ref);
    expect(shown?.resolvers).toEqual(["@noor", "@alex", "@olive"]);
    const byOwner = await resolveDispute(w, card.ref, "The owner decides.");
    expect(byOwner).toMatchObject({ state: "resolved", resolved_by: { handle: "alex" } });

    const other = await createCard(w, CH, { title: "Second" });
    const head2 = idx.disputeOf(CH, other.id).head;
    const forged2 = signed(team, kira, "msg.post", {
      text: `Dispute on ${other.key}: I win`, thread: other.id,
      board: { v: 1, rev: 1, op: "dispute", state: "open", summary: "I win again", resolvers: ["@kira"], routed: "contact", after: head2, settings },
    } as BodyOf<"msg.post">, { channel: CH });
    feed(core, [forged2]);
    idx.flushAll();
    const open = opEventOf(core.store.getRow(forged2.id)!.json);
    const byKira = signed(team, kira, "msg.post", {
      text: `Dispute on ${other.key} resolved: kira wins`, thread: other.id,
      board: { v: 1, rev: 2, op: "dispute", state: "resolved", reason: "kira wins", after: refOf(open) },
    } as BodyOf<"msg.post">, { channel: CH });
    feed(core, [byKira]);
    idx.flushAll();
    expect(showDispute(w, other.ref)?.state).toBe("open");
    const byNoor = signed(team, noor, "msg.post", {
      text: `Dispute on ${other.key} resolved: noor decides`, thread: other.id,
      board: { v: 1, rev: 2, op: "dispute", state: "resolved", reason: "noor decides", after: refOf(open), settings },
    } as BodyOf<"msg.post">, { channel: CH });
    feed(core, [byNoor]);
    idx.flushAll();
    expect(showDispute(w, other.ref)).toMatchObject({ state: "resolved", resolved_by: { handle: "noor" } });
  });

  test("an owner resolves after the only contact leaves the team", async () => {
    const { w, core, idx, dave } = world({ dave: true });
    await updateProject(w, CH, { escalation_contact: "@dave" });
    const card = await createCard(w, CH, { title: "Ship it" });
    await raiseDispute(w, card.ref, "Who owns the deploy?");
    core.emit("team.member", { login: dave.login, handle: dave.handle, role: "removed" });
    idx.rosterChanged();
    idx.flushAll();
    const done = await resolveDispute(w, card.ref, "The owner decides.");
    expect(done).toMatchObject({ state: "resolved", resolved_by: { handle: "alex" } });
    expect(done.resolvers.map((a) => a.replace(/^@/, "").split("/")[0])).not.toContain("dave");
  });

  test("the creator raising with no contact asks at most five owners, in handle order", async () => {
    const owners = ["bea", "kira", "maren", "noor", "olive"].map((h) => tnode(h));
    const { core, w } = teamProject(owners.map((node) => ({ node, role: "owner" as const })), {
      limits: { ...DEFAULT_LIMITS, humanWrite: { capacity: 60, perSecond: 0 } },
    });
    const card = await createCard(w, CH, { title: "Ship it" });
    const spec = core.limits.humanWrite;
    const before = core.limiter.available("write:human", spec, Date.now());
    const res = await raiseDispute(w, card.ref, "Who owns the deploy?");
    expect(res.dispute.routed).toBe("owners");
    // Alex raised it. Another owner can be asked, so the five asks are the other owners and olive is not dropped.
    expect(res.asks.map((a) => a.to)).toEqual(["@bea", "@kira", "@maren", "@noor", "@olive"]);
    expect(res.asks.map((a) => a.to)).not.toContain("@alex");
    expect(before - core.limiter.available("write:human", spec, Date.now())).toBe(1 + res.asks.length);
  });

  test("a raise spends one write token for the post and one per ask, or it signs nothing", async () => {
    const h = world({ dave: true, limits: { ...DEFAULT_LIMITS, agentWrite: { capacity: 1, perSecond: 0 } } });
    await updateProject(h.w, CH, { escalation_contact: "@dave" });
    const card = await createCard(h.w, CH, { title: "Ship it" });
    const before = h.core.store.allocatedSelfSeq(h.core.nodeId);
    await expect(call(h, "POST", `/v1/tasks/${card.ref}/dispute`, { summary: "Who owns the deploy?" }, "cc-1"))
      .rejects.toMatchObject({ status: 429, code: "rate_limited" });
    expect(h.core.store.allocatedSelfSeq(h.core.nodeId)).toBe(before);

    const ok = world({ dave: true, limits: { ...DEFAULT_LIMITS, agentWrite: { capacity: 8, perSecond: 0 } } });
    await updateProject(ok.w, CH, { escalation_contact: "@dave" });
    const card2 = await createCard(ok.w, CH, { title: "Later" });
    const spec = ok.core.limits.agentWrite;
    const tokens = ok.core.limiter.available("write:cc-1", spec, Date.now());
    const raised = await call(ok, "POST", `/v1/tasks/${card2.ref}/dispute`, { summary: "Who owns the deploy?" }, "cc-1");
    expect(raised.status).toBe(200);
    const body = await raised.json() as { asks: { id: string; to: string }[] };
    expect(body.asks).toEqual([{ id: expect.any(String), to: "@dave" }]);
    expect(tokens - ok.core.limiter.available("write:cc-1", spec, Date.now())).toBe(2);
  });

  test("a card waits 10 minutes after a resolve before another dispute", async () => {
    let t = now();
    const { w } = world({ clock: () => t });
    t = now();
    const card = await createCard(w, CH, { title: "Ship it" });
    await raiseDispute(w, card.ref, "Who owns the deploy?");
    await resolveDispute(w, card.ref, "Ship Friday.");
    await expect(raiseDispute(w, card.ref, "Again")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("10 minutes") });
    t += 10 * 60 * 1000;
    expect((await raiseDispute(w, card.ref, "Again")).dispute.state).toBe("open");
  });

  test("a resolve stamped ahead cannot stretch the 10 minute wait", async () => {
    const noor = tnode("noor");
    let t = now();
    const { w, core, idx, team } = teamProject([{ node: noor, role: "member" }], { clock: () => t });
    t = now();
    await updateProject(w, CH, { escalation_contact: "@noor" });
    const head = idx.settingsOf(CH).project?.head ?? "";
    const card = await createCard(w, CH, { title: "Ship it" });
    const raised = await raiseDispute(w, card.ref, "Who owns the deploy?");
    const open = opEventOf(core.store.getRow(raised.dispute.id)!.json);
    const fwd = signed(team, noor, "msg.post", {
      text: `Dispute on ${card.key} resolved: Done.`, thread: card.id,
      board: { v: 1, rev: 2, op: "dispute", state: "resolved", reason: "Done.", after: refOf(open), settings: head },
    } as BodyOf<"msg.post">, { channel: CH, ts: t + 23 * 3_600_000 });
    feed(core, [fwd]);
    idx.flushAll();
    expect(showDispute(w, card.ref)).toMatchObject({ state: "resolved", resolved_by: { handle: "noor" } });
    await expect(raiseDispute(w, card.ref, "too soon")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("10 minutes") });
    t += 10 * 60 * 1000;
    expect((await raiseDispute(w, card.ref, "again")).dispute.state).toBe("open");
  });

  test("a resolver whose machine has not seen the open's settings head is refused before anything is signed", async () => {
    const alex = tnode("alex"), noor = tnode("noor"), dave = tnode("dave");
    const { team, create } = createTeam(alex);
    const core = makeCore(noor, team, cleanups);
    const idx = indexFor(core);
    const people = [
      memberEv(team, alex, noor, "member"), nodeEv(team, alex, noor),
      memberEv(team, alex, dave, "member"), nodeEv(team, alex, dave),
    ];
    const channel = signed(team, alex, "channel.upsert", { name: CH, project: true });
    const root = signed(team, alex, "msg.post", { text: "Project", board: { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB" } } as BodyOf<"msg.post">, { channel: CH });
    const board = signed(team, alex, "msg.post", { text: "Board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } } as BodyOf<"msg.post">, { channel: CH });
    feed(core, [create, ...people, channel, root, board]);
    idx.flushAll();
    const w: WriteCtx = { core, idx, client: {} as WriteCtx["client"], catchUp: async () => {} };
    const asNoor = signed(team, alex, "msg.post", {
      text: "Settings", thread: root.id,
      board: { v: 1, rev: 1, op: "project", after: refOf(opEventOf(core.store.getRow(root.id)!.json)), escalation_contact: "@noor" },
    } as BodyOf<"msg.post">, { channel: CH });
    const cardEv = signed(team, dave, "msg.post", {
      text: "Card", board: { v: 1, rev: 0, op: "card", board: board.id, title: "Ship it", column: "todo" },
    } as BodyOf<"msg.post">, { channel: CH });
    feed(core, [asNoor, cardEv]);
    idx.flushAll();
    const card = idx.db.card(cardEv.id)!;
    const unknown = "b000000000000099:1#0123456789abcdef";
    const open = signed(team, dave, "msg.post", {
      text: `Dispute on ${card.key}: Who owns the deploy?`, thread: cardEv.id,
      board: {
        v: 1, rev: 1, op: "dispute", state: "open", summary: "Who owns the deploy?", resolvers: ["@noor"], routed: "contact",
        after: idx.disputeOf(CH, cardEv.id).head, settings: unknown,
      },
    } as BodyOf<"msg.post">, { channel: CH });
    feed(core, [open]);
    idx.flushAll();
    expect(showDispute(w, card.ref)?.resolvers).toEqual(["@alex"]);
    const before = core.store.allocatedSelfSeq(core.nodeId);
    await expect(resolveDispute(w, card.ref, "Noor decides.")).rejects.toMatchObject({
      status: 409,
      message: "this machine has not received the project settings this dispute was raised under yet; try again after sync",
    });
    expect(core.store.allocatedSelfSeq(core.nodeId)).toBe(before);
    expect(showDispute(w, card.ref)?.state).toBe("open");
  });

  test("an owner can still resolve when the open's settings head is not on this machine", async () => {
    const dave = tnode("dave");
    const { w, core, idx, team } = teamProject([{ node: dave, role: "member" }]);
    const card = await createCard(w, CH, { title: "Ship it" });
    const unknown = "b000000000000099:1#0123456789abcdef";
    const open = signed(team, dave, "msg.post", {
      text: `Dispute on ${card.key}: Who owns the deploy?`, thread: card.id,
      board: {
        v: 1, rev: 1, op: "dispute", state: "open", summary: "Who owns the deploy?", resolvers: ["@alex"], routed: "owners",
        after: idx.disputeOf(CH, card.id).head, settings: unknown,
      },
    } as BodyOf<"msg.post">, { channel: CH });
    feed(core, [open]);
    idx.flushAll();
    const done = await resolveDispute(w, card.ref, "The owner decides.");
    expect(done).toMatchObject({ state: "resolved", resolved_by: { handle: "alex" } });
  });

  test("a scheduled WalkieTalkie turn cannot raise or resolve a dispute", async () => {
    const h = world();
    const card = await createCard(h.w, CH, { title: "Ship it" });
    registerHost(h.core, { acceptsToken: () => true, scheduledChildActive: () => true } as unknown as OrchestratorHost);
    const before = h.core.store.allocatedSelfSeq(h.core.nodeId);
    await expect(call(h, "POST", `/v1/tasks/${card.ref}/dispute`, { summary: "Who owns the deploy?" }, "orchestrator"))
      .rejects.toMatchObject({ status: 403, code: "scheduled_turn_cannot_act" });
    expect(h.core.store.allocatedSelfSeq(h.core.nodeId)).toBe(before);
  });
});

describe("a later contact does not re-judge a resolve", () => {
  function boardSettings(core: ReturnType<typeof makeCore>, id: string): string | undefined {
    const row = core.store.getRow(id);
    return (JSON.parse(row?.json ?? "{}").body as { board?: { settings?: string } }).board?.settings;
  }

  function handResolve(team: string, who: ReturnType<typeof tnode>, card: { id: string; key: string }, openId: string, core: ReturnType<typeof makeCore>, reason: string, settings?: string) {
    const open = opEventOf(core.store.getRow(openId)!.json);
    return signed(team, who, "msg.post", {
      text: `Dispute on ${card.key} resolved: ${reason}`, thread: card.id,
      board: { v: 1, rev: 2, op: "dispute", state: "resolved", reason, after: refOf(open), ...(settings ? { settings } : {}) },
    } as BodyOf<"msg.post">, { channel: CH });
  }

  test("removing the contact and naming a new one leaves resolved disputes resolved", async () => {
    const noor = tnode("noor"), kira = tnode("kira"), olive = tnode("olive");
    let t = now();
    const { w, core, idx, team } = teamProject(
      [{ node: noor, role: "member" }, { node: kira, role: "member" }, { node: olive, role: "member" }],
      { clock: () => t, limits: { ...DEFAULT_LIMITS, humanWrite: { capacity: 80, perSecond: 0 } } },
    );
    t = now();
    await updateProject(w, CH, { escalation_contact: "@noor" });
    const head = idx.settingsOf(CH).project?.head;
    const cards = [];
    for (let i = 0; i < 3; i++) {
      const card = await createCard(w, CH, { title: `C${i}` });
      const raised = await raiseDispute(w, card.ref, `Q${i}`);
      expect(boardSettings(core, raised.dispute.id)).toBe(head);
      feed(core, [handResolve(team, noor, card, raised.dispute.id, core, `noor closes ${i}`, head)]);
      idx.flushAll();
      cards.push(card);
    }
    expect(cards.map((c) => showDispute(w, c.ref)?.state)).toEqual(["resolved", "resolved", "resolved"]);
    await expect(raiseDispute(w, cards[0]!.ref, "too soon")).rejects.toMatchObject({ status: 409, message: expect.stringContaining("10 minutes") });

    core.emit("team.member", { login: noor.login, handle: noor.handle, role: "removed" });
    idx.rosterChanged();
    idx.flushAll();
    expect(cards.map((c) => showDispute(w, c.ref)?.state)).toEqual(["resolved", "resolved", "resolved"]);

    const asksBefore = core.store.queryEvents({ channel: CH, kinds: ["ask"], limit: 100 }).length;
    t += 60 * 60 * 1000;
    await updateProject(w, CH, { escalation_contact: "@kira" });
    expect(cards.map((c) => showDispute(w, c.ref)?.resolved_by)).toEqual([{ handle: "noor" }, { handle: "noor" }, { handle: "noor" }]);
    expect(core.store.queryEvents({ channel: CH, kinds: ["ask"], limit: 100 }).length).toBe(asksBefore);
    // Noor has left, so the contact cannot be set back to her. Flip among people who can still be named.
    await updateProject(w, CH, { escalation_contact: "@olive" });
    await updateProject(w, CH, { escalation_contact: null });
    await updateProject(w, CH, { escalation_contact: "@kira" });
    expect(cards.map((c) => showDispute(w, c.ref)?.state)).toEqual(["resolved", "resolved", "resolved"]);
    const fresh = await raiseDispute(w, cards[0]!.ref, "fresh");
    expect(fresh.dispute.state).toBe("open");
    expect(fresh.asks.map((a) => a.to)).toEqual(["@kira"]);
  });

  test("a refused resolve stays refused after its signer is named contact, and a second dispute keeps its own resolve", async () => {
    const noor = tnode("noor"), kira = tnode("kira");
    let t = now();
    const { w, core, idx, team } = teamProject(
      [{ node: noor, role: "member" }, { node: kira, role: "member" }],
      { clock: () => t, limits: { ...DEFAULT_LIMITS, humanWrite: { capacity: 80, perSecond: 0 } } },
    );
    t = now();
    await updateProject(w, CH, { escalation_contact: "@noor" });
    const seen = idx.settingsOf(CH).project?.head ?? "";
    const card = await createCard(w, CH, { title: "Twice" });
    const first = await raiseDispute(w, card.ref, "First");
    const early = handResolve(team, kira, card, first.dispute.id, core, "kira pre-signed this");
    feed(core, [early]);
    idx.flushAll();
    expect(showDispute(w, card.ref)?.state).toBe("open");
    feed(core, [handResolve(team, noor, card, first.dispute.id, core, "first done", seen)]);
    idx.flushAll();
    expect(showDispute(w, card.ref)).toMatchObject({ state: "resolved", summary: "First", resolved_by: { handle: "noor" } });
    expect(boardSettings(core, showDispute(w, card.ref)!.id)).toBe(seen);

    t += 11 * 60 * 1000;
    const second = await raiseDispute(w, card.ref, "Second");
    feed(core, [handResolve(team, noor, card, second.dispute.id, core, "second done", seen)]);
    idx.flushAll();
    expect(showDispute(w, card.ref)).toMatchObject({ state: "resolved", summary: "Second", resolved_by: { handle: "noor" } });

    const stuck = await createCard(w, CH, { title: "Refused" });
    const stuckOpen = await raiseDispute(w, stuck.ref, "Not kira's");
    feed(core, [handResolve(team, kira, stuck, stuckOpen.dispute.id, core, "kira pre-signed this too")]);
    idx.flushAll();
    expect(showDispute(w, stuck.ref)?.state).toBe("open");

    t += 60 * 60 * 1000;
    await updateProject(w, CH, { escalation_contact: "@kira" });
    const after = idx.disputeOf(CH, card.id);
    expect(after.current).toMatchObject({ state: "resolved", summary: "Second", resolved_by: { handle: "noor" } });
    expect(after.ignored.map((x) => x.reason)).not.toContain("already_open");
    expect(showDispute(w, card.ref)?.reason).toBe("second done");
    const refused = idx.disputeOf(CH, stuck.id);
    expect(refused.current?.state).toBe("open");
    expect(refused.current?.resolved_by).toBeUndefined();
    expect(refused.ignored).toEqual([{ id: expect.any(String), reason: "not_resolver" }]);
  });

  test("naming the signer contact in the same millisecond does not accept a resolve that was refused", async () => {
    const noor = tnode("noor"), kira = tnode("kira");
    const { w, core, idx, team } = teamProject(
      [{ node: noor, role: "member" }, { node: kira, role: "member" }],
      { limits: { ...DEFAULT_LIMITS, humanWrite: { capacity: 40, perSecond: 0 } } },
    );
    await updateProject(w, CH, { escalation_contact: "@noor" });
    const card = await createCard(w, CH, { title: "Stuck" });
    const raised = await raiseDispute(w, card.ref, "Who owns the deploy?");
    feed(core, [handResolve(team, kira, card, raised.dispute.id, core, "kira pre-signed this")]);
    idx.flushAll();
    expect(showDispute(w, card.ref)?.state).toBe("open");
    await updateProject(w, CH, { escalation_contact: "@kira" });
    const after = idx.disputeOf(CH, card.id);
    expect(after.current?.state).toBe("open");
    expect(after.current?.resolved_by).toBeUndefined();
    expect(after.ignored.map((x) => x.reason)).toEqual(["not_resolver"]);
  });

  test("the card's creator cannot resolve a dispute about their card while a contact can post", async () => {
    const kira = tnode("kira"), noor = tnode("noor"), dave = tnode("dave");
    let t = now();
    const { team, core, idx, w } = teamProject([
      { node: kira, role: "member" }, { node: noor, role: "member" }, { node: dave, role: "member" },
    ], { clock: () => t, limits: { ...DEFAULT_LIMITS, humanWrite: { capacity: 40, perSecond: 0 } } });
    t = now();
    await updateProject(w, CH, { escalation_contact: "@noor" });
    const boardId = idx.project(CH)!.boards[0]!.id;
    const root = signed(team, kira, "msg.post", {
      text: "Card", board: { v: 1, rev: 0, op: "card", board: boardId, title: "Kira's work", column: "todo" },
    } as BodyOf<"msg.post">, { channel: CH });
    feed(core, [root]);
    idx.flushAll();
    const cardRow = idx.db.card(root.id)!;
    const settings = idx.settingsOf(CH).project?.head;
    const raised = signed(team, dave, "msg.post", {
      text: `Dispute on ${cardRow.key}: kira's work is wrong`, thread: root.id,
      board: { v: 1, rev: 1, op: "dispute", state: "open", summary: "kira's work is wrong", resolvers: ["@noor"], routed: "contact", after: idx.disputeOf(CH, root.id).head, settings },
    } as BodyOf<"msg.post">, { channel: CH });
    feed(core, [raised]);
    idx.flushAll();
    const shown = showDispute(w, cardRow.ref);
    expect(shown?.resolvers).toEqual(["@noor", "@alex"]);
    feed(core, [handResolve(team, kira, { id: root.id, key: cardRow.key }, raised.id, core, "I disagree, closed")]);
    idx.flushAll();
    expect(showDispute(w, cardRow.ref)?.state).toBe("open");
    expect(idx.disputeOf(CH, root.id).ignored.map((x) => x.reason)).toContain("not_resolver");
    feed(core, [handResolve(team, noor, { id: root.id, key: cardRow.key }, raised.id, core, "noor decides", settings)]);
    idx.flushAll();
    expect(showDispute(w, cardRow.ref)).toMatchObject({ state: "resolved", resolved_by: { handle: "noor" } });
  });
});
