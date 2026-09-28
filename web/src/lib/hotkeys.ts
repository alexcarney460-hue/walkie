import { useEffect } from "react";
import { getRoute, navigate, type View } from "./route.ts";

const G_MAP: Record<string, View> = { m: "mission", p: "projects", o: "orchestrator", b: "board", a: "asks", f: "artifacts", t: "team", i: "integrations", u: "accounts", s: "seats" };

export const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ["g", "m"], label: "Mission Control" },
  { keys: ["g", "p"], label: "Projects" },
  { keys: ["g", "o"], label: "WalkieTalkie" },
  { keys: ["g", "b"], label: "Channels" },
  { keys: ["g", "a"], label: "Asks" },
  { keys: ["g", "f"], label: "Artifacts" },
  { keys: ["g", "t"], label: "Team" },
  { keys: ["g", "i"], label: "Integrations" },
  { keys: ["g", "u"], label: "Accounts (usage left)" },
  { keys: ["g", "s"], label: "Seats" },
];

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Global keys: ⌘K / Ctrl+K palette, and g-then-letter view jumps (1 s window). */
export function useGlobalHotkeys(openPalette: () => void): void {
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openPalette();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "g") {
        gAt = Date.now();
        return;
      }
      const view = G_MAP[key];
      if (view && Date.now() - gAt < 1_000) {
        e.preventDefault();
        gAt = 0;
        if (getRoute().view !== view) navigate({ view });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPalette]);
}
