// TALKIE-OPS-1, the card curation's pure part: the steward's plan turned into recommendations (a move, with the plan's evidence and
// one line of why), then the review bottlenecks and stalled pipelines the steward does not move, routed to the right audience and
// said in plain English. Every fixture here is the steward's own, so the mapping is tested against what the planner really says.
import { describe, expect, test } from "bun:test";
import { planCuration, REVIEW_WAIT_MS, type CurationInput } from "../../src/daemon/orchestrator/curation-plan.ts";
import { DEFAULT_COLUMNS, type CardView, type TimelineEntry } from "../../src/protocol/projects/schema.ts";
import {
  planSteward, type BranchEvidence, type CardEvidence, type LiveAgent, type StewardCard, type StewardInput,
} from "../../src/protocol/projects/steward.ts";
import { RecCreate, recKey } from "../../src/protocol/talkie-recs.ts";

const H = 3_600_000;
const NOW = 1_800_000_000_000;
const BOARD = "a000000000000001:2";
const CHANNEL = "p-0a1b2c3d";

let n = 0;
function card(title: string, column: string, extra: Partial<StewardCard> = {}): StewardCard {
  n++;
  return {
    id: `a000000000000001:${100 + n}`, key: `WR-${n}`, ref: `WR-${n}-0000000${n % 10}`, title, board: BOARD, column, state: "open",
    assignee: null, blocked: false, blocked_reason: null, created_at: NOW - 48 * H, created_by: { handle: "alex", node: "a000000000000001", agent: "lead" },
    updated_at: NOW - 48 * H, ...extra,
  };
}
const builder = (title: string): LiveAgent => ({ address: "@kira/kiras-mbp/codex-1", handle: "kira", agent: "codex-1", text: title, auditor: false });
const branch = (name: string, own: number, at: number | null, merged: string | null = null): BranchEvidence => ({ repo: "/r", branch: name, own_commits: own, last_commit_at: at, merged_into: merged });
const cmt = (text: string, ts: number): TimelineEntry => ({ id: `c${ts}`, ts, author: { handle: "alex", node: "n", agent: "cc-orch" }, kind: "comment", text });
const moved = (column: string, ts: number): TimelineEntry => ({ id: `m${ts}`, ts, author: { handle: "alex", node: "n" }, kind: "op", changes: { column, pos: "i" } });
/** An agent's move: unlike a person's, it does not pin the card against the steward for a day. */
const placed = (column: string, ts: number): TimelineEntry => ({ id: `p${ts}`, ts, author: { handle: "alex", node: "n", agent: "cc-orch" }, kind: "op", changes: { column, pos: "i" } });

function steward(cards: StewardCard[], ev: Record<string, Partial<CardEvidence>>, extra: Partial<StewardInput> = {}): StewardInput {
  const evidence = new Map<string, CardEvidence>();
  for (const c of cards) evidence.set(c.id, { agents: [], branches: [], linear: null, timeline: [], ...(ev[c.id] ?? {}) });
  return { now: NOW, prefix: "WR", steward: "on", boards: [{ id: BOARD, columns: [...DEFAULT_COLUMNS] }], cards, evidence, staleHours: 24, owners: ["alex", "kira"], agentsCanClose: true, ...extra };
}
const views = (cards: StewardCard[], labels: Record<string, string[]> = {}): CardView[] => cards.map((c) => ({
  id: c.id, ref: c.ref, labels: labels[c.id] ?? [], reviewer: null,
} as unknown as CardView));

function run(cards: StewardCard[], ev: Record<string, Partial<CardEvidence>>, over: Partial<CurationInput> = {}, extra: Partial<StewardInput> = {}) {
  const s = steward(cards, ev, extra);
  const plan = planSteward(s);
  return planCuration({
    project: { channel: CHANNEL, name: "Website", prefixes: ["WR"], private: false }, steward: s, plan, cards: views(cards), now: NOW,
    seatCards: new Set(), askTarget: (c) => (c.assignee ? { to: c.assignee, label: "Maren's agent" } : { to: "@maren", label: "Maren" }), ...over,
  });
}

