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
  ASK_SETUP_STEPS, ASK_TOPICS, MAX_CONTEXT, ONBOARDING_STEPS, REC_TTL_MS, SETUP_TTL_MS, recKey, recTitle, type NewRec, type RecGroup,
} from "../../protocol/talkie-recs.ts";
import type { Core } from "../core.ts";
import { HttpError } from "../http.ts";
import { findCard, findProject } from "../projects/service.ts";
import { activeNodes, memberByHandle } from "../roster.ts";
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

/** The model's own words, one line each, as text a person may read (links and secrets withheld), quoted under the recommendation. */
function contextOf(input: RecommendInputT): string {
  const lines = [input.reason, ...(input.kind === "ask_orchestrator" && input.note ? [input.note] : []), ...(input.evidence ?? [])];
  return lines.map((line) => safeText(line.replace(/\s+/g, " "), MAX_CONTEXT)).filter(Boolean).join("\n").slice(0, MAX_CONTEXT) || "(no words)";
}

const common = (input: RecommendInputT) => ({
  source: "turn" as const,
  reason: TURN_REASON,
  evidence: [] as string[],
  context: contextOf(input),
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
    const title = safeText(input.title, 200);
    if (!title) throw new HttpError(400, "invalid", "the title is empty");
    const prefixes = [project.prefix, ...(project.prior_prefixes ?? [])];
    const exists = d.idx.db.cards(project.channel, { states: ["open"], limit: 20_000 }).some((c) => norm(c.title) === norm(title));
    return {
      channel: project.channel, ...(exists ? { skip: "a card with that title already exists" } : {}),
      rec: {
        key: recKey.create(project.channel, title), group: "moves", audience: project.private ? "owners" : "team", ...(project.private ? { project: project.channel } : {}),
        action: { kind: "create_card", project: project.channel, title }, summary: `Create a card “${recTitle(title, prefixes)}” in ${safeText(project.name, 60)}`, ttl_ms: REC_TTL_MS, ...common(input),
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
          summary: `Ask ${labelOf(d.core, input.to)} to set up ${name}`, ttl_ms: SETUP_TTL_MS, ...common(input),
        },
      };
    }
    const found = input.card ? findCard(ro, input.card) : null;
    if (found && found.project.state !== "active") throw new HttpError(409, "conflict", `project ${found.project.name} is ${found.project.state}`);
    const who = labelOf(d.core, input.to);
    const title = found ? recTitle(found.card.title, [found.project.prefix, ...(found.project.prior_prefixes ?? [])]) : null;
    const owners = !found || found.project.private || isConfidential(found.card.labels);
    const group: RecGroup = input.topic === "review" ? "reviews" : input.topic === "status" ? "stalled" : "work";
    const summary = input.topic === "review" ? `Ask ${who} to review “${title}”` : input.topic === "take" ? `Ask ${who} to take on “${title}”`
      : input.topic === "status" ? `Ask ${who} for an update${title ? ` on “${title}”` : ""}` : `Ask ${who} to record some work`;
    return {
      channel: found?.project.channel ?? null,
      rec: {
        key: recKey.ask(input.to, found?.card.id, input.topic), group, audience: owners ? "owners" : "team", ...(owners && found ? { project: found.project.channel } : {}),
        action: { kind: "ask_orchestrator", to: input.to, topic: input.topic, ...(found ? { card: found.card.id } : {}) },
        summary, ttl_ms: REC_TTL_MS, ...common(input),
      },
    };
  }
  const node = machineOf(d, input.machine);
  const name = safeText(node.hostname, 63);
  return {
    channel: null,
    rec: {
      key: recKey.step(node.node_id, input.step), group: "setup", audience: "owners", action: { kind: "onboarding_step", machine: node.node_id, step: input.step },
      summary: input.step === "seats_doctor" ? `Check that ${name} is ready to take seats` : `Turn on seats on ${name}`, ttl_ms: SETUP_TTL_MS, ...common(input),
    },
  };
}
