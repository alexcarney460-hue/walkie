// TALKIE-OPS-1: the recommendations API and one-tap approval. Who may list, approve and dismiss (a person, never an agent; an owner for
// owners-only ones; a member for a team project's; an observer reads only), that approving performs exactly the action once through
// the routes a person's own CLI would use, and that a refused or failed action leaves the recommendation open.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "../../src/daemon/projects/routes.ts";
import { overrideCall, overrideFleet, overrideSeats, type FleetNow } from "../../src/daemon/orchestrator/rec-act.ts";
import type { PollMachine } from "../../src/daemon/orchestrator/poll-plan.ts";
import "../../src/daemon/orchestrator/rec-routes.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { createRec, openRecs, readRecs } from "../../src/daemon/orchestrator/recs.ts";
import { updateCard, updateProject } from "../../src/daemon/projects/service.ts";
import { shortId } from "../../src/protocol/projects/short.ts";
import { ONBOARDING_ARGV, REC_TTL_MS, recKey, type NewRec } from "../../src/protocol/talkie-recs.ts";
import { approveShown, outcome, recsWorld, requester } from "../helpers/talkie-recs.ts";

const cleanups: (() => void)[] = [];
/** The fleet a seat approval reads (rec-act.ts chooses the machine then): mac-a with three free seats on Claude and Codex. */
const machine = (node: string, hostname: string, active = 0, runtimes: PollMachine["runtimes"] = ["claude", "codex"]): PollMachine =>
  ({ node, hostname, handle: "alex", online: true, seats: { allows: true, max: 3, active }, runtimes });
let fleet: FleetNow = { machines: [], working: new Set() };
beforeEach(() => { fleet = { machines: [machine("aaaaaaaaaaaaaaaa", "mac-a")], working: new Set() }; overrideFleet(() => fleet); });
afterEach(() => { overrideCall(null); overrideSeats(null); overrideFleet(null); while (cleanups.length) (cleanups.pop() as () => void)(); });

const H = 3_600_000;
type World = ReturnType<typeof recsWorld>;
const at = (id: string, what: "approve" | "dismiss") => `/v1/talkie/recs/${shortId(id)}/${what}`;
const timelineOf = (t: World, channel: string, id: string) => t.idx.foldCardNow(channel, id)?.state.timeline ?? [];
const comments = (t: World, channel: string, id: string) => timelineOf(t, channel, id).filter((e) => e.kind === "comment");
const boardOps = (t: World, channel: string) => t.core.store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE channel = ? AND json_extract(body, '$.board') IS NOT NULL").get(channel)?.n ?? 0;

async function moveWorld() {
  const t = recsWorld(cleanups);
  const p = await t.project("Website", "WEB", { off: true });
  const card = t.card(p, "Fix the login page", { column: "doing" });
  const id = createRec(t.deps, t.moveRec(card, { evidence: ["its branch has 3 commits (last 2 h ago)"] }, "review"), p.channel);
  return { t, p, card, id };
}

