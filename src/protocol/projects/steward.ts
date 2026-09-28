// FO-6 board steward (Alex 2026-09-27: "the orchestrator should also move cards from one category to another to keep
// the board accurate for all members since some agents neglect to do that"). The rules are PURE: a board snapshot and
// the evidence gathered for it go in, the moves the steward would make come out, each with the evidence that justifies
// it. The daemon signs them as its `steward` agent (daemon/projects/steward-run.ts); `--dry-run` only prints them.
//
// Rules, per open card, first match wins:
//   done    merged into a release branch / tag (a lane branch with its own commits, none newer unmerged), the card's
//           Linear issue is Done, or the latest trusted comment says "done" -> the first done column. On a comment
//           alone the project's agents_can_close applies (off: left to a person).
//   review  in todo / active, its branch has its own commits, no live builder on it, and a review was requested (the
//           latest trusted comment) or a trusted audit agent is on it    -> the first review column
//   doing   in backlog / todo / review and a trusted live builder agent (not an audit) is working on it: a fix round
//           is work in progress                                         -> the first active column
//   stale   in an active column, not blocked, no live agent, no commit and no card activity for N hours, and at least N
//           hours in the column -> the first todo column, or blocked with the last error; the owner is mentioned
//   duplicate  (steward-dup.ts) the newer of two open cards on one board with the same title or Linear key: flagged
//           with a comment on both cards, never archived (a person archives)
// "Trusted" (steward-core.ts trustedAuthor): a person, an owner's agent, the card's assignee or its creator. Anyone
// else's comments and statuses are not evidence (fix round 2, Opus HIGH 2). A live agent anyone runs still counts
// AGAINST a move (a builder on the card makes a done signal ambiguous and a card never stale): failing safe.
// Never: delete, reassign, or touch a card a person moved in the last 24 h (the person's move wins and pins it), a card
// whose latest move was a person undoing the steward, a card an agent moved in the last hour, or one the steward itself
// moved in the last 6 h. Conflicting evidence (a done signal while a builder is still working) is reported as
// ambiguous for the fleet agent, never acted on.
import type { Author } from "../schemas.ts";
import type { Column, ColumnRole } from "./schema.ts";
import { commentSignal, excerpt, type CommentSignal } from "./steward-match.ts";
import {
  colName, commentText, firstOf, history, holdReason, hoursAgo, MAX_MOVES_PER_RUN, ownerHandle, roleOf, STEWARD_AGENT,
  trustedAuthor, type BranchEvidence, type CardEvidence, type History, type LiveAgent, type StewardCard, type StewardInput,
  type StewardMove, type StewardPlan, type StewardSkip,
} from "./steward-core.ts";
import { duplicates } from "./steward-dup.ts";

export * from "./steward-core.ts";

interface Ctx { readonly input: StewardInput; readonly columns: (card: StewardCard) => readonly Column[] }

// ---- evidence per rule --------------------------------------------------------------------------------------------

function gitDone(branches: readonly BranchEvidence[] | null, now: number): string | null {
  if (!branches) return null;
  const worked = branches.filter((b) => b.own_commits > 0);
  const merged = worked.filter((b) => b.merged_into);
  if (!merged.length) return null;
  const newestMerged = Math.max(...merged.map((b) => b.last_commit_at ?? 0));
  if (worked.some((b) => !b.merged_into && (b.last_commit_at ?? 0) > newestMerged)) return null;
  const b = [...merged].sort((x, y) => (y.last_commit_at ?? 0) - (x.last_commit_at ?? 0))[0] as BranchEvidence;
  return `branch ${b.branch} (${b.own_commits} commit${b.own_commits === 1 ? "" : "s"}, last ${hoursAgo(now, b.last_commit_at ?? 0)}) is merged into ${b.merged_into}`;
}

