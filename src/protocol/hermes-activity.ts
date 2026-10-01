// Which Hermes profiles may show activity text on their status. Every Hermes profile shows its state (working, idle,
// offline) and nothing else, unless config.json lists it in `hermes_activity_profiles`. The hook, the daemon's Hermes route
// and discovery all read the list through hermesActivityProfiles() below, so they cannot disagree, and no environment
// variable decides anything.
import { z } from "zod";

/** The profile names Walkie carries: what Hermes hooks, the status route and the installer accept. */
export const HERMES_PROFILE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** The most profiles the list may name. */
export const HERMES_ACTIVITY_PROFILES_MAX = 64;
export const HermesActivityProfiles = z.array(z.string().regex(HERMES_PROFILE)).max(HERMES_ACTIVITY_PROFILES_MAX);

/**
 * The allow list in a parsed config.json: the names it holds, each once. A missing key, anything that is not an array, an array
 * over the bound and an array with a single invalid name all give [] (no profile shows activity): a damaged setting fails private,
 * and one bad entry never leaves the others in force.
 */
export function hermesActivityProfiles(cfg: unknown): readonly string[] {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return [];
  const parsed = HermesActivityProfiles.safeParse((cfg as { hermes_activity_profiles?: unknown }).hermes_activity_profiles);
  return parsed.success ? [...new Set(parsed.data)] : [];
}
