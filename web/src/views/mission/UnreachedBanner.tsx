import { useEffect, useMemo, useState } from "react";
import type { MeView, NodeView } from "../../api/types.ts";
import { load, save } from "../../lib/storage.ts";
import { useStore } from "../../state/store.tsx";

/** Machines this one can't reach whose agents are hidden here now (the daemon's `unreached`: no machine vouches for them). */
export function hiddenMachines(nodes: readonly NodeView[]): NodeView[] {
  return nodes.filter((n) => !n.self && n.unreached?.vouched === false);
}

/**
 * This machine serves Walkie Direct and not Tailscale: `walkie direct enable` is for the other machines to run.
 * Anywhere else the fix is to run it here.
 */
export function directOnlyHere(me: Pick<MeView, "transport"> | null): boolean {
  const serving = me?.transport?.transports ?? [];
  return serving.includes("direct") && !serving.includes("tailscale");
}

const DISMISSED_KEY = "walkie.unreachedDismissed";
const DISMISSED_MAX = 256;

/** Dismissed machine ids as stored: anything that is not a list of strings counts as none. */
export function readDismissed(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(-DISMISSED_MAX) : [];
}

/** Dismissed machines stay dismissed; the banner comes back when a machine it was not dismissed for is hidden. */
export function isDismissed(hidden: readonly NodeView[], dismissed: readonly string[]): boolean {
  return hidden.every((n) => dismissed.includes(n.node_id));
}

/** The dismissed list after dismissing for `hidden` (each machine once, the newest kept when the list is full). */
export function withDismissed(dismissed: readonly string[], hidden: readonly NodeView[]): string[] {
  return readDismissed([...new Set([...dismissed, ...hidden.map((n) => n.node_id)])]);
}

/**
 * A dismissal lasts only while its machine stays hidden: the ones for machines that are not hidden now are dropped, so a
 * machine that recovers and is hidden again later (the recurrence this banner exists to catch) is told again.
 */
export function pruneDismissed(dismissed: readonly string[], hidden: readonly NodeView[]): string[] {
  const now = new Set(hidden.map((n) => n.node_id));
  return dismissed.filter((id) => now.has(id));
}

/**
 * Dismissing removes the button that has focus, which would drop focus to the page body and send a keyboard user back to
 * the top of the page. Moves it to the page heading instead (tabIndex -1: script can focus it, Tab never lands on it).
 * No scroll: the heading is where the banner was.
 */
export function focusPageHeading(doc: Pick<Document, "querySelector"> | undefined = typeof document === "undefined" ? undefined : document): void {
  const heading = doc?.querySelector<HTMLElement>(".mission-main h1");
  if (!heading) return;
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
}

export function UnreachedBanner({ count, here, onDismiss }: { count: number; here: boolean; onDismiss: () => void }) {
  const one = count === 1;
  return (
    <div className="local-lag-banner unreached-banner" role="status" data-testid="unreached-banner">
      <p>
        {count} {one ? "machine's" : "machines'"} agents are hidden on this machine because it can't reach {one ? "it" : "them"} directly (or {one ? "that machine is" : "those machines are"} off).{" "}
        {here ? <>Run <code>walkie direct enable</code> here.</> : <>Run <code>walkie direct enable</code> on {one ? "that machine" : "those machines"}.</>}
      </p>
      <button type="button" className="btn btn-sm" onClick={() => { onDismiss(); focusPageHeading(); }}>Dismiss</button>
    </div>
  );
}

/**
 * Mission Control: a machine that can't reach part of the team (Tailscale-only here, Direct-only there, or the reverse)
 * shows those machines' agents only while another machine that reaches them is in sync. When none is, say so, with the
 * fix. Dismissing is remembered in this browser, per hidden machine, for as long as that machine stays hidden.
 */
export function UnreachedNotice() {
  const { me, nodes } = useStore();
  const [dismissed, setDismissed] = useState<string[]>(() => readDismissed(load<unknown>(DISMISSED_KEY, [])));
  const hidden = useMemo(() => hiddenMachines(nodes), [nodes]);
  // Forget the dismissals of machines that are not hidden now (also in storage); storage that fails keeps them in memory.
  useEffect(() => {
    const kept = pruneDismissed(dismissed, hidden);
    if (kept.length === dismissed.length) return;
    save(DISMISSED_KEY, kept);
    setDismissed(kept);
  }, [dismissed, hidden]);
  if (!hidden.length || isDismissed(hidden, dismissed)) return null;
  const dismiss = () => {
    const next = withDismissed(dismissed, hidden);
    save(DISMISSED_KEY, next);
    setDismissed(next);
  };
  return <UnreachedBanner count={hidden.length} here={!directOnlyHere(me)} onDismiss={dismiss} />;
}
