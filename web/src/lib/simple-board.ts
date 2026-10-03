// Pure rules for the dashboard's Simple page (WALK-75). No fetch and no new wire field.
// Confidential labels match status-report.ts isConfidential (trim, then the word). That module is not imported
// here: loading it pulls in credential code the dashboard page does not need.
// A confidential title matches an ask as a whole word after spaces and line breaks collapse and every punctuation mark
// is read as a space. Ids, keys, and refs stay exact, so a hyphen in a key still matters.
// Card keys in titles and blocked reasons are scrubbed with the same shape as KEY_SHAPE in src/protocol/talkie-recs.ts.
// Comment text is shown as it was written.
import type { AgentView, AskView, CardView, Column, ColumnRole, MemberView, ProjectView, TimelineEntry } from "../api/types.ts";
import { addressedToMe, displayName, effectiveAskState } from "./format.ts";
import { isMe } from "./projects.ts";

export const STATUS_NAMES = ["To do", "Working on", "Waiting for review", "Done"] as const;
export type StatusName = (typeof STATUS_NAMES)[number];

const KEY_SHAPE = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,9}-\d{1,7}(?:-[0-9a-fA-F]{8})?(?![A-Za-z0-9])/g;
const SKIP_OP = new Set(["pos", "labels", "estimate", "board"]);

/** Plain words for a column role. Cancelled cards are not shown. A missing role reads as To do. */
export function statusName(role: ColumnRole | null | undefined): StatusName | null {
  if (role === "cancelled") return null;
  if (role === "active") return "Working on";
  if (role === "review") return "Waiting for review";
  if (role === "done") return "Done";
  return "To do";
}

/** The column a Move button writes. To do prefers the first todo column, then backlog. */
export function columnForStatus(columns: readonly Column[], status: StatusName): Column | undefined {
  const roles: ColumnRole[] = status === "To do" ? ["todo", "backlog"]
    : status === "Working on" ? ["active"]
    : status === "Waiting for review" ? ["review"]
    : ["done"];
  for (const role of roles) {
    const found = columns.find((c) => c.role === role);
    if (found) return found;
  }
  return undefined;
}

export function plainText(text: string): string {
  return text
    .replace(KEY_SHAPE, " ")
    .replace(/\bagents\b/gi, (m) => (m[0] === "A" ? "Assistants" : "assistants"))
    .replace(/\bagent\b/gi, (m) => (m[0] === "A" ? "Assistant" : "assistant"))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
}

const DUE = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export function dueLabel(due: string | null): string {
  if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return "No due date";
  const [year, month, day] = due.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  if (Number.isNaN(date.getTime())) return "No due date";
  return DUE.format(date);
}

export function whoFromAddress(addr: string | null, me: string | null, members: readonly MemberView[] | undefined): string {
  if (!addr) return "No one yet";
  const body = addr.startsWith("@") ? addr.slice(1) : addr;
  const [handle, , assistant] = body.split("/");
  if (!handle) return "No one yet";
  if (assistant) return handle === me ? "Your assistant" : `${displayName(members as MemberView[] | undefined, handle)}'s assistant`;
  if (handle === me) return "You";
  return displayName(members as MemberView[] | undefined, handle);
}

export function whoFromAuthor(author: TimelineEntry["author"], me: string | null, members: readonly MemberView[] | undefined): string {
  if (author.agent) return author.handle === me ? "Your assistant" : `${displayName(members as MemberView[] | undefined, author.handle)}'s assistant`;
  if (author.handle === me) return "You";
  return displayName(members as MemberView[] | undefined, author.handle);
}

function added(who: string): string {
  return who === "You" ? "You added this." : `${who} added this.`;
}

function moved(who: string, status: StatusName): string {
  return who === "You" ? `You moved this to ${status}.` : `${who} moved this to ${status}.`;
}

