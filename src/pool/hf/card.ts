// A Mixture of Experts' ACTIVE parameters from its model card ("320B total parameters and just 18B active parameters"),
// for models whose name carries no A3B token. The card is untrusted text: only numbers are read, and a sentence counts
// only when the total it names (if it names one) agrees with the checkpoint, so another model's line in the same card is
// not taken. Never computed from the config: an architecture's expert layout is not enough (Qwen3.8-Flash-Next's config
// formula says 62B active, its card says 6B). docs/plans/LOCAL-MODELS-HF-1.md "Candidates" 7.

/** How much of a card is read, and the longest line looked at. */
export const CARD_READ_MAX = 200_000;
const LINE_MAX = 20_000;
/** A total named near the statement must be this share of the checkpoint (an n-gram-embedding model names 125B of 180B). */
const TOTAL_MIN = 0.4;
const TOTAL_MAX = 1.15;
/** How far before a statement a total may sit. */
const TOTAL_WINDOW = 120;

interface Num { v: number; start: number; end: number }

/** Free-standing "125B" / "1.6T" tokens (not the 3B inside "A3B" or the 35B of a model name). */
function numbers(line: string): Num[] {
  const out: Num[] = [];
  for (const m of line.matchAll(/(?<![A-Za-z0-9.-])(\d+(?:\.\d+)?)\s?([BT])\b/g)) {
    out.push({ v: Number(m[1]) * (m[2] === "T" ? 1000 : 1), start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

const FILLER = String.raw`(?:(?:only|just|about|approximately|roughly|around|nearly)\s+)*`;
/** Each pattern's group 1 is the active figure in billions. */
const STATEMENTS: readonly RegExp[] = [
  /(?<![A-Za-z0-9.-])(\d+(?:\.\d+)?)\s?B\s+(?:parameters\s+|params\s+)?(?:active|activated)\b/gi,
  /\b(?:active|activated)\s+(?:parameters|params)\s*[|:=]?\s*(\d+(?:\.\d+)?)\s?B\b/gi,
  /\bactivated\s+(\d+(?:\.\d+)?)\s?B\b/gi,
  new RegExp(String.raw`\bactivates\s+${FILLER}(\d+(?:\.\d+)?)\s?B\s+(?:parameters|params)\b`, "gi"),
];

/**
 * The active parameters (billions) the card states for a checkpoint of `totalB` billion parameters, or null. The first
 * sentence in the card that fits wins.
 */
export function activeFromCard(text: string, totalB: number): number | null {
  const lines = text.slice(0, CARD_READ_MAX).split("\n");
  for (const raw of lines) {
    if (raw.length > LINE_MAX) continue;
    const line = raw.replace(/<[^>]*>/g, " ").replace(/[*`~≈]/g, "");
    const found: { active: number; at: number }[] = [];
    for (const re of STATEMENTS) {
      for (const m of line.matchAll(re)) found.push({ active: Number(m[1]), at: m.index! + m[0].indexOf(m[1]!) });
    }
    if (!found.length) continue;
    const nums = numbers(line);
    for (const { active, at } of found.sort((a, b) => a.at - b.at)) {
      if (!(active >= 0.3 && active < 0.95 * totalB)) continue;
      const near = nums.filter((n) => n.end <= at && at - n.end <= TOTAL_WINDOW);
      // A named total must be this checkpoint's; a table row names none and is accepted on plausibility alone.
      if (near.length && !near.some((n) => n.v / totalB >= TOTAL_MIN && n.v / totalB <= TOTAL_MAX)) continue;
      return active;
    }
  }
  return null;
}
