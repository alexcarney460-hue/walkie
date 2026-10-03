// TALKIE-OPS-1: how a model-driven duty (project sync, machine onboarding) records what it would have done. The model hands in a few
// fields; the daemon checks every one against the board and the roster, decides the audience and the group itself, and writes the
// sentence people read from a template: nothing the model wrote is ever the action, the summary, the reason or the place, and an
// ask carries no text at all (askMessage writes it from the topic and the card). What the model wrote itself (its reason, its note,
// its evidence) is kept as the record's `context`: shown quoted as WalkieTalkie's to the person who answers, never sent or posted
// in anyone's name. Only three kinds come this way (a card to create, an orchestrator to ask, a setup step); moves and seats are
// the daemon's own duties' alone.
import { z } from "zod";
import { isConfidential, safeText } from "../../protocol/projects/status-report.ts";
import { Address } from "../../protocol/schemas.ts";
import {
  ASK_SETUP_STEPS, ASK_TOPICS, MAX_CONTEXT, ONBOARDING_STEPS, REC_TTL_MS, SETUP_TTL_MS, cardScheduleRef, recKey, recTitle,
  sealedCreateKey, withoutPrivatePhrases, type NewRec, type RecGroup,
} from "../../protocol/talkie-recs.ts";
import type { Core } from "../core.ts";
import { HttpError } from "../http.ts";
import { findCard, findProject, visibleProjects } from "../projects/service.ts";
import { activeNodes, memberByHandle } from "../roster.ts";
import { loadOrCreateRecSeal } from "./rec-seal.ts";
import type { RecDeps } from "./recs.ts";

const Reason = z.string().trim().min(1).max(200);
const Evidence = z.array(z.string().trim().min(1).max(200)).max(4).optional();

export const RecommendInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create_card"), project: z.string().min(1).max(60), title: z.string().trim().min(1).max(200), reason: Reason, evidence: Evidence }).strict(),
  z.object({
    kind: z.literal("ask_orchestrator"), to: Address, topic: z.enum(ASK_TOPICS), card: z.string().min(1).max(64).optional(),
    /** topic "setup" (machine onboarding): the machine, and the one step its person is asked to take (a fixed sentence each). */
    machine: z.string().min(1).max(64).optional(), step: z.enum(ASK_SETUP_STEPS).optional(),
    /** For the person who approves: shown to them quoted as WalkieTalkie's, never sent (the ask's message is a template). */
    note: z.string().trim().min(1).max(400).optional(), reason: Reason, evidence: Evidence,
  }).strict(),
  z.object({ kind: z.literal("onboarding_step"), machine: z.string().min(1).max(64), step: z.enum(ONBOARDING_STEPS), reason: Reason, evidence: Evidence }).strict(),
]);
export type RecommendInputT = z.infer<typeof RecommendInput>;

export interface BuiltRec { rec: NewRec; channel: string | null; /** Why it is not worth recording (what it asks for is already there). */ skip?: string }

const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** A person's name, or "agent <name> for <person>". */
function labelOf(core: Core, address: string): string {
  const [handle = "", , agent] = address.replace(/^@/, "").split("/");
  const person = memberByHandle(core.roster, handle)?.display_name || handle;
  return agent ? `agent ${agent} for ${safeText(person, 40)}` : safeText(person, 40);
}

/** The reason every model-recorded recommendation shows: the model's own reason is in the quoted context under it. */
export const TURN_REASON = "WalkieTalkie suggested this in a scheduled run; what it wrote is quoted below.";

interface PhraseBundle { phrases: string[]; prefixes: string[] }

/**
 * Private project names, and the title and the key of every card a non-member must not read (open and archived cards
 * on a private project, and open and archived cards labelled confidential), plus the prefixes those sentences use.
 * A public card's title is not one of them. Built again for every recommendation: a card created after an earlier one
 * in the same turn is still a phrase. The matcher for one phrase set is cached separately, by the set's contents.
 * A stored title is kept even when it ends in "…". The only form skipped for that ending is a shortened sentence this
 * code produced (`sentenceForm`), and that skip lives there.
 */
function collectPhrases(d: RecDeps): PhraseBundle {
  const phrases: string[] = [];
  const prefixes: string[] = [];
  const seenP = new Set<string>();
  const seenX = new Set<string>();
  const addPhrase = (s: string): void => {
    const t = s.trim();
    if (!t || t === "(untitled)" || seenP.has(t)) return;
    seenP.add(t);
    phrases.push(t);
  };
  const addPrefix = (s: string): void => {
    const t = s.trim();
    if (!t || seenX.has(t)) return;
    seenX.add(t);
    prefixes.push(t);
  };
  for (const p of visibleProjects({ core: d.core, idx: d.idx })) {
    if (p.state === "deleted") continue;
    const cards = d.idx.db.cards(p.channel, { states: ["open", "archived"], limit: 20_000 });
    const secret = cards.filter((c) => p.private || isConfidential(c.labels));
    if (p.private) addPhrase(p.name);
    if (p.private || secret.length) {
      addPrefix(p.prefix);
      for (const old of p.prior_prefixes ?? []) addPrefix(old);
    }
    for (const c of secret) {
      addPhrase(c.title);
      addPhrase(c.key);
    }
  }
  return { phrases, prefixes };
}