/** Up to six plain sentences, oldest first. Ops that only touch position, labels, estimate, or board are skipped. */
export function activityLines(
  timeline: readonly TimelineEntry[], columns: readonly Column[], me: string | null, members: readonly MemberView[] | undefined,
): string[] {
  const lines: string[] = [];
  const ordered = [...timeline].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  for (const entry of ordered) {
    if (entry.ignored) continue;
    const who = whoFromAuthor(entry.author, me, members);
    if (entry.kind === "create") {
      lines.push(added(who));
      continue;
    }
    if (entry.kind === "comment") {
      const text = (entry.text ?? "").trim();
      if (!text) continue;
      lines.push(`${who === "You" ? "You wrote" : `${who} wrote`}: ${text}`);
      continue;
    }
    const changes = entry.changes ?? {};
    const keys = Object.keys(changes);
    if (keys.length === 0 || keys.every((k) => SKIP_OP.has(k))) continue;
    if (typeof changes.column === "string") {
      const status = statusName(columns.find((c) => c.id === changes.column)?.role ?? null);
      if (status) lines.push(moved(who, status));
      continue;
    }
    if (changes.blocked === true) {
      const reason = plainText(typeof changes.blocked_reason === "string" ? changes.blocked_reason : "");
      lines.push(reason ? `Waiting: ${reason}` : "Waiting on something else.");
    }
  }
  return lines.slice(-6);
}

function hasLabel(card: CardView, word: string): boolean {
  return card.labels.some((label) => label.trim().toLowerCase() === word);
}

/** Same rule as the daemon: trim the label, then the whole word `confidential`. */
export function isConfidential(card: CardView): boolean {
  return hasLabel(card, "confidential");
}

export function boardColumns(card: CardView, projects: readonly ProjectView[]): Column[] {
  const project = projects.find((p) => p.channel === card.channel);
  return project?.boards.find((b) => b.id === card.board)?.columns ?? [];
}

export function cardRole(card: CardView, projects: readonly ProjectView[]): ColumnRole | null {
  return boardColumns(card, projects).find((c) => c.id === card.column)?.role ?? null;
}

function activeBoard(card: CardView, projects: readonly ProjectView[]): boolean {
  const project = projects.find((p) => p.channel === card.channel && p.state === "active");
  const board = project?.boards.find((b) => b.id === card.board);
  return !!board && board.state === "active";
}

/** Open, not confidential, on an active board of an active project, in a column that board has, and not cancelled. */
export function onSimplePage(card: CardView, projects: readonly ProjectView[]): boolean {
  if (card.state !== "open" || isConfidential(card) || !activeBoard(card, projects)) return false;
  // page-counts.ts skips a column the board does not have. A missing role on a column that does exist still reads as To do.
  if (!boardColumns(card, projects).some((column) => column.id === card.column)) return false;
  return statusName(cardRole(card, projects)) !== null;
}

export function needsYourDecision(card: CardView, projects: readonly ProjectView[], me: string | null): boolean {
  if (!onSimplePage(card, projects)) return false;
  const role = cardRole(card, projects);
  if (role === "done" || role === "cancelled") return false;
  const review = role === "review" && (isMe(card.reviewer, me) || (card.reviewer == null && isMe(card.assignee, me)));
  const labeled = hasLabel(card, "decision-needed") && (isMe(card.assignee, me) || isMe(card.reviewer, me));
  return review || labeled;
}

