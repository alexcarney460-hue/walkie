// PROJECT-PAGES-1 in the daemon: a project's status page. Reads (the route's answer: the plain-English story the report turn
// posted, the counts Walkie makes itself, the facts people and agents set, the screens) and writes (a fact, a screen added or
// taken off), each checked at the boundary. The facts are signed `page` ops in the project root's thread (folded by
// protocol/projects/page.ts and cached by the index), the screens are Data Room files carrying a screen register, the story
// is the `status_page` that WalkieTalkie's report post carries. docs/plans/PROJECT-PAGES-1.md has the design.
import type { AgentView } from "../../protocol/schemas.ts";
import { currentVersion, type RoomFileState } from "../../protocol/projects/room.ts";
import { cleanFactText, compareScreens, composeScreens, factKey, pageOpText, sameScreen, screenKey, screensWanted } from "../../protocol/projects/page.ts";
import { sniffImage } from "../../protocol/projects/page-image.ts";
import { readStoryPost } from "../../protocol/projects/page-story.ts";
import { hasQuery, isRouteAddress, problemsIn, routeCarriesToken, shownText } from "../../protocol/projects/page-text.ts";
import {
  FACT_LABEL_MAX, FACT_VALUE_MAX, MAX_FACTS, MAX_SCREEN_GROUPS, MAX_SCREENS, PLAIN_LINE, ScreenMeta, SCREEN_MAX_BYTES, SCREEN_STATUSES,
  type ProjectView, type ScreenMetaT,
} from "../../protocol/projects/schema.ts";
import type { ComputedFacts, ScreenView, SetFactView, StatusPagePayload, StoryView } from "../../protocol/projects/status-page.ts";
import { reportMode } from "../../protocol/projects/status-report.ts";
import type { Core } from "../core.ts";
import { HttpError } from "../http.ts";
import type { ProjectsIndex } from "./index.ts";
import { cardCounts } from "./page-counts.ts";
import { pageScreens, screensUpdatedAt } from "./page-screens.ts";
import { addFile, setScreen } from "./room.ts";
import { post, visibleProject, visibleProjects, type WriteCtx } from "./service.ts";
import { agentsByProject, liveAgent } from "./status-report.ts";

export interface PageDeps {
  readonly core: Core; readonly idx: ProjectsIndex;
  /** Every agent this daemon knows (views.ts agentsView). */
  readonly agents: () => readonly AgentView[];
  /** The page's clock; default Date.now. */
  readonly now?: () => number;
}

const whoOf = (a: { handle: string; agent?: string | undefined }) => ({ handle: a.handle, ...(a.agent ? { agent: a.agent } : {}) });

// ---- the read model -----------------------------------------------------------------------------------------------------

/** What Walkie counts itself: the card counts (page-counts.ts) and the agents working on the project now. */
function computeFacts(d: PageDeps, p: ProjectView, visible: readonly ProjectView[], now: number): ComputedFacts {
  const counts = cardCounts(d.idx, p, now);
  const working = (agentsByProject({ core: d.core, idx: d.idx, agents: d.agents }, visible).get(p.channel) ?? [])
    .filter((a) => liveAgent(a.agent) && a.agent.effective_state === "working");
  return { ...counts, agents_working: working.length, agent_machines: new Set(working.map((a) => a.agent.node)).size };
}

