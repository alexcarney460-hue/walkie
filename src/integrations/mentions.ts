// Maps teammate names in external text (meeting action items) to @handle mentions, so the named
// person's agents see the item. Matching is case-insensitive on whole words: the handle, the full
// display name, or the display name's first word (3+ letters).

export interface Teammate { handle: string; display_name?: string }

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function patterns(m: Teammate): RegExp[] {
  const names = new Set<string>([m.handle]);
  const dn = m.display_name?.trim();
  if (dn) {
    names.add(dn);
    const first = dn.split(/\s+/)[0] ?? "";
    if (first.length >= 3) names.add(first);
  }
  return [...names].map((n) => new RegExp(`(^|[^\\p{L}\\p{N}_@])${escapeRe(n)}(?=$|[^\\p{L}\\p{N}_])`, "iu"));
}

/** Handles of teammates named in `line`, in roster order. */
export function teammatesIn(line: string, members: readonly Teammate[]): string[] {
  const out: string[] = [];
  for (const m of members) if (patterns(m).some((re) => re.test(line))) out.push(m.handle);
  return out;
}

/** Appends "→ @handle" to every line that names a teammate (and doesn't already mention them). */
export function annotateMentions(text: string, members: readonly Teammate[]): string {
  return text.split("\n").map((line) => {
    const handles = teammatesIn(line, members).filter((h) => !line.toLowerCase().includes(`@${h}`));
    return handles.length ? `${line} → ${handles.map((h) => `@${h}`).join(" ")}` : line;
  }).join("\n");
}
