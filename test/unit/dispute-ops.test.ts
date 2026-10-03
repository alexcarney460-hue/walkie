// WALK-73: a dispute is a board op in the card's thread. The fold keeps one current dispute; a pre.12 union has no
// such op, so that fold ignores it, while msg.post still accepts the post (no new event kind, so nothing stalls).
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import { foldCard, refOf, type OpEvent } from "../../src/protocol/projects/fold.ts";
import { chooseResolvers, foldDispute, settingsHeadState } from "../../src/protocol/projects/dispute.ts";
import {
  BoardOp, BoardOpSchema, CardOp, DEFAULT_COLUMNS, DisputeOp, FileOp, PageOp, ProjectOp, isBoardOp,
} from "../../src/protocol/projects/schema.ts";
import { Bodies, KindSchema } from "../../src/protocol/schemas.ts";

const CH = "p-5e7a7e01";
const hashOf = (id: string) => createHash("sha256").update(`sig-${id}`).digest("hex").slice(0, 16);
let seq = 0;
function op(handle: string, board: unknown, opts: { thread?: string; agent?: string; hidden?: boolean } = {}): OpEvent {
  seq++;
  const origin = "a000000000000001";
  const id = `${origin}:${seq}`;
  return {
    id, origin, seq, ts: 1_700_000_000_000 + seq * 1000, h: hashOf(id),
    author: { handle, node: origin, ...(opts.agent ? { agent: opts.agent } : {}) },
    ...(opts.thread ? { thread: opts.thread } : {}), text: "op", board, ...(opts.hidden ? { hidden: true } : {}),
  };
}

const env = {
  roleOf: (e: OpEvent) => ({ alex: "owner", kira: "member", bob: "observer" } as const)[e.author.handle as "alex" | "kira" | "bob"] ?? null,
  // Alex created the card. He is listed because he is an owner, not because he created the card.
  owners: ["alex"],
};
const boardId = "a000000000000001:1";
const cardRoot = () => op("alex", { v: 1, rev: 0, op: "card", board: boardId, title: "Ship it", column: "todo" });
const openBody = (summary = "Who owns the deploy?", resolvers = ["@alex"], routed = "contact") =>
  ({ v: 1, rev: 1, op: "dispute", state: "open", summary, resolvers, routed });

function opened(card: OpEvent, who = "alex", extra: { agent?: string; after?: string; summary?: string; resolvers?: string[]; routed?: "contact" | "creator" | "owners" } = {}) {
  return op(who, { ...openBody(extra.summary, extra.resolvers, extra.routed), ...(extra.after ? { after: extra.after } : { after: refOf(card) }) }, { thread: card.id, ...(extra.agent ? { agent: extra.agent } : {}) });
}

describe("the dispute op", () => {
  test("parses an open and a resolve, and is a board op in a project channel", () => {
    expect(DisputeOp.safeParse(openBody()).success).toBe(true);
    expect(DisputeOp.safeParse({ v: 1, rev: 2, op: "dispute", state: "resolved", reason: "Ship Friday." }).success).toBe(true);
    expect(DisputeOp.safeParse({ v: 1, rev: 1, op: "dispute", state: "escalated" }).success).toBe(false);
    expect(BoardOpSchema.safeParse(openBody()).success).toBe(true);
    const post = { text: "Dispute on WEB-12: Who owns the deploy?", thread: "a000000000000001:2", board: openBody() };
    expect(isBoardOp({ kind: "msg.post", channel: CH, body: post })).toBe(true);
    expect(isBoardOp({ kind: "msg.post", channel: "general", body: post })).toBe(false);
    expect(KindSchema.safeParse("dispute").success).toBe(false);
  });

  test("a body over 16 KB is an ordinary post, still a valid msg.post", () => {
    const huge = { text: "x".repeat(20_000), thread: "a000000000000001:2", board: openBody() };
    expect(isBoardOp({ kind: "msg.post", channel: CH, body: huge })).toBe(false);
    expect(Bodies["msg.post"].safeParse(huge).success).toBe(true);
  });
});

