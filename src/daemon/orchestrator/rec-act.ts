// TALKIE-OPS-1: what approving a recommendation does. Each action is performed by sending the SAME request a person's CLI would send
// to the existing route (a card move to /v1/tasks/<id>, a seat to /v1/seats/run, an ask to /v1/ask, a setup step to /v1/admin/run, a
// new card to /v1/tasks) under the approver's own credential: so the route's own validation, permission rules, rate limit and audit
// are the ones that judge it, the signed result is the person's, and nothing here can do what that person could not. Before it
// goes, the recommendation is checked against the board as it is NOW (the card still where it was, the project still active, and
// for a seat the poll's own rules: not blocked, confidential, assigned, waiting on someone or worked on); a seat's machine is chosen
// again from the fleet as it is now; the card gets a comment naming the recommendation and, for what the daemon recommended, its
// evidence; and what is repeat-prone (a seat, an ask, a created card) carries a mark of the recommendation that is looked for first,
// so a retry after a half-finished approval does not do it twice. Words a model wrote (a record's `context`) are never sent, posted
// or commented: an ask's message is outgoingOf's template, the same text the person was shown.
import type { CardView, ColumnRole, ProjectView } from "../../protocol/projects/schema.ts";
import { isConfidential, safeText } from "../../protocol/projects/status-report.ts";
import { TERMINAL_STATES, type SeatView } from "../../protocol/seats.ts";
import { ONBOARDING_ARGV, cardDataTitle, recMarker, type Rec, type RecActionT } from "../../protocol/talkie-recs.ts";
import { HttpError } from "../http.ts";
import { dispatch, type RouteCtx } from "../local-routes.ts";
import { seatHosts, seatsList } from "../seats/view.ts";
import { accountsView, agentsView, nodesView } from "../views.ts";
import { visibleProjects } from "../projects/service.ts";
import { fleetNow, seatHold } from "./poll.ts";
import { seatTarget, type PollMachine } from "./poll-plan.ts";
import { outgoingOf, type RecDeps } from "./recs.ts";
import { canSeeChannel } from "../roster.ts";
import type { Core } from "../core.ts";

/** Tests answer a route's request themselves (the seat and admin routes need a team of machines); undefined = let the real route answer. */
export type CallOverride = (method: string, path: string, body?: unknown) => Promise<unknown> | undefined;
let override: CallOverride | null = null;
export function overrideCall(fn: CallOverride | null): void { override = fn; }
let seatsOverride: (() => readonly SeatView[]) | null = null;
export function overrideSeats(fn: (() => readonly SeatView[]) | null): void { seatsOverride = fn; }
/** What approving a seat reads of the fleet: each machine's capacity, and the cards an agent works on now. */
export interface FleetNow { machines: readonly PollMachine[]; working: ReadonlySet<string> }
let fleetOverride: (() => FleetNow) | null = null;
export function overrideFleet(fn: (() => FleetNow) | null): void { fleetOverride = fn; }

/** The fleet read once per request: the list and an approval's check and action see the same machines. */
export function fleetReader(d: RecDeps, c: RouteCtx): () => FleetNow {
  let read: FleetNow | null = null;
  return () => (read ??= fleetOf(d, c));
}

/** Who may see a channel: a predicate on a person's handle (canSeeChannel: a restricted channel's members, else everyone). */
export function viewersOf(core: Core, channel: string): { restricted: boolean; can: (handle: string) => boolean } {
  return { restricted: !!core.roster.channels.get(channel)?.members, can: (handle) => canSeeChannel(core.roster, channel, handle) };
}

/** Where a seat would start now: its card, and the machine by the poll's rules among machines whose person can see the card. */
function seatPlan(d: RecDeps, fleet: FleetNow, a: Extract<RecActionT, { kind: "start_seat" }>) {
  const card = d.idx.db.card(a.card);
  if (!card || card.state !== "open") return null;
  const viewers = viewersOf(d.core, card.channel);
  return { card, restricted: viewers.restricted, target: seatTarget(fleet.machines, a, viewers.can) };
}

const noSeat = (restricted: boolean): string =>
  `no machine${restricted ? " whose person can see this project" : ""} can take a seat now (none has a free seat and an account with room)`;

