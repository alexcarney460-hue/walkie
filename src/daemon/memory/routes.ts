// Local personal-memory routes. Not on the dashboard session allow-list, the phone allow-list, or remote admin.
// The handler refuses a dashboard session and a phone on read and on write. A scheduled WalkieTalkie turn is
// refused on read here (its writes are already refused for every route before dispatch). This person and their
// own agents can read and write. Nothing is emitted.
import { z } from "zod";
import { ORCHESTRATOR_AGENT } from "../../protocol/orchestrator.ts";
import { HttpError, json, parseWith, readJson } from "../http.ts";
import { limitWrite, route, scheduledChild, validAgentHeader, type RouteCtx } from "../local-routes.ts";
import { hostFor } from "../orchestrator/host.ts";
import { MemoryStore } from "./store.ts";
import { MEMORY_LIST_DEFAULT, MEMORY_LIST_MAX, MEMORY_QUERY_MAX, MEMORY_SOURCES_MAX, MemoryError } from "./text.ts";

const AddBody = z.object({
  kind: z.string().optional(),
  text: z.string(),
  sources: z.array(z.string()).max(MEMORY_SOURCES_MAX).optional(),
}).strict();

const RetractBody = z.object({
  id: z.string(),
}).strict();

function actorOf(c: RouteCtx, write: boolean): string {
  if (c.via === "phone") throw new HttpError(403, "forbidden", "personal memory stays on this machine");
  if (c.dashboard) {
    throw new HttpError(403, "forbidden", write
      ? "the dashboard cannot change personal memory; use the terminal (walkie memory)"
      : "the dashboard cannot read personal memory; use the terminal (walkie memory)");
  }
  // Writes never reach here while a scheduled turn is held (dispatch refuses them). Reads would, and the child can still post.
  if (!write && scheduledChild(c)) throw new HttpError(403, "scheduled_turn_cannot_act", "a scheduled WalkieTalkie turn cannot read personal memory");
  if (c.agent !== undefined) validAgentHeader(c.agent);
  if (c.agent === ORCHESTRATOR_AGENT && !hostFor(c.core)?.acceptsToken(c.orchestratorToken)) {
    throw new HttpError(403, "forbidden", "the agent name \"orchestrator\" is reserved for this machine's orchestrator host");
  }
  if (write) limitWrite(c);
  if (c.agent) return c.agent;
  if (c.underAgent) return "agent";
  return "person";
}

function limitOf(c: RouteCtx): number {
  const raw = c.url.searchParams.get("limit");
  if (raw === null) return MEMORY_LIST_DEFAULT;
  if (!/^[1-9]\d*$/.test(raw) || Number(raw) > MEMORY_LIST_MAX) throw new HttpError(400, "invalid", `limit must be 1..${MEMORY_LIST_MAX}`);
  return Number(raw);
}

function allOf(c: RouteCtx): boolean {
  const raw = c.url.searchParams.get("all");
  if (raw === null) return false;
  if (raw === "1" || raw === "true") return true;
  throw new HttpError(400, "invalid", "all must be 1 or true");
}

function useStore<T>(home: string, fn: (store: MemoryStore) => T): T {
  let store: MemoryStore | undefined;
  try {
    store = MemoryStore.open(home);
    return fn(store);
  } catch (err) {
    if (err instanceof MemoryError) {
      const status = err.code === "not_found" ? 404 : err.code === "full" ? 409 : 400;
      throw new HttpError(status, err.code, err.message);
    }
    throw err;
  } finally {
    store?.close();
  }
}

route("GET", "/v1/memory", (c) => {
  actorOf(c, false);
  if (c.url.searchParams.has("scope")) throw new HttpError(400, "invalid", "personal memory has no team or org scope");
  const limit = limitOf(c);
  const all = allOf(c);
  const rawQ = c.url.searchParams.get("q") ?? "";
  // A NUL survives URL decoding. SQLite would treat it as the end of the string and the pattern would match every note.
  if (rawQ.includes("\0")) throw new HttpError(400, "invalid", "a search cannot contain a NUL character");
  const q = rawQ.trim();
  if (q.length > MEMORY_QUERY_MAX) throw new HttpError(400, "invalid", `a search is at most ${MEMORY_QUERY_MAX} characters`);
  const entries = useStore(c.core.paths.home, (store) => (q ? store.search(q, limit) : store.list({ limit, includeRetracted: all })));
  return json({ entries });
});

route("POST", "/v1/memory", async (c) => {
  const actor = actorOf(c, true);
  const body = parseWith(AddBody, await readJson(c.req, 64 * 1024));
  const entry = useStore(c.core.paths.home, (store) => store.add({ kind: body.kind, text: body.text, sources: body.sources, actor }));
  return json({ entry });
});

route("POST", "/v1/memory/retract", async (c) => {
  actorOf(c, true);
  const body = parseWith(RetractBody, await readJson(c.req, 1024));
  const entry = useStore(c.core.paths.home, (store) => store.retract(body.id));
  return json({ entry });
});
