// WALK-73 Phase 0: one dispute on a card. A pure fold of `dispute` ops in the card's thread (ranked like every other
// board op, chained to each other or to the card root, never to a card op). No I/O. Later phases may add fields; the
// ones here are optional so an older build of this op still parses. Pre.12 peers have no `dispute` arm: they show the
// post's text and fold nothing (docs/PROTOCOL.md).
import { foldProject, order, projectRootId, refOf, type FoldEnv, type OpEvent } from "./fold.ts";
import { escalationContactOf } from "./escalation.ts";
import { DisputeOp, type DisputeOpT } from "./schema.ts";

/** How long the ask that delivers a dispute stays open. Expiry does not close the dispute and does not escalate it. */
export const DISPUTE_ASK_TTL_S = 86_400;

/** Owners asked on one raise. The contact and the creator are one ask each; this caps only the owners route. */
export const DISPUTE_ASKS_PER_RAISE = 5;

/** After a resolve, this daemon refuses another raise on the same card until this long has passed. A local API rule. */
export const DISPUTE_RERAISE_AFTER_MS = 10 * 60 * 1000;

export type DisputeRouted = "contact" | "creator" | "owners";

/** The dispute as the API and the CLI show it. `ref` is the card's current reference; the fold leaves it empty. */
export interface DisputeView {
  id: string;
  card: string;
  ref: string;
  state: "open" | "resolved";
  summary: string;
  resolvers: string[];
  routed: DisputeRouted;
  by: { handle: string; agent?: string };
  at: number;
  reason?: string;
  resolved_by?: { handle: string };
  resolved_at?: number;
}

export interface DisputeState {
  current: DisputeView | null;
  ignored: Array<{
    id: string;
    reason: "not_member" | "already_open" | "not_open" | "not_resolver" | "incomplete" | "waiting_for_parent" | "waiting_for_settings";
  }>;
  /** The op the next dispute names as its parent (the card root's ref when there is none). */
  head: string;
  rev: number;
}

/** The handle an address names (`@kira/kiras-mbp` and `@kira` are the same person). */
export function resolverHandle(address: string): string {
  return address.startsWith("@") ? (address.slice(1).split("/")[0] ?? "") : "";
}

/** What an older daemon shows for a dispute it does not fold. */
export function disputeText(key: string, summary: string): string {
  return `Dispute on ${key}: ${summary}`;
}

/** What an older daemon shows when a dispute is resolved. */
export function resolveText(key: string, reason: string): string {
  return `Dispute on ${key} resolved: ${reason}`;
}

/** The ask sent to each resolver. Its expiry does not close or escalate the dispute. */
export function disputeAskText(key: string, project: string, summary: string, ref: string): string {
  return [
    `Dispute on ${key} in ${project}: ${summary}`,
    `Resolve it with: walkie dispute resolve ${ref} <reason>`,
    "Nothing escalates on its own. This ask expiring does not close the dispute and does not escalate it.",
    "A Walkie from before this release cannot resolve a dispute. Upgrade, or an owner on this release can resolve it.",
  ].join("\n");
}

export interface ResolverRoster {
  /** The project's escalation contact, or "" when unset. */
  contact: string;
  creator: string;
  owners: readonly string[];
  roleOf: (handle: string) => string | null;
  canSee: (handle: string) => boolean;
  /** Who is raising. The raiser is not asked to resolve their own dispute: the next route in order is used. */
  raiser?: string;
}

function canPost(dir: ResolverRoster, handle: string): boolean {
  const role = dir.roleOf(handle);
  return (role === "owner" || role === "member") && dir.canSee(handle);
}

/**
 * Who is asked when a dispute is raised now. The open op records these addresses; the fold does not treat that list as
 * authority. It asks the people the fold will let resolve, in the fold's own order:
 *   - a contact in effect (the contact can still post, as in {@link contactInEffect}) is asked, unless they are the raiser
 *     (the fold refuses the raiser) or cannot be asked. The creator is never asked then: with a contact in effect only the
 *     contact or an owner may resolve, so a member creator would get a 403. The owners are asked instead.
 *   - with no contact in effect, the creator, unless they are the raiser or cannot be asked.
 *   - otherwise the owners, at most {@link DISPUTE_ASKS_PER_RAISE}, sorted by handle. The raiser is left out when another
 *     owner can be asked, so the cap does not spend a slot on them and drop someone else.
 * Nobody who can be asked is an error the caller refuses before it signs.
 */
