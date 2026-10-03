// TALKIE-OPS-1: the card curation, the duty's prepare step. About every seven minutes the lead's daemon gathers the board steward's
// evidence for each active project and PLANS from it (gather + planSteward: the steward's pure rules, with no write path: nothing
// here moves a card), turns the plan into recommendations (curation-plan.ts) and reconciles the open ones with it. It works
// oldest-planned first inside a time budget, so a team of many projects never stalls the daemon, and says in its run's result
// how many it reached. No model turn: the run ends in the prepare step.
import { memberByHandle } from "../roster.ts";
import { Address, type AgentView } from "../../protocol/schemas.ts";
import type { CardView } from "../../protocol/projects/schema.ts";
import { planSteward, type StewardCard } from "../../protocol/projects/steward.ts";
import type { Core } from "../core.ts";
import { findProject, visibleProjects } from "../projects/service.ts";
import { gather, type AgentRow, type StewardSource } from "../projects/steward-gather.ts";
import { stewardConfig } from "../projects/steward-run.ts";
import { planCuration } from "./curation-plan.ts";
import type { SkippedTurn } from "./prepared.ts";
import { openRecs, reconcile, type Desired, type RecDeps } from "./recs.ts";

export interface CurationDeps extends RecDeps {
  readonly agents: () => readonly AgentView[];
  /** The time one pass may take (default 90 s: the prepare step's own limit is two minutes). */
  readonly budgetMs?: number;
  /** The whole git scan's budget per project (default 20 s). */
  readonly gitDeadlineMs?: number;
}

export const CURATION_BUDGET_MS = 90_000;
const GIT_DEADLINE_MS = 20_000;
const PLANNED_META = "talkie_curation_planned_v1";

const yieldLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function readPlanned(core: Core): Record<string, number> {
  try {
    const raw = JSON.parse(core.store.getMeta(PLANNED_META) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Record<string, number>;
  } catch { return {}; }
}

function notePlanned(core: Core, channels: readonly string[], keep: ReadonlySet<string>, at: number): void {
  const before = readPlanned(core);
  const next: Record<string, number> = Object.fromEntries(Object.entries(before).filter(([channel]) => keep.has(channel)));
  for (const channel of channels) next[channel] = at;
  core.store.setMeta(PLANNED_META, JSON.stringify(next));
}

const personName = (core: Core, handle: string): string => memberByHandle(core.roster, handle)?.display_name || handle;

/** Who to ask about a card: the reviewer (for a review), else the assignee, else its creator; the agent when it is one, else the person. */
export function askTargetOf(core: Core, card: Pick<CardView, "assignee" | "reviewer" | "created_by">, about: "review" | "status"): { to: string; label: string } | null {
  const person = (handle: string) => ({ to: `@${handle}`, label: personName(core, handle) });
  const named = (address: string) => {
    const [handle = "", , agent] = address.replace(/^@/, "").split("/");
    return agent ? { to: address, label: `agent ${agent} for ${personName(core, handle)}` } : person(handle);
  };
  const asked = about === "review" ? card.reviewer ?? card.assignee : card.assignee;
  if (asked && Address.safeParse(asked).success) return named(asked);
  const by = card.created_by;
  if (by.agent) {
    const host = core.roster.nodes.get(by.node)?.hostname;
    const address = host ? `@${by.handle}/${host}/${by.agent}` : null;
    if (address && Address.safeParse(address).success) return named(address);
  }
  return by.handle ? person(by.handle) : null;
}

/** The steward's evidence source over this daemon's own views (steward-run.ts daemonSource, with the agents injected and no tracker). */
function sourceOf(d: CurationDeps): StewardSource {
  const ro = { core: d.core, idx: d.idx };
  return {
    project: async (ref) => { d.idx.flushAll(); return findProject(ro, ref); },
    cards: async (p) => d.idx.db.cards(p.channel, { states: ["open"], limit: 20_000 }),
    timeline: async (p, c) => d.idx.foldCardNow(p.channel, c.id)?.state.timeline ?? [],
    agents: async () => d.agents() as unknown as AgentRow[],
    owners: async () => [...d.core.roster.members.values()].filter((m) => m.role === "owner").map((m) => m.handle),
    linear: async () => null,
  };
}

export async function prepareCardCuration(d: CurationDeps, canAct: () => boolean, signal?: AbortSignal): Promise<SkippedTurn> {
  const now = (d.now ?? d.core.clock)();
  d.idx.flushAll();
  const cfg = stewardConfig(d.core);
  const all = visibleProjects({ core: d.core, idx: d.idx }).filter((p) => p.state === "active");
  const projects = all.filter((p) => p.steward !== "off");
  const lastPlanned = readPlanned(d.core);
  const order = [...projects].sort((a, b) => (lastPlanned[a.channel] ?? -1) - (lastPlanned[b.channel] ?? -1) || (a.channel < b.channel ? -1 : 1));
  const source = sourceOf(d);
  const seatCards = new Set(openRecs(d).flatMap((r) => (r.action.kind === "start_seat" ? [r.action.card] : [])));
  const started = performance.now();
  const budget = d.budgetMs ?? CURATION_BUDGET_MS;
  const desired: Desired[] = [];
  const planned: string[] = [];
  let failed = 0, held = 0, ambiguous = 0, deferred = 0;
  for (const p of order) {
    if (!canAct() || signal?.aborted) throw new Error("WalkieTalkie lease expired");
    if (planned.length + failed > 0 && performance.now() - started >= budget) break;
    await yieldLoop();
    try {
      const g = await gather(source, p.channel, { now, staleHours: cfg.stale_hours, repos: [...(cfg.repos?.[p.prefix] ?? [])], gitDeadlineMs: d.gitDeadlineMs ?? GIT_DEADLINE_MS });
      const views = new Map(g.cards.map((c) => [c.id, c]));
      const cur = planCuration({
        project: { channel: p.channel, name: p.name, prefixes: [p.prefix, ...(p.prior_prefixes ?? [])], private: p.private },
        steward: g.input, plan: planSteward(g.input), cards: g.cards, now, seatCards,
        askTarget: (c: StewardCard, about) => { const v = views.get(c.id); return v ? askTargetOf(d.core, v, about) : null; },
      });
      desired.push(...cur.recs.map((rec) => ({ rec, channel: p.channel })));
      held += cur.held; ambiguous += cur.ambiguous; deferred += cur.deferred;
      planned.push(p.channel);
    } catch (err) {
      failed += 1;
      d.log?.warn("talkie_curation_project_failed", { project: p.prefix, err: String(err).slice(0, 200) });
    }
  }
  if (!canAct()) throw new Error("WalkieTalkie lease expired");
  const done = reconcile(d, { source: "curation", scope: new Set(planned), desired, canAct });
  if (planned.length) notePlanned(d.core, planned, new Set(projects.map((p) => p.channel)), now);
  const reached = `checked ${planned.length} of ${projects.length} project${projects.length === 1 ? "" : "s"}${failed ? ` (${failed} failed)` : ""}${planned.length + failed < projects.length ? `, the rest next time` : ""}`;
  const parts = [
    `${done.created} new`, `${done.kept} already open`,
    ...(done.superseded + done.replaced ? [`${done.superseded + done.replaced} retired`] : []),
    ...(done.suppressed ? [`${done.suppressed} not repeated`] : []), ...(done.capped ? [`${done.capped} over the limits`] : []),
  ];
  const left = held + ambiguous + deferred ? ` The steward left ${held} held, ${ambiguous} unclear${deferred ? `, ${deferred} for later` : ""}.` : "";
  const skipped = all.length - projects.length ? ` ${all.length - projects.length} project${all.length - projects.length === 1 ? " has" : "s have"} the steward switched off.` : "";
  return { skip: `Card curation: ${reached}; recommendations ${parts.join(", ")}.${left}${skipped}`.slice(0, 1_900) };
}