/** The newest usable story among the project's latest report posts (an owner's WalkieTalkie wrote it; read through the cleaning again). */
function latestStory(d: PageDeps, p: ProjectView, keys: readonly string[]): StoryView | null {
  const owners = [...d.core.roster.members.values()].filter((m) => m.role === "owner").map((m) => m.handle);
  for (const ev of d.idx.db.statusReportPosts(p.channel, owners, 5)) {
    const body = ev.body as { status_report?: { as_of?: unknown }; status_page?: unknown };
    const asOf = body.status_report?.as_of;
    if (typeof asOf !== "number" || !Number.isSafeInteger(asOf) || asOf < 0) continue;
    const story = readStoryPost(body.status_page, keys);
    // Dated by the earlier of the lead machine's stamp and this daemon's receipt (the order the posts are ranked in, db.ts
    // statusReportPosts): a lead whose clock runs ahead cannot date its story in the future, nor have it read "just now" for hours.
    if (story) return { ...story, as_of: asOf, at: Math.min(ev.ts, d.idx.db.receivedAt(ev.id) ?? ev.ts), by: whoOf(ev.author) };
  }
  return null;
}

function withNote(story: StoryView, keep: boolean): StoryView {
  const { screens_note: note, ...rest } = story;
  return keep && note ? { ...rest, screens_note: note } : rest;
}

/**
 * When the project's hourly report was last switched on (the start of the stretch it has been on since), from the settings the
 * project folds: an op that set `status_report` to "hourly" after the last one that set it off, or the project's own root when it
 * was created with reports on. Null when the history says nothing (it is read as "unknown", never as "long ago").
 */
function reportingSince(idx: ProjectsIndex, channel: string): number | null {
  const entries = (idx.settingsOf(channel).project?.timeline ?? [])
    .filter((e) => !e.ignored && e.changes && "status_report" in e.changes)
    .sort((a, b) => (a.effective_rev ?? 0) - (b.effective_rev ?? 0) || a.ts - b.ts);
  let since: number | null = null;
  for (const e of entries) {
    const mode = (e.changes as Record<string, unknown>).status_report;
    if (mode === "hourly") since = since ?? e.ts;
    else if (mode === "off") since = null;
  }
  return since;
}

/**
 * The status page of a project this member can see. The facts people and agents set and the screens are always answered
 * (an agent can prepare them with the report off); the story and Walkie's own counts only while the report is on, which is
 * also the only time the dashboard shows the page. A screens sentence the report turn wrote is dropped once it is no longer true.
 */
export function buildPage(d: PageDeps, p: ProjectView): StatusPagePayload {
  const now = (d.now ?? Date.now)();
  const on = reportMode(p) === "hourly";
  const screens = pageScreens(d.idx, p.channel);
  const set = factsOf(d.idx, p.channel);
  const visible = visibleProjects({ core: d.core, idx: d.idx });
  const keys = [...new Set(visible.flatMap((x) => [x.prefix, ...(x.prior_prefixes ?? [])]))];
  const found = on ? latestStory(d, p, keys) : null;
  // The sentence "screens are out of date" is kept only while it is still true (a screen added since drops it).
  const stillWanted = screensWanted({ count: screens.total, newest: screens.newest_at }, now);
  const story = found ? withNote(found, stillWanted) : null;
  const times = [story?.at, screensUpdatedAt(d.idx, p.channel), d.idx.page(p.channel).updated_at].filter((t): t is number => typeof t === "number");
  // A time signed on a machine whose clock runs ahead is never shown as later than the moment the page was read.
  const upTo = (t: number): number => Math.min(t, now);
  const computed = on ? computeFacts(d, p, visible, now) : null;
  const since = on ? reportingSince(d.idx, p.channel) : null;
  return {
    mode: reportMode(p), state: p.state, generated_at: now, updated_at: times.length ? upTo(Math.max(...times)) : null,
    reports_since: since === null ? null : upTo(since),
    story: story ? { ...story, as_of: upTo(story.as_of), at: upTo(story.at) } : null,
    facts: { computed: computed && computed.last_change !== null ? { ...computed, last_change: upTo(computed.last_change) } : computed, set: set.map((f) => ({ ...f, at: upTo(f.at) })) },
    screens: { ...screens, newest_at: screens.newest_at === null ? null : upTo(screens.newest_at),
      groups: screens.groups.map((g) => ({ ...g, screens: g.screens.map((x) => ({ ...x, at: upTo(x.at) })) })) },
  };
}