describe("foldDispute", () => {
  test("raise then resolve is the current dispute; the head moves only when an op applies", () => {
    const card = cardRoot();
    const raised = opened(card, "kira");
    const open = foldDispute([raised], card, env);
    expect(open.current).toMatchObject({ state: "open", summary: "Who owns the deploy?", resolvers: ["@alex"], routed: "contact", by: { handle: "kira" } });
    expect(open.head).toBe(refOf(raised));
    const resolved = op("alex", { v: 1, rev: 2, op: "dispute", state: "resolved", reason: "Ship Friday.", after: refOf(raised) }, { thread: card.id });
    const done = foldDispute([raised, resolved], card, env);
    expect(done.current).toMatchObject({ state: "resolved", summary: "Who owns the deploy?", reason: "Ship Friday.", resolved_by: { handle: "alex" } });
    expect(done.head).toBe(refOf(resolved));
    expect(done.ignored).toEqual([]);
  });

  test("a second open while one is open is ignored and does not move the head", () => {
    const card = cardRoot();
    const first = opened(card, "alex", { summary: "First" });
    const second = opened(card, "kira", { summary: "Second", after: refOf(card) });
    const folded = foldDispute([first, second], card, env);
    expect(folded.current?.summary).toBe("First");
    expect(folded.head).toBe(refOf(first));
    expect(folded.ignored).toEqual([{ id: second.id, reason: "already_open" }]);
  });

  test("the wrong person and an agent cannot resolve, and a resolve with nothing open does not apply", () => {
    const card = cardRoot();
    const raised = opened(card);
    const stranger = op("kira", { v: 1, rev: 2, op: "dispute", state: "resolved", reason: "I say so.", after: refOf(raised) }, { thread: card.id });
    const agent = op("alex", { v: 1, rev: 2, op: "dispute", state: "resolved", reason: "I say so.", after: refOf(raised) }, { thread: card.id, agent: "cc-1" });
    const early = op("alex", { v: 1, rev: 1, op: "dispute", state: "resolved", reason: "Too soon.", after: refOf(card) }, { thread: card.id });
    const folded = foldDispute([early, raised, stranger, agent], card, env);
    expect(folded.current?.state).toBe("open");
    expect(folded.head).toBe(refOf(raised));
    expect(folded.ignored.map((x) => x.reason).sort()).toEqual(["not_open", "not_resolver", "not_resolver"]);
  });

  test("an observer's open is not a dispute, and an incomplete op is ignored", () => {
    const card = cardRoot();
    const watcher = opened(card, "bob");
    const half = op("alex", { v: 1, rev: 1, op: "dispute", state: "open", summary: "No resolvers named.", after: refOf(card) }, { thread: card.id });
    const folded = foldDispute([watcher, half], card, env);
    expect(folded.current).toBeNull();
    expect(folded.head).toBe(refOf(card));
    expect(folded.ignored.map((x) => x.reason).sort()).toEqual(["incomplete", "not_member"]);
  });

  test("a resolved dispute can be opened again, and that open is the current one", () => {
    const card = cardRoot();
    const raised = opened(card, "alex", { summary: "First" });
    const resolved = op("alex", { v: 1, rev: 2, op: "dispute", state: "resolved", reason: "Done.", after: refOf(raised) }, { thread: card.id });
    const again = opened(card, "kira", { summary: "Second", after: refOf(resolved) });
    const folded = foldDispute([raised, resolved, again], card, env);
    expect(folded.current).toMatchObject({ state: "open", summary: "Second", by: { handle: "kira" } });
    expect(folded.head).toBe(refOf(again));
  });

  test("a resolve matches the contact by handle, whichever machine the contact named", () => {
    const card = cardRoot();
    const raised = opened(card, "kira", { resolvers: ["@kira"] });
    const resolved = op("noor", { v: 1, rev: 2, op: "dispute", state: "resolved", reason: "Agreed.", after: refOf(raised) }, { thread: card.id });
    const dir = {
      roleOf: (e: OpEvent) => (e.author.handle === "noor" || e.author.handle === "kira" ? "member" : e.author.handle === "alex" ? "owner" : null),
      contact: "@noor/noor-mbp", projectCreator: "maren", owners: ["alex"],
    };
    expect(foldDispute([raised, resolved], card, dir).current?.state).toBe("resolved");
  });

  test("a forged resolver list does not decide who may resolve", () => {
    const card = op("bea", { v: 1, rev: 0, op: "card", board: boardId, title: "Ship it", column: "todo" });
    const raised = opened(card, "kira", { resolvers: ["@kira"], routed: "contact" });
    const roles: Record<string, "owner" | "member"> = { alex: "owner", olive: "owner", kira: "member", noor: "member", bea: "member", maren: "member" };
    const dir = {
      roleOf: (e: OpEvent) => roles[e.author.handle] ?? null,
      contact: "@noor/noor-mbp", projectCreator: "maren", owners: ["olive", "alex"],
    };
    const open = foldDispute([raised], card, dir);
    // Contact, then owners. The project's creator (maren) and the card's creator (bea) are not resolvers while the contact can post.
    expect(open.current?.resolvers).toEqual(["@noor/noor-mbp", "@alex", "@olive"]);
    const resolve = (who: string) => op(who, { v: 1, rev: 2, op: "dispute", state: "resolved", reason: `${who} decides.`, after: refOf(raised) }, { thread: card.id });
    for (const who of ["kira", "maren", "bea"]) {
      const folded = foldDispute([raised, resolve(who)], card, dir);
      expect(folded.current?.state).toBe("open");
      expect(folded.ignored.map((x) => x.reason)).toContain("not_resolver");
    }
    for (const who of ["noor", "olive", "alex"]) {
      expect(foldDispute([raised, resolve(who)], card, dir).current?.resolved_by).toEqual({ handle: who });
    }
  });

  test("a removed contact cannot resolve, and an owner still can", () => {
    const card = cardRoot();
    const raised = opened(card, "kira", { resolvers: ["@noor"] });
    const role = (handle: string) => (handle === "noor" ? "removed" : handle === "alex" ? "owner" : "member");
    const dir = { roleOf: (e: OpEvent) => role(e.author.handle), roleNow: role, contact: "@noor", projectCreator: "alex", owners: ["alex"] };
    const open = foldDispute([raised], card, dir);
    expect(open.current?.resolvers.map((a) => a.replace(/^@/, "").split("/")[0])).toEqual(["alex"]);
    const byNoor = op("noor", { v: 1, rev: 2, op: "dispute", state: "resolved", reason: "Noor decides.", after: refOf(raised) }, { thread: card.id });
    const byAlex = op("alex", { v: 1, rev: 2, op: "dispute", state: "resolved", reason: "Alex decides.", after: refOf(raised) }, { thread: card.id });
    const folded = foldDispute([raised, byNoor, byAlex], card, dir);
    expect(folded.current?.state).toBe("resolved");
    expect(folded.current?.resolved_by).toEqual({ handle: "alex" });
    expect(folded.ignored.map((x) => x.reason)).toContain("not_member");
  });
});

