// Integration sources: a post whose author.agent is a connector id was written by that connector on
// the author's machine. The link to the source is the first https URL on the service's own host.
import type { Event } from "../api/types.ts";

export type SourceId = "fireflies" | "wispr" | "linear";

export const SOURCES: Record<SourceId, { label: string; linkLabel: string; hosts: readonly string[] }> = {
  fireflies: { label: "Fireflies", linkLabel: "Open in Fireflies", hosts: ["app.fireflies.ai", "fireflies.ai"] },
  wispr: { label: "Wispr Flow", linkLabel: "Open in Wispr Flow", hosts: ["notes.wisprflow.ai"] },
  linear: { label: "Linear", linkLabel: "Open in Linear", hosts: ["linear.app"] },
};

export function sourceOf(ev: Pick<Event, "author">): SourceId | null {
  const a = ev.author.agent;
  return a === "fireflies" || a === "wispr" || a === "linear" ? a : null;
}

/** First https link in the text on one of the source's hosts, else null. */
export function sourceLink(ev: Event): string | null {
  const src = sourceOf(ev);
  if (!src) return null;
  const text = typeof (ev.body as { text?: unknown }).text === "string" ? (ev.body as { text: string }).text : "";
  for (const m of text.matchAll(/https:\/\/[^\s<>()]+/g)) {
    try {
      const url = new URL(m[0].replace(/[.,;:!?'")]+$/, ""));
      if (url.protocol === "https:" && SOURCES[src].hosts.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`))) return url.toString();
    } catch {
      /* not a URL */
    }
  }
  return null;
}

/** "ALE-5156"-shaped issue keys. */
export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,6}$/;