export function chooseResolvers(dir: ResolverRoster): { resolvers: string[]; routed: DisputeRouted } | { error: string } {
  const contact = contactInEffect(dir.contact, dir.roleOf);
  if (contact) {
    const handle = resolverHandle(contact);
    const machine = contact.slice(1).split("/")[1];
    if (handle !== dir.raiser && machine !== "cloud" && canPost(dir, handle)) return { resolvers: [contact], routed: "contact" };
  } else if (dir.creator && dir.creator !== dir.raiser && canPost(dir, dir.creator)) {
    return { resolvers: [`@${dir.creator}`], routed: "creator" };
  }
  const eligible = [...new Set(dir.owners)].filter((h) => canPost(dir, h));
  const others = dir.raiser ? eligible.filter((h) => h !== dir.raiser) : eligible;
  // The raiser stays only when they are the only owner who can be asked. Otherwise the cap would keep them and drop
  // another owner.
  const owners = (others.length > 0 ? others : eligible).sort().slice(0, DISPUTE_ASKS_PER_RAISE);
  if (owners.length === 0) return { error: "nobody can resolve a dispute on this project" };
  return { resolvers: owners.map((h) => `@${h}`), routed: "owners" };
}

/** What the fold already trusts when it decides who may resolve. The open op's `resolvers` is not one of these. */
export interface DisputeFoldEnv extends Pick<FoldEnv, "roleOf"> {
  /** Role in the roster now, for the list a reader sees. Defaults to `roleOf` on that handle. */
  roleNow?: (handle: string) => ReturnType<FoldEnv["roleOf"]>;
  /**
   * Role of a handle in the roster at an event. Used to see whether the contact named by the settings at that event
   * could still post. Defaults to treating a named contact as a posting member.
   */
  roleAt?: (ev: OpEvent, handle: string) => ReturnType<FoldEnv["roleOf"]>;
  /**
   * The project's escalation contact as the settings fold holds it now, or "". The list on an open dispute uses this.
   * A resolve does not: that decision uses {@link settingsPosts}.
   */
  contact?: string;
  /** The project's creator (the person), or "". */
  projectCreator?: string;
  /** Owner handles in the roster now. */
  owners?: readonly string[];
  /**
   * The project's settings posts (roots and replies). When present, a resolve is judged against the contact on the
   * parent chain of the settings head it names, never against {@link contact} and never against a timestamp. An open
   * or a resolve that omits the head grants no contact or creator authority. When absent, the fold uses
   * {@link contact}: the daemon always passes the log, and this fallback is only for a caller with no settings log.
   */
  settingsPosts?: readonly OpEvent[];
  /** How those posts are folded. Defaults to this env's `roleOf` and a null channel creator. */
  settingsEnv?: FoldEnv;
}

/**
 * Whether this person may resolve. Pending Alex's D11 decision: the escalation contact when one is in effect, otherwise
 * the project's creator, plus project owners always. The card's creator is not a resolver unless they are one of those.
 * The raiser is not a resolver of their own dispute unless they are an owner. Anyone else, including a removed member,
 * may not. Agents are refused by the caller: this looks at the handle and the role only.
 *
 * This is the only place that decides. Changing it after release re-judges disputes that already resolved, because a
 * dispute is folded on every read and never stored.
 *
 * `who.contact` is the contact address in effect for THIS decision (empty when unset or when that person cannot post).
 * It is not "whatever the project says now" unless the caller is listing who could resolve an open dispute today.
 */
export function handleMayResolve(
  handle: string,
  role: string | null | undefined,
  who: { contact: string; projectCreator: string },
  raiser?: string,
): boolean {
  if (role !== "owner" && role !== "member") return false;
  if (role === "owner") return true;
  if (raiser && handle === raiser) return false;
  const contact = resolverHandle(who.contact);
  if (contact) return handle === contact;
  return handle !== "" && handle === who.projectCreator;
}

/** The contact address when that person can still post, otherwise "". A removed contact is not in effect. */
function contactInEffect(contact: string, roleOf: (handle: string) => string | null): string {
  const named = escalationContactOf({ escalation_contact: contact });
  const handle = resolverHandle(named);
  if (!handle) return "";
  const role = roleOf(handle);
  if (role !== "owner" && role !== "member") return "";
  return named;
}

/**
 * Who may resolve, in the order a reader sees: the contact when that person can still post, otherwise the project's
 * creator, then the owners sorted by handle. Each person once. The card's creator is not listed unless they are one of
 * those. The raiser is left out unless they are an owner.
 */