describe("a pre.12 fold", () => {
  test("ignores the dispute, accepts the post, and leaves the card's fold alone", () => {
    const OlderProject = ProjectOp.omit({ escalation_contact: true });
    const OlderBoard = z.discriminatedUnion("op", [OlderProject, BoardOp, CardOp, FileOp, PageOp]);
    const dispute = openBody();
    expect(OlderBoard.safeParse(dispute).success).toBe(false);
    expect(BoardOpSchema.safeParse(dispute).success).toBe(true);
    const body = { text: "Dispute on WEB-12: Who owns the deploy?", thread: "a000000000000001:2", board: dispute };
    expect(Bodies["msg.post"].safeParse(body).success).toBe(true);
    expect(KindSchema.options).not.toContain("dispute");

    const card = cardRoot();
    const raised = opened(card);
    const ctx = { boards: new Map([[boardId, { id: boardId, columns: [...DEFAULT_COLUMNS] }]]) };
    const before = foldCard(card, [raised], ctx);
    expect(before?.title).toBe("Ship it");
    expect(before?.comments).toBe(0);
    expect(before?.rev).toBe(0);
    expect(before?.head).toBe(refOf(card));
    expect(before?.timeline.some((t) => t.kind === "comment")).toBe(false);

    const renamed = op("alex", { v: 1, rev: 1, op: "card", title: "Renamed", after: refOf(card) }, { thread: card.id });
    const after = foldCard(card, [raised, renamed], ctx);
    expect(after?.title).toBe("Renamed");
    expect(after?.head).toBe(refOf(renamed));
    expect(after?.comments).toBe(0);
  });
});

