import type { AgentView, ProjectView } from "../api/types.ts";
import { associate } from "../../../src/protocol/projects/assoc.ts";

export interface ProjectCount { channel: string | null; name: string; prefix: string | null; count: number }

/** Count exactly the agents passed by Mission Control's default roster split. */
export function projectCounts(shown: readonly AgentView[], projects: readonly ProjectView[]): ProjectCount[] {
  if (!shown.length || !projects.length) return [];
  const byChannel = new Map(projects.map((project) => [project.channel, project]));
  const counts = new Map<string, number>();
  let unmatched = 0;
  for (const agent of shown) {
    const hit = associate(agent.status, projects, () => true);
    if (hit && byChannel.has(hit.channel)) counts.set(hit.channel, (counts.get(hit.channel) ?? 0) + 1);
    else unmatched += 1;
  }
  const named = [...counts].map(([channel, count]) => {
    const project = byChannel.get(channel) as ProjectView;
    return { channel, name: project.name, prefix: project.prefix, count };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return unmatched ? [...named, { channel: null, name: "No project", prefix: null, count: unmatched }] : named;
}