export function resolverAddresses(dir: {
  contact: string;
  projectCreator: string;
  owners: readonly string[];
  roleOf: (handle: string) => string | null;
  raiser?: string;
}): string[] {
  const contact = contactInEffect(dir.contact, dir.roleOf);
  const who = { contact, projectCreator: dir.projectCreator };
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (address: string): void => {
    const handle = resolverHandle(address);
    if (!handle || seen.has(handle)) return;
    if (!handleMayResolve(handle, dir.roleOf(handle), who, dir.raiser)) return;
    seen.add(handle);
    out.push(address);
  };
  if (contact) add(contact);
  else if (dir.projectCreator) add(`@${dir.projectCreator}`);
  for (const handle of [...new Set(dir.owners)].sort()) add(`@${handle}`);
  return out;
}

function roleNowOf(env: DisputeFoldEnv, handle: string): ReturnType<FoldEnv["roleOf"]> {
  if (env.roleNow) return env.roleNow(handle);
  return env.roleOf({ author: { handle, node: "" } } as OpEvent);
}

function settingsFoldEnv(env: DisputeFoldEnv): FoldEnv {
  return env.settingsEnv ?? { creator: null, roleOf: env.roleOf };
}

/** Same shape as a settings op's `after` (fold.ts). The hash is the parent's signature, not a claim the op makes. */
const SETTINGS_REF_RE = /^([0-9a-f]{16}:[1-9][0-9]*)#([0-9a-f]{16})$/;

/** One applied settings revision: the contact along that head's own parent chain, and the rank of that chain. */
interface SettingsRevision {
  head: string;
  contact: string;
  rank: number;
  /** Root first, this head last. A strict ancestor's ref is in here, so an equal rank cannot hide one. */
  chain: string[];
}

