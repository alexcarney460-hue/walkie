// Blob access is per (channel, hash) provenance (PROTOCOL §4, D5): this node may hand out the bytes
// of `hash` for channel X only if it holds provenance for (X, hash) — it uploaded them with a share in
// X, or fetched them for an accepted share in X from a peer that had provenance — and an accepted
// artifact.share of the hash in X is visible to the caller. A signed announcement alone grants nothing.
import { canSeeChannel, type Roster } from "./roster.ts";
import type { Store } from "./store.ts";

export function blobServable(r: Roster, store: Store, hash: string, channel: string, handle: string | null): boolean {
  if (!r.channels.has(channel) || !canSeeChannel(r, channel, handle)) return false;
  if (!store.hasProvenance(channel, hash)) return false;
  return store.blobRefRows(hash).some((s) => s.channel === channel);
}

/** Channels with an accepted share of the hash that `handle` may see (where a fetch may be attempted). */
export function shareChannels(r: Roster, store: Store, hash: string, handle: string | null): string[] {
  const out = new Set<string>();
  for (const s of store.blobRefRows(hash)) if (s.channel && canSeeChannel(r, s.channel, handle)) out.add(s.channel);
  return [...out].sort();
}