/**
 * The model's own words, one line each, as text a person may read (links and secrets withheld), quoted under the recommendation.
 * Every private title and private project name this daemon knows is taken out first, as a whole phrase, and so is `extra`
 * (a card this create would add, which is not on the board yet).
 */
function contextOf(d: RecDeps, input: RecommendInputT, extra: readonly string[] = []): string {
  const lines = [input.reason, ...(input.kind === "ask_orchestrator" && input.note ? [input.note] : []), ...(input.evidence ?? [])];
  const known = collectPhrases(d);
  const phrases = [...known.phrases, ...extra.map((s) => s.trim()).filter((s) => s.length > 0 && s !== "(untitled)")];
  // Nothing is cut until every scrub has run: a cut could split a private title, and the scrub, which matches whole
  // phrases, would miss what is left of it. Each line is scrubbed, made safe to read with no cut (making it readable can
  // itself form a title out of look-alike characters) and scrubbed again; the joined lines are scrubbed (a title split
  // across two fields). Check the final display text too: shortening can change a token boundary, so the uncut
  // text passing the whole-phrase policy is not enough (Codex pre.13 audit rounds 1-4).
  const scrub = (line: string) => (phrases.length ? withoutPrivatePhrases(line, phrases, known.prefixes) : line);
  const uncut = (line: string) => safeText(line, 1_000_000);
  const text = scrub(lines.map((line) => scrub(uncut(scrub(line.replace(/\s+/g, " "))))).filter(Boolean).join("\n")).slice(0, MAX_CONTEXT);
  if (scrub(text) !== text || !text || !/[\p{L}\p{N}]/u.test(text)) return "(no words)";
  return text;
}

function sealSecret(home: string): Uint8Array {
  try { return loadOrCreateRecSeal(home); }
  catch (err) {
    const message = err instanceof Error && /rec-seal\.key/.test(err.message) ? err.message
      : "rec-seal.key is missing or unreadable. Walkie will not write a new one.";
    throw new HttpError(409, "rec_seal", message);
  }
}

/** A scrubbed title that still says something. Punctuation left behind a removed phrase is not a title. */
function keptTitle(text: string): string {
  return /[\p{L}\p{N}]/u.test(text) ? text : "";
}

const common = (d: RecDeps, input: RecommendInputT, extra: readonly string[] = []) => ({
  source: "turn" as const,
  reason: TURN_REASON,
  evidence: [] as string[],
  context: contextOf(d, input, extra),
});

/** One admitted machine by node id or name. */
function machineOf(d: RecDeps, ref: string) {
  const nodes = activeNodes(d.core.roster).filter((n) => n.node_id === ref || n.hostname === ref);
  if (!nodes.length) throw new HttpError(404, "not_found", `no admitted machine ${ref}`);
  if (nodes.length > 1) throw new HttpError(409, "ambiguous", `${nodes.length} machines are named ${ref}: give the node id`);
  return nodes[0]!;
}

