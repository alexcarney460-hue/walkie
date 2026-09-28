// Fractional positions for cards in a column: strings over base-36 digits compared as plain strings, never ending in
// "0", so there is always a key between two others (the fractional-indexing algorithm without an integer part).
// Moving one card writes one key; nobody renumbers the column.
const D = "0123456789abcdefghijklmnopqrstuvwxyz";
export const POS_MAX_LEN = 128;

function mid(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n) + mid(a.slice(n), b.slice(n));
  }
  const da = a ? D.indexOf(a[0] as string) : 0;
  const db = b !== null ? D.indexOf(b[0] as string) : D.length;
  if (db - da > 1) return D[Math.round((da + db) / 2)] as string;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return D[da] + mid(a.slice(1), null);
}

/**
 * A key strictly between `a` and `b` (null = the start / the end of the column). Keys that aren't ordered (a peer's
 * concurrent move put two cards at the same key) give a key just after `a`.
 */
export function keyBetween(a: string | null, b: string | null): string {
  const lo = a ?? "";
  const hi = b !== null && b > lo ? b : null;
  const k = mid(lo, hi);
  return k.length <= POS_MAX_LEN ? k : mid(lo, null).slice(0, POS_MAX_LEN).replace(/0+$/, "") || "z";
}

/** Keys for `n` cards appended in order after `last`. */
export function keysAfter(last: string | null, n: number): string[] {
  const out: string[] = [];
  let prev = last;
  for (let i = 0; i < n; i++) {
    prev = keyBetween(prev, null);
    out.push(prev);
  }
  return out;
}

/**
 * `n` strictly increasing keys between `lo` and `hi` (null = the start / the end), spread by bisection so that a bulk
 * import of n cards into one column gets keys of about log36(n) + 2 characters instead of the n-long chain keysAfter
 * would grow (LINEAR-IMPORT-1: 2 000 appends reach the 128-character cap).
 */
export function spreadKeys(lo: string | null, hi: string | null, n: number): string[] {
  if (n <= 0) return [];
  const m = keyBetween(lo, hi);
  const left = Math.floor((n - 1) / 2);
  return [...spreadKeys(lo, m, left), m, ...spreadKeys(m, hi, n - 1 - left)];
}