describe("listing", () => {
  test("an owner lists what is open, with each one's short id, group, what they may do and why not", async () => {
    const { t, id } = await moveWorld();
    const r = await outcome(requester(t)("GET", "/v1/talkie/recs"));
    expect(r.status).toBe(200);
    expect(r.body.recs).toHaveLength(1);
    expect(r.body.recs[0]).toMatchObject({ id, short: shortId(id), group: "moves", status: "pending", project_name: "Website", can_approve: true, can_dismiss: true, summary: expect.stringContaining("Fix the login page") });
    expect(typeof r.body.now).toBe("number");
  });

  test("resolved and expired ones are listed only when asked for", async () => {
    const { t, id } = await moveWorld();
    await outcome(requester(t)("POST", at(id, "dismiss"), {}));
    expect((await outcome(requester(t)("GET", "/v1/talkie/recs"))).body.recs).toEqual([]);
    const all = await outcome(requester(t)("GET", "/v1/talkie/recs?status=all"));
    expect(all.body.recs.map((x: { status: string }) => x.status)).toEqual(["dismissed"]);
    expect((await outcome(requester(t)("GET", "/v1/talkie/recs?status=bogus"))).status).toBe(400);
  });

  test("a member lists their team's; an observer lists them but cannot act; an owners-only one is not theirs at all", async () => {
    const t = recsWorld(cleanups);
    const open = await t.project("Website", "WEB", { off: true });
    const secret = await t.project("Ops", "OPS", { off: true, private: true });
    createRec(t.deps, t.moveRec(t.card(open, "Public work")), open.channel);
    createRec(t.deps, t.ownersRec(secret, t.card(secret, "Secret work")), secret.channel);
    const maren = t.person("maren");
    const olive = t.person("olive", "observer");
    const mine = await outcome(requester(maren)("GET", "/v1/talkie/recs"));
    expect(mine.body.recs.map((x: { summary: string }) => x.summary)).toEqual(["Move “Public work” to review"]);
    expect(mine.body.recs[0]).toMatchObject({ can_approve: true });
    const theirs = await outcome(requester(olive)("GET", "/v1/talkie/recs"));
    expect(theirs.body.recs[0]).toMatchObject({ can_approve: false, can_dismiss: false, why_not: "observers can read recommendations but not act on them" });
    expect((await outcome(requester(t)("GET", "/v1/talkie/recs"))).body.recs).toHaveLength(2);
  });

  test("an agent may read them; a paired phone may not", async () => {
    const { t } = await moveWorld();
    expect((await outcome(requester(t, { agent: "cc-9", underAgent: true })("GET", "/v1/talkie/recs"))).status).toBe(200);
    expect((await outcome(requester(t, { via: "phone", listener: undefined })("GET", "/v1/talkie/recs"))).status).toBe(403);
  });
});

describe("approving a card move", () => {
  test("it moves the card as the person, comments the evidence on it, signs the answer, and is done once", async () => {
    const { t, p, card, id } = await moveWorld();
    const before = boardOps(t, p.channel);
    const r = await outcome(approveShown(requester(t), id));
    expect(r.status).toBe(200);
    expect(r.body.result).toBe("Moved to “In review”.");
    expect(r.body.rec).toMatchObject({ status: "approved", resolved: { by: "alex", status: "approved" } });
    expect(t.idx.db.card(card.id)?.column).toBe("review");
    expect(boardOps(t, p.channel)).toBe(before + 1);
    const said = comments(t, p.channel, card.id);
    expect(said).toHaveLength(1);
    expect(said[0]?.text).toContain(`[WalkieTalkie recommendation ${shortId(id)}]`);
    expect(said[0]?.text).toContain("@alex approved");
    expect(said[0]?.text).toContain("its branch has 3 commits");
    expect(said[0]?.author.agent).toBeUndefined();
    const answer = t.core.store.db.query<{ json: string }, []>("SELECT json FROM events WHERE json_extract(body, '$.talkie_rec.op') = 'resolve'").get();
    expect(JSON.parse(answer!.json).author.agent).toBeUndefined();
    // A second tap, whether of the same person or another, does nothing more.
    expect(await outcome(approveShown(requester(t), id))).toMatchObject({ status: 409, code: "rec_not_pending" });
    expect(boardOps(t, p.channel)).toBe(before + 1);
    expect(openRecs(t.deps)).toEqual([]);
  });

  test("two taps at the same moment: one performs, the other is told it is done", async () => {
    const { t, p, card, id } = await moveWorld();
    const go = requester(t);
    const [a, b] = await Promise.all([outcome(approveShown(go, id)), outcome(approveShown(go, id))]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(comments(t, p.channel, card.id)).toHaveLength(1);
    expect(t.idx.db.card(card.id)?.column).toBe("review");
  });

  test("a card that has moved since is refused as stale and the recommendation stays open", async () => {
    const { t, card, id } = await moveWorld();
    updateCard(t.w, card.id, { column: "todo" });
    t.idx.flushAll();
    const stale = await outcome(approveShown(requester(t), id));
    expect(stale).toMatchObject({ status: 409, code: "rec_stale" });
    expect(stale.message).toContain("moved");
    expect(t.idx.db.card(card.id)?.column).toBe("todo");
    expect(openRecs(t.deps)).toHaveLength(1);
  });

  test("a card already where the recommendation wanted it is just recorded", async () => {
    const { t, p, card, id } = await moveWorld();
    updateCard(t.w, card.id, { column: "review" });
    t.idx.flushAll();
    const before = boardOps(t, p.channel);
    // It was in "doing" when recommended; a person has since put it where it was to go: nothing is left to do but record it.
    const r = await outcome(approveShown(requester(t), id));
    expect(r.status).toBe(200);
    expect(r.body.result).toBe("Already in “In review”.");
    expect(r.body.rec.status).toBe("approved");
    expect(boardOps(t, p.channel)).toBe(before);
    expect(comments(t, p.channel, card.id)).toEqual([]);
  });

  test("marking a card blocked is the move when there is no column to go to", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    const card = t.card(p, "Rebuild the index", { column: "doing" });
    const id = createRec(t.deps, t.moveRec(card, { key: recKey.move(card.id, undefined), action: { kind: "move_card", card: card.id, from: "doing", blocked_reason: "stalled: the build failed" }, summary: "Mark “Rebuild the index” as blocked" }), p.channel);
    expect((await outcome(approveShown(requester(t), id))).body.result).toBe("Marked as blocked.");
    expect(t.idx.db.card(card.id)).toMatchObject({ blocked: true, blocked_reason: "stalled: the build failed", column: "doing" });
  });

  test("a full event id works as well as the short id, and an unknown one is not found", async () => {
    const { t, id, card } = await moveWorld();
    expect((await outcome(requester(t)("POST", `/v1/talkie/recs/${encodeURIComponent(id)}/approve`))).status).toBe(200);
    expect(t.idx.db.card(card.id)?.column).toBe("review");
    expect(await outcome(requester(t)("POST", "/v1/talkie/recs/deadbeef/approve"))).toMatchObject({ status: 404, code: "not_found" });
  });

  test("an expired one is refused", async () => {
    const { t, id } = await moveWorld();
    t.tick(REC_TTL_MS + H);
    expect(await outcome(approveShown(requester(t), id))).toMatchObject({ status: 409, code: "rec_not_pending" });
  });
});

