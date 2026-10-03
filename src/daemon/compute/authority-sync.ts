// When this daemon last held the roster authority's whole log (RENT-2, WALK-101): what ComputeService needs to know before it
// closes a rental whose machine it never saw join (an admission it has not received yet must not be missed).
import type { Core } from "../core.ts";
import type { PeerState } from "../sync.ts";

/**
 * The START of the latest sync after which this daemon held everything the roster authority's version vector listed
 * (PeerState.levelAt), so a later admission is the only thing it can lack; the authority's own daemon: now (its log is
 * the authority's); null when there is no authority, or no such sync yet since this daemon started (mixed transports
 * with no shared transport to the authority never give one).
 */
export function authorityLevelAt(
  core: Pick<Core, "authority" | "nodeId" | "clock">,
  peerState: (nodeId: string) => Pick<PeerState, "levelAt"> | undefined,
): number | null {
  const authority = core.authority;
  if (!authority) return null;
  if (authority === core.nodeId) return core.clock();
  return peerState(authority)?.levelAt ?? null;
}
