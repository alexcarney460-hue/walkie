import { expect, test } from "bun:test";
import { guestData } from "../../src/mcp/guest-data.ts";
import { GuestScope, type GuestCard, type GuestProject } from "../../src/mcp/guest-scope.ts";
import type { Guest } from "../../src/mcp/guest-registry.ts";
import type { Core } from "../../src/daemon/core.ts";
import { ProjectsIndex } from "../../src/daemon/projects/index.ts";
import type { PeerClient } from "../../src/daemon/peer-client.ts";
import type { CatchUp } from "../../src/daemon/requests.ts";

test("each guest call folds accepted reassignment, label, and project visibility before authorization", () => {
  const guest = { address: "@alex/cloud/dots-ops", cardIds: ["aaaaaaaaaaaaaaaa:1"], tools: ["walkie_task"] } as Guest;
  const baseCard: GuestCard = { id: guest.cardIds[0]!, channel: "p-11111111", key: "WEB-1", ref: "WEB-1-aaaaaaaa",
    title: "Assigned", body: "Work", assignee: guest.address, labels: [], state: "open", column: "todo", updated_at: 1 };
  const baseProject: GuestProject = { channel: baseCard.channel, name: "Allowed", prefix: "WEB", private: false, state: "active" };
  let currentCard = baseCard;
  let currentProject = baseProject;
  let indexedCard = baseCard;
  let indexedProject = baseProject;
  let folds = 0;
  const idx = { flushProject: () => { folds++; indexedCard = currentCard; indexedProject = currentProject; },
    db: { card: () => indexedCard }, project: () => indexedProject,
    foldCardNow: () => ({ state: { timeline: [] } }) } as unknown as ProjectsIndex;
  const core = { isProjectChannel: () => true, visible: () => true } as unknown as Core;
  const scope = new GuestScope(guestData(core, idx, {} as PeerClient, {} as CatchUp));
  const read = () => scope.call(guest, "walkie_task", { key: baseCard.key });
  expect(read().isError).toBeUndefined();
  currentCard = { ...baseCard, assignee: "@alex" };
  expect(read().isError).toBe(true);
  currentCard = { ...baseCard, labels: ["confidential"] };
  expect(read().isError).toBe(true);
  currentCard = baseCard;
  currentProject = { ...baseProject, private: true };
  expect(read().isError).toBe(true);
  expect(folds).toBeGreaterThanOrEqual(4);
});

test("guest reads leave a dirty unrelated project's cards for background folding", () => {
  const channel = "p-11111111";
  const unrelated = "p-22222222";
  const id = "aaaaaaaaaaaaaaaa:1";
  const guest = { address: "@alex/cloud/dots-ops", cardIds: [id], tools: ["walkie_task"] } as Guest;
  const card: GuestCard = { id, channel, key: "WEB-1", ref: "WEB-1-aaaaaaaa", title: "Assigned",
    body: "Work", assignee: guest.address, labels: [], state: "open", column: "todo", updated_at: 1 };
  const project: GuestProject = { channel, name: "Allowed", prefix: "WEB", private: false, state: "active" };
  const pending = new Map([[channel, new Set([id])],
    [unrelated, new Set(Array.from({ length: 401 }, (_, i) => `bbbbbbbbbbbbbbbb:${i + 1}`))]]);
  const folded: string[] = [];
  const idx = Object.assign(Object.create(ProjectsIndex.prototype), {
    dirtyFull: new Set<string>(), dirtyCards: pending, keysDirty: new Set<string>(),
    rosterDirty: new Set<string>(), roomDirty: new Set<string>(), pageDirty: new Set<string>(),
    settingsOf: () => ({ project: null, boards: [] }),
    refoldCard: (ch: string) => { folded.push(ch); },
    finishChannel: () => undefined,
    db: { card: () => card }, project: () => project,
    foldCardNow: () => ({ state: { timeline: [] } }),
  }) as ProjectsIndex;
  const core = { isProjectChannel: () => true, visible: () => true } as unknown as Core;
  const scope = new GuestScope(guestData(core, idx, {} as PeerClient, {} as CatchUp));
  expect(scope.call(guest, "walkie_task", { key: card.key }).isError).toBeUndefined();
  expect(folded).toEqual([channel]);
  expect(pending.get(unrelated)?.size).toBe(401);
});
