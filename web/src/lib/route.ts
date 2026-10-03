import { useSyncExternalStore } from "react";

// Hash routing keeps the daemon's static server trivial (one index.html).
//   #/machines/<node-id>   the machine page (WALKIE-UI-POLISH-1)
//   #/mission[?tab=archive&machine=<host>]   #/board/<channel>[/<threadId>]   #/asks[?tab=]
//   #/updates            every reported project's latest status report (UPDATES-1)
//   #/artifacts          #/team     #/integrations   #/accounts   #/orchestrator[/<conversationId>]   #/seats
//   #/projects           #/projects/<channel>[/<board id>][?card=<card id>]   (WALKIE-PROJECTS-1)
//   #/simple[?card=<card id>|?ask=<ask id>]   plain-language board (WALK-75)
//   #/projects/<channel>/room   the project's Data Room (DATA-ROOM-1)
//   #/projects/<channel>/page[?group=<slug>]   the project's status page (PROJECT-PAGES-1), at a group of its screens
//   any + ?agent=<id>

export type View = "mission" | "updates" | "projects" | "simple" | "orchestrator" | "board" | "asks" | "artifacts" | "team" | "integrations" | "accounts" | "machine" | "seats";

export interface Route {
  view: View;
  channel?: string;
  thread?: string;
  agent?: string;
  tab?: string;
  /** The machine page (#/machines/<node-id>): the machine's node id. */
  node?: string;
  /** Mission Control's Archive: only this machine (hostname). */
  machine?: string;
  /** Projects: the board shown (its root event id) and the open card (its root event id). */
  board?: string;
  card?: string;
  /** Simple mode: an ask open on the page. A card, when both are present, wins. */
  ask?: string;
  /** Projects: the project's Data Room tab instead of a board. */
  room?: boolean;
  /** Projects: the project's status page instead of a board, and the group of screens it scrolls to. */
  page?: boolean;
  group?: string;
}

const VIEWS: View[] = ["mission", "updates", "projects", "simple", "orchestrator", "board", "asks", "artifacts", "team", "integrations", "accounts", "seats"];

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [pathPart = "", query = ""] = raw.split("?");
  const parts = pathPart.split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const params = new URLSearchParams(query);
  const first = parts[0] as View | undefined;
  const isMachine = parts[0] === "machines" && !!parts[1];
  const view: View = isMachine ? "machine" : first && VIEWS.includes(first) ? first : "mission";
  const route: Route = { view };
  if (isMachine) route.node = parts[1];
  if (view === "board") {
    if (parts[1]) route.channel = parts[1];
    if (parts[2]) route.thread = parts[2];
  }
  if (view === "orchestrator" && parts[1]) route.thread = parts[1];
  if (view === "projects") {
    if (parts[1]) route.channel = parts[1];
    if (parts[2] === "room") route.room = true;
    else if (parts[2] === "page") route.page = true;
    else if (parts[2]) route.board = parts[2];
    const card = params.get("card");
    if (card) route.card = card;
    const group = params.get("group");
    if (group && route.page) route.group = group;
  }
  if (view === "simple") {
    const card = params.get("card");
    if (card) route.card = card;
    else {
      const ask = params.get("ask");
      if (ask) route.ask = ask;
    }
  }
  const agent = params.get("agent");
  if (agent) route.agent = agent;
  const tab = params.get("tab");
  if (tab) route.tab = tab;
  const machine = params.get("machine");
  if (machine) route.machine = machine;
  return route;
}

export function hrefFor(r: Route): string {
  let path = r.view === "machine" ? `#/machines/${encodeURIComponent(r.node ?? "")}` : `#/${r.view}`;
  if (r.view === "board" && r.channel) {
    path += `/${encodeURIComponent(r.channel)}`;
    if (r.thread) path += `/${encodeURIComponent(r.thread)}`;
  }
  if (r.view === "orchestrator" && r.thread) path += `/${encodeURIComponent(r.thread)}`;
  if (r.view === "projects" && r.channel) {
    path += `/${encodeURIComponent(r.channel)}`;
    if (r.room) path += "/room";
    else if (r.page) path += "/page";
    else if (r.board) path += `/${encodeURIComponent(r.board)}`;
  }
  const params = new URLSearchParams();
  if ((r.view === "projects" || r.view === "simple") && r.card) params.set("card", r.card);
  else if (r.view === "simple" && r.ask) params.set("ask", r.ask);
  if (r.view === "projects" && r.page && r.group) params.set("group", r.group);
  if (r.tab) params.set("tab", r.tab);
  if (r.machine) params.set("machine", r.machine);
  if (r.agent) params.set("agent", r.agent);
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}

export function navigate(r: Route): void {
  const next = hrefFor(r);
  if (window.location.hash !== next) window.location.hash = next;
}

let current = parseHash(window.location.hash);
let currentHash = window.location.hash;

/** A view-level location: the route without the agent drawer, so opening or closing a drawer is not a move. */
export function pageKey(r: Route): string {
  return hrefFor({ ...r, agent: undefined });
}
const TRAIL_MAX = 50;
/** View-level locations visited in this page, oldest first (the last is the current one); "Back" walks it. */
let trail: string[] = [pageKey(current)];

const subs = new Set<() => void>();
window.addEventListener("hashchange", () => {
  if (window.location.hash === currentHash) return;
  currentHash = window.location.hash;
  current = parseHash(currentHash);
  const key = pageKey(current);
  if (trail[trail.length - 1] !== key) trail = [...trail, key].slice(-TRAIL_MAX);
  subs.forEach((s) => s());
});

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

export function getRoute(): Route {
  return current;
}

/**
 * Back to the previous view visited in the dashboard (drawers opened and closed on the way don't count); with no
 * earlier view (a deep link opened fresh) it goes to `fallback`. Never leaves the dashboard.
 */
export function goBack(fallback: Route): void {
  const previous = trail.length >= 2 ? trail[trail.length - 2] : undefined;
  if (previous) {
    trail = trail.slice(0, -2); // the move below pushes `previous` back as the current view
    window.location.hash = previous;
  } else {
    navigate(fallback);
  }
}