describe("who may approve", () => {
  test("an agent never can, whoever it is: named, unnamed, or WalkieTalkie itself", async () => {
    const { t, card, id } = await moveWorld();
    registerHost(t.core, { acceptsToken: () => true, scheduledTurnActive: () => false, currentTurnId: () => "turn-1" } as unknown as OrchestratorHost);
    for (const over of [{ agent: "cc-9" }, { underAgent: true }, { agent: "orchestrator", orchestratorToken: "valid" }]) {
      expect(await outcome(approveShown(requester(t, over), id))).toMatchObject({ status: 403, code: "person_only" });
      expect(await outcome(requester(t, over)("POST", at(id, "dismiss"), {}))).toMatchObject({ status: 403, code: "person_only" });
    }
    expect(t.idx.db.card(card.id)?.column).toBe("doing");
    expect(openRecs(t.deps)).toHaveLength(1);
  });

  test("while WalkieTalkie's scheduled turn runs, even its approval attempt is refused by the dispatcher", async () => {
    const { t, id } = await moveWorld();
    registerHost(t.core, { acceptsToken: () => true, scheduledTurnActive: () => true, currentTurnId: () => "turn-1" } as unknown as OrchestratorHost);
    expect(await outcome(approveShown(requester(t, { orchestratorToken: "valid" }), id))).toMatchObject({ status: 403, code: "scheduled_turn_cannot_act" });
  });

  test("a paired phone cannot", async () => {
    const { t, id } = await moveWorld();
    expect(await outcome(approveShown(requester(t, { via: "phone", listener: undefined }), id))).toMatchObject({ status: 403 });
  });

  test("a member approves a team project's move, as themselves, and it reaches the lead", async () => {
    const { t, card, id } = await moveWorld();
    const maren = t.person("maren");
    const r = await outcome(approveShown(requester(maren), id));
    expect(r.status).toBe(200);
    maren.push();
    t.idx.flushAll();
    expect(t.idx.db.card(card.id)?.column).toBe("review");
    expect(t.idx.db.card(card.id)?.updated_by).toMatchObject({ handle: "maren" });
    expect(readRecs(t.deps).find((x) => x.id === id)).toMatchObject({ status: "approved", resolved: { by: "maren" } });
  });

  test("an observer cannot approve or dismiss, and the card stays put", async () => {
    const { t, card, id } = await moveWorld();
    const olive = t.person("olive", "observer");
    expect(await outcome(approveShown(requester(olive), id))).toMatchObject({ status: 403, code: "forbidden" });
    expect(await outcome(requester(olive)("POST", at(id, "dismiss"), {}))).toMatchObject({ status: 403, code: "forbidden" });
    expect(t.idx.db.card(card.id)?.column).toBe("doing");
  });

  test("an owners-only recommendation is not found by a member, and an owner approves it", async () => {
    const t = recsWorld(cleanups);
    const secret = await t.project("Ops", "OPS", { off: true, private: true });
    const card = t.card(secret, "Rotate the keys", { column: "doing" });
    const id = createRec(t.deps, t.ownersRec(secret, card), secret.channel);
    const maren = t.person("maren");
    expect(await outcome(approveShown(requester(maren), id))).toMatchObject({ status: 404, code: "not_found" });
    expect((await outcome(approveShown(requester(t), id))).status).toBe(200);
    expect(t.idx.db.card(card.id)?.column).toBe("review");
  });
});