/**
 * Word for word what approving `rec` does in `by`'s name: for a seat, which seat on which machine for which card (chosen now,
 * by the poll's rules); for the rest what outgoingOf says. The list shows it, and an approval must echo it: if what it would do
 * now differs from what the person saw (a card renamed, another machine chosen), the approval is refused.
 */
export function outgoingNow(d: RecDeps, rec: Rec, by: string, fleet: () => FleetNow): string | null | undefined {
  const a = rec.action;
  if (a.kind !== "start_seat") return outgoingOf(d, rec, by);
  const plan = seatPlan(d, fleet(), a);
  if (!plan) return null;
  // The machine by its person, name and node id (names are not unique), and the card's title as data: a change of either
  // between the list and the tap changes this text, so the echo check refuses the approval.
  const project = d.idx.project(plan.card.channel);
  const title = cardDataTitle(plan.card.title, project ? [project.prefix, ...(project.prior_prefixes ?? [])] : []);
  return plan.target ? `Starts a ${a.role} seat (${plan.target.runtime}) on @${plan.target.handle}/${safeText(plan.target.hostname, 63)} (${plan.target.node.slice(0, 8)}) for card ${plan.card.ref}: ${title}`
    : `Starts nothing now: ${noSeat(plan.restricted)}`;
}

function fleetOf(d: RecDeps, c: RouteCtx): FleetNow {
  if (fleetOverride) return fleetOverride();
  const deps = { ...d, nodes: () => nodesView(c.core, c.sync), seatHosts: () => seatHosts(c.core, c.sync), seats: () => seatsList(c.core),
    accounts: () => accountsView(c.core, c.sync), agents: () => agentsView(c.core, c.sync) };
  const projects = visibleProjects({ core: d.core, idx: d.idx }).filter((p) => p.state === "active");
  const { machines, facts } = fleetNow(deps, projects, (d.now ?? d.core.clock)());
  return { machines, working: facts.onCard };
}

/** One request to an existing route, as the approver (their ctx, a new request); an error is the route's own HttpError. */
async function call(c: RouteCtx, method: string, path: string, body?: unknown): Promise<any> {
  const answered = override?.(method, path, body);
  if (answered) return answered;
  const req = new Request(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: c.req.signal,
  });
  const res = await dispatch({ ...c, req, url: new URL(req.url) });
  const answer = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  // A route that answers with an error status instead of throwing is a refusal too, never a success.
  if (!res.ok) throw new HttpError(res.status, answer?.error?.code ?? "rec_action_failed", safeText(answer?.error?.message ?? `the request was refused (${res.status})`, 300));
  return answer;
}

const stale = (why: string): HttpError => new HttpError(409, "rec_stale", `${why}; dismiss this recommendation`);

/** What a card, a seat prompt and an ask carry so a recommendation can be found again. */
export const markerOf = (rec: Pick<Rec, "id">): string => recMarker(rec.id);

const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

interface Where { project: ProjectView; card: CardView; role: ColumnRole; columnName: string }

function columnsOf(project: ProjectView, board: string) {
  return project.boards.find((b) => b.id === board)?.columns ?? [];
}

/** The card and its project as the board has them now, or why the recommendation is stale. */
function whereIs(d: RecDeps, rec: Rec, cardId: string): Where {
  d.idx.flushAll();
  const card = d.idx.db.card(cardId);
  if (!card || card.state !== "open") throw stale("the card is no longer open");
  const project = d.idx.project(card.channel);
  if (!project || project.state !== "active") throw stale("its project is not active");
  if (rec.audience === "team" && card.channel !== rec.channel) throw stale("the card is not in this project");
  const col = columnsOf(project, card.board).find((x) => x.id === card.column);
  return { project, card, role: col?.role ?? "todo", columnName: col?.name ?? card.column };
}

const named = (project: ProjectView, board: string, id: string): string => safeText(columnsOf(project, board).find((x) => x.id === id)?.name ?? id, 40);

/** Why and the evidence, for what the daemon recommended; nothing for a model-recorded one (its words are not posted as anyone's). */
function daemonWhy(rec: Rec): string {
  if (rec.source === "turn") return "";
  return `\nWhy: ${rec.reason}${rec.evidence.length ? `\nEvidence: ${rec.evidence.join("; ")}` : ""}`;
}