function boardField(ev: OpEvent, key: "op" | "after"): string | undefined {
  const board = ev.board;
  if (!board || typeof board !== "object") return undefined;
  const value = (board as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * What a named settings head is on this machine. `known`: an applied revision, with its chain. `unknown`: the head or one
 * of its ancestors has not been received here, so sync may change it. `invalid`: it is here and cannot be used (a wrong
 * signature hash, a cycle, a hidden or ignored op, not a project op, or a chain that ends at a project root other than
 * the canonical one), so waiting will not change it.
 */
type SettingsLookup = { kind: "known"; rev: SettingsRevision } | { kind: "unknown" } | { kind: "invalid" };
const UNKNOWN: SettingsLookup = { kind: "unknown" };
const INVALID: SettingsLookup = { kind: "invalid" };

/**
 * The contact in effect at one named settings head, from that head's own parent chain. Every settings op names
 * exactly one parent, and the signature hash is checked, so a concurrent or later op cannot join the chain.
 * The chain must end at the canonical project root (the one `foldProject` takes), not another root the channel's
 * creator posted, and folding that chain has to land on the head.
 */
function settingsLookup(posts: readonly OpEvent[], headRef: string, env: FoldEnv, canonicalRoot: string | null): SettingsLookup {
  const named = SETTINGS_REF_RE.exec(headRef);
  if (!named) return INVALID;
  const byId = new Map(posts.map((p) => [p.id, p]));
  const head = byId.get(named[1] as string);
  if (!head) return UNKNOWN;
  if (head.h !== named[2]) return INVALID;
  const chain: OpEvent[] = [];
  const seen = new Set<string>();
  let cur: OpEvent | undefined = head;
  while (cur) {
    if (seen.has(cur.id)) return INVALID;
    seen.add(cur.id);
    chain.push(cur);
    if (cur.thread === undefined) break;
    const after = boardField(cur, "after");
    if (after === undefined) {
      // No parent named: the parent is this reply's thread root, which has to be a root post.
      const root = byId.get(cur.thread);
      if (!root) return UNKNOWN;
      if (root.thread !== undefined || seen.has(root.id)) return INVALID;
      chain.push(root);
      break;
    }
    const parentRef = SETTINGS_REF_RE.exec(after);
    if (!parentRef) return INVALID;
    const parent = byId.get(parentRef[1] as string);
    if (!parent) return UNKNOWN;
    if (parent.h !== parentRef[2] || parent.id === cur.id) return INVALID;
    cur = parent;
  }
  chain.reverse();
  const root = chain[0];
  if (!root || root.thread !== undefined || boardField(root, "op") !== "project" || root.id !== canonicalRoot) return INVALID;
  const folded = foldProject(chain, env);
  if (!folded || folded.head !== headRef) return INVALID;
  return { kind: "known", rev: { head: headRef, contact: folded.escalation_contact, rank: folded.rev, chain: chain.map(refOf) } };
}

/**
 * Whether `head` is an applied project-settings revision in `posts`, still to be received, or unusable (see
 * {@link SettingsLookup}). A settings op that is not an ancestor of `head` cannot change this.
 */
export function settingsHeadState(posts: readonly OpEvent[], head: string, env: FoldEnv): "known" | "unknown" | "invalid" {
  return settingsLookup(posts, head, env, projectRootId(posts, env)).kind;
}

/** Whether `head` is an applied project-settings revision in `posts`. A missing, hidden, ignored or forged one is not. */
export function knownSettingsHead(posts: readonly OpEvent[], head: string, env: FoldEnv): boolean {
  return settingsHeadState(posts, head, env) === "known";
}

/**
 * The resolve's head is too old for the open's when it is a strict ancestor of the open's head (including a
 * same-machine follow-up, whose rank is equal), or when its own chain's rank is lower. The same head is not too old.
 * A later head is not too old, and neither is a concurrent head of equal or higher rank: origin is not a tiebreak,
 * because an honest resolve names the project's current head, which can be a concurrent op.
 */
function settingsHeadIsOlder(named: SettingsRevision, open: SettingsRevision): boolean {
  if (named.head === open.head) return false;
  if (open.chain.includes(named.head)) return true;
  return named.rank < open.rank;
}

/**
 * The contact a resolve is judged against, or a refusal of contact and creator authority. Owners do not need this:
 * the caller still lets them resolve.
 *
 * With a settings log, both the open and the resolve have to name a head. One that omits it gets no contact and no
 * creator authority: timestamps are not consulted, so a backdated or future-dated time cannot choose the contact.
 * The contact at a named head is that head's parent chain only. A head this fold has not received yet is `waiting`
 * (sync may change the verdict); one it cannot use, or one older than the open's head, is a plain refusal. Without a
 * settings log the fold uses the contact it was given.
 */
function contactAtResolve(
  env: DisputeFoldEnv,
  op: DisputeOpT,
  open: { op: DisputeOpT },
  posts: readonly OpEvent[] | undefined,
  lookup: (head: string) => SettingsLookup,
): { contact: string; refuse: boolean; waiting: boolean } {
  if (!posts) return { contact: env.contact ?? "", refuse: false, waiting: false };
  if (!op.settings || !open.op.settings) return { contact: "", refuse: true, waiting: false };
  const named = lookup(op.settings);
  const opened = lookup(open.op.settings);
  if (named.kind === "invalid" || opened.kind === "invalid") return { contact: "", refuse: true, waiting: false };
  if (named.kind === "unknown" || opened.kind === "unknown") return { contact: "", refuse: true, waiting: true };
  if (settingsHeadIsOlder(named.rev, opened.rev)) return { contact: "", refuse: true, waiting: false };
  return { contact: named.rev.contact, refuse: false, waiting: false };
}

/** One fold judges the same head many times. The chain does not depend on which dispute op is being judged. */
function cachedSettingsLookup(posts: readonly OpEvent[] | undefined, env: FoldEnv | undefined): (head: string) => SettingsLookup {
  const cache = new Map<string, SettingsLookup>();
  let canonicalRoot: string | null | undefined;
  return (head: string): SettingsLookup => {
    if (!posts || !env) return INVALID;
    const hit = cache.get(head);
    if (hit !== undefined) return hit;
    if (canonicalRoot === undefined) canonicalRoot = projectRootId(posts, env);
    const found = settingsLookup(posts, head, env, canonicalRoot);
    cache.set(head, found);
    return found;
  };
}

function complete(op: DisputeOpT): "open" | "resolved" | null {
  if (op.state === "open" && op.summary && op.resolvers && op.resolvers.length > 0 && op.routed) return "open";
  if (op.state === "resolved" && op.reason) return "resolved";
  return null;
}

const whoOf = (a: { handle: string; agent?: string | undefined }): DisputeView["by"] => ({ handle: a.handle, ...(a.agent ? { agent: a.agent } : {}) });

/**
 * The card's dispute: `dispute` ops in `card`'s thread, in the board fold's order. One open dispute at a time; a
 * resolved one can be followed by a new open, which becomes current. An op that does not apply does not move the head.
 * Pure: any arrival order folds to the same dispute.
 */
export function foldDispute(posts: readonly OpEvent[], card: OpEvent, env: DisputeFoldEnv): DisputeState {
  const replies: Array<{ ev: OpEvent; op: DisputeOpT }> = [];
  for (const ev of posts) {
    if (ev.thread !== card.id) continue;
    const parsed = DisputeOp.safeParse(ev.board);
    if (parsed.success) replies.push({ ev, op: parsed.data });
  }
  const { applied, waiting } = order<DisputeOpT>({ ev: card, op: { v: 1, rev: 0, op: "dispute" } }, replies);
  const ignored: DisputeState["ignored"] = waiting.map((x) => ({ id: x.ev.id, reason: "waiting_for_parent" }));
  let current: DisputeView | null = null;
  let openOp: DisputeOpT | null = null;
  let openEv: OpEvent | null = null;
  let head = refOf(card);
  let rev = 0;
  // The list a reader sees on an open dispute is who could resolve it now (the contact now, the roster now). A resolve
  // that already applied is not judged against that. Owners use the roster at the resolve (`roleOf`). The open op's
  // own resolver list is not consulted.
  const settings = env.settingsPosts;
  const lookupOf = cachedSettingsLookup(settings, settings ? settingsFoldEnv(env) : undefined);
  const listed = (raiser: string, opened: DisputeOpT): string[] => {
    // An unusable open head cannot grant contact or creator authority, including in the displayed resolver list.
    const usable = !settings || (!!opened.settings && lookupOf(opened.settings).kind === "known");
    return resolverAddresses({
      contact: usable ? env.contact ?? "" : "", projectCreator: usable ? env.projectCreator ?? "" : "", owners: env.owners ?? [],
      roleOf: (handle) => roleNowOf(env, handle), raiser,
    });
  };
  for (const o of applied) {
    if (o.root) continue;
    const kind = complete(o.op);
    if (!kind) { ignored.push({ id: o.ev.id, reason: "incomplete" }); continue; }
    const role = env.roleOf(o.ev);
    if (role !== "owner" && role !== "member") { ignored.push({ id: o.ev.id, reason: "not_member" }); continue; }
    if (kind === "open") {
      if (current?.state === "open") { ignored.push({ id: o.ev.id, reason: "already_open" }); continue; }
      current = {
        id: o.ev.id, card: card.id, ref: "", state: "open", summary: o.op.summary as string,
        resolvers: listed(o.ev.author.handle, o.op), routed: o.op.routed as DisputeRouted, by: whoOf(o.ev.author), at: o.ev.ts,
      };
      openOp = o.op;
      openEv = o.ev;
    } else {
      // The resolve has to name the open dispute as its parent. One that sorts earlier, or that only names the card
      // (it was signed without having seen the open), closes nothing.
      const parentId = o.op.after?.split("#")[0];
      if (current === null || current.state !== "open" || !openOp || !openEv || parentId !== current.id) { ignored.push({ id: o.ev.id, reason: "not_open" }); continue; }
      const open: DisputeView = current;
      const at = contactAtResolve(env, o.op, { op: openOp }, settings, lookupOf);
      const contactRole = (handle: string): ReturnType<FoldEnv["roleOf"]> => env.roleAt ? env.roleAt(o.ev, handle) : (handle ? "member" : null);
      // An unknown or too-old settings head refuses contact authority. An owner does not need it: the roster at this
      // op is enough, and a missing settings op must not reopen their resolve.
      const contact = at.refuse ? "" : contactInEffect(at.contact, contactRole);
      const allowed = !o.ev.author.agent && (role === "owner" || !at.refuse) && handleMayResolve(
        o.ev.author.handle, role, { contact, projectCreator: env.projectCreator ?? "" }, open.by.handle,
      );
      if (!allowed) { ignored.push({ id: o.ev.id, reason: at.waiting && role !== "owner" && !o.ev.author.agent ? "waiting_for_settings" : "not_resolver" }); continue; }
      current = {
        ...open, id: o.ev.id, state: "resolved", reason: o.op.reason as string, resolvers: listed(open.by.handle, openOp),
        resolved_by: { handle: o.ev.author.handle }, resolved_at: o.ev.ts,
      };
    }
    head = refOf(o.ev);
    rev = o.rank;
  }
  return { current, ignored, head, rev };
}