// ---- writes -------------------------------------------------------------------------------------------------------------

/** Who may change a project's page, and when: a member or their named agent, while the project is active. */
function writer(w: WriteCtx, channel: string): ProjectView {
  if (w.underAgent && !w.agent) throw new HttpError(403, "agent_unnamed", "a status page change from an agent must name it (WALKIE_AGENT=<name>, or --agent)");
  const p = visibleProject(w, channel);
  const m = w.core.me();
  if (!m || m.role === "removed") throw new HttpError(403, "forbidden", "this node is not an admitted member");
  if (m.role === "observer") throw new HttpError(403, "forbidden", "observers can't change a project's status page");
  if (p.state !== "active") throw new HttpError(409, "conflict", `project ${p.name} is ${p.state}`);
  return p;
}

/**
 * One text of a fact or a screen as it is stored: tidied to one line, within its length, made of characters a page can show,
 * and with no link (a page is plain text), no join code and no secret in it. Throws the plain reason.
 */
function plain(what: string, raw: string, max: number): string {
  const t = cleanFactText(raw);
  if (!t) throw new HttpError(400, "invalid", `${what} can't be empty`);
  if (t.length > max) throw new HttpError(400, "invalid", `${what} is at most ${max} characters`);
  if (!PLAIN_LINE.test(t)) throw new HttpError(400, "invalid", `${what} has characters a page can't show (plain text on one line)`);
  // Judged as shown and on its bare letters (page-text.ts): a disguise cannot hide a link, a join code or a secret.
  const problems = problemsIn(t);
  if (problems.link) throw new HttpError(400, "invalid", `${what} has a link in it: a status page is plain text (write the name of the site, not its address)`);
  if (problems.join) throw new HttpError(400, "invalid", `${what} looks like a join code, which is never put on a page`);
  if (problems.secrets.length) throw secretFound(what, problems.secrets);
  return t;
}

/** The refusal for a text the secret detectors flagged. */
function secretFound(what: string, found: readonly string[]): HttpError {
  return new HttpError(409, "secret_detected", `${what} looks like it contains a secret (${found.join(", ")}); remove it`, { findings: [...found] });
}

export interface FactRequest { label: string; value: string | null }
export interface FactResult { facts: SetFactView[]; unchanged: boolean }

/**
 * The facts as the API lists them, each text read through the checks it was written through (page-text.ts): a fact a modified peer
 * signed with a link shows without it, a secret is redacted, and one whose label or value is a join code is not listed.
 */
function factsOf(idx: ProjectsIndex, channel: string): SetFactView[] {
  return idx.page(channel).facts.flatMap((f) => {
    const label = shownText(f.label);
    const value = shownText(f.value);
    return label && value ? [{ label, value, by: f.by, at: f.at }] : [];
  });
}

/**
 * Sets (a value) or removes (null) one fact of a project's page, as a signed page op in the project's thread: a member or
 * their named agent. Setting what is already there, or removing what is not, signs nothing (`unchanged`). The seventh
 * label is refused with what to do; the fold would ignore it anyway.
 */
export function setFact(w: WriteCtx, channel: string, req: FactRequest): FactResult {
  const p = writer(w, channel);
  const label = plain("a fact's label", req.label, FACT_LABEL_MAX);
  const value = req.value === null ? null : plain("a fact's value", req.value, FACT_VALUE_MAX);
  w.idx.flushAll();
  const page = w.idx.page(p.channel);
  const key = factKey(label);
  const had = page.facts.find((f) => factKey(f.label) === key);
  if (value === null ? !had : had?.label === label && had.value === value) return { facts: factsOf(w.idx, p.channel), unchanged: true };
  if (value !== null && !had && page.facts.length >= MAX_FACTS) {
    throw new HttpError(409, "fact_limit", `a status page shows at most ${MAX_FACTS} facts; remove one first (walkie projects fact <project> "<label>" --remove)`);
  }
  post(w, p.channel, pageOpText({ label, value }), { v: 1, rev: page.rev + 1, op: "page", ...(page.head ? { after: page.head } : {}), fact: { label, value } }, { thread: p.id });
  w.idx.markPage(p.channel);
  w.idx.flushAll();
  return { facts: factsOf(w.idx, p.channel), unchanged: false };
}

