import type { AskView } from "../../protocol/schemas.ts";

/** Only the first answer to the exact direct ask can approve, and it must be this machine's person. */
export function approvedBrowserAnswer(view: AskView, id: string, node: string, handle: string | null): boolean {
  if (view.state !== "answered" || !handle) return false;
  const first = [...view.answers].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id))[0];
  return first?.author.agent === undefined && first?.author.node === node && first?.author.handle === handle
    && first.body.text === `YES ${id.slice(0, 8)}`;
}
