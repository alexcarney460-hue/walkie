// Pure view model of the Orchestrator tab (ORCH-FIX-11): this machine's LOCAL conversation with its own host, from
// its own store only (GET /v1/orchestrator/messages and the `orchestrator_message` stream). Nothing a peer posted is
// ever part of it: the tab never reads team events.
import type { AgentView, OrchMessage } from "../../api/types.ts";
import { DEFAULT_MODEL, MODEL_ALIASES, ORCHESTRATOR_AGENT } from "../../../../src/protocol/orchestrator.ts";
import { plainPreview } from "../../lib/markdown.tsx";

export interface ChatMessage {
  id: string; ts: number;
  role: "user" | "assistant" | "system";
  scheduled?: boolean;
  text: string;
  tools: string[];
  /** For `user`: why it never reached Claude (refused: its session ended first; dropped: stopped, too old, a restart). */
  note?: string;
}

export interface Conversation { id: string; title: string; lastTs: number; count: number }

/** Conversations, newest activity first. The title is the first line of the person's first message. */
export function conversations(messages: readonly OrchMessage[]): Conversation[] {
  const groups = new Map<string, OrchMessage[]>();
  for (const m of messages) {
    const list = groups.get(m.thread);
    if (list) list.push(m); else groups.set(m.thread, [m]);
  }
  const out: Conversation[] = [];
  for (const [id, list] of groups) {
    const sorted = [...list].sort(byTime);
    const first = sorted.find((m) => m.role === "person");
    const title = sorted[0]?.via === "private" ? "Private join details" : first?.via === "schedule" ? "Scheduled run" : first ? plainPreview(first.text.split("\n").find((l) => l.trim()) ?? "", 60) : "Conversation";
    out.push({ id, title: title || "Conversation", lastTs: (sorted[sorted.length - 1] as OrchMessage).ts, count: sorted.length });
  }
  return out.sort((a, b) => b.lastTs - a.lastTs);
}

function byTime(a: OrchMessage, b: OrchMessage): number {
  return a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const NOTES: Record<string, string> = {
  refused: "Not sent: the session that sent it ended before it ran.",
  dropped: "Not sent: stopped before it ran.",
};

/** The messages of one conversation, in order. */
export function threadMessages(messages: readonly OrchMessage[], thread: string): ChatMessage[] {
  return messages.filter((m) => m.thread === thread).sort(byTime).map((m) => m.role === "person"
    ? { id: m.id, ts: m.ts, role: "user" as const, text: m.text, tools: [], ...(m.via === "schedule" ? { scheduled: true } : {}), ...(m.state && NOTES[m.state] ? { note: NOTES[m.state] } : {}) }
    : { id: m.id, ts: m.ts, role: "assistant" as const, text: m.text, tools: m.tools ?? [] });
}

/** The person's message still waiting for a reply (the conversation's last message, queued or sent), if any. */
export function awaitingReply(messages: readonly ChatMessage[], now: number, maxAgeMs = 10 * 60_000): ChatMessage | null {
  const last = messages[messages.length - 1];
  return last?.role === "user" && !last.note && now - last.ts < maxAgeMs ? last : null;
}

/** This machine's own orchestrator, from its status (its generic state: "Thinking…", "Using tools…"), if running. */
export function localOrchestrator(agents: readonly AgentView[], node: string | undefined): AgentView | null {
  if (!node) return null;
  return agents.find((a) => a.agent === ORCHESTRATOR_AGENT && a.node === node && a.effective_state !== "offline") ?? null;
}

export type DayGroup = "Today" | "Yesterday" | "Previous 7 days" | "Previous 30 days" | "Older";

export function dayGroup(ts: number, now: number): DayGroup {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = 24 * 60 * 60 * 1000;
  if (ts >= start.getTime()) return "Today";
  if (ts >= start.getTime() - day) return "Yesterday";
  if (ts >= start.getTime() - 7 * day) return "Previous 7 days";
  if (ts >= start.getTime() - 30 * day) return "Previous 30 days";
  return "Older";
}

/** "Claude" plus the model family when the status names one ("claude-opus-5-5[1m]" → "Claude · Opus 5.5"). */
export function modelLabel(model: string | undefined): string {
  if (!model || model === DEFAULT_MODEL) return "Claude";
  if (MODEL_ALIASES.includes(model)) return `Claude · ${model[0]?.toUpperCase()}${model.slice(1)}`;
  const m = /claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/i.exec(model);
  if (!m) return `Claude · ${model}`;
  const fam = (m[1] as string).charAt(0).toUpperCase() + (m[1] as string).slice(1);
  return `Claude · ${fam} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}