export interface ScreenRequest { title: string; group: string; status: string; about: string; route?: string | undefined; note?: string | undefined }
export interface ScreenResult { screen: ScreenView; created: boolean; version: number; unchanged: boolean }

/** The live screen files that are this (group, title): one, or two when machines added it at once. */
function screensWithKey(idx: ProjectsIndex, channel: string, key: string): RoomFileState[] {
  return idx.room(channel).filter((f) => f.state === "active" && !!f.screen && screenKey(f.screen.group, f.screen.title) === key);
}

/** The one the page shows, using composeScreens' version/creation/id comparator. */
function findScreen(idx: ProjectsIndex, channel: string, key: string): RoomFileState | null {
  const selection = (f: RoomFileState) => ({ id: f.id, created_at: f.created_at, updated_at: currentVersion(f).ts });
  return screensWithKey(idx, channel, key).reduce<RoomFileState | null>((best, f) =>
    !best || compareScreens(selection(f), selection(best)) > 0 ? f : best, null);
}

const EXTENSION = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

/**
 * A Data Room name for a new screen: its group and title, with no slash in it. A name is taken only by a file that is a screen
 * of the page right now (another screen whose group and title read the same once the slash is gone): a file taken off the page
 * earlier is not, so adding the screen again brings that file back in its place instead of making a second one.
 */
function screenName(idx: ProjectsIndex, channel: string, group: string, title: string, mime: keyof typeof EXTENSION): string {
  const taken = new Set(idx.room(channel).filter((f) => f.state === "active" && f.screen).map((f) => f.name));
  const base = `${group} - ${title}`.replace(/[\\/]/g, "-");
  const name = (n: number) => `${base}${n > 1 ? ` (${n})` : ""}.${EXTENSION[mime]}`;
  let n = 1;
  while (taken.has(name(n))) n++;
  return name(n);
}

/**
 * Adds a screen to a project's page, or replaces the one with this group and title (a new version of its Data Room file; the
 * same bytes with new details change the details only): the image is judged from its own bytes (PNG, JPEG or WebP, at most
 * 8 MB and a size a browser can decode), the details are plain text, and the file is stored through the Data Room, so its
 * limits, its privacy and its replication are the room's. A member or their named agent.
 */