describe("the steward's plan, as recommendations", () => {
  test("a card reported finished: move it to Done, said in one line, with the plan's own evidence", () => {
    const c = card("WR-1 Fix the login page", "doing");
    const r = run([c], { [c.id]: { timeline: [cmt("Done: merged into main", NOW - H)] } });
    expect(r.recs).toHaveLength(1);
    const rec = r.recs[0]!;
    expect(rec).toMatchObject({
      key: recKey.move(c.id, "done"), group: "moves", source: "curation", audience: "team",
      action: { kind: "move_card", card: c.id, from: "doing", to: "done" },
      summary: "Move “Fix the login page” to Done", reason: "A recent update says it is finished.",
    });
    expect(rec.evidence[0]).toContain("says ”Done: merged into main”");
    expect(RecCreate.safeParse({ v: 1, op: "create", ...rec }).success).toBe(true);
  });

  test("merged work, a card ready for review, and a card an agent is on", () => {
    const merged = card("Ship the invoice export", "review");
    const ready = card("Tidy the settings page", "doing");
    const building = card("Write the onboarding guide", "todo");
    const r = run([merged, ready, building], {
      [merged.id]: { branches: [branch("lane/export", 2, NOW - 3 * H, "main")] },
      [ready.id]: { branches: [branch("lane/settings", 3, NOW - 2 * H)], timeline: [cmt("Built. Audits r1 running: Opus", NOW - 2 * H)] },
      [building.id]: { agents: [builder("Write the onboarding guide")] },
    });
    const by = Object.fromEntries(r.recs.map((x) => [(x.action as { card: string }).card, x]));
    expect(by[merged.id]).toMatchObject({ summary: "Move “Ship the invoice export” to Done", reason: "Its work has been merged." });
    expect(by[ready.id]).toMatchObject({ summary: "Move “Tidy the settings page” to In review", reason: "The work is ready and nobody is building it." });
    expect(by[building.id]).toMatchObject({ summary: "Move “Write the onboarding guide” to In progress", reason: "An agent is working on it." });
  });

  test("a card nobody has worked on for a day goes back to To do and is Stalled; one that stopped with an error is marked blocked", () => {
    const idle = card("Update the pricing copy", "doing");
    const failed = card("Rebuild the search index", "doing");
    const r = run([idle, failed], {
      [idle.id]: {},
      [failed.id]: { timeline: [cmt("builder could not authenticate; OAuth session expired", NOW - 30 * H)] },
    });
    const by = Object.fromEntries(r.recs.map((x) => [(x.action as { card: string }).card, x]));
    expect(by[idle.id]).toMatchObject({ group: "stalled", summary: "Move “Update the pricing copy” back to To do", action: { to: "todo" } });
    expect(by[idle.id]?.reason).toBe("Nobody has worked on it for at least 24 hours.");
    expect(by[failed.id]).toMatchObject({ group: "stalled", summary: "Mark “Rebuild the search index” as blocked", reason: "It stopped with an error.", key: recKey.move(failed.id, undefined) });
    expect(by[failed.id]?.action).toEqual({ kind: "move_card", card: failed.id, from: "doing", blocked_reason: expect.stringContaining("OAuth") });
  });

  test("duplicate flags, held cards and ambiguous evidence are counted, never recommended", () => {
    const a = card("Same title", "todo");
    const b = card("Same title", "todo", { created_at: NOW - 47 * H });
    const pinned = card("Pinned by a person", "doing");
    const both = card("Done but an agent is on it", "doing");
    const r = run([a, b, pinned, both], {
      [pinned.id]: { timeline: [moved("doing", NOW - 2 * H), cmt("Done: merged", NOW - H)] },
      [both.id]: { timeline: [cmt("Done: merged", NOW - H)], agents: [builder("Done but an agent is on it")] },
    });
    expect(r.recs.filter((x) => (x.action as { card: string }).card !== b.id && (x.action as { card: string }).card !== a.id)).toEqual([]);
    expect(r.recs.map((x) => x.action.kind)).not.toContain("duplicate");
    expect(r.held).toBeGreaterThanOrEqual(1);
    expect(r.ambiguous).toBe(1);
  });

  test("a confidential card, or any card of a private project, is for the owners and names its project", () => {
    const secret = card("Plan the layoffs", "doing");
    const s = steward([secret], { [secret.id]: { timeline: [cmt("Done: merged", NOW - H)] } });
    const plan = planSteward(s);
    const base = { steward: s, plan, now: NOW, seatCards: new Set<string>(), askTarget: () => null };
    const confidential = planCuration({ ...base, project: { channel: CHANNEL, name: "Ops", prefixes: ["WR"], private: false }, cards: views([secret], { [secret.id]: ["Confidential"] }) });
    expect(confidential.recs[0]).toMatchObject({ audience: "owners", project: CHANNEL });
    const priv = planCuration({ ...base, project: { channel: CHANNEL, name: "Ops", prefixes: ["WR"], private: true }, cards: views([secret]) });
    expect(priv.recs[0]).toMatchObject({ audience: "owners", project: CHANNEL });
    const open = planCuration({ ...base, project: { channel: CHANNEL, name: "Ops", prefixes: ["WR"], private: false }, cards: views([secret]) });
    expect(open.recs[0]?.audience).toBe("team");
    expect(open.recs[0]?.project).toBeUndefined();
  });
});

