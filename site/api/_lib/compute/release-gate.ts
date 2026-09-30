import { optionalEnv, type Env } from "../env.js";
import { fail } from "../http.js";

/** This release contains the compute code for review, but cannot activate the control plane. */
export const COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION = false;

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
