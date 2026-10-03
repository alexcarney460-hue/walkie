// Peer call budgets offboard's apply wait is derived from. The numbers are the timeouts those calls already use
// (`PeerClient.vv`, `pull`, `rosterRequest`). One pull page is the budget for a catch-up; a longer history can
// still take more pages than this.

/** `GET /peer/v1/vv`. */
export const PEER_VV_TIMEOUT_MS = 5_000;
/** One `GET /peer/v1/events` page. */
export const PEER_PULL_TIMEOUT_MS = 10_000;
/** `POST /peer/v1/roster-request`. */
export const PEER_ROSTER_REQUEST_TIMEOUT_MS = 10_000;

/** `catchUpAuthorityRoster` follows at most this many hops, then refuses. */
export const OFFBOARD_AUTHORITY_HOPS = 4;

/** One hop: the version vector, then one pull of that origin when this machine is behind. */
export const OFFBOARD_HOP_TIMEOUT_MS = PEER_VV_TIMEOUT_MS + PEER_PULL_TIMEOUT_MS;

/** One role send: the roster request, then the pull of the event it appended. */
export const OFFBOARD_SEND_TIMEOUT_MS = PEER_ROSTER_REQUEST_TIMEOUT_MS + PEER_PULL_TIMEOUT_MS;

/**
 * How long offboard waits for a roster flush that is already in progress: one roster request and one
 * catch-up pull. A flush that is still sending when this ends is not cancelled.
 */
export const OFFBOARD_FLUSH_WAIT_MS = PEER_ROSTER_REQUEST_TIMEOUT_MS + PEER_PULL_TIMEOUT_MS;

/** How long one team peer gets to store an SSH revocation receipt before the revocation goes on without it. */
export const RECEIPT_PEER_TIMEOUT_MS = 3_000;

/**
 * CLI wait for `POST /v1/team/offboard`: the flush wait, the catch-up, both role sends, and the SSH receipt.
 * The flush wait is capped at 20 s. A catch-up of many pages can still outlast this wait.
 */
export const OFFBOARD_APPLY_TIMEOUT_MS =
  OFFBOARD_FLUSH_WAIT_MS
  + OFFBOARD_AUTHORITY_HOPS * OFFBOARD_HOP_TIMEOUT_MS
  + 2 * OFFBOARD_SEND_TIMEOUT_MS
  + RECEIPT_PEER_TIMEOUT_MS;
