// Mission Control's Live activity (WALKIE-LIVE-2): what happened on the team, newest first, without the noise.
// - Flapping: an agent that goes X → Y → X within FLAP_MS shows once (the excursion is dropped, counted on the entry).
// - Churn: sessions that appear and go offline within CHURN_MS are grouped per machine ("hestia-wsl: 3 agents came and
//   went") instead of one Offline entry each.
// - Tool-level lines, when the team shares them (anything but Walkie's fixed phrases): "Editing web/src/…"; an agent's
//   consecutive steps within STEP_MERGE_MS are one entry showing the latest.
// Pure over the event list, so the rules are unit-tested (web/test/live-2.test.ts).
import type { AgentState, Event, MemberView, NodeView, StatusBody } from "../../api/types.ts";
import { STATE_LABEL, askBody, displayName, hostFor } from "../../lib/format.ts";
import { plainPreview } from "../../lib/markdown.tsx";
import type { Route } from "../../lib/route.ts";
import { ACTIVITY_PHRASES } from "../../../../src/protocol/activity-phrases.ts";

export const FLAP_MS = 60_000;
export const CHURN_MS = 2 * 60_000;
export const CHURN_GROUP_MS = 10 * 60_000;
export const STEP_MERGE_MS = 60_000;
export const FEED_LIMIT = 50;

export type ItemKind = "post" | "state" | "step" | "churn" | "ask" | "answer" | "file";

export interface Item {
  id: string;
  ts: number;
  kind: ItemKind;
  who: string;
  text: string;
  state?: AgentState;
  /** step: how many steps this entry stands for; churn: how many sessions; state: brief excursions folded in. */
  count?: number;
  to: Route;
}

const FEED_KINDS = new Set(["msg.post", "artifact.share", "ask", "answer", "agent.status"]);

interface Hist { idx: number; state: AgentState; from: AgentState; ts: number }