export function buildRec(d: RecDeps, input: RecommendInputT): BuiltRec {
  const ro = { core: d.core, idx: d.idx };
  d.idx.flushAll();
  if (input.kind === "create_card") {
    const project = findProject(ro, input.project);
    if (project.state !== "active") throw new HttpError(409, "conflict", `project ${project.name} is ${project.state}`);
    const owners = project.private;
    let title = safeText(input.title, 200);
    if (!title) throw new HttpError(400, "invalid", "the title is empty");
    // A team create is readable by every project member. A title the scrub would change is refused, not stored in a
    // shortened form. An owners-only create keeps the real title for the project post and for the HMAC; the schedules
    // record never carries it. Model text is still scrubbed, in `contextOf`.
    if (!owners) {
      const known = collectPhrases(d);
      const unchanged = keptTitle(withoutPrivatePhrases(title, [], []));
      const scrubbed = keptTitle(withoutPrivatePhrases(title, known.phrases, known.prefixes));
      if (!unchanged) throw new HttpError(400, "invalid", "the title is empty");
      // The whole title is checked too, not only what is kept after the 200-character cut: normalizing can lengthen a
      // title (a ligature becomes several letters), and a private name cut in two at the limit would not match as a whole
      // phrase (Codex pre.13 audit round 2 MUST).
      const whole = safeText(input.title, 100_000);
      if (scrubbed !== unchanged || keptTitle(withoutPrivatePhrases(whole, known.phrases, known.prefixes)) !== keptTitle(withoutPrivatePhrases(whole, [], []))) {
        throw new HttpError(400, "invalid", "this title matches a private card or project name");
      }
      title = unchanged;
    }
    const prefixes = [project.prefix, ...(project.prior_prefixes ?? [])];
    const exists = d.idx.db.cards(project.channel, { states: ["open"], limit: 20_000 }).some((c) => norm(c.title) === norm(title));
    return {
      channel: project.channel, ...(exists ? { skip: "a card with that title already exists" } : {}),
      rec: {
        key: owners ? sealedCreateKey(project.channel, title, sealSecret(d.core.paths.home)) : recKey.create(project.channel, title), group: "moves",
        audience: owners ? "owners" : "team", ...(owners ? { project: project.channel } : {}),
        action: { kind: "create_card", project: project.channel, title },
        summary: owners ? `Create a card in ${project.channel}` : `Create a card “${recTitle(title, prefixes)}” in ${safeText(project.name, 60)}`,
        ttl_ms: REC_TTL_MS, ...common(d, input, owners ? [title, project.name] : []),
      },
    };
  }
  if (input.kind === "ask_orchestrator") {
    const handle = input.to.replace(/^@/, "").split("/")[0] as string;
    const member = memberByHandle(d.core.roster, handle);
    if (!member || member.role === "removed") throw new HttpError(404, "not_found", `no member @${handle}`);
    if ((input.topic === "review" || input.topic === "take") && !input.card) throw new HttpError(400, "invalid", `an ask to ${input.topic} needs the card it is about`);
    const names = input.machine !== undefined || input.step !== undefined;
    if (input.topic === "setup" ? input.machine === undefined || input.step === undefined || input.card !== undefined : names) {
      throw new HttpError(400, "invalid", "a setup ask names a machine and a step and no card, and only a setup ask names them");
    }
    if (input.topic === "setup") {
      const node = machineOf(d, input.machine as string);
      const name = safeText(node.hostname, 63);
      return {
        channel: null,
        rec: {
          key: recKey.ask(input.to, node.node_id, `setup:${input.step}`), group: "setup", audience: "owners",
          action: { kind: "ask_orchestrator", to: input.to, topic: "setup", machine: node.node_id, step: input.step },
          summary: `Ask ${labelOf(d.core, input.to)} to set up ${name}`, ttl_ms: SETUP_TTL_MS, ...common(d, input),
        },
      };
    }
    const found = input.card ? findCard(ro, input.card) : null;
    if (found && found.project.state !== "active") throw new HttpError(409, "conflict", `project ${found.project.name} is ${found.project.state}`);
    const who = labelOf(d.core, input.to);
    const prefixes = found ? [found.project.prefix, ...(found.project.prior_prefixes ?? [])] : [];
    const title = found ? recTitle(found.card.title, prefixes) : null;
    const owners = !found || found.project.private || isConfidential(found.card.labels);
    const subject = found && owners ? cardScheduleRef(found.card.id) : title ? `“${title}”` : null;
    const group: RecGroup = input.topic === "review" ? "reviews" : input.topic === "status" ? "stalled" : "work";
    const summary = input.topic === "review" ? `Ask ${who} to review ${subject}` : input.topic === "take" ? `Ask ${who} to take on ${subject}`
      : input.topic === "status" ? `Ask ${who} for an update${subject ? ` on ${subject}` : ""}` : `Ask ${who} to record some work`;
    return {
      channel: found?.project.channel ?? null,
      rec: {
        key: recKey.ask(input.to, found?.card.id, input.topic), group, audience: owners ? "owners" : "team", ...(owners && found ? { project: found.project.channel } : {}),
        action: { kind: "ask_orchestrator", to: input.to, topic: input.topic, ...(found ? { card: found.card.id } : {}) },
        summary, ttl_ms: REC_TTL_MS, ...common(d, input),
      },
    };
  }
  const node = machineOf(d, input.machine);
  const name = safeText(node.hostname, 63);
  return {
    channel: null,
    rec: {
      key: recKey.step(node.node_id, input.step), group: "setup", audience: "owners", action: { kind: "onboarding_step", machine: node.node_id, step: input.step },
      summary: input.step === "seats_doctor" ? `Check that ${name} is ready to take seats` : `Turn on seats on ${name}`, ttl_ms: SETUP_TTL_MS, ...common(d, input),
    },
  };
}