export function addScreen(w: WriteCtx, channel: string, bytes: Uint8Array, req: ScreenRequest): ScreenResult {
  const p = writer(w, channel);
  if (bytes.byteLength > SCREEN_MAX_BYTES) throw new HttpError(413, "too_large", `a screen is at most ${SCREEN_MAX_BYTES / (1024 * 1024)} MB`);
  const image = sniffImage(bytes);
  if (!image) throw new HttpError(400, "invalid", "a screen is a PNG, JPEG or WebP image of a size a page can show (at most 8 MB and 12,000 pixels a side)");
  if (!(SCREEN_STATUSES as readonly string[]).includes(req.status)) throw new HttpError(400, "invalid", `a screen's status is one of ${SCREEN_STATUSES.join(", ")}`);
  const candidate = {
    title: plain("a screen's title", req.title, 60), group: plain("a screen's group", req.group, 40), status: req.status,
    about: plain("what a screen shows", req.about, 300),
    ...(req.route !== undefined ? { route: req.route.trim() } : {}),
    ...(req.note !== undefined ? { note: plain("a screen's note", req.note, 200) } : {}),
    w: image.width, h: image.height,
  };
  if (candidate.route !== undefined) {
    // The route is judged like every other text: a link, `//host/path` and a join code are refused, and so is a secret (a key
    // in a query string, say).
    const problems = problemsIn(candidate.route);
    if (problems.link || problems.join || isRouteAddress(candidate.route)) throw new HttpError(400, "invalid", "a screen's route is the path of a page (/carrier/loads), not an address");
    if (problems.secrets.length) throw secretFound("a screen's route", problems.secrets);
    // No query string at all: the detectors do not know every token that rides in one (an OAuth code, a session id), so what the
    // page was filtered by goes in the screen's note.
    if (hasQuery(candidate.route)) throw new HttpError(400, "invalid", "a screen's route is the path of a page, with no query string (/carrier/loads, not /carrier/loads?status=open): say what the page was filtered by in the screen's note");
  }
  const parsed = ScreenMeta.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // The route is the one detail that reaches the schema unchecked (the text ones were judged above, the image gave the size).
    if (issue?.path[0] === "route") throw new HttpError(400, "invalid", "a screen's route is the path of a page, like /carrier/loads or #/projects: printable characters with no spaces, at most 120");
    throw new HttpError(400, "invalid", `a screen's ${issue?.path.join(".") || "details"} is not valid: ${issue?.message ?? "out of range"}`);
  }
  const meta: ScreenMetaT = parsed.data;
  // And no token in the path (judged once the route is known to be a path of the right shape): an invitation, a password reset or a
  // session id is signed into the log for good, and an invite-acceptance page is exactly what an agent captures.
  if (meta.route !== undefined && routeCarriesToken(meta.route)) {
    throw new HttpError(400, "invalid", "a screen's route looks like it contains a one-time token; use the page's path without it (/invite/:token, not /invite/Xk9p...), or the path of a page an ordinary visitor reaches");
  }
  w.idx.flushAll();
  const key = screenKey(meta.group, meta.title);
  const target = findScreen(w.idx, p.channel, key);
  if (!target) {
    const live = w.idx.room(p.channel).filter((f) => f.state === "active" && f.screen);
    const keys = new Set(live.map((f) => screenKey((f.screen as ScreenMetaT).group, (f.screen as ScreenMetaT).title)));
    const groups = new Set(live.map((f) => factKey((f.screen as ScreenMetaT).group)));
    if (keys.size >= MAX_SCREENS) throw new HttpError(409, "screen_limit", `a status page shows at most ${MAX_SCREENS} screens; take one off first (walkie projects screen <project> --remove --group <g> --title <t>)`);
    if (!groups.has(factKey(meta.group)) && groups.size >= MAX_SCREEN_GROUPS) throw new HttpError(409, "group_limit", `a status page has at most ${MAX_SCREEN_GROUPS} groups of screens; use one of the existing groups`);
  }
  const changedMeta = !target || !sameScreen(target.screen, meta);
  const res = addFile(w, p.channel, bytes, {
    name: target?.name ?? screenName(w.idx, p.channel, meta.group, meta.title, image.mime), mime: image.mime,
    ...(target ? { file: target.id } : {}), screen: meta,
  });
  const screen = composeScreens([res.file]).groups[0]?.screens[0];
  if (!screen) throw new HttpError(500, "internal", "the screen wasn't added to the page");
  return { screen, created: res.created, version: res.version, unchanged: res.unchanged === true && !changedMeta };
}

/**
 * Takes a screen off the page (every file that is this group and title; they stay in the Data Room): a member or their named
 * agent. `removed` is how many files were taken off, 0 when there was none.
 */
export function removeScreen(w: WriteCtx, channel: string, req: { group: string; title: string }): { removed: number } {
  const p = writer(w, channel);
  w.idx.flushAll();
  const files = screensWithKey(w.idx, p.channel, screenKey(cleanFactText(req.group), cleanFactText(req.title)));
  for (const f of files) setScreen(w, p.channel, f.id, null);
  return { removed: files.length };
}
