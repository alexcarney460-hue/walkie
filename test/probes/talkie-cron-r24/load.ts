// Probe loader: SRC selects the tree under test (new = this worktree, old = a fixture archive).
import { resolve } from "node:path";
export const SRC = process.env.SRC ?? resolve(import.meta.dir, "../../..");
export async function load() {
  const [core, events, sched, lead, claims, fwd, peer, host, proto, header, storeM] = await Promise.all([
    import(`${SRC}/test/helpers/core.ts`),
    import(`${SRC}/test/helpers/events.ts`),
    import(`${SRC}/src/daemon/orchestrator/schedules.ts`),
    import(`${SRC}/src/daemon/orchestrator/leadership.ts`),
    import(`${SRC}/src/daemon/orchestrator/schedule-claims.ts`),
    import(`${SRC}/src/daemon/orchestrator/schedule-forward.ts`).catch(() => ({})),
    import(`${SRC}/src/daemon/peer-api.ts`),
    import(`${SRC}/src/daemon/orchestrator/host.ts`),
    import(`${SRC}/src/protocol/talkie-schedule.ts`),
    import(`${SRC}/src/protocol/header.ts`),
    import(`${SRC}/src/daemon/store.ts`),
  ]);
  return { ...core, ...events, ...sched, ...lead, ...claims, ...fwd, ...peer, ...host, ...proto, ...header, ...storeM };
}
