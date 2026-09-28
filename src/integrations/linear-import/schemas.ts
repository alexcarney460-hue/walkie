// Linear response shapes the import reads (zod). A leaf module (zod only): the plan, the mapping and the dashboard's
// types import it without pulling in the HTTP layer.
import { z } from "zod";

const Str = z.string().max(100_000);
export const Id = z.string().min(1).max(100);
export const PageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().max(500).nullish() });
const Named = z.object({ name: Str.nullish() }).nullish();

export const LTeam = z.object({ id: Id, key: z.string().max(20), name: z.string().max(200) });
export type LTeam = z.infer<typeof LTeam>;

export const LProject = z.object({
  id: Id, name: z.string().max(300), state: z.string().max(40).nullish(), url: z.string().max(1000).nullish(),
  description: z.string().max(100_000).nullish(), updatedAt: z.string().max(40), completedAt: z.string().max(40).nullish(),
  canceledAt: z.string().max(40).nullish(),
  teams: z.object({ nodes: z.array(LTeam).max(50) }),
  initiatives: z.object({ nodes: z.array(z.object({ name: z.string().max(300) })).max(5) }).nullish(),
});
export type LProject = z.infer<typeof LProject>;

const LUserRef = z.object({ id: Id.nullish(), name: Str.nullish(), displayName: Str.nullish(), email: Str.nullish() }).nullish();
export const LIssue = z.object({
  id: Id, identifier: z.string().max(40), title: z.string().max(10_000), url: z.string().max(1000),
  description: Str.nullish(), priority: z.number().nullish(), estimate: z.number().nullish(), dueDate: z.string().max(40).nullish(),
  createdAt: z.string().max(40), updatedAt: z.string().max(40), completedAt: z.string().max(40).nullish(), canceledAt: z.string().max(40).nullish(),
  state: z.object({ id: Id, name: z.string().max(200), type: z.string().max(40) }),
  labels: z.object({ nodes: z.array(z.object({ name: z.string().max(200) })).max(50) }).nullish(),
  assignee: LUserRef, creator: Named,
  parent: z.object({ id: Id, identifier: z.string().max(40) }).nullish(),
  project: z.object({ id: Id }).nullish(),
  team: z.object({ id: Id, key: z.string().max(20), name: z.string().max(200) }),
  comments: z.object({ nodes: z.array(z.object({ body: Str, createdAt: z.string().max(40), user: Named })).max(100) }).nullish(),
  history: z.object({
    nodes: z.array(z.object({
      createdAt: z.string().max(40), actor: Named, fromState: Named, toState: Named, fromAssignee: Named, toAssignee: Named,
    })).max(100),
  }).nullish(),
});
export type LIssue = z.infer<typeof LIssue>;

export const LState = z.object({ id: Id, name: z.string().max(200), type: z.string().max(40), position: z.number(), team: z.object({ id: Id, key: z.string().max(20) }).nullish() });
export type LState = z.infer<typeof LState>;
export const LUser = z.object({ id: Id, name: z.string().max(300), displayName: z.string().max(300).nullish(), email: z.string().max(300).nullish(), active: z.boolean().nullish() });
export type LUser = z.infer<typeof LUser>;