describe("the contact at that resolve", () => {
  // A later settings op must not change a resolve that already applied or was already refused. The current contact
  // (env.contact) is who a reader would ask now; the fold does not judge a past resolve by it.
  const roles: Record<string, "owner" | "member"> = { alex: "owner", olive: "owner", pat: "owner", kira: "member", noor: "member", bea: "member", maren: "member", dave: "member" };
  const roleOf = (e: OpEvent) => roles[e.author.handle] ?? null;
  const settingsEnv = { creator: "alex", roleOf };
  let n = 0;
  function ev(handle: string, board: unknown, opts: { thread?: string; ts: number; origin?: string }): OpEvent {
    n++;
    const origin = opts.origin ?? "b000000000000001";
    const id = `${origin}:${n}`;
    return {
      id, origin, seq: n, ts: opts.ts, h: hashOf(id), author: { handle, node: origin },
      ...(opts.thread ? { thread: opts.thread } : {}), text: "op", board,
    };
  }
  const project = () => ev("alex", { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB" }, { ts: 1_800_000_000_000 });
  const contactOp = (root: OpEvent, parent: OpEvent, value: string | null, ts: number) =>
    ev("alex", { v: 1, rev: 1, op: "project", after: refOf(parent), escalation_contact: value }, { thread: root.id, ts });
  const cardOf = (who: string) => ev(who, { v: 1, rev: 0, op: "card", board: boardId, title: "Ship it", column: "todo" }, { ts: 1_800_000_010_000 });
  const openOf = (card: OpEvent, who: string, ts: number, settings?: string) => ev(who, {
    v: 1, rev: 1, op: "dispute", state: "open", summary: "Who owns the deploy?", resolvers: ["@kira"], routed: "contact",
    after: refOf(card), ...(settings ? { settings } : {}),
  }, { thread: card.id, ts });
  const resolveOf = (card: OpEvent, parent: OpEvent, who: string, ts: number, settings?: string, reason = `${who} decides.`) => ev(who, {
    v: 1, rev: 2, op: "dispute", state: "resolved", reason, after: refOf(parent), ...(settings ? { settings } : {}),
  }, { thread: card.id, ts });

  test("a settings head is kept on the op, and a head that is not one is not a dispute op", () => {
    const head = refOf(project());
    const parsed = DisputeOp.safeParse({ ...openBody(), settings: head });
    expect(parsed.success && parsed.data.settings).toBe(head);
    expect(DisputeOp.safeParse({ ...openBody(), settings: "not-a-head" }).success).toBe(false);
    expect(DisputeOp.safeParse(openBody()).success).toBe(true);
  });

  test("naming the contact later does not reopen a resolve, and does not accept one that was refused", () => {
    const root = project();
    const asNoor = contactOp(root, root, "@noor", 1_800_000_001_000);
    const asKira = contactOp(root, asNoor, "@kira", 1_800_000_050_000);
    const card = cardOf("bea");
    const raised = openOf(card, "dave", 1_800_000_020_000, refOf(asNoor));
    const byNoor = resolveOf(card, raised, "noor", 1_800_000_030_000, refOf(asNoor));
    const posts = [root, asNoor, asKira];
    const judged = (contact: string) => foldDispute([raised, byNoor], card, {
      roleOf, contact, projectCreator: "maren", owners: ["alex"], settingsPosts: posts, settingsEnv,
    });
    // The project says @kira now. Noor resolved while the head she named still said @noor.
    for (const contact of ["@kira", "@noor", ""]) {
      expect(judged(contact).current).toMatchObject({ state: "resolved", resolved_by: { handle: "noor" } });
      expect(judged(contact).ignored).toEqual([]);
    }
    // A peer that has not yet stored the later settings op folds the same outcome.
    const peer = foldDispute([raised, byNoor], card, {
      roleOf, contact: "@noor", projectCreator: "maren", owners: ["alex"], settingsPosts: [root, asNoor], settingsEnv,
    });
    expect(peer.current).toMatchObject({ state: "resolved", resolved_by: { handle: "noor" } });

    const early = resolveOf(card, raised, "kira", 1_800_000_025_000);
    const refused = foldDispute([raised, early], card, {
      roleOf, contact: "@kira", projectCreator: "maren", owners: ["alex"], settingsPosts: posts, settingsEnv,
    });
    expect(refused.current?.state).toBe("open");
    expect(refused.ignored).toEqual([{ id: early.id, reason: "not_resolver" }]);
  });

  test("a contact change in the same millisecond does not accept a refused resolve or reopen one", () => {
    const root = project();
    const asNoor = contactOp(root, root, "@noor", 1_800_000_001_000);
    const card = cardOf("bea");
    const raised = openOf(card, "dave", 1_800_000_020_000, refOf(asNoor));
    const byNoor = resolveOf(card, raised, "noor", 1_800_000_030_000, refOf(asNoor), "Noor decides.");
    const byKira = resolveOf(card, raised, "kira", 1_800_000_030_000, refOf(asNoor));
    // Same timestamp as those resolves, and an origin that sorts first. It is not on asNoor's chain.
    const tied = ev("alex", { v: 1, rev: 1, op: "project", after: refOf(asNoor), escalation_contact: "@kira" }, {
      thread: root.id, ts: byNoor.ts, origin: "a000000000000001",
    });
    const dir = {
      roleOf, contact: "@kira", projectCreator: "maren", owners: ["alex"],
      settingsPosts: [root, asNoor, tied], settingsEnv,
    };
    expect(foldDispute([raised, byNoor], card, dir).current).toMatchObject({ state: "resolved", resolved_by: { handle: "noor" } });
    const refused = foldDispute([raised, byKira], card, dir);
    expect(refused.current?.state).toBe("open");
    expect(refused.ignored).toEqual([{ id: byKira.id, reason: "not_resolver" }]);
  });

  test("an open or resolve that omits settings grants no contact or creator authority", () => {
    const root = project();
    const asNoor = contactOp(root, root, "@noor", 1_800_000_001_000);
    const asKira = contactOp(root, asNoor, "@kira", 1_800_000_005_000);
    const card = cardOf("bea");
    const raised = openOf(card, "dave", 1_800_000_020_000, refOf(asKira));
    // Noor was replaced before the dispute. She omits settings and stamps a time from when she was still the contact.
    const backdated = resolveOf(card, raised, "noor", 1_800_000_002_000);
    const dir = {
      roleOf, contact: "@kira", projectCreator: "maren", owners: ["alex"],
      settingsPosts: [root, asNoor, asKira], settingsEnv,
    };
    const stayed = foldDispute([raised, backdated], card, dir);
    expect(stayed.current?.state).toBe("open");
    expect(stayed.ignored).toEqual([{ id: backdated.id, reason: "not_resolver" }]);
    // The project's creator, a member, backdates to before any contact existed.
    const bareCreator = resolveOf(card, raised, "maren", 1_800_000_000_500);
    const creatorFold = foldDispute([raised, bareCreator], card, dir);
    expect(creatorFold.current?.state).toBe("open");
    expect(creatorFold.ignored).toEqual([{ id: bareCreator.id, reason: "not_resolver" }]);
    // An owner does not need a head.
    const owner = resolveOf(card, raised, "alex", 1_800_000_030_000, undefined, "Alex decides.");
    expect(foldDispute([raised, owner], card, dir).current).toMatchObject({ state: "resolved", resolved_by: { handle: "alex" } });
    // An open that omits settings grants none either, even when the resolve names a real head.
    const bareOpen = openOf(card, "dave", 1_800_000_020_000 + 23 * 3_600_000);
    const byNoor = resolveOf(card, bareOpen, "noor", 1_800_000_030_000, refOf(asNoor), "Noor decides.");
    const edit = ev("alex", { v: 1, rev: 1, op: "project", after: refOf(asNoor), description: "later" }, { thread: root.id, ts: 1_800_000_060_000 });
    const before = foldDispute([bareOpen, byNoor], card, { ...dir, settingsPosts: [root, asNoor], contact: "@noor" });
    const after = foldDispute([bareOpen, byNoor], card, { ...dir, settingsPosts: [root, asNoor, edit], contact: "@noor" });
    expect(before.current?.state).toBe("open");
    expect(after.current?.state).toBe("open");
    expect(after.ignored.map((x) => x.reason)).toEqual(["not_resolver"]);
  });

  test("two disputes on one card each keep the resolve they already had", () => {
    const root = project();
    const asNoor = contactOp(root, root, "@noor", 1_800_000_001_000);
    const asKira = contactOp(root, asNoor, "@kira", 1_800_000_090_000);
    const card = cardOf("bea");
    const head = refOf(asNoor);
    const first = openOf(card, "dave", 1_800_000_020_000, head);
    const firstDone = resolveOf(card, first, "noor", 1_800_000_030_000, head, "First done.");
    const second = ev("dave", {
      v: 1, rev: 3, op: "dispute", state: "open", summary: "Second", resolvers: ["@kira"], routed: "contact",
      after: refOf(firstDone), settings: head,
    }, { thread: card.id, ts: 1_800_000_040_000 });
    const secondDone = resolveOf(card, second, "noor", 1_800_000_050_000, head, "Second done.");
    const folded = foldDispute([first, firstDone, second, secondDone], card, {
      roleOf, contact: "@kira", projectCreator: "maren", owners: ["alex", "olive"],
      settingsPosts: [root, asNoor, asKira], settingsEnv,
    });
    expect(folded.current).toMatchObject({ state: "resolved", summary: "Second", reason: "Second done.", resolved_by: { handle: "noor" } });
    expect(folded.ignored.filter((x) => x.reason === "not_resolver" || x.reason === "already_open")).toEqual([]);
  });

  test("a concurrent settings op does not change the contact at a named head", () => {
    const root = project();
    const asNoor = contactOp(root, root, "@noor", 1_800_000_001_000);
    // Olive's edit does not touch the contact. Pat, offline since asNoor, names @kira with the same parent.
    // Pat's origin sorts first, so a global fold applies Pat before Olive and would paint Olive's head with @kira.
    const olive = ev("olive", { v: 1, rev: 1, op: "project", after: refOf(asNoor), description: "Q4 site" }, {
      thread: root.id, ts: 1_800_000_002_000, origin: "d000000000000001",
    });
    const pat = ev("pat", { v: 1, rev: 1, op: "project", after: refOf(asNoor), escalation_contact: "@kira" }, {
      thread: root.id, ts: 1_800_000_040_000, origin: "a000000000000001",
    });
    const card = cardOf("bea");
    const raised = openOf(card, "dave", 1_800_000_020_000, refOf(olive));
    const byNoor = resolveOf(card, raised, "noor", 1_800_000_030_000, refOf(olive), "Noor decides.");
    const byKira = resolveOf(card, raised, "kira", 1_800_000_030_000, refOf(olive));
    const judge = (posts: OpEvent[], who: OpEvent) => foldDispute([raised, who], card, {
      roleOf, contact: "@kira", projectCreator: "maren", owners: ["alex", "olive", "pat"],
      settingsPosts: posts, settingsEnv,
    });
    const before = judge([root, asNoor, olive], byNoor);
    const after = judge([root, asNoor, olive, pat], byNoor);
    expect(before.current).toMatchObject({ state: "resolved", resolved_by: { handle: "noor" } });
    expect(after.current).toMatchObject({ state: "resolved", resolved_by: { handle: "noor" } });
    expect(after.ignored).toEqual([]);
    expect(judge([root, asNoor, olive], byKira).current?.state).toBe("open");
    expect(judge([root, asNoor, olive, pat], byKira).current?.state).toBe("open");
    expect(judge([root, asNoor, olive, pat], byKira).ignored).toEqual([{ id: byKira.id, reason: "not_resolver" }]);
  });

  test("a settings op that is not an ancestor of the named head never changes a dispute verdict", () => {
    const root = project();
    const asNoor = contactOp(root, root, "@noor", 1_800_000_001_000);
    const olive = ev("olive", { v: 1, rev: 1, op: "project", after: refOf(asNoor), description: "Q4 site" }, {
      thread: root.id, ts: 1_800_000_002_000, origin: "d000000000000001",
    });
    const card = cardOf("bea");
    const raised = openOf(card, "dave", 1_800_000_020_000, refOf(olive));
    const byNoor = resolveOf(card, raised, "noor", 1_800_000_030_000, refOf(olive), "Noor decides.");
    const byKira = resolveOf(card, raised, "kira", 1_800_000_030_000, refOf(olive));
    const tooOld = resolveOf(card, raised, "noor", 1_800_000_031_000, refOf(asNoor));
    const bare = resolveOf(card, raised, "noor", 1_800_000_002_000);
    const base = [root, asNoor, olive];
    const verdict = (extra: OpEvent[]) => {
      const posts = [...base, ...extra];
      const fold = (who: OpEvent) => foldDispute([raised, who], card, {
        roleOf, contact: "@olive", projectCreator: "maren", owners: ["alex", "olive", "pat"],
        settingsPosts: posts, settingsEnv,
      });
      const one = (who: OpEvent) => {
        const s = fold(who);
        return `${s.current?.state}:${s.current?.resolved_by?.handle ?? ""}:${s.ignored.map((x) => x.reason).join(",")}`;
      };
      return [one(byNoor), one(byKira), one(tooOld), one(bare)].join("|");
    };
    const before = verdict([]);
    expect(before.startsWith("resolved:noor:")).toBe(true);
    // The op that used to flip the verdict: a sibling of Olive, smaller origin, later wall clock, contact @kira.
    const pat = ev("pat", { v: 1, rev: 1, op: "project", after: refOf(asNoor), escalation_contact: "@kira" }, {
      thread: root.id, ts: 1_800_000_040_000, origin: "a000000000000001",
    });
    const extras: OpEvent[][] = [[pat]];
    let seed = 0x5eed;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const origins = ["a000000000000001", "c000000000000001", "e000000000000001", "f000000000000001"];
    const authors = ["alex", "olive", "pat"] as const;
    for (let i = 0; i < 40; i++) {
      const batch: OpEvent[] = [];
      const pool = [...base];
      const count = 1 + Math.floor(rnd() * 4);
      for (let k = 0; k < count; k++) {
        const parent = pool[Math.floor(rnd() * pool.length)] ?? root;
        const kind = Math.floor(rnd() * 3);
        const fields = kind === 0
          ? { escalation_contact: "@kira" }
          : kind === 1
            ? { description: `note ${i} ${k}` }
            : { escalation_contact: null };
        const origin = origins[Math.floor(rnd() * origins.length)] ?? origins[0];
        const who = authors[Math.floor(rnd() * authors.length)] ?? "alex";
        const op = ev(who, { v: 1, rev: 1, op: "project", after: refOf(parent), ...fields }, {
          thread: root.id, ts: 1_700_000_000_000 + Math.floor(rnd() * 400_000_000_000), origin,
        });
        batch.push(op);
        pool.push(op);
      }
      extras.push(batch);
    }
    for (const extra of extras) expect(verdict(extra)).toBe(before);
  });

  test("a resolve that names an unknown head or a head older than the open is refused, and an owner still resolves", () => {
    const root = project();
    const asNoor = contactOp(root, root, "@noor", 1_800_000_001_000);
    const asKira = contactOp(root, asNoor, "@kira", 1_800_000_002_000);
    const card = cardOf("bea");
    const raised = openOf(card, "dave", 1_800_000_020_000, refOf(asKira));
    const unknown = "b000000000000099:1#0123456789abcdef";
    const dir = {
      roleOf, contact: "@noor", projectCreator: "maren", owners: ["alex"],
      settingsPosts: [root, asNoor, asKira], settingsEnv,
    };
    const byNoor = resolveOf(card, raised, "noor", 1_800_000_030_000, unknown);
    const unknownFold = foldDispute([raised, byNoor], card, dir);
    expect(unknownFold.current?.state).toBe("open");
    // Not here yet: sync may change it, so it is shown as waiting for the settings and not as refused.
    expect(unknownFold.ignored).toEqual([{ id: byNoor.id, reason: "waiting_for_settings" }]);
    const tooOld = resolveOf(card, raised, "noor", 1_800_000_031_000, refOf(asNoor));
    const oldFold = foldDispute([raised, tooOld], card, dir);
    expect(oldFold.current?.state).toBe("open");
    expect(oldFold.ignored).toEqual([{ id: tooOld.id, reason: "not_resolver" }]);
    const owner = resolveOf(card, raised, "alex", 1_800_000_032_000, unknown, "Alex decides.");
    expect(foldDispute([raised, owner], card, dir).current).toMatchObject({ state: "resolved", resolved_by: { handle: "alex" } });
    // Citing the open's own head still grants the contact at that head, after a later change is in the log.
    const cited = resolveOf(card, raised, "kira", 1_800_000_033_000, refOf(asKira));
    expect(foldDispute([raised, cited], card, { ...dir, contact: "@noor" }).current?.resolved_by).toEqual({ handle: "kira" });
  });

  test("the card's creator cannot close a dispute about their own card, and the raiser cannot close their own", () => {
    const card = cardOf("kira");
    const raised = openOf(card, "dave", 1_800_000_020_000);
    const dir = { roleOf, contact: "@noor/noor-mbp", projectCreator: "maren", owners: ["alex", "olive"] };
    const open = foldDispute([raised], card, dir);
    expect(open.current?.resolvers).toEqual(["@noor/noor-mbp", "@alex", "@olive"]);
    const resolve = (who: string) => resolveOf(card, raised, who, 1_800_000_030_000);
    for (const who of ["kira", "maren", "dave"]) {
      const folded = foldDispute([raised, resolve(who)], card, dir);
      expect(folded.current?.state).toBe("open");
      expect(folded.ignored.map((x) => x.reason)).toContain("not_resolver");
    }
    expect(foldDispute([raised, resolve("noor")], card, dir).current?.resolved_by).toEqual({ handle: "noor" });

    const self = openOf(card, "noor", 1_800_000_021_000);
    const selfResolve = resolveOf(card, self, "noor", 1_800_000_031_000);
    const refused = foldDispute([self, selfResolve], card, dir);
    expect(refused.current?.state).toBe("open");
    expect(refused.ignored).toEqual([{ id: selfResolve.id, reason: "not_resolver" }]);
    expect(foldDispute([self, resolveOf(card, self, "alex", 1_800_000_032_000)], card, dir).current?.resolved_by).toEqual({ handle: "alex" });
  });

  test("a removed contact is not in effect, so the project's creator can resolve and the card's creator cannot", () => {
    const card = cardOf("kira");
    const raised = openOf(card, "dave", 1_800_000_020_000);
    const role = (handle: string) => (handle === "noor" ? "removed" : roles[handle] ?? null);
    const dir = { roleOf: (e: OpEvent) => role(e.author.handle), roleNow: role, roleAt: (_e: OpEvent, handle: string) => role(handle), contact: "@noor", projectCreator: "maren", owners: ["alex"] };
    expect(foldDispute([raised], card, dir).current?.resolvers).toEqual(["@maren", "@alex"]);
    const byKira = resolveOf(card, raised, "kira", 1_800_000_030_000);
    const byMaren = resolveOf(card, raised, "maren", 1_800_000_031_000, undefined, "Maren decides.");
    const folded = foldDispute([raised, byKira, byMaren], card, dir);
    expect(folded.current).toMatchObject({ state: "resolved", resolved_by: { handle: "maren" } });
    expect(folded.ignored.map((x) => x.reason)).toContain("not_resolver");
  });

  test("a resolve whose settings ancestors have not arrived waits, then applies once they do, and never shows refused", () => {
    const root = project();
    const asNoor = contactOp(root, root, "@noor", 1_800_000_001_000);
    const asKira = contactOp(root, asNoor, "@kira", 1_800_000_002_000);
    const card = cardOf("bea");
    const raised = openOf(card, "dave", 1_800_000_020_000, refOf(asKira));
    const byKira = resolveOf(card, raised, "kira", 1_800_000_030_000, refOf(asKira));
    const judge = (posts: OpEvent[]) => foldDispute([raised, byKira], card, {
      roleOf, contact: "@kira", projectCreator: "maren", owners: ["alex"], settingsPosts: posts, settingsEnv,
    });
    const lagging = judge([root, asKira]);
    expect(lagging.current?.state).toBe("open");
    expect(lagging.ignored).toEqual([{ id: byKira.id, reason: "waiting_for_settings" }]);
    expect(judge([root, asNoor, asKira]).current).toMatchObject({ state: "resolved", resolved_by: { handle: "kira" } });
    // A head that is here and unusable is a refusal, not a wait: sync will not change it.
    const hidden = { ...contactOp(root, asNoor, "@bea", 1_800_000_003_000), hidden: true };
    const byBea = resolveOf(card, raised, "bea", 1_800_000_031_000, refOf(hidden));
    const refused = foldDispute([raised, byBea], card, {
      roleOf, contact: "@kira", projectCreator: "maren", owners: ["alex"], settingsPosts: [root, asNoor, asKira, hidden], settingsEnv,
    });
    expect(refused.ignored).toEqual([{ id: byBea.id, reason: "not_resolver" }]);
    // An owner does not wait on settings, and an agent's resolve is a plain refusal.
    const byAlex = resolveOf(card, raised, "alex", 1_800_000_032_000, refOf(asKira), "Alex decides.");
    expect(foldDispute([raised, byAlex], card, { roleOf, contact: "@kira", projectCreator: "maren", owners: ["alex"], settingsPosts: [root, asKira], settingsEnv }).current?.state).toBe("resolved");
  });

  test("a settings head is known, still to arrive, or unusable, and only the canonical project root counts", () => {
    const root = project();
    const asNoor = contactOp(root, root, "@noor", 1_800_000_001_000);
    const asKira = contactOp(root, asNoor, "@kira", 1_800_000_002_000);
    const state = (posts: OpEvent[], head: string) => settingsHeadState(posts, head, settingsEnv);
    expect(state([root, asNoor, asKira], refOf(asKira))).toBe("known");
    // Not received: the head itself, or an ancestor of it. Sync may change both.
    expect(state([root, asNoor], refOf(asKira))).toBe("unknown");
    expect(state([root, asKira], refOf(asKira))).toBe("unknown");
    expect(state([asNoor, asKira], refOf(asKira))).toBe("unknown");
    // Here and unusable: a wrong hash on the head or on a parent, a hidden head, a non-admin's op, a head that is not a head.
    expect(state([root, asNoor, asKira], `${asKira.id}#0000000000000000`)).toBe("invalid");
    expect(state([root, asNoor, asKira], "not-a-head")).toBe("invalid");
    const forged = ev("olive", { v: 1, rev: 1, op: "project", after: `${asNoor.id}#ffffffffffffffff`, escalation_contact: "@kira" }, { thread: root.id, ts: 1_800_000_003_000 });
    expect(state([root, asNoor, forged], refOf(forged))).toBe("invalid");
    const hidden = { ...contactOp(root, asNoor, "@bea", 1_800_000_004_000), hidden: true };
    expect(state([root, asNoor, hidden], refOf(hidden))).toBe("invalid");
    const byMember = ev("noor", { v: 1, rev: 1, op: "project", after: refOf(asNoor), escalation_contact: "@noor" }, { thread: root.id, ts: 1_800_000_005_000 });
    expect(state([root, asNoor, byMember], refOf(byMember))).toBe("invalid");
    // The chain's root has to be the one the project folds from: a second project root by the channel creator is not.
    const second = ev("alex", { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB", escalation_contact: "@noor" }, { ts: 1_800_000_000_050 });
    const onSecond = contactOp(second, second, "@kira", 1_800_000_006_000);
    expect(state([root, second, onSecond], refOf(onSecond))).toBe("invalid");
    expect(state([root, second, onSecond], refOf(second))).toBe("invalid");
    expect(state([root, second, onSecond], refOf(root))).toBe("known");
  });

  test("a resolve that names a second project root's head by the channel creator is refused, and the canonical contact stands", () => {
    const root = project();
    const second = ev("alex", { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB", escalation_contact: "@noor" }, { ts: 1_800_000_000_050 });
    const asKira = contactOp(root, root, "@kira", 1_800_000_001_000);
    const card = cardOf("bea");
    const raised = openOf(card, "dave", 1_800_000_020_000, refOf(asKira));
    const byNoor = resolveOf(card, raised, "noor", 1_800_000_030_000, refOf(second), "Noor decides.");
    const folded = foldDispute([raised, byNoor], card, {
      roleOf, contact: "@kira", projectCreator: "maren", owners: ["alex"], settingsPosts: [root, second, asKira], settingsEnv,
    });
    expect(folded.current?.state).toBe("open");
    expect(folded.ignored).toEqual([{ id: byNoor.id, reason: "not_resolver" }]);
    const byKira = resolveOf(card, raised, "kira", 1_800_000_031_000, refOf(asKira));
    expect(foldDispute([raised, byKira], card, {
      roleOf, contact: "@kira", projectCreator: "maren", owners: ["alex"], settingsPosts: [root, second, asKira], settingsEnv,
    }).current?.resolved_by).toEqual({ handle: "kira" });
  });
});

describe("who is asked", () => {
  const canSee = () => true;
  test("the owners route leaves the raiser out when another owner can be asked", () => {
    const roleOf = () => "owner" as const;
    const many = chooseResolvers({
      contact: "", creator: "alex", owners: ["alex", "bea", "kira", "maren", "noor", "olive"], raiser: "alex", roleOf, canSee,
    });
    expect(many).toEqual({ resolvers: ["@bea", "@kira", "@maren", "@noor", "@olive"], routed: "owners" });
    const only = chooseResolvers({ contact: "", creator: "alex", owners: ["alex"], raiser: "alex", roleOf, canSee });
    expect(only).toEqual({ resolvers: ["@alex"], routed: "owners" });
  });

  test("a contact who raised it is not asked, and the owners are asked, not the project's creator", () => {
    const roleOf = (handle: string) => (handle === "alex" || handle === "olive" ? "owner" : "member");
    // Noor is the contact and raised it. With a contact in effect only the contact or an owner may resolve, so a member
    // creator (Maren) would be asked and then refused: the owners are asked.
    const asked = chooseResolvers({
      contact: "@noor", creator: "maren", owners: ["alex"], raiser: "noor", roleOf, canSee,
    });
    expect(asked).toEqual({ resolvers: ["@alex"], routed: "owners" });
    // The creator is the raiser too: the owners are asked, and the raiser is left out when another owner can be.
    const owners = chooseResolvers({
      contact: "@noor", creator: "noor", owners: ["alex", "olive"], raiser: "noor", roleOf, canSee,
    });
    expect(owners).toEqual({ resolvers: ["@alex", "@olive"], routed: "owners" });
    // The only owner left is the raiser, so they are asked. An owner may resolve their own dispute.
    const only = chooseResolvers({
      contact: "@alex", creator: "alex", owners: ["alex"], raiser: "alex", roleOf, canSee,
    });
    expect(only).toEqual({ resolvers: ["@alex"], routed: "owners" });
  });

  test("a contact in effect who cannot be asked sends it to the owners; a contact no longer in effect sends it to the creator", () => {
    const roleOf = (handle: string) => (handle === "alex" ? "owner" : handle === "gone" ? "removed" : "member");
    const cannotSee = (handle: string) => handle !== "noor";
    // Noor can still post but cannot see the project: the fold keeps her as the contact, so the creator may not resolve.
    expect(chooseResolvers({ contact: "@noor", creator: "maren", owners: ["alex"], raiser: "bea", roleOf, canSee: cannotSee }))
      .toEqual({ resolvers: ["@alex"], routed: "owners" });
    expect(chooseResolvers({ contact: "@noor/cloud", creator: "maren", owners: ["alex"], raiser: "bea", roleOf, canSee }))
      .toEqual({ resolvers: ["@alex"], routed: "owners" });
    // A removed contact is not in effect: the creator resolves.
    expect(chooseResolvers({ contact: "@gone", creator: "maren", owners: ["alex"], raiser: "bea", roleOf, canSee }))
      .toEqual({ resolvers: ["@maren"], routed: "creator" });
    expect(chooseResolvers({ contact: "", creator: "maren", owners: ["alex"], raiser: "bea", roleOf, canSee }))
      .toEqual({ resolvers: ["@maren"], routed: "creator" });
  });
});