function compareCards(a: CardView, b: CardView, projects: readonly ProjectView[]): number {
  const sa = STATUS_NAMES.indexOf(statusName(cardRole(a, projects)) ?? "To do");
  const sb = STATUS_NAMES.indexOf(statusName(cardRole(b, projects)) ?? "To do");
  if (sa !== sb) return sa - sb;
  if (a.pos !== b.pos) return a.pos < b.pos ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface SimpleModel {
  myWork: CardView[];
  decisions: CardView[];
  projects: ProjectView[];
  counts: Array<{ channel: string; name: string; counts: Record<StatusName, number> }>;
  hiddenIds: ReadonlySet<string>;
  needles: ConfidentialNeedles;
  confidentialLeftOff: boolean;
}

/** Ids, keys, and refs match an ask exactly. Titles also match with spaces and every punctuation mark folded. */
export interface ConfidentialNeedles {
  exact: readonly string[];
  titles: readonly string[];
}

function blankCounts(): Record<StatusName, number> {
  return { "To do": 0, "Working on": 0, "Waiting for review": 0, Done: 0 };
}

function pushNeedle(needles: string[], raw: string): void {
  const word = raw.trim();
  if (!word) return;
  if (needles.some((n) => n.toLowerCase() === word.toLowerCase())) return;
  needles.push(word);
}

/** Whole word, any case. A title shorter than 4 characters still counts. "IPOs" does not match "IPO". */
function wholeWord(word: string, text: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i").test(text);
}

function mentionsExact(needle: string, text: string): boolean {
  const word = needle.trim();
  if (!word) return false;
  return wholeWord(word, text);
}

/**
 * Spaces and line breaks collapse, and every punctuation mark is a word break (WALK-75 review LOW-1): "Q3: launch."
 * matches the title "Q3 launch". Both sides are folded before the word check.
 */
function foldMatchText(raw: string): string {
  return raw.replace(/\p{P}+/gu, " ").replace(/\s+/g, " ").trim();
}

function mentionsFolded(needle: string, text: string): boolean {
  const word = foldMatchText(needle);
  if (!word) return false;
  return wholeWord(word, foldMatchText(text));
}

function needleBag(needles: readonly string[] | ConfidentialNeedles): ConfidentialNeedles {
  if ("exact" in needles && "titles" in needles) return needles;
  return { exact: needles, titles: [] };
}

export function quotesConfidential(text: string, needles: readonly string[] | ConfidentialNeedles): boolean {
  const bag = needleBag(needles);
  if (bag.exact.some((needle) => mentionsExact(needle, text))) return true;
  return bag.titles.some((title) => mentionsFolded(title, text));
}

export function partition(
  cards: readonly CardView[],
  projects: readonly ProjectView[],
  me: string | null,
  more?: { mine?: readonly CardView[]; review?: readonly CardView[] },
): SimpleModel {
  const mineSource = more?.mine ?? cards;
  const reviewSource = more?.review ?? cards;
  const hiddenIds = new Set<string>();
  const exact: string[] = [];
  const titles: string[] = [];
  // Every fetched copy is judged (WALK-75 review LOW-2): a card is hidden if any copy of it says confidential, even
  // when an older copy in another list does not.
  for (const card of [...cards, ...mineSource, ...reviewSource]) {
    if (!isConfidential(card)) continue;
    hiddenIds.add(card.id);
    pushNeedle(exact, card.id);
    pushNeedle(exact, card.key);
    pushNeedle(exact, card.ref);
    pushNeedle(titles, card.title);
  }
  const visible = (list: readonly CardView[]) => list.filter((card) => !hiddenIds.has(card.id) && onSimplePage(card, projects));
  const teamVisible = visible(cards);
  const mineVisible = visible(mineSource);
  const reviewVisible = visible(reviewSource);
  const myWork = mineVisible
    .filter((card) => isMe(card.assignee, me) && !needsYourDecision(card, projects, me))
    .sort((a, b) => compareCards(a, b, projects));
  const decisionMap = new Map<string, CardView>();
  // The team list too: a decision-needed card where I am the reviewer, someone else is assigned, and the
  // column is not review is in none of the assignee=me or role=review results.
  for (const card of [...teamVisible, ...mineVisible, ...reviewVisible]) {
    if (decisionMap.has(card.id)) continue;
    if (needsYourDecision(card, projects, me)) decisionMap.set(card.id, card);
  }
  const decisions = [...decisionMap.values()].sort((a, b) => compareCards(a, b, projects));
  const active = projects.filter((p) => p.state === "active").sort((a, b) => a.name.localeCompare(b.name));
  const counts = active.map((project) => {
    const tally = blankCounts();
    for (const card of teamVisible) {
      if (card.channel !== project.channel) continue;
      const status = statusName(cardRole(card, projects));
      if (status) tally[status] += 1;
    }
    return { channel: project.channel, name: project.name, counts: tally };
  });
  return { myWork, decisions, projects: active, counts, hiddenIds, needles: { exact, titles }, confidentialLeftOff: hiddenIds.size > 0 };
}

export function askText(ask: AskView): string {
  const text = ask.ask.body.text;
  return typeof text === "string" ? text : "";
}

export function askVisible(
  ask: AskView, me: string | null, agents: readonly AgentView[], now: number,
  needles: readonly string[] | ConfidentialNeedles, answered: ReadonlySet<string>,
): boolean {
  // `agents` is unused on purpose. canAnswer also accepts a human ask-policy on someone else's assistant,
  // and POST /v1/answer then 403s. Only an ask addressed to this person is listed.
  void agents;
  if (answered.has(ask.ask.id) || !addressedToMe(ask, me) || effectiveAskState(ask, now) !== "open") return false;
  return !quotesConfidential(askText(ask), needles);
}
