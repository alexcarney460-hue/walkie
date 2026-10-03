// TALKIE-OPS-1: the card curation's pure part. The board steward's plan (protocol/projects/steward.ts, which the daemon only ever
// PLANS here, never applies) becomes recommendations: each move with the plan's evidence and one line of why. The curation adds
// what the steward does not move: review bottlenecks (a card that has waited in review with nobody on it) and stalled pipelines
// (an active card with nobody on it and no change for the stale window). Each recommendation goes to the audience that may see the
// card (owners only for a private project or a card labelled `confidential`) and is said in plain English: a title, never a key.
import { isConfidential, safeText, utcMinute } from "../../protocol/projects/status-report.ts";
import type { CardView, Column } from "../../protocol/projects/schema.ts";
import { history, roleOf, type StewardCard, type StewardInput, type StewardMove, type StewardPlan } from "../../protocol/projects/steward.ts";
import { REC_TTL_MS, recKey, recTitle, type NewRec } from "../../protocol/talkie-recs.ts";
import { waited } from "./poll-plan.ts";

/** A card has waited this long in review, with nobody on it, before the curation asks who will take it. */
export const REVIEW_WAIT_MS = 4 * 3_600_000;

export interface CurationProject { channel: string; name: string; prefixes: readonly string[]; private: boolean }

export interface CurationInput {
  project: CurationProject;
  /** What the planner read (the cards' evidence and timelines included) and what it decided. */
  steward: StewardInput;
  plan: StewardPlan;
  /** The same cards as the board has them, for what a steward card does not carry (labels). */
  cards: ReadonlyArray<Pick<CardView, "id" | "labels">>;
  now: number;
  /** Cards that already have an open seat recommendation (the poll is on them). */
  seatCards: ReadonlySet<string>;
  /** Who to ask about a card (about its review, or how it is going): the agent it is assigned to, else a person; null when nobody can be named. */
  askTarget: (card: StewardCard, about: "review" | "status") => { to: string; label: string } | null;
}

export interface CurationPlan { recs: NewRec[]; held: number; ambiguous: number; deferred: number }

const MAX_EVIDENCE = 6;

function reasonOf(m: StewardMove, staleMs: number): string {
  if (m.blocked_reason) return "It stopped with an error.";
  if (m.rule === "done") return m.text_only ? "A recent update says it is finished." : m.evidence[0]?.startsWith("branch ") ? "Its work has been merged." : "It is marked as finished elsewhere.";
  if (m.rule === "review") return "The work is ready and nobody is building it.";
  if (m.rule === "doing") return "An agent is working on it.";
  return `Nobody has worked on it for at least ${waited(staleMs)}.`;
}

export function planCuration(i: CurationInput): CurationPlan {
  const { project, steward: s, plan } = i;
  const columns = new Map<string, readonly Column[]>(s.boards.map((b) => [b.id, b.columns]));
  const colsOf = (card: StewardCard): readonly Column[] => columns.get(card.board) ?? [];
  const byId = new Map(s.cards.map((c) => [c.id, c]));
  const labels = new Map(i.cards.map((c) => [c.id, c.labels]));
  const staleMs = s.staleHours * 3_600_000;
  const audienceOf = (card: StewardCard): { audience: "team" | "owners"; project?: string } =>
    project.private || isConfidential(labels.get(card.id) ?? []) ? { audience: "owners", project: project.channel } : { audience: "team" };
  const recs: NewRec[] = [];

  for (const m of plan.moves) {
    const card = byId.get(m.card);
    if (!card || m.rule === "duplicate") continue;
    const to = m.to ? colsOf(card).find((c) => c.id === m.to) : undefined;
    if (m.to && !to) continue;
    const title = recTitle(card.title, project.prefixes);
    const where = to ? safeText(to.name, 40) : "";
    recs.push({
      key: recKey.move(m.card, m.to), group: m.rule === "stale" ? "stalled" : "moves", source: "curation", ...audienceOf(card),
      action: { kind: "move_card", card: m.card, from: m.from, ...(m.to ? { to: m.to } : {}), ...(m.blocked_reason ? { blocked_reason: safeText(m.blocked_reason, 300) } : {}) },
      summary: to ? `Move “${title}” ${m.rule === "stale" ? "back to" : "to"} ${where}` : `Mark “${title}” as blocked`,
      reason: reasonOf(m, staleMs),
      evidence: m.evidence.slice(0, MAX_EVIDENCE).map((line) => safeText(line, 200)),
      ttl_ms: REC_TTL_MS,
    });
  }

  const planned = new Set(plan.moves.map((m) => m.card));
  for (const card of s.cards) {
    if (card.state !== "open" || card.blocked || planned.has(card.id)) continue;
    const ev = s.evidence.get(card.id);
    if (!ev || ev.agents.length) continue;
    const role = roleOf(colsOf(card), card.column);
    if (role !== "review" && role !== "active") continue;
    const h = history(ev.timeline, card, s.owners);
    const target = i.askTarget(card, role === "review" ? "review" : "status");
    if (!target) continue;
    const title = recTitle(card.title, project.prefixes);
    const who = safeText(target.label, 60);
    if (role === "review") {
      if (i.now - h.inColumnSince < REVIEW_WAIT_MS || i.seatCards.has(card.id)) continue;
      const age = waited(i.now - h.inColumnSince);
      recs.push({
        key: recKey.ask(target.to, card.id, "review"), group: "reviews", source: "curation", ...audienceOf(card),
        action: { kind: "ask_orchestrator", to: target.to, topic: "review", card: card.id },
        summary: `Ask ${who} to review “${title}”`, reason: `It has waited ${age} for review and nobody is on it.`,
        evidence: [`in review since ${utcMinute(h.inColumnSince)}`, "no agent is working on it"], ttl_ms: REC_TTL_MS,
      });
      continue;
    }
    const lastCommit = Math.max(0, ...(ev.branches ?? []).filter((b) => b.own_commits > 0).map((b) => b.last_commit_at ?? 0));
    const last = Math.max(h.lastActivity, lastCommit);
    if (i.now - last < staleMs) continue;
    const age = waited(i.now - last);
    recs.push({
      key: recKey.ask(target.to, card.id, "status"), group: "stalled", source: "curation", ...audienceOf(card),
      action: { kind: "ask_orchestrator", to: target.to, topic: "status", card: card.id },
      summary: `Ask ${who} about “${title}”`, reason: `Nothing has changed for ${age} and nobody is working on it.`,
      evidence: [`last change ${utcMinute(last)}`, "no agent is working on it"], ttl_ms: REC_TTL_MS,
    });
  }
  return { recs, held: plan.held.length, ambiguous: plan.ambiguous.length, deferred: plan.deferred };
}