/** Done evidence: from git / Linear (hard), and from a trusted comment (text). */
function doneEvidence(ev: CardEvidence, h: History, now: number): { hard: string[]; text: string[] } {
  const hard: string[] = [];
  const git = ev.branchesComplete === false ? null : gitDone(ev.branches, now);
  if (git) hard.push(git);
  if (ev.linear && ev.linear.state_type === "completed") hard.push(`Linear ${ev.linear.key} is ${ev.linear.state}`);
  const c = h.lastComment;
  const text = c && commentSignal(c.text as string) === "done"
    ? [`the latest comment (${c.author.agent ?? `@${c.author.handle}`}, ${hoursAgo(now, c.ts)}) says "${excerpt(c.text as string, 80)}"`]
    : [];
  return { hard, text };
}

/** The card's branch with its own commits, newest first. */
function worked(ev: CardEvidence): BranchEvidence | null {
  return [...(ev.branches ?? [])].filter((x) => x.own_commits > 0).sort((x, y) => (y.last_commit_at ?? 0) - (x.last_commit_at ?? 0))[0] ?? null;
}

function agentLine(a: LiveAgent): string {
  return `${a.auditor ? "audit agent" : "agent"} ${a.address} is working on it (status: ${excerpt(a.text, 70)})`;
}

// ---- the plan -----------------------------------------------------------------------------------------------------

interface Verdict { move?: Omit<StewardMove, "card" | "key" | "ref" | "title" | "from" | "comment">; what?: string; ambiguous?: string; held?: string }

function judge(card: StewardCard, ctx: Ctx): Verdict {
  const { input } = ctx;
  const cols = ctx.columns(card);
  const role = roleOf(cols, card.column);
  const ev = input.evidence.get(card.id);
  if (!ev || role === "done" || role === "cancelled") return {};
  const h0 = history(ev.timeline, card, input.owners);
  // Associations from an untrusted title (its Linear key, the branches its code names) are not evidence.
  const ev1: CardEvidence = h0.titleTrusted ? ev : { ...ev, linear: null, branches: null };
  return decide(card, ctx, cols, role, ev1, h0);
}

function decide(card: StewardCard, ctx: Ctx, cols: readonly Column[], role: ColumnRole, ev: CardEvidence, h: History): Verdict {
  const { input } = ctx;
  const now = input.now;
  const trusted = (a: LiveAgent) => trustedAuthor({ handle: a.handle, agent: a.agent }, card, input.owners);
  const anyBuilder = ev.agents.filter((a) => !a.auditor);
  const builders = anyBuilder.filter(trusted);
  const auditors = ev.agents.filter((a) => a.auditor && trusted(a));
  const signal: CommentSignal = h.lastComment ? commentSignal(h.lastComment.text as string) : null;

  let v: Verdict = {};
  const done = doneEvidence(ev, h, now);
  const b = worked(ev);
  if (done.hard.length || done.text.length) {
    const col = firstOf(cols, "done");
    if (!col) return {};
    const all = [...done.hard, ...done.text];
    if (anyBuilder.length) return { ambiguous: `done evidence (${all.join("; ")}) but ${agentLine(anyBuilder[0] as LiveAgent)}` };
    if (!done.hard.length && !input.agentsCanClose) return { held: `a comment says it is done, but agents_can_close is off: a person closes it` };
    v = { move: { rule: "done", to: col.id, evidence: all, ping: [], ...(done.hard.length ? {} : { text_only: true as const }) }, what: `moved ${card.key} from ${colName(cols, card.column)} to ${col.name}` };
  } else if ((role === "todo" || role === "active") && !anyBuilder.length && b && (signal === "review" || auditors.length)) {
    const col = firstOf(cols, "review");
    if (!col) return {};
    const why = [
      `branch ${b.branch} has ${b.own_commits} commit${b.own_commits === 1 ? "" : "s"} (last ${hoursAgo(now, b.last_commit_at ?? 0)})`,
      "no builder agent is working on it",
      ...(signal === "review" && h.lastComment ? [`the latest comment asks for review: "${excerpt(h.lastComment.text as string, 80)}"`] : []),
      ...auditors.slice(0, 2).map(agentLine),
    ];
    v = { move: { rule: "review", to: col.id, evidence: why, ping: [] }, what: `moved ${card.key} from ${colName(cols, card.column)} to ${col.name}` };
  } else if ((role === "backlog" || role === "todo" || role === "review") && builders.length) {
    const col = firstOf(cols, "active");
    if (!col) return {};
    v = { move: { rule: "doing", to: col.id, evidence: builders.slice(0, 2).map(agentLine), ping: [] }, what: `moved ${card.key} from ${colName(cols, card.column)} to ${col.name}` };
  } else if (role === "active" && !card.blocked && !ev.agents.length && ev.branches !== null && ev.branchesComplete !== false) {
    v = stale(card, ev, h, cols, input);
  }
  if (!v.move) return v;
  const held = holdReason(h, now);
  return held ? { held } : v;
}

