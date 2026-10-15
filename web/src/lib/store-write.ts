import type { CardView, ProjectView, RoomFileView } from "../api/types.ts";
import { projectsStore } from "../state/projects.ts";

export const SAVED_REFRESHING = "Saved; refreshing. The change may take a moment to appear.";

type Answer = { kind: "project"; value: ProjectView } | { kind: "card"; value: CardView; localView?: boolean } | { kind: "roomFile"; value: RoomFileView };

/** A server write succeeded. Check whether its answer reached the visible cache; otherwise re-read it. */
export function storeWriteAnswer(answer: Answer, generation: number, onShown?: () => void, store = projectsStore): boolean {
  const { kind, value } = answer;
  const accepted = kind === "project" ? store.project(value, generation) : kind === "card"
    ? (store.card(value, generation), store.isVisible(value.channel, generation) && store.get().cards[value.channel]?.some((c) => c === value))
    : (store.roomFile(value, generation), store.isVisible(value.channel, generation) && store.get().rooms[value.channel]?.some((f) => f === value));
  // Simple mode owns a separate task list; it can show the server answer when no project-card cache was loaded.
  if (accepted || (kind === "card" && answer.localView && !store.get().cards[value.channel] && store.isVisible(value.channel, generation))) return true;

  void (async () => {
    try {
      await store.refresh();
      if (kind === "card") await store.loadCards(value.channel);
      if (kind === "roomFile") await store.loadRoom(value.channel);
      const shown = kind === "project" ? store.get().projects.some((p) => p.channel === value.channel && JSON.stringify(p) === JSON.stringify(value))
        : kind === "card" ? store.get().cards[value.channel]?.some((c) => c.id === value.id && JSON.stringify(c) === JSON.stringify(value))
          : store.get().rooms[value.channel]?.some((f) => f.id === value.id && JSON.stringify(f) === JSON.stringify(value));
      if (shown) onShown?.();
    } catch {
      // The saved notice remains visible when a refresh fails.
    }
  })();
  return false;
}
