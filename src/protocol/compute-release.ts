/**
 * Rental compute ships switched on from v0.2.0-pre.17: the daemon runs its compute service and the CLI's `walkie compute`.
 * Releases pre.10 to pre.16 shipped this false (the CLI refused, and the daemon started no rental service).
 */
export const RENTAL_COMPUTE_AVAILABLE_IN_THIS_VERSION = true;
