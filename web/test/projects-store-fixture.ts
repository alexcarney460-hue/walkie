import type { ProjectsState } from "../src/state/projects.ts";
import { projectsStore } from "../src/state/projects.ts";

const empty = (): ProjectsState => ({ status: "idle", error: null, projects: [], stubs: [], cards: {}, cardsError: {}, rooms: {}, roomsError: {} });

/** Bun keeps this module singleton across test files; discard its fixture state and fence older async work. */
export function resetProjectsStore(): void {
  const current = projectsStore as unknown as Record<string, unknown>;
  const fresh = new (projectsStore.constructor as new () => typeof projectsStore)() as unknown as Record<string, unknown>;
  const fenced = new Set(["listGeneration", "accessVersion", "accessRevision", "detailGeneration", "seq"]);
  for (const [key, value] of Object.entries(fresh)) {
    if (typeof value === "function") continue; // get and subscribe are bound to the existing exported instance.
    current[key] = fenced.has(key) ? Number(current[key]) + 1 : value;
  }
  projectsStore.set(empty());
}
