// Ask/answer: addressing (`to=me`), state, and long-poll waiting.
import { parseAddress, type ParsedAddress } from "../protocol/address.ts";
import type { AskView, BodyOf, Event } from "../protocol/schemas.ts";
import type { Core } from "./core.ts";
import { isHermesStatus } from "./hermes-status.ts";
import { HttpError } from "./http.ts";
import { nodeMember } from "./roster.ts";
import { askView } from "./views.ts";

export const MAX_WAIT_S = 120;

export { parseAddress, type ParsedAddress } from "../protocol/address.ts";

/**
 * Whether an ask's `to` addresses this node's member. A machine segment must
 * be this host; an agent segment must match the calling agent when one is given.
 */
export function addressedTo(to: string, me: { handle: string; hostname: string; agent?: string }): boolean {
  const a = parseAddress(to);
  if (a.handle !== me.handle) return false;
  // Cloud aliases are assigned-card guests, with no ask inbox or answer authority.
  if (a.machine === "cloud") return false;
  if (a.machine && a.machine !== me.hostname) return false;
  if (a.agent && me.agent && a.agent !== me.agent) return false;
  return true;
}

/**
 * Whether an address names a Hermes agent: `@handle/machine/agent`, where that person's machine of that hostname shows a card under
 * that agent name that is a Hermes session's. Hermes is view only and has no inbox, so an ask to it would sit unanswered until it
 * expired. An address with no agent segment (a person, a machine) names none, whatever runs there.
 */
export function namesHermesAgent(core: Core, to: ParsedAddress): boolean {
  if (!to.machine || !to.agent) return false;
  for (const node of core.roster.nodes.values()) {
    if (node.hostname !== to.machine || nodeMember(core.roster, node.node_id)?.handle !== to.handle) continue;
    const row = core.store.agent(node.node_id, to.agent);
    if (row && isHermesStatus(JSON.parse(row.body) as BodyOf<"agent.status">)) return true;
  }
  return false;
}

export function getAskView(core: Core, id: string): AskView {
  const row = core.store.getRow(id);
  if (!row || row.kind !== "ask" || row.redacted === 1 || row.status !== "ok") throw new HttpError(404, "not_found", "no such ask");
  const view = askView(core, row);
  if (!core.visible(view.ask)) throw new HttpError(404, "not_found", "no such ask");
  return view;
}

/** Resolves when the ask leaves "open", the wait elapses, or the ask expires. */
export function waitForAsk(core: Core, id: string, waitS: number, signal?: AbortSignal): Promise<AskView> {
  const initial = getAskView(core, id);
  if (initial.state !== "open" || waitS <= 0) return Promise.resolve(initial);
  const expiresIn = initial.expires_at - Date.now();
  const ms = Math.max(0, Math.min(Math.min(waitS, MAX_WAIT_S) * 1000, expiresIn + 5));
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      try { resolve(getAskView(core, id)); } catch { resolve(initial); }
    };
    const timer = setTimeout(finish, ms);
    const unsubscribe = core.hub.subscribe((ev: Event) => {
      if (ev.kind === "answer" && (ev.body as { ask?: string }).ask === id) finish();
    });
    signal?.addEventListener("abort", finish, { once: true });
  });
}