describe("dismissing", () => {
  test("it records the person's no, performs nothing, and is done once", async () => {
    const { t, p, card, id } = await moveWorld();
    const r = await outcome(requester(t)("POST", at(id, "dismiss"), { note: "not now" }));
    expect(r.body.rec).toMatchObject({ status: "dismissed", resolved: { by: "alex", note: "not now" } });
    expect(t.idx.db.card(card.id)?.column).toBe("doing");
    expect(comments(t, p.channel, card.id)).toEqual([]);
    expect(await outcome(requester(t)("POST", at(id, "dismiss"), {}))).toMatchObject({ status: 409, code: "rec_not_pending" });
    expect(await outcome(approveShown(requester(t), id))).toMatchObject({ status: 409, code: "rec_not_pending" });
  });

  test("a body with anything but a short note is refused", async () => {
    const { t, id } = await moveWorld();
    expect((await outcome(requester(t)("POST", at(id, "dismiss"), { note: "x".repeat(300) }))).status).toBe(400);
    expect((await outcome(requester(t)("POST", at(id, "dismiss"), { other: 1 }))).status).toBe(400);
  });
});

describe("approving the other kinds", () => {
  const ask = (card: { id: string; ref: string }, to = "@maren"): NewRec => ({
    key: recKey.ask(to, card.id, "review"), group: "reviews", source: "curation", audience: "team",
    action: { kind: "ask_orchestrator", to: to as never, topic: "review", card: card.id },
    summary: "Ask maren to review “Check the refund flow”", reason: "It has waited 5 hours for review and nobody is on it.", evidence: ["in review since 07:00 UTC"], ttl_ms: REC_TTL_MS,
  });

  test("asking an orchestrator sends the ask as the person, marked with the recommendation, once", async () => {
    const t = recsWorld(cleanups);
    t.person("maren");
    const p = await t.project("Website", "WEB", { off: true });
    const card = t.card(p, "Check the refund flow", { column: "review" });
    const id = createRec(t.deps, ask(card), p.channel);
    const r = await outcome(approveShown(requester(t), id));
    expect(r.status).toBe(200);
    expect(r.body.result).toBe("Asked @maren.");
    const asks = t.core.store.db.query<{ json: string }, []>("SELECT json FROM events WHERE kind = 'ask'").all().map((x) => JSON.parse(x.json));
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ author: { handle: "alex" }, body: { to: "@maren" } });
    expect(asks[0].author.agent).toBeUndefined();
    expect(asks[0].body.text).toContain(`[WalkieTalkie recommendation ${shortId(id)}]`);
    expect(asks[0].body.text).toContain("Please take the review of");
    expect(comments(t, p.channel, card.id)).toHaveLength(1);
    expect(await outcome(approveShown(requester(t), id))).toMatchObject({ status: 409, code: "rec_not_pending" });
    expect(t.core.store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE kind = 'ask'").get()?.n).toBe(1);
  });

  test("an ask to someone who is not on the team fails with the ask route's own reason and leaves the recommendation open", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    const card = t.card(p, "Check the refund flow", { column: "review" });
    const id = createRec(t.deps, ask(card, "@ghost"), p.channel);
    const r = await outcome(approveShown(requester(t), id));
    expect(r).toMatchObject({ status: 404, code: "not_found" });
    expect(openRecs(t.deps)).toHaveLength(1);
    expect(comments(t, p.channel, card.id)).toEqual([]);
  });

  test("creating a card makes it as the person in the project's to-do column; one that is already there is not made twice", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    const mk = (title: string) => createRec(t.deps, {
      key: recKey.create(p.channel, title), group: "moves", source: "turn", audience: "team", action: { kind: "create_card", project: p.channel, title },
      summary: `Create a card “${title}” in Website`, reason: "An agent is working on it and no card names it.", evidence: [], ttl_ms: REC_TTL_MS,
    }, p.channel);
    const first = mk("Migrate the billing job");
    const r = await outcome(approveShown(requester(t), first));
    expect(r.body.result).toBe("Created a card in “To do”.");
    const made = t.idx.db.cards(p.channel, { states: ["open"], limit: 10 }).find((c) => c.title === "Migrate the billing job");
    expect(made).toMatchObject({ column: "todo", created_by: { handle: "alex" } });
    // A model-recorded recommendation's words are never posted in the person's name: the body says who approved it, not why.
    expect(made?.body).toContain("Created from a WalkieTalkie recommendation approved by @alex.");
    expect(made?.body).not.toContain("An agent is working on it");
    expect(made?.created_by.agent).toBeUndefined();
    t.tick(1_000);
    const again = mk("Migrate  the billing job");
    expect((await outcome(approveShown(requester(t), again))).body.result).toBe("A card with that title is already there.");
    expect(t.idx.db.cards(p.channel, { states: ["open"], limit: 10 }).filter((c) => c.title.startsWith("Migrate"))).toHaveLength(1);
  });

  test("starting a seat sends the seat request through the seat route, with a short brief that points at the card and the recommendation, once", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    const card = t.card(p, "Fix the login page");
    const calls: Array<{ method: string; path: string; body: any }> = [];
    overrideCall((method, path, body) => {
      if (path !== "/v1/seats/run") return undefined;
      calls.push({ method, path, body });
      return Promise.resolve({ seat: "aaaaaaaaaaaaaaaa:7", host: { hostname: "mac-a" } });
    });
    const id = createRec(t.deps, t.seatRec(card, "aaaaaaaaaaaaaaaa", { action: { kind: "start_seat", machine: "aaaaaaaaaaaaaaaa", runtime: "codex", role: "builder", card: card.id } }), p.channel);
    const r = await outcome(approveShown(requester(t), id));
    expect(r.status).toBe(200);
    expect(r.body.result).toBe("Started a builder seat (codex) on mac-a.");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v1/seats/run", body: { machine: "aaaaaaaaaaaaaaaa", runtime: "codex" } });
    const prompt = calls[0]!.body.prompt as string;
    for (const part of [`[WalkieTalkie recommendation ${shortId(id)}]`, card.ref, "Fix the login page", "walkie task start", "builder"]) expect(prompt).toContain(part);
    expect(Object.keys(calls[0]!.body).sort()).toEqual(["machine", "prompt", "runtime"]);
    expect(comments(t, p.channel, card.id).map((e) => e.text)).toEqual([expect.stringContaining("builder seat")]);
    expect(await outcome(approveShown(requester(t), id))).toMatchObject({ status: 409 });
    expect(calls).toHaveLength(1);
  });

  test("a reviewer seat's brief asks for a verdict on the card, not for the work", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    const card = t.card(p, "Check the refund flow", { column: "review" });
    let prompt = "";
    overrideCall((_m, path, body) => { if (path !== "/v1/seats/run") return undefined; prompt = (body as { prompt: string }).prompt; return Promise.resolve({ host: { hostname: "mac-a" } }); });
    const id = createRec(t.deps, t.seatRec(card, "aaaaaaaaaaaaaaaa", { key: recKey.seat(card.id, "reviewer"), group: "reviews", action: { kind: "start_seat", machine: "aaaaaaaaaaaaaaaa", runtime: "claude", role: "reviewer", card: card.id } }), p.channel);
    expect((await outcome(approveShown(requester(t), id))).body.result).toBe("Started a reviewer seat (claude) on mac-a.");
    expect(prompt).toContain("reviewer");
    expect(prompt).toContain("walkie task comment");
    expect(prompt).not.toContain("walkie task start");
  });

  test("a seat that is already running for the recommendation is not started again", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    const card = t.card(p, "Fix the login page");
    const launched: string[] = [];
    overrideCall((_m, path) => { if (path === "/v1/seats/run") { launched.push(path); return Promise.resolve({}); } return undefined; });
    const id = createRec(t.deps, t.seatRec(card, "aaaaaaaaaaaaaaaa"), p.channel);
    overrideSeats(() => [{ id: "aaaaaaaaaaaaaaaa:5", state: "running", prompt: `[WalkieTalkie recommendation ${shortId(id)}] Earlier brief`, host: { hostname: "mac-a" } } as never]);
    const r = await outcome(approveShown(requester(t), id));
    expect(r.body.result).toBe("A seat for this is already running.");
    expect(launched).toEqual([]);
    expect(openRecs(t.deps)).toEqual([]);
  });

  test("a seat for a card that has moved on is refused as stale", async () => {
    const t = recsWorld(cleanups);
    const p = await t.project("Website", "WEB", { off: true });
    const card = t.card(p, "Fix the login page");
    overrideCall((_m, path) => (path === "/v1/seats/run" ? Promise.resolve({}) : undefined));
    const id = createRec(t.deps, t.seatRec(card, "aaaaaaaaaaaaaaaa"), p.channel);
    updateCard(t.w, card.id, { column: "doing" });
    t.idx.flushAll();
    expect(await outcome(approveShown(requester(t), id))).toMatchObject({ status: 409, code: "rec_stale" });
    expect(openRecs(t.deps)).toHaveLength(1);
  });

  test("a setup step runs its one fixed command on the machine through remote admin; a failure leaves it open to try again", async () => {
    const t = recsWorld(cleanups);
    const calls: Array<{ path: string; body: any }> = [];
    let ok = false;
    overrideCall((_m, path, body) => {
      if (path !== "/v1/admin/run") return undefined;
      calls.push({ path, body });
      return Promise.resolve(ok ? { ok: true, results: [{ machine: "mac-a", ok: true, exit: 0, stdout: "all good" }] }
        : { ok: false, results: [{ machine: "mac-a", ok: false, error: { code: "remote_admin_off", message: "mac-a: its person turned remote admin off" } }] });
    });
    const id = createRec(t.deps, { key: recKey.step("aaaaaaaaaaaaaaaa", "seats_doctor"), group: "setup", source: "turn", audience: "owners",
      action: { kind: "onboarding_step", machine: "aaaaaaaaaaaaaaaa", step: "seats_doctor" }, summary: "Check that mac-a is ready to take seats", reason: "It joined an hour ago.", evidence: [], ttl_ms: REC_TTL_MS }, null);
    const failed = await outcome(approveShown(requester(t), id));
    expect(failed).toMatchObject({ status: 502, code: "rec_action_failed" });
    expect(failed.message).toContain("remote admin off");
    expect(openRecs(t.deps)).toHaveLength(1);
    ok = true;
    const done = await outcome(approveShown(requester(t), id));
    expect(done.status).toBe(200);
    expect(done.body.result).toBe("Ran the check on mac-a.");
    expect(calls.map((c) => c.body)).toEqual([{ machines: "aaaaaaaaaaaaaaaa", argv: [...ONBOARDING_ARGV.seats_doctor] }, { machines: "aaaaaaaaaaaaaaaa", argv: [...ONBOARDING_ARGV.seats_doctor] }]);
    expect(openRecs(t.deps)).toEqual([]);
  });

  test("a member cannot even see a setup step, so cannot run one", async () => {
    const t = recsWorld(cleanups);
    const id = createRec(t.deps, { key: recKey.step("aaaaaaaaaaaaaaaa", "seats_enable"), group: "setup", source: "turn", audience: "owners",
      action: { kind: "onboarding_step", machine: "aaaaaaaaaaaaaaaa", step: "seats_enable" }, summary: "Turn on seats on mac-a", reason: "Its seats are off.", evidence: [], ttl_ms: REC_TTL_MS }, null);
    const maren = t.person("maren");
    expect(await outcome(approveShown(requester(maren), id))).toMatchObject({ status: 404 });
  });

  test("an archived project's card cannot be moved: the move's own refusal is passed on and nothing is recorded", async () => {
    const { t, p, id } = await moveWorld();
    await updateProject(t.w, p.channel, { state: "archived" });
    t.idx.flushAll();
    const r = await outcome(approveShown(requester(t), id));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(readRecs(t.deps).filter((x) => x.status === "approved")).toEqual([]);
  });
});