/** The comment the card gets: whose recommendation, who approved it, why, and the evidence. Skipped when the card already has it. */
function evidenceComment(d: RecDeps, c: RouteCtx, rec: Rec, by: string, what: string, w: Where): Promise<unknown> | null {
  const marker = markerOf(rec);
  const have = d.idx.foldCardNow(w.card.channel, w.card.id)?.state.timeline.some((e) => e.kind === "comment" && typeof e.text === "string" && e.text.includes(marker));
  if (have) return null;
  const text = `${marker}\n@${by} approved WalkieTalkie's recommendation: ${what}.${daemonWhy(rec)}`;
  return call(c, "POST", `/v1/tasks/${encodeURIComponent(w.card.id)}/comment`, { text: text.slice(0, 4_000) });
}

async function moveCard(d: RecDeps, c: RouteCtx, rec: Rec, a: Extract<RecActionT, { kind: "move_card" }>, by: string): Promise<string> {
  const w = whereIs(d, rec, a.card);
  const to = a.to ? named(w.project, w.card.board, a.to) : null;
  if (a.to && w.card.column === a.to) return `Already in “${to}”.`;
  if (w.card.column !== a.from) throw stale(`the card has moved (it is in “${w.columnName}” now)`);
  await call(c, "POST", `/v1/tasks/${encodeURIComponent(w.card.id)}`, a.to ? { column: a.to } : { blocked: true, blocked_reason: a.blocked_reason });
  await evidenceComment(d, c, rec, by, a.to ? `moved to “${to}”` : "marked as blocked", w);
  return a.to ? `Moved to “${to}”.` : "Marked as blocked.";
}

/** The short brief a seat started from a recommendation gets: where the card is, how to claim and report on it, and what to do when it cannot. */
export function seatBrief(rec: Rec, a: Extract<RecActionT, { kind: "start_seat" }>, w: Where, by: string): string {
  const title = cardDataTitle(w.card.title, [w.project.prefix, ...(w.project.prior_prefixes ?? [])]);
  const head = `${markerOf(rec)} You are a ${a.role} seat, started by @${by} on WalkieTalkie's recommendation.\nCard ${w.card.ref}: ${title}\nProject: ${cardDataTitle(w.project.name, [])}`;
  const ref = w.card.ref;
  return a.role === "builder"
    ? `${head}\n1. Read the card: walkie task ${ref} (its description, comments and pinned documents are the brief).\n2. Claim it: walkie task start ${ref}. Work only in this seat's directory.\n3. Keep it current: walkie task comment ${ref} "<what changed>" after each real step.\n4. When the work is done and tested, run walkie task review ${ref}. Do not mark it done: a reviewer does.\nIf you cannot do it (the repository or credentials are not available here, or the card is unclear), comment on the card saying exactly what is missing, and stop.`
    : `${head}\n1. Read the card and what was built: walkie task ${ref}.\n2. Review the work against the card: correctness first, then tests, security and anything the card promised.\n3. Give your verdict as a comment: walkie task comment ${ref} "PASS" or "FAIL" with the reasons, one finding per line, the worst first.\nDo not change the work yourself. If you cannot review it (nothing to review here, access missing), comment on the card saying what is missing, and stop.`;
}

async function startSeat(d: RecDeps, c: RouteCtx, rec: Rec, a: Extract<RecActionT, { kind: "start_seat" }>, by: string, read: () => FleetNow): Promise<string> {
  const w = whereIs(d, rec, a.card);
  const wanted: readonly ColumnRole[] = a.role === "builder" ? ["todo", "backlog"] : ["review"];
  if (!wanted.includes(w.role)) throw stale(`the card is in “${w.columnName}” now`);
  const marker = markerOf(rec);
  if ((seatsOverride ?? (() => seatsList(d.core)))().some((s) => !TERMINAL_STATES.has(s.state) && s.prompt.includes(marker))) return "A seat for this is already running.";
  const fleet = read();
  const hold = seatHold(w.card, a.role === "builder" ? "build" : "review", fleet.working.has(w.card.id));
  if (hold) throw stale(hold);
  // Only a machine whose person can see the card's project: a private project's card never goes into a brief elsewhere.
  const plan = seatPlan(d, fleet, a);
  const target = plan?.target;
  if (!target) throw new HttpError(409, "no_free_seat", `${noSeat(plan?.restricted ?? false)}; try again later`);
  const chosen = { ...a, machine: target.node, runtime: target.runtime };
  const res = await call(c, "POST", "/v1/seats/run", { machine: chosen.machine, runtime: chosen.runtime, prompt: seatBrief(rec, chosen, w, by) });
  const host = (res as { host?: { hostname?: string } })?.host?.hostname ?? target.hostname;
  await evidenceComment(d, c, rec, by, `a ${a.role} seat (${chosen.runtime}) was started on ${host}`, w);
  return `Started a ${a.role} seat (${chosen.runtime}) on ${host}.`;
}