function stale(card: StewardCard, ev: CardEvidence, h: History, cols: readonly Column[], input: StewardInput): Verdict {
  const now = input.now;
  const window = input.staleHours * 3_600_000;
  const lastCommit = Math.max(0, ...(ev.branches ?? []).filter((b) => b.own_commits > 0).map((b) => b.last_commit_at ?? 0));
  if (now - h.inColumnSince < window || now - h.lastActivity < window || now - lastCommit < window) return {};
  const owner = ownerHandle(card);
  const evidence = [
    `in ${colName(cols, card.column)} since ${hoursAgo(now, h.inColumnSince)}`,
    "no live agent is working on it",
    lastCommit ? `its last commit was ${hoursAgo(now, lastCommit)}` : "no branch with commits for it",
    `no card activity since ${hoursAgo(now, h.lastActivity)}`,
  ];
  const sig = h.lastComment ? commentSignal(h.lastComment.text as string) : null;
  if ((sig === "error" || sig === "fail") && h.lastComment) {
    const reason = excerpt(`stalled: ${h.lastComment.text as string}`, 300);
    return {
      move: { rule: "stale", blocked_reason: reason, evidence: [...evidence, `the last comment reports an error: "${excerpt(h.lastComment.text as string, 100)}"`], ping: [owner] },
      what: `marked ${card.key} blocked with its last error`,
    };
  }
  const col = firstOf(cols, "todo");
  if (!col) return {};
  return { move: { rule: "stale", to: col.id, evidence, ping: [owner] }, what: `moved ${card.key} from ${colName(cols, card.column)} back to ${col.name}` };
}

/** What the steward would do on this board now. */
export function planSteward(input: StewardInput): StewardPlan {
  const boards = new Map(input.boards.map((b) => [b.id, b.columns]));
  const ctx: Ctx = { input, columns: (c) => boards.get(c.board) ?? [] };
  const dup = duplicates(input, ctx.columns);
  const moves: StewardMove[] = [...dup.moves];
  const ambiguous: StewardSkip[] = [...dup.ambiguous];
  const held: StewardSkip[] = [...dup.held];
  const cards = [...input.cards].filter((c) => c.state === "open")
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  for (const card of cards) {
    const v = judge(card, ctx);
    if (v.ambiguous) ambiguous.push({ card: card.id, key: card.key, reason: v.ambiguous });
    if (v.held) held.push({ card: card.id, key: card.key, reason: v.held });
    if (!v.move) continue;
    const m = v.move;
    moves.push({
      card: card.id, key: card.key, ref: card.ref, title: card.title, from: card.column, ...m,
      comment: commentText(card, v.what ?? `moved ${card.key}`, m.evidence, m.ping),
    });
  }
  const cap = input.maxMoves ?? MAX_MOVES_PER_RUN;
  return { steward: input.steward, moves: moves.slice(0, cap), ambiguous, held, deferred: Math.max(0, moves.length - cap) };
}

/**
 * Whether a board op's author is the project's steward, as the fold judges it (fold.ts cardDenial): the reserved
 * `steward` agent of a member who is an owner, or the project's creator while a member. The local API refuses the
 * name from every client, so only a daemon's steward signs as it.
 */
export function isStewardAuthor(author: Pick<Author, "handle" | "agent">, role: string | null, creator: string | null): boolean {
  if (author.agent !== STEWARD_AGENT) return false;
  return role === "owner" || (role === "member" && creator !== null && author.handle === creator);
}
