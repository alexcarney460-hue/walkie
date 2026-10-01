// Guest-only MCP projection. This module never calls a local person socket or the broad MCP handlers.
import { z } from "zod";
import { redactSecrets, cleanText, defang } from "../protocol/safety.ts";
import type { Guest } from "./guest-registry.ts";

export interface GuestProject { channel: string; name: string; prefix: string; private: boolean; state: string; classification?: string }
export interface GuestCard {
  id: string; channel: string; key: string; ref: string; title: string; body: string; assignee: string | null;
  labels: string[]; state: string; column: string; updated_at: number; due?: string | null;
  created_by?: { handle: string; agent?: string };
}
export interface GuestComment { id: string; channel: string; text: string; author: { handle: string; agent?: string } }
export interface GuestData {
  card(id: string): GuestCard | null;
  project(channel: string): GuestProject | null;
  comments(card: GuestCard): GuestComment[];
  comment(guest: Guest, id: string, text: string): string;
  move(guest: Guest, id: string, action: "start" | "review" | "done" | "block", reason?: string): string;
  status(guest: Guest, id: string, title: string, state: "working" | "idle" | "waiting" | "blocked"): string | null;
}
export interface GuestResult { content: { type: "text"; text: string }[]; isError?: boolean; eventId?: string; objectId?: string }
const result = (value: unknown, eventId?: string, objectId?: string): GuestResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(eventId ? { eventId } : {}), ...(objectId ? { objectId } : {}) });
const denied = (): GuestResult => ({ content: [{ type: "text", text: "not available for this guest" }], isError: true });
const Text = z.string().min(1).max(4_000);
const Key = z.string().min(3).max(80);
const argsFor: Record<string, z.ZodTypeAny> = {
  walkie_tasks: z.object({ project: z.string().max(60).optional(), query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
  walkie_task: z.object({ key: Key }).strict(),
  walkie_read: z.object({ channel: z.string().max(60).optional(), thread: Key, limit: z.number().int().min(1).max(100).optional() }).strict(),
  walkie_post: z.object({ channel: z.string().max(60), thread: Key, text: Text }).strict(),
  walkie_task_comment: z.object({ key: Key, text: Text }).strict(),
  walkie_task_start: z.object({ key: Key }).strict(),
  walkie_task_review: z.object({ key: Key }).strict(),
  walkie_task_done: z.object({ key: Key }).strict(),
  walkie_task_block: z.object({ key: Key, reason: z.string().min(1).max(300) }).strict(),
  walkie_set_status: z.object({ title: z.string().min(1).max(200), state: z.enum(["working", "idle", "waiting", "blocked"]).optional(), task: Key }).strict(),
};
export const GUEST_TOOLS = Object.freeze(Object.keys(argsFor));

function sensitive(text: string): boolean {
  if (/\b(?:join|invite|enroll|pair)(?:\s|[-_])?(?:link|code|url)?\b/i.test(text)) return true;
  if (/https?:\/\/[^\s]*(?:invite|join|token|secret|key)[^\s]*/i.test(text)) return true;
  return redactSecrets(text).redactions.length > 0;
}
const safeLine = (text: string, max: number): string => defang(redactSecrets(text).text, max);
const safeBody = (text: string): string => cleanText(redactSecrets(text).text);

export function guestEligible(guest: Pick<Guest, "address">, card: GuestCard, project: GuestProject | null): boolean {
  return !!project && !project.private && project.classification !== "confidential" && project.state === "active"
    && card.state === "open" && card.assignee === guest.address
    && !card.labels.some((label) => label.toLowerCase() === "confidential");
}

export class GuestScope {
  constructor(private readonly data: GuestData) {}

  private assigned(guest: Guest, ref: string): { card: GuestCard; project: GuestProject } | null {
    for (const id of guest.cardIds) {
      const card = this.data.card(id);
      if (!card || ![card.id, card.key, card.ref].includes(ref)) continue;
      const project = this.data.project(card.channel);
      if (!guestEligible(guest, card, project)) return null;
      if (!project) return null;
      return { card, project };
    }
    return null;
  }

  private safeComments(card: GuestCard): GuestComment[] | null {
    const comments = this.data.comments(card);
    return comments.some((c) => c.channel !== card.channel) ? null : comments;
  }

  call(guest: Guest, name: string, raw: unknown, canWrite: () => boolean = () => true): GuestResult {
    if (!guest.tools.includes(name) || !argsFor[name]) return denied();
    const parsed = argsFor[name].safeParse(raw);
    if (!parsed.success) return denied();
    const args = parsed.data as Record<string, unknown>;
    if (name === "walkie_tasks") {
      const cards = guest.cardIds.flatMap((id) => {
        const found = this.assigned(guest, id);
        if (!found) return [];
        const { card, project } = found;
        if (args.project && args.project !== project.channel && args.project !== project.prefix) return [];
        if (args.query && !`${card.key} ${card.title}`.toLowerCase().includes(String(args.query).toLowerCase())) return [];
        return [{ key: card.key, title: safeLine(card.title, 200), column: safeLine(card.column, 80),
          labels: card.labels.map((label) => safeLine(label, 80)), due: card.due ?? null }];
      });
      return result({ tasks: cards.slice(0, Number(args.limit ?? 30)), total: cards.length });
    }
    const ref = String(args.key ?? args.thread ?? args.task ?? "");
    const found = this.assigned(guest, ref);
    if (!found) return denied();
    const { card } = found;
    if (name === "walkie_task") {
      if (!this.safeComments(card)) return denied();
      return result({ key: card.key, title: safeLine(card.title, 200), description: safeBody(card.body),
        column: safeLine(card.column, 80), labels: card.labels.map((label) => safeLine(label, 80)), due: card.due ?? null }, undefined, card.id);
    }
    if (name === "walkie_read") {
      if (args.channel && args.channel !== card.channel) return denied();
      const comments = this.safeComments(card);
      if (!comments) return denied();
      const limit = Number(args.limit ?? 30);
      return result({ comments: comments.slice(-limit).map((c) => safeBody(c.text)) }, undefined, card.id);
    }
    if (name === "walkie_post" && args.channel !== card.channel) return denied();
    if (name === "walkie_set_status") {
      const title = String(args.title);
      if (sensitive(title)) return denied();
      if (!canWrite()) return denied();
      const id = this.data.status(guest, card.id, title, (args.state ?? "working") as "working");
      return result("status updated", id ?? undefined, card.id);
    }
    if (name === "walkie_post" || name === "walkie_task_comment") {
      const text = String(args.text);
      if (sensitive(text)) return denied();
      if (!canWrite()) return denied();
      const id = this.data.comment(guest, card.id, text);
      return result("comment posted", id, card.id);
    }
    const action = name.slice("walkie_task_".length) as "start" | "review" | "done" | "block";
    if (!["start", "review", "done", "block"].includes(action)) return denied();
    const reason = args.reason === undefined ? undefined : String(args.reason);
    if (reason && sensitive(reason)) return denied();
    if (!canWrite()) return denied();
    return result("card moved", this.data.move(guest, card.id, action, reason), card.id);
  }
}