describe("review bottlenecks", () => {
  test("a card that has waited in review for four hours with nobody on it: ask who is on it to review", () => {
    const c = card("WR-4 Check the refund flow", "review", { assignee: "@maren/mbp/cc-2" });
    const r = run([c], { [c.id]: { timeline: [placed("review", NOW - 5 * H)] } });
    expect(r.recs).toHaveLength(1);
    expect(r.recs[0]).toMatchObject({
      key: recKey.ask("@maren/mbp/cc-2", c.id, "review"), group: "reviews", source: "curation", audience: "team",
      action: { kind: "ask_orchestrator", to: "@maren/mbp/cc-2", topic: "review", card: c.id },
      summary: "Ask Maren's agent to review “Check the refund flow”", reason: "It has waited 5 hours for review and nobody is on it.",
    });
    // An ask carries no words of its own: what approving it sends is written from its topic and card (askMessage).
    expect(Object.keys(r.recs[0]!.action).sort()).toEqual(["card", "kind", "to", "topic"]);
    expect(`${r.recs[0]?.summary} ${r.recs[0]?.reason}`).not.toMatch(/WR-\d/);
    expect(RecCreate.safeParse({ v: 1, op: "create", ...r.recs[0] }).success).toBe(true);
  });

  test("not before four hours, not with an agent on it, not blocked, not with a seat already recommended, not when the steward moves it", () => {
    expect(REVIEW_WAIT_MS).toBe(4 * H);
    const young = card("Young review", "review");
    const watched = card("Watched review", "review");
    const blocked = card("Blocked review", "review", { blocked: true });
    const seated = card("Seated review", "review");
    const merged = card("Merged review", "review");
    const timeline = { timeline: [placed("review", NOW - 6 * H)] };
    const r = run([young, watched, blocked, seated, merged], {
      [young.id]: { timeline: [placed("review", NOW - 3 * H)] }, [watched.id]: { ...timeline, agents: [builder("Watched review")] },
      [blocked.id]: timeline, [seated.id]: timeline, [merged.id]: { ...timeline, branches: [branch("lane/merged", 2, NOW - 3 * H, "main")] },
    }, { seatCards: new Set([seated.id]) });
    expect(r.recs.filter((x) => x.action.kind === "ask_orchestrator")).toEqual([]);
    // What the steward itself plans stays its own: an agent on a review card is a fix round (back to In progress), merged work is Done.
    expect(r.recs.filter((x) => x.action.kind === "move_card").map((x) => (x.action as { card: string }).card)).toEqual([watched.id, merged.id]);
  });

  test("a card nobody can be asked about is left alone", () => {
    const c = card("Orphan review", "review");
    const r = run([c], { [c.id]: { timeline: [placed("review", NOW - 6 * H)] } }, { askTarget: () => null });
    expect(r.recs).toEqual([]);
  });
});

describe("stalled pipelines", () => {
  test("an active card with no agent and no change for the stale window, the steward having nothing to go on: ask about it", () => {
    const c = card("WR-5 Migrate the billing job", "doing", { assignee: "@maren" });
    const r = run([c], { [c.id]: {} }, {}, {});
    // The steward could not judge (no repository was scanned): it plans nothing, the curation still asks.
    const s = steward([c], { [c.id]: { branches: null } });
    const asked = planCuration({ project: { channel: CHANNEL, name: "Website", prefixes: ["WR"], private: false }, steward: s, plan: planSteward(s), cards: views([c]), now: NOW, seatCards: new Set(), askTarget: () => ({ to: "@maren", label: "Maren" }) });
    expect(asked.recs).toHaveLength(1);
    expect(asked.recs[0]).toMatchObject({
      key: recKey.ask("@maren", c.id, "status"), group: "stalled", action: { kind: "ask_orchestrator", to: "@maren", topic: "status", card: c.id },
      summary: "Ask Maren about “Migrate the billing job”", reason: "Nothing has changed for 2 days and nobody is working on it.",
    });
    expect(r.recs.map((x) => x.group)).toEqual(["stalled"]); // with a scanned repository the steward's own move is what is recommended
  });

  test("not with an agent on it, a recent commit, a block, or recent activity", () => {
    const watched = card("Watched", "doing");
    const committing = card("Committing", "doing");
    const blocked = card("Blocked", "doing", { blocked: true });
    const talking = card("Talking", "doing");
    const s = steward([watched, committing, blocked, talking], {
      [watched.id]: { branches: null, agents: [builder("Watched")] }, [committing.id]: { branches: [branch("lane/c", 2, NOW - 2 * H)] },
      [blocked.id]: { branches: null }, [talking.id]: { branches: null, timeline: [cmt("Still on it", NOW - 3 * H)] },
    });
    const r = planCuration({ project: { channel: CHANNEL, name: "Website", prefixes: ["WR"], private: false }, steward: s, plan: planSteward(s), cards: views([watched, committing, blocked, talking]), now: NOW, seatCards: new Set(), askTarget: () => ({ to: "@maren", label: "Maren" }) });
    expect(r.recs).toEqual([]);
  });
});