/** `events` newest first (the store's order). */
export function buildActivity(events: readonly Event[], nodes: readonly NodeView[] | undefined, members: MemberView[] | undefined, limit = FEED_LIMIT): Item[] {
  const chronological = events.filter((e) => FEED_KINDS.has(e.kind)).reverse();
  const oldest = chronological[0]?.ts ?? 0;
  const items: (Item | null)[] = [];
  const lastState = new Map<string, AgentState>();
  const firstSeen = new Map<string, number>();
  const hist = new Map<string, Hist[]>();
  const lastStep = new Map<string, number>();
  const churnGroup = new Map<string, { idx: number; agents: Set<string> }>();
  /** Excursions folded away with no earlier entry of the agent's to count them on: the next entry carries them. */
  const carry = new Map<string, number>();

  for (const e of chronological) {
    const host = hostFor(nodes as NodeView[] | undefined, e.author.node) ?? "?";
    const who = e.author.agent ? e.author.agent : displayName(members, e.author.handle);
    const whoFull = e.author.agent ? `${who} · ${host}` : who;
    if (e.kind !== "agent.status") {
      items.push(other(e, whoFull));
      continue;
    }
    const b = e.body as StatusBody;
    const key = `${e.origin}/${b.agent}`;
    const agentRoute: Route = { view: "mission", agent: `${e.author.handle}/${host}/${b.agent}` };
    const prev = lastState.get(key);
    lastState.set(key, b.state);
    if (!firstSeen.has(key)) firstSeen.set(key, e.ts);
    if (prev === undefined) continue; // its first status: an appearance, not a change
    if (prev === b.state) {
      if (b.state !== "working" || !b.activity || ACTIVITY_PHRASES.has(b.activity)) continue;
      const li = lastStep.get(key);
      const last = li === undefined ? null : items[li];
      if (li !== undefined && last && e.ts - last.ts <= STEP_MERGE_MS) {
        items[li] = { ...last, id: e.id, ts: e.ts, text: b.activity, count: (last.count ?? 1) + 1 };
      } else {
        lastStep.set(key, items.length);
        items.push({ id: e.id, ts: e.ts, kind: "step", who: whoFull, text: b.activity, state: "working", to: agentRoute });
      }
      continue;
    }
    lastStep.delete(key);
    const h = hist.get(key) ?? [];
    hist.set(key, h);

    // Churn: a session that went offline soon after it appeared (its session start, else when it was first seen here
    // if that wasn't simply the start of the buffer).
    if (b.state === "offline") {
      const first = firstSeen.get(key) as number;
      const started = typeof b.started_at === "number" ? b.started_at : first > oldest ? first : undefined;
      if (started !== undefined && e.ts - started <= CHURN_MS) {
        for (const x of h) items[x.idx] = null;
        hist.delete(key);
        const g = churnGroup.get(host);
        const gi = g ? items[g.idx] : null;
        if (g && gi && e.ts - gi.ts <= CHURN_GROUP_MS) {
          g.agents.add(key);
          items[g.idx] = { ...gi, id: e.id, ts: e.ts, count: g.agents.size, text: churnText(g.agents.size) };
        } else {
          churnGroup.set(host, { idx: items.length, agents: new Set([key]) });
          items.push({ id: e.id, ts: e.ts, kind: "churn", who: host, text: churnText(1), state: "offline", count: 1, to: { view: "mission", tab: "archive", machine: host } });
        }
        continue;
      }
    }

    // Flapping: back to the state it left, within FLAP_MS of leaving it. The brief excursion is dropped.
    const last = h[h.length - 1];
    if (last && items[last.idx] && last.state === prev && last.from === b.state && e.ts - last.ts <= FLAP_MS) {
      const folded = 1 + (items[last.idx]?.count ?? 0); // this excursion, and any it already carried
      items[last.idx] = null;
      h.pop();
      const keep = h[h.length - 1];
      const kept = keep ? items[keep.idx] : null;
      if (keep && kept) items[keep.idx] = { ...kept, count: (kept.count ?? 0) + folded };
      else carry.set(key, (carry.get(key) ?? 0) + folded);
      continue;
    }
    h.push({ idx: items.length, state: b.state, from: prev, ts: e.ts });
    if (h.length > 4) h.shift();
    const carried = carry.get(key);
    carry.delete(key);
    items.push({ id: e.id, ts: e.ts, kind: "state", who: whoFull, state: b.state, text: b.title ?? STATE_LABEL[b.state], to: agentRoute, ...(carried ? { count: carried } : {}) });
  }
  return items.filter((x): x is Item => x !== null).sort((a, b) => b.ts - a.ts).slice(0, limit);
}

function churnText(n: number): string {
  return `${n} ${n === 1 ? "agent" : "agents"} came and went`;
}

function other(e: Event, who: string): Item {
  if (e.kind === "msg.post") {
    const body = e.body as { text: string; thread?: string };
    return { id: e.id, ts: e.ts, kind: "post", who, text: `${body.thread ? "replied in" : "posted in"} #${e.channel}: ${plainPreview(body.text, 110)}`, to: { view: "board", channel: e.channel, thread: body.thread ?? e.id } };
  }
  if (e.kind === "artifact.share") {
    const body = e.body as { name: string };
    return { id: e.id, ts: e.ts, kind: "file", who, text: `shared ${body.name}${e.channel ? ` in #${e.channel}` : ""}`, to: { view: "artifacts" } };
  }
  if (e.kind === "ask") return { id: e.id, ts: e.ts, kind: "ask", who, text: `asked ${askBody(e).to}: ${plainPreview(askBody(e).text, 90)}`, to: { view: "asks" } };
  const declined = !!(e.body as { declined?: boolean }).declined;
  return { id: e.id, ts: e.ts, kind: "answer", who, text: declined ? "declined an ask" : "answered an ask", to: { view: "asks", tab: "resolved" } };
}