async function askOrchestrator(d: RecDeps, c: RouteCtx, rec: Rec, a: Extract<RecActionT, { kind: "ask_orchestrator" }>, by: string): Promise<string> {
  const w = a.card ? whereIs(d, rec, a.card) : null;
  if (w && rec.audience === "team" && isConfidential(w.card.labels)) throw stale("the card is labelled confidential now");
  const text = outgoingOf(d, rec, by);
  if (!text) throw stale("the card is no longer open");
  const marker = markerOf(rec);
  const asked = d.core.store.queryEvents({ kinds: ["ask"], since_ts: (d.now ?? d.core.clock)() - 24 * 3_600_000, limit: 500 })
    .some((row) => { try { const e = JSON.parse(row.json) as { author?: { handle?: string }; body?: { text?: string } }; return e.author?.handle === by && !!e.body?.text?.includes(marker); } catch { return false; } });
  if (asked) return `Already asked ${a.to}.`;
  // An ask about a card goes in the card's own channel, so only those who can see the card can read it (the ask route checks
  // that the person asked can see it too); never a channel-less message that every member and observer reads.
  await call(c, "POST", "/v1/ask", { to: a.to, text, timeout_s: 86_400, ...(w ? { channel: w.card.channel } : {}) });
  if (w) await evidenceComment(d, c, rec, by, `asked ${a.to}`, w);
  return `Asked ${a.to}.`;
}

async function createCard(d: RecDeps, c: RouteCtx, rec: Rec, a: Extract<RecActionT, { kind: "create_card" }>, by: string): Promise<string> {
  d.idx.flushAll();
  const project = d.idx.project(a.project);
  if (!project || project.state !== "active") throw stale("the project is not active");
  const title = norm(a.title);
  if (d.idx.db.cards(a.project, { states: ["open"], limit: 20_000 }).some((card) => norm(card.title) === title)) return "A card with that title is already there.";
  const body = `${markerOf(rec)}\nCreated from a WalkieTalkie recommendation approved by @${by}.${daemonWhy(rec)}`;
  const res = await call(c, "POST", "/v1/tasks", { project: a.project, title: a.title, body, ...(a.column ? { column: a.column } : {}) });
  const made = (res as { task?: { board?: string; column?: string } }).task;
  return `Created a card in “${made?.board && made.column ? named(project, made.board, made.column) : "the project"}”.`;
}

async function onboardingStep(c: RouteCtx, a: Extract<RecActionT, { kind: "onboarding_step" }>): Promise<string> {
  const res = await call(c, "POST", "/v1/admin/run", { machines: a.machine, argv: [...ONBOARDING_ARGV[a.step]] }) as
    { ok?: boolean; results?: Array<{ machine?: string; ok?: boolean; stderr?: string; error?: { message?: string } }> };
  const r = res.results?.[0];
  if (!res.ok || !r?.ok) throw new HttpError(502, "rec_action_failed", safeText(r?.error?.message ?? r?.stderr ?? "the command failed on that machine", 300));
  return a.step === "seats_doctor" ? `Ran the check on ${r.machine ?? a.machine}.` : `Turned on seats on ${r.machine ?? a.machine}.`;
}

/** Does what the recommendation says, as `by`, through the existing routes; returns one plain line of what was done. Throws the route's own error when it cannot. */
export async function performRec(d: RecDeps, c: RouteCtx, rec: Rec, by: string, fleet: () => FleetNow = fleetReader(d, c)): Promise<string> {
  const a = rec.action;
  switch (a.kind) {
    case "move_card": return moveCard(d, c, rec, a, by);
    case "start_seat": return startSeat(d, c, rec, a, by, fleet);
    case "ask_orchestrator": return askOrchestrator(d, c, rec, a, by);
    case "create_card": return createCard(d, c, rec, a, by);
    case "onboarding_step": return onboardingStep(c, a);
  }
}
