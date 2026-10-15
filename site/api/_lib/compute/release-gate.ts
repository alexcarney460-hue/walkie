import { optionalEnv, type Env } from "../env.js";
import { fail } from "../http.js";

/**
 * Rental compute ships switched on in code from v0.2.0-pre.17: the deployment's environment decides the mode (fully off
 * without COMPUTE_PRIVATE_CONFIG, drained without COMPUTE_ENABLED=1, enabled with it; handler.ts). Setting this back to
 * false is the code-level lock that pre.10 to pre.16 shipped with: every /api/compute/* route answers 503. The rollback
 * for a live site is drain, not a locked build (a locked build binds licences without recording them; docs/COMPUTE-GOLIVE.md).
 */
export const COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION = true;

export function computeReleaseGate(env: Env): Response | null {
  if (COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION) return null;
  const configured = optionalEnv(env, "COMPUTE_ENABLED") === "1";
  return fail(503, "compute_unavailable_in_this_version", {
    message: configured
      ? "COMPUTE_ENABLED=1 is refused in this version; remove it from the deployment configuration"
      : "rental compute is not available in this version",
  });
}

/** License binding remains on its released path unless a forbidden live switch was configured. */
export function computeConfigurationError(env: Env): Response | null {
  return optionalEnv(env, "COMPUTE_ENABLED") === "1" ? computeReleaseGate(env) : null;
}
