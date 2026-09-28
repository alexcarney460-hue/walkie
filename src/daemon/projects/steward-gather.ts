// FO-6 board steward: the evidence for one project, from a source that is either this daemon itself (the steward's
// run and loop) or a daemon's local API read with GETs only (the CLI's `--dry-run` against a daemon without the
// steward route, e.g. a released pre.5). Everything the rules read is gathered here; the rules (steward.ts) are pure.
import type { CardView, ProjectView, TimelineEntry } from "../../protocol/projects/schema.ts";
import {
  type BranchEvidence, type CardEvidence, type LiveAgent, type StewardCard, type StewardInput, STEWARD_AGENT,
} from "../../protocol/projects/steward.ts";
import { cardNamedIn, indexCards, isAuditText, linearKeyOf } from "../../protocol/projects/steward-match.ts";
import { repoDirs, scanRepo, type GitRun, runGit } from "./steward-git.ts";

/** One agent as the local API lists it (GET /v1/agents), the fields the steward reads. */
export interface AgentRow {
  handle: string; hostname: string; agent: string; machine_online?: boolean; effective_state?: string; archived?: boolean;
  status: { state?: string; task?: string; branch?: string; title?: string; parent?: string };
}

export interface StewardSource {
  project(ref: string): Promise<ProjectView>;
  /** The project's open cards. */
  cards(project: ProjectView): Promise<CardView[]>;
  timeline(project: ProjectView, card: CardView): Promise<TimelineEntry[]>;
  agents(): Promise<AgentRow[]>;
  /** The team's owners' handles (their agents' text is evidence on any card). */
  owners(): Promise<string[]>;
  /** Linear issues by key (state and its type), or null when the integration is off or failed. */
  linear(keys: readonly string[]): Promise<Record<string, { state: string; state_type: string } | null> | null>;
}

export interface GatherOpts {
  readonly now: number;
  /** Local repositories to read branches from (besides the project's path rules that are repositories here). */
  readonly repos: readonly string[];
  readonly staleHours: number;
  readonly git?: GitRun;
  /** The whole git scan's budget (default GIT_DEADLINE_MS). */
  readonly gitDeadlineMs?: number;
}

/** Every repository's git work in one run, together. */
export const GIT_DEADLINE_MS = 60_000;

const LINEAR_BATCH = 50;

/** Working agents, with the card each one names (by key, reference or lane code). */
function liveAgents(rows: readonly AgentRow[], idx: ReturnType<typeof indexCards>): Map<string, LiveAgent[]> {
  const out = new Map<string, LiveAgent[]>();
  for (const a of rows) {
    const state = a.effective_state ?? a.status.state;
    if (state !== "working" || a.machine_online === false || a.archived || a.agent === STEWARD_AGENT) continue;
    const text = [a.status.task, a.status.branch, a.status.title].filter((x): x is string => !!x).join(" | ");
    const card = cardNamedIn(text, idx);
    if (!card) continue;
    const live: LiveAgent = { address: `@${a.handle}/${a.hostname}/${a.agent}`, handle: a.handle, agent: a.agent, text, auditor: isAuditText(text) };
    out.set(card.id, [...(out.get(card.id) ?? []), live]);
  }
  return out;
}

async function linearStates(src: StewardSource, cards: readonly CardView[]): Promise<Map<string, { key: string; state: string; state_type: string }>> {
  const keys = [...new Set(cards.map((c) => linearKeyOf(c.title)).filter((k): k is string => !!k))];
  const out = new Map<string, { key: string; state: string; state_type: string }>();
  for (let i = 0; i < keys.length; i += LINEAR_BATCH) {
    const got = await src.linear(keys.slice(i, i + LINEAR_BATCH)).catch(() => null);
    if (!got) return out;
    for (const [k, v] of Object.entries(got)) if (v) out.set(k, { key: k, state: v.state, state_type: v.state_type });
  }
  return out;
}

/** The steward's input for one project: its board, open cards, and each card's evidence. */
export async function gather(src: StewardSource, projectRef: string, opts: GatherOpts): Promise<{ project: ProjectView; cards: CardView[]; input: StewardInput; repos: string[] }> {
  const project = await src.project(projectRef);
  const cards = await src.cards(project);
  const idx = indexCards(project.prefix, cards);
  const agents = liveAgents(await src.agents(), idx);
  const linear = await linearStates(src, cards);
  const repos = repoDirs([...opts.repos, ...project.paths.flatMap((p) => ("path" in p ? [p.path] : []))]);
  let branches: Map<string, BranchEvidence[]> | null = null;
  let complete = true;
  const skipped = new Set<string>();
  // One deadline for every repository's git work (fix round 2, Codex MED 6); what it cuts short is unknown, not absent.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.gitDeadlineMs ?? GIT_DEADLINE_MS);
  try {
    for (const dir of repos) {
      const found = await scanRepo(dir, (name) => cardNamedIn(name.replace(/[/_.]/g, " "), idx)?.id ?? null, opts.git ?? runGit, ac.signal);
      if (!found) { complete = false; continue; }
      if (!found.complete) complete = false;
      for (const id of found.skipped) skipped.add(id);
      branches ??= new Map();
      for (const b of found.branches) {
        const { card, ...ev } = b;
        branches.set(card, [...(branches.get(card) ?? []), ev]);
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const evidence = new Map<string, CardEvidence>();
  for (const c of cards) {
    const key = linearKeyOf(c.title);
    evidence.set(c.id, {
      agents: agents.get(c.id) ?? [],
      branches: branches === null ? null : branches.get(c.id) ?? [],
      branchesComplete: complete && !skipped.has(c.id),
      linear: key ? linear.get(key) ?? null : null,
      timeline: await src.timeline(project, c),
    });
  }
  const view = (c: CardView): StewardCard => ({
    id: c.id, key: c.key, ref: c.ref, title: c.title, board: c.board, column: c.column, state: c.state, assignee: c.assignee,
    blocked: c.blocked, blocked_reason: c.blocked_reason, created_at: c.created_at, created_by: c.created_by, updated_at: c.updated_at,
  });
  return {
    project, repos, cards,
    input: {
      now: opts.now, prefix: project.prefix, steward: project.steward ?? "on",
      boards: project.boards.filter((b) => b.state === "active").map((b) => ({ id: b.id, columns: b.columns })),
      cards: cards.map(view), evidence, staleHours: opts.staleHours,
      owners: await src.owners(), agentsCanClose: project.automations.agents_can_close !== false,
    },
  };
}
