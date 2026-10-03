// PROJECT-PAGES-1: the screens of a project's status page, from its Data Room (the page's read model and the report's fact sheet
// both ask for them, so they live apart from either).
import { currentVersion, roomFileView } from "../../protocol/projects/room.ts";
import { compareIds, composeScreens, sameScreen } from "../../protocol/projects/page.ts";
import { ScreenMeta, type ScreenMetaT, type RoomFileView } from "../../protocol/projects/schema.ts";
import type { ScreensView } from "../../protocol/projects/status-page.ts";
import type { ProjectsIndex } from "./index.ts";

/** The files of a project's Data Room that are screens (the register is set), as the room's own views say them. */
export function screenFiles(idx: ProjectsIndex, channel: string): RoomFileView[] {
  return idx.room(channel).filter((f) => f.state === "active" && f.screen).map((f) => {
    const cur = currentVersion(f);
    return roomFileView(f, channel, { cards: [], available: idx.db.shareAccepted(cur.share, cur.hash, channel) });
  });
}

/** The page's screens: grouped, ordered and capped (protocol/projects/page.ts composeScreens). */
export function pageScreens(idx: ProjectsIndex, channel: string): ScreensView {
  return composeScreens(screenFiles(idx, channel));
}

/**
 * Latest screen mutation from the retained room history, including metadata and removals. Replay in fold order, not
 * timestamp order: clocks on different members can disagree. Plain room edits and edits after detaching do not count.
 * This is derived from signed history on every replica, so an empty page keeps its time across index rebuilds.
 */
export function screensUpdatedAt(idx: ProjectsIndex, channel: string): number | null {
  let newest: number | null = null;
  for (const file of idx.room(channel)) {
    let screen: ScreenMetaT | null = null;
    let active = true;
    const versions = new Set(file.versions.filter((v) => !v.ignored).map((v) => v.id));
    const entries = file.timeline.filter((e) => !e.ignored).sort((a, b) =>
      (a.effective_rev ?? 0) - (b.effective_rev ?? 0) || compareIds(a.id, b.id));
    for (const entry of entries) {
      const fields = entry.changes ?? {};
      const parsed = ScreenMeta.safeParse(fields.screen);
      const nextScreen: ScreenMetaT | null = fields.screen === null ? null : parsed.success ? parsed.data : screen;
      const nextActive: boolean = fields.state === undefined ? active : fields.state === "active";
      const wasVisible = active && screen !== null;
      const isVisible = nextActive && nextScreen !== null;
      const contentChanged = versions.has(entry.id);
      if (wasVisible !== isVisible || ((wasVisible || isVisible) && (!sameScreen(screen, nextScreen) || contentChanged))) {
        newest = Math.max(newest ?? entry.ts, entry.ts);
      }
      screen = nextScreen;
      active = nextActive;
    }
  }
  return newest;
}
