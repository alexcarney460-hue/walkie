import { useMemo } from "react";
import type { RenderOpts } from "../lib/markdown.tsx";
import { navigate } from "../lib/route.ts";
import { useStore } from "./store.tsx";

/** Markdown render options for the current viewer: own mentions, known channels. */
export function useMdOpts(): RenderOpts {
  const { me, team } = useStore();
  const handle = me?.handle ?? null;
  const names = team?.channels.map((c) => c.name).join(",") ?? "";
  return useMemo(() => ({
    me: handle,
    channels: new Set(names ? names.split(",") : []),
    onChannel: (c: string) => navigate({ view: "board", channel: c }),
  }), [handle, names]);
}
