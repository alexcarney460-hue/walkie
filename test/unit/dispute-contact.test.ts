// WALK-73: one contact for the project. The settings view, the routing, the resolver list, the 403 gate and the fold all
// read the contact on the chain of the settings head the daemon stamps (the head it names in a new open or resolve).
// A contact change that lost the order to a concurrent edit takes effect nowhere. Real signed events, one daemon per
// person, the real ingest and API.
import { afterEach, describe, expect, test } from "bun:test";
import { createLogger } from "../../src/daemon/logger.ts";
import type { Core } from "../../src/daemon/core.ts";
import { ProjectsIndex } from "../../src/daemon/projects/index.ts";
import "../../src/daemon/projects/routes.ts";
import { createCard, updateProject, type WriteCtx } from "../../src/daemon/projects/service.ts";
import { raiseDispute, resolveDispute, showDispute } from "../../src/daemon/projects/dispute.ts";
import { opEventOf } from "../../src/daemon/projects/db.ts";
import { refOf } from "../../src/protocol/projects/fold.ts";
import { DEFAULT_COLUMNS } from "../../src/protocol/projects/schema.ts";
import type { BodyOf, Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore, statusOf } from "../helpers/core.ts";
import { createTeam, ev as signed, memberEv, nodeEv, tnode, type TNode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const CH = "p-5e7a7e01";

function indexFor(core: Core): ProjectsIndex {
  const idx = new ProjectsIndex(core, createLogger({}));
  cleanups.push(() => idx.stop());
  core.onPostChange = (e, change) => idx.onPost(e, change);
  core.onRosterChange = () => idx.rosterChanged();
  return idx;
}

/** Alex's project plus extra people, ingested locally. A remote feed of Alex's own posts is refused (`self_origin`). */
function teamProject(people: { node: TNode; role: "owner" | "member" }[]) {
  const alex = tnode("alex");
  const { team, create } = createTeam(alex);
  const admitted = people.flatMap((p) => [memberEv(team, alex, p.node, p.role), nodeEv(team, alex, p.node)]);
  const channel = signed(team, alex, "channel.upsert", { name: CH, project: true });
  const root = signed(team, alex, "msg.post", { text: "Project", board: { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB" } } as BodyOf<"msg.post">, { channel: CH });
  const board = signed(team, alex, "msg.post", { text: "Board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } } as BodyOf<"msg.post">, { channel: CH });
  const core = makeCore(alex, team, cleanups);
  const idx = indexFor(core);
  for (const e of [create, ...admitted, channel, root, board]) core.ingest(e, "local");
  idx.flushAll();
  const w: WriteCtx = { core, idx, client: {} as WriteCtx["client"], catchUp: async () => {} };
  return { core, idx, w, team, alex };
}

/** One node's daemon over its own copy of the log: the real ingest, index and API. */
function daemonOf(self: TNode, team: string, clock: () => number) {
  const core = makeCore(self, team, cleanups, { clock });
  const idx = indexFor(core);
  const w: WriteCtx = { core, idx, client: {} as WriteCtx["client"], catchUp: async () => {} };
  return { core, idx, w };
}

/** Every stored event of the given origins, in seq order (what a sync would carry). */
function dump(core: Core, origins: string[]): Event[] {
  return origins.flatMap((o) => core.store.rowsForSync(o, 0, 1_000_000, 1_000_000).map((r) => JSON.parse(r.json) as Event));
}

async function outcome(run: () => Promise<{ state: string; resolved_by?: { handle: string } }>): Promise<string> {
  try { const d = await run(); return `200 ${d.state}${d.resolved_by ? ` by ${d.resolved_by.handle}` : ""}`; } catch (e) { return `${(e as { status?: number }).status}`; }
}

describe("one contact for the project: displayed, asked, gated and judged from the settings head's chain", () => {
  test("a contact change that lost the order to a concurrent edit takes effect nowhere, and its owner can set it again", async () => {
    const alex = tnode("alex");
    // Pat's node id sorts before Olive's, so Pat's contact op is folded before Olive's edit and Olive's edit is the head.
    let pat = tnode("pat"), olive = tnode("olive");
    while (!(pat.keys.nodeId < olive.keys.nodeId)) { pat = tnode("pat"); olive = tnode("olive"); }
    const noor = tnode("noor"), kira = tnode("kira");
    let t = 1_900_000_000_000;
    const clock = () => t;
    const { team, create } = createTeam(alex);
    const people: Array<[TNode, "owner" | "member"]> = [[pat, "owner"], [olive, "owner"], [noor, "member"], [kira, "member"]];
    const admitted = people.flatMap(([n, r]) => [memberEv(team, alex, n, r), nodeEv(team, alex, n)]);
    const channel = signed(team, alex, "channel.upsert", { name: CH, project: true });
    const root = signed(team, alex, "msg.post", { text: "Project", board: { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB" } } as BodyOf<"msg.post">, { channel: CH });
    const board = signed(team, alex, "msg.post", { text: "Board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } } as BodyOf<"msg.post">, { channel: CH });

    const A = daemonOf(alex, team, clock);
    for (const e of [create, ...admitted, channel, root, board]) A.core.ingest(e, "local");
    A.idx.flushAll();
    t += 1000;
    await updateProject(A.w, CH, { escalation_contact: "@noor" });
    const asNoor = A.idx.settingsOf(CH).project!.head;
    const rootId = A.idx.settingsOf(CH).project!.id;
    // Both owners had synced to asNoor and edit offline, concurrently.
    t += 1000;
    const settingsOp = (who: TNode, fields: Record<string, unknown>) => signed(team, who, "msg.post", {
      text: "Settings", thread: rootId, board: { v: 1, rev: 2, op: "project", after: asNoor, ...fields },
    } as BodyOf<"msg.post">, { channel: CH, ts: t });
    const patsChange = settingsOp(pat, { escalation_contact: "@kira" });
    const olivesEdit = settingsOp(olive, { description: "Q4 site" });
    feed(A.core, [patsChange, olivesEdit]);
    A.idx.flushAll();
    const oliveRef = refOf(opEventOf(A.core.store.getRow(olivesEdit.id)!.json));
    // Both ops are accepted. Olive's edit is the head, and the contact on its chain is still noor.
    expect([statusOf(A.core, patsChange.id), statusOf(A.core, olivesEdit.id)]).toEqual(["ok", "ok"]);
    expect(A.idx.settingsOf(CH).project?.head).toBe(oliveRef);
    expect(A.idx.project(CH)).toMatchObject({ escalation_contact: "@noor", description: "Q4 site" });

    t += 86_400_000;
    const card = await createCard(A.w, CH, { title: "Ship it" });
    t += 1000;
    const raised = await raiseDispute(A.w, card.ref, "Who owns the deploy?");
    const openRow = opEventOf(A.core.store.getRow(raised.dispute.id)!.json);
    // Asked, listed and stamped: the displayed contact, and the head the fold will judge by.
    expect(raised.asks.map((a) => a.to)).toEqual(["@noor"]);
    expect(raised.dispute).toMatchObject({ routed: "contact", resolvers: ["@noor", "@alex", "@olive", "@pat"] });
    expect((openRow.board as { settings?: string }).settings).toBe(oliveRef);

    // Kira's machine, fully synced: the settings view shows noor, kira is not a resolver, and her API refuses her.
    const K = daemonOf(kira, team, clock);
    feed(K.core, dump(A.core, [alex.keys.nodeId, pat.keys.nodeId, olive.keys.nodeId]));
    K.idx.flushAll();
    expect(K.idx.project(CH)?.escalation_contact).toBe("@noor");
    expect(showDispute(K.w, card.ref)?.resolvers).not.toContain("@kira");
    t += 1000;
    expect(await outcome(() => resolveDispute(K.w, card.ref, "Kira decides."))).toBe("403");
    // A raw resolve by kira naming the current head (what a hand-signed event would do) is not applied either.
    const kiraRaw = signed(team, kira, "msg.post", { text: "resolved", thread: card.id, board: {
      v: 1, rev: 2, op: "dispute", state: "resolved", reason: "Kira decides.", after: refOf(openRow), settings: oliveRef,
    } } as BodyOf<"msg.post">, { channel: CH, ts: t + 1000 });
    feed(A.core, [kiraRaw]);
    A.idx.flushAll();
    expect(showDispute(A.w, card.ref)?.state).toBe("open");
    expect(A.idx.disputeOf(CH, card.id).ignored).toEqual([{ id: kiraRaw.id, reason: "not_resolver" }]);

    // Noor, the contact everything agrees on: her own daemon's gate lets her through, and the fold applies it.
    const N = daemonOf(noor, team, clock);
    feed(N.core, dump(A.core, [alex.keys.nodeId, pat.keys.nodeId, olive.keys.nodeId]));
    N.idx.flushAll();
    t += 1000;
    expect(await outcome(() => resolveDispute(N.w, card.ref, "Noor decides."))).toBe("200 resolved by noor");
    feed(A.core, dump(N.core, [noor.keys.nodeId]));
    A.idx.flushAll();
    expect(showDispute(A.w, card.ref)).toMatchObject({ state: "resolved", resolved_by: { handle: "noor" } });

    // The owner sees @kira did not stick and sets it again: the new op names the head, so it counts.
    t += 1000;
    expect((await updateProject(A.w, CH, { escalation_contact: "@kira" })).escalation_contact).toBe("@kira");
    expect(A.idx.settingsOf(CH).project?.head).not.toBe(oliveRef);
  });

  test("with one contact everywhere, the gate and the fold agree for the displayed contact and everyone else", async () => {
    const alex = tnode("alex");
    const noor = tnode("noor"), kira = tnode("kira"), bea = tnode("bea");
    let t = 1_900_000_000_000;
    const clock = () => t;
    const { team, create } = createTeam(alex);
    const admitted = [noor, kira, bea].flatMap((n) => [memberEv(team, alex, n, "member"), nodeEv(team, alex, n)]);
    const channel = signed(team, alex, "channel.upsert", { name: CH, project: true });
    const root = signed(team, alex, "msg.post", { text: "Project", board: { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB" } } as BodyOf<"msg.post">, { channel: CH });
    const board = signed(team, alex, "msg.post", { text: "Board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } } as BodyOf<"msg.post">, { channel: CH });
    const A = daemonOf(alex, team, clock);
    for (const e of [create, ...admitted, channel, root, board]) A.core.ingest(e, "local");
    A.idx.flushAll();
    t += 1000;
    await updateProject(A.w, CH, { escalation_contact: "@noor" });
    const card = await createCard(A.w, CH, { title: "Ship it" });
    t += 1000;
    const raised = await raiseDispute(A.w, card.ref, "Who owns the deploy?");
    expect(raised.asks.map((a) => a.to)).toEqual(["@noor"]);
    for (const who of [kira, bea]) {
      const D = daemonOf(who, team, clock);
      feed(D.core, dump(A.core, [alex.keys.nodeId]));
      D.idx.flushAll();
      expect(await outcome(() => resolveDispute(D.w, card.ref, "Not mine to decide."))).toBe("403");
    }
    const N = daemonOf(noor, team, clock);
    feed(N.core, dump(A.core, [alex.keys.nodeId]));
    N.idx.flushAll();
    expect(await outcome(() => resolveDispute(N.w, card.ref, "Noor decides."))).toBe("200 resolved by noor");
  });

  test("the contact raises it: the owners are asked, and the member who created the project cannot resolve it", async () => {
    const alex = tnode("alex"), kira = tnode("kira"), dave = tnode("dave"), noor = tnode("noor");
    // Dave's second machine: his first one signed the project root, and a daemon never ingests its own origin as remote.
    const daveDesk = tnode("dave", "dave@example.com", "dave-desk");
    let t = 1_900_000_000_000;
    const clock = () => t;
    const { team, create } = createTeam(alex);
    const A = daemonOf(alex, team, clock);
    for (const e of [create, memberEv(team, alex, kira, "owner"), nodeEv(team, alex, kira), memberEv(team, alex, dave, "member"), nodeEv(team, alex, dave),
      memberEv(team, alex, noor, "member"), nodeEv(team, alex, noor), nodeEv(team, alex, daveDesk)]) A.core.ingest(e, "local");
    A.core.emit("channel.upsert", { name: CH, project: true, topic: "Walkie project", requested_by: dave.handle });
    const root = signed(team, dave, "msg.post", { text: "Project", board: { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB" } } as BodyOf<"msg.post">, { channel: CH });
    const board = signed(team, dave, "msg.post", { text: "Board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } } as BodyOf<"msg.post">, { channel: CH });
    feed(A.core, [root, board]);
    A.idx.flushAll();
    t += 1000;
    await updateProject(A.w, CH, { escalation_contact: "@noor" });
    const card = await createCard(A.w, CH, { title: "Ship it" });
    const N = daemonOf(noor, team, clock);
    feed(N.core, dump(A.core, [alex.keys.nodeId, dave.keys.nodeId]));
    N.idx.flushAll();
    t += 1000;
    const raised = await raiseDispute(N.w, card.ref, "Who owns the deploy?");
    expect(raised.dispute.routed).toBe("owners");
    expect(raised.asks.map((a) => a.to)).toEqual(["@alex", "@kira"]);
    expect(raised.dispute.resolvers).toEqual(["@alex", "@kira"]);
    const D = daemonOf(daveDesk, team, clock);
    feed(D.core, [...dump(A.core, [alex.keys.nodeId, dave.keys.nodeId]), ...dump(N.core, [noor.keys.nodeId])]);
    D.idx.flushAll();
    t += 1000;
    expect(await outcome(() => resolveDispute(D.w, card.ref, "Dave decides."))).toBe("403");
    // An owner who was asked resolves it.
    feed(A.core, dump(N.core, [noor.keys.nodeId]));
    A.idx.flushAll();
    expect(await outcome(() => resolveDispute(A.w, card.ref, "Alex decides."))).toBe("200 resolved by alex");
  });

  test("a dispute raised under settings that cannot be used: a member is told an owner must resolve it, an owner can", async () => {
    const noor = tnode("noor"), dave = tnode("dave");
    const { w, core, idx, team } = teamProject([{ node: noor, role: "member" }, { node: dave, role: "member" }]);
    await updateProject(w, CH, { escalation_contact: "@noor" });
    const card = await createCard(w, CH, { title: "Ship it" });
    const rootId = idx.settingsOf(CH).project!.id;
    // Dave is not a project admin: his settings op is accepted but the fold ignores it, so it is here and unusable.
    const ignored = signed(team, dave, "msg.post", {
      text: "Settings", thread: rootId, board: { v: 1, rev: 3, op: "project", after: idx.settingsOf(CH).project!.head, description: "mine" },
    } as BodyOf<"msg.post">, { channel: CH });
    feed(core, [ignored]);
    idx.flushAll();
    const named = refOf(opEventOf(core.store.getRow(ignored.id)!.json));
    expect(idx.settingsOf(CH).project?.head).not.toBe(named);
    const open = signed(team, dave, "msg.post", {
      text: `Dispute on ${card.key}: Who owns the deploy?`, thread: card.id,
      board: {
        v: 1, rev: 1, op: "dispute", state: "open", summary: "Who owns the deploy?", resolvers: ["@noor"], routed: "contact",
        after: idx.disputeOf(CH, card.id).head, settings: named,
      },
    } as BodyOf<"msg.post">, { channel: CH });
    feed(core, [open]);
    idx.flushAll();
    // Noor is still the project contact, but this dispute lists only the owners who can actually resolve it.
    const N = daemonOf(noor, team, () => core.clock());
    feed(N.core, dump(core, [core.nodeId, dave.keys.nodeId]));
    N.idx.flushAll();
    expect(showDispute(N.w, card.ref)?.resolvers).not.toContain("@noor");
    const before = N.core.store.allocatedSelfSeq(N.core.nodeId);
    await expect(resolveDispute(N.w, card.ref, "Noor decides.")).rejects.toMatchObject({
      status: 403, message: "this dispute names project settings that cannot be used (hidden or invalid), so only an owner can resolve it",
    });
    expect(N.core.store.allocatedSelfSeq(N.core.nodeId)).toBe(before);
    expect(await outcome(() => resolveDispute(w, card.ref, "The owner decides."))).toBe("200 resolved by alex");
  });
});
