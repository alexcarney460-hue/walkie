// A throwaway team for the recommendation tests: alex (owner, creator, roster authority and the lead) on a real Core with a board
// index and a few projects, and members whose own daemons receive what alex's writes, so what each person SEES is the platform's
// own channel rules at work, not a fake. The clock is the mocked Date.now of reportsWorld.
import type { Core } from "../../src/daemon/core.ts";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { ProjectsIndex } from "../../src/daemon/projects/index.ts";
import { forgetRecs, type RecDeps } from "../../src/daemon/orchestrator/recs.ts";
import { recKey, REC_TTL_MS, type NewRec } from "../../src/protocol/talkie-recs.ts";
import type { CardView, ProjectView } from "../../src/protocol/projects/schema.ts";
import { makeCore } from "./core.ts";
import { tnode } from "./events.ts";
import { reportsWorld } from "./project-reports.ts";

export const NODE = "fedcba9876543210";

export function recsWorld(cleanups: (() => void)[]) {
  const t = reportsWorld(cleanups);
  const deps: RecDeps = { core: t.core, idx: t.idx, now: () => Date.now() };

  /** A person with a daemon of their own, in the team with `role`: it receives every event alex's daemon holds (`mirror`), as replication would deliver them. */
  function person(handle: string, role: "member" | "observer" | "owner" = "member") {
    const node = tnode(handle);
    t.core.emit("team.member", { login: node.login, handle, role });
    t.core.emit("team.node", { node_id: node.keys.nodeId, login: node.login, hostname: node.hostname, pubkey: node.keys.pubkey, ip: "127.0.0.1" });
    const core: Core = makeCore(node, t.team, cleanups, { clock: () => Date.now() });
    const idx = new ProjectsIndex(core, core.log);
    cleanups.push(() => idx.stop());
    core.onPostChange = (e, change) => idx.onPost(e, change);
    core.onRosterChange = () => idx.rosterChanged();
    // The roster (who is a member, which channels are restricted) arrives before the posts, as it does when a machine syncs.
    const mirror = (): void => {
      const rows = t.core.store.db.query<{ json: string }, []>(
        `SELECT json FROM events WHERE redacted = 0 AND status = 'ok'
         ORDER BY kind IN ('team.create','team.member','team.node','channel.upsert','team.authority','team.license','team.integration') DESC, origin, seq`).all();
      for (const row of rows) core.ingest(JSON.parse(row.json), "remote");
      idx.flushAll();
      forgetRecs(core);
    };
    /** What this person's daemon wrote reaches alex's daemon. */
    const push = (): void => {
      const rows = core.store.db.query<{ json: string }, [string]>("SELECT json FROM events WHERE origin = ? AND redacted = 0 AND status = 'ok' ORDER BY seq").all(node.keys.nodeId);
      for (const row of rows) t.core.ingest(JSON.parse(row.json), "remote");
      t.idx.flushAll();
      forgetRecs(t.core);
    };
    mirror();
    const memberDeps: RecDeps = { core, idx, now: () => Date.now() };
    return { node, core, idx, mirror, push, deps: memberDeps };
  }

  /** A valid move recommendation for `card` (to `to`), keyed as the curation keys it; `over` replaces fields. */
  const moveRec = (card: CardView, over: Partial<NewRec> = {}, to = "review"): NewRec => ({
    key: recKey.move(card.id, to), group: "moves", source: "curation", audience: "team",
    action: { kind: "move_card", card: card.id, from: card.column, to },
    summary: `Move “${card.title}” to ${to}`, reason: "The work is ready and nobody is building it.", evidence: ["its branch has 3 commits"], ttl_ms: REC_TTL_MS, ...over,
  });
  const seatRec = (card: CardView, machine = NODE, over: Partial<NewRec> = {}): NewRec => ({
    key: recKey.seat(card.id, "builder"), group: "work", source: "poll", audience: "team",
    action: { kind: "start_seat", machine, runtime: "claude", role: "builder", card: card.id },
    summary: `Start a builder on mac-a for “${card.title}”`, reason: "mac-a has a free seat.", evidence: [], ttl_ms: REC_TTL_MS, ...over,
  });
  /** A recommendation for the owners about a project (what a private project or a confidential card makes). */
  const ownersRec = (project: ProjectView, card: CardView): NewRec => moveRec(card, { audience: "owners", project: project.channel });

  return { ...t, deps, person, moveRec, seatRec, ownersRec };
}

export type RecsWorld = ReturnType<typeof recsWorld>;

/** What a request to one person's daemon looks like: its core and board index, a terminal's socket unless `over` says otherwise (an agent, a phone, a dashboard). */
export function requester(who: { core: Core; idx: ProjectsIndex }, over: Record<string, unknown> = {}) {
  return (method: string, path: string, body?: unknown) => {
    const req = new Request(`http://localhost${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return dispatch({
      core: who.core, sync: { requestCatchUp: async () => {}, isOnline: () => true }, client: {}, projects: who.idx, req, url: new URL(req.url),
      via: "cli", listener: "unix", noTimeout: () => {}, ...over,
    } as unknown as RouteCtx);
  };
}

/** The JSON of a response, or the error a refused request threw as { status, code }. */
export async function outcome(p: Promise<Response>): Promise<{ status: number; code?: string; message?: string; body?: any }> {
  try {
    const res = await p;
    return { status: res.status, body: await res.json() };
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    return { status: e.status ?? 500, ...(e.code ? { code: e.code } : {}), message: e.message };
  }
}

/**
 * Approves the way a person's dashboard or terminal does: it lists the recommendation (as the same requester) and approves
 * echoing the `outgoing` text that list showed, so the daemon can refuse it if what it would do now differs.
 */
export async function approveShown(req: ReturnType<typeof requester>, id: string, body: Record<string, unknown> = {}): Promise<Response> {
  let shown: unknown;
  try {
    const list = await (await req("GET", "/v1/talkie/recs?status=all")).json() as { recs?: Array<{ id: string; short: string; outgoing?: unknown }> };
    shown = list.recs?.find((r) => r.id === id || r.short === id)?.outgoing;
  } catch { shown = undefined; }
  return req("POST", `/v1/talkie/recs/${encodeURIComponent(id)}/approve`, { ...body, ...(typeof shown === "string" ? { seen: shown } : {}) });
}
