// A card's short id (round-6 audits): 8 hex of sha256 of its root event id. Stable forever (the id never changes),
// unlike the key number, a label that can move when cards are created concurrently or offline. References for tools,
// branches and pull requests carry it (`WEB-12-7f3a09c1`) and resolve by it; the key part is advisory.
import { createHash } from "node:crypto";

export const SHORT_HEX = 8;

export function shortId(cardId: string): string {
  return createHash("sha256").update(cardId).digest("hex").slice(0, SHORT_HEX);
}

/** "WEB-12-7f3a09c1": the card's current key plus its short id. */
export function cardRef(key: string, cardId: string): string { return `${key}-${shortId(cardId)}`; }
