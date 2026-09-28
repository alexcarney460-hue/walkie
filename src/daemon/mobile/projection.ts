// What a phone is shown (WALKIE-PWA-1): phone-specific projections of the local API's answers. The allow-list in
// tunnel.ts decides which routes a phone may call; this decides which fields leave the daemon. Built from an
// allow-list of fields (never a copy with fields removed), so a field added to a view later stays on the computer
// until it is added here on purpose. Never on the phone: the plan, license or billing data, account data, Tailscale
// logins and addresses, sync internals, signatures, and any event kind but posts, asks and answers.

/** Event kinds a phone receives, in lists, detail, asks and the live stream. */
export const PHONE_EVENT_KINDS: ReadonlySet<string> = new Set(["msg.post", "ask", "answer"]);

type Obj = Record<string, unknown>;
import { cutText } from "../views.ts";

const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const pick = (o: Obj, keys: readonly string[]): Obj => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

const BODY_FIELDS: Record<string, readonly string[]> = {
  "msg.post": ["text", "thread", "mentions"],
  ask: ["to", "text", "expires_at"],
  answer: ["ask", "text", "declined"],
};

/** Text longer than this is cut for the phone (lists then always fit the phone link's response cap). */
export const PHONE_TEXT_MAX = 4_000;
export const PHONE_TEXT_MORE = "… (open on your computer for the rest)";

/** An event a phone may see, reduced to what the app renders; null for any other kind. */
export function phoneEvent(v: unknown): Obj | null {
  const e = obj(v);
  if (!e || typeof e.kind !== "string" || !PHONE_EVENT_KINDS.has(e.kind)) return null;
  const author = obj(e.author);
  const body = pick(obj(e.body) ?? {}, BODY_FIELDS[e.kind] ?? []);
  // Cut here, never between the two halves of a surrogate pair (an emoji would become a lone, invalid half). The marker
  // is set only when this projection cut the text: a body's own `truncated` field is never passed on or trusted (the
  // tunnel asks the local API to cut open asks a little past PHONE_TEXT_MAX, so those are cut again, and marked, here).
  const cut = typeof body.text === "string" ? cutText(body.text, PHONE_TEXT_MAX) : null;
  if (cut !== null) {
    body.text = cut + PHONE_TEXT_MORE;
    body.truncated = true;
  }
  return {
    ...pick(e, ["id", "origin", "seq", "ts", "kind", "channel"]),
    author: author ? pick(author, ["handle", "node", "agent"]) : null,
    body,
  };
}

const events = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(phoneEvent).filter((e): e is Obj => e !== null) : []);

function me(v: unknown): Obj | null {
  const m = obj(v);
  if (!m) return null;
  const team = obj(m.team);
  const node = obj(m.node);
  return {
    ...pick(m, ["version", "handle", "role"]),
    team: team ? pick(team, ["id", "name"]) : null,
    node: node ? pick(node, ["id", "hostname"]) : null,
  };
}

function node(v: unknown): Obj | null {
  const n = obj(v);
  return n ? pick(n, ["node_id", "handle", "hostname", "online", "last_seen", "self", "stats"]) : null;
}

const nodes = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(node).filter((n): n is Obj => n !== null) : []);

function team(v: unknown): Obj | null {
  const t = obj(v);
  if (!t) return null;
  const members = Array.isArray(t.members) ? t.members.map((m) => obj(m)).filter((m): m is Obj => m !== null).map((m) => pick(m, ["handle", "display_name", "role"])) : [];
  const channels = Array.isArray(t.channels) ? t.channels.map((c) => obj(c)).filter((c): c is Obj => c !== null).map((c) => pick(c, ["name", "topic", "members", "archived", "last_ts", "count"])) : [];
  return { ...pick(t, ["id", "name"]), members, channels, nodes: nodes(t.nodes) };
}

function ask(v: unknown): Obj | null {
  const a = obj(v);
  const ev = a ? phoneEvent(a.ask) : null;
  if (!a || !ev) return null;
  return { ask: ev, answers: events(a.answers), ...pick(a, ["state", "expires_at"]) };
}

function agent(v: unknown): Obj | null {
  const a = obj(v);
  if (!a) return null;
  const st = obj(a.status) ?? {};
  return {
    ...pick(a, ["id", "handle", "node", "hostname", "agent", "updated_at", "machine_online", "effective_state"]),
    status: pick(st, ["agent", "state", "runtime", "title", "task", "activity", "started_at"]),
  };
}

const agents = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(agent).filter((a): a is Obj => a !== null) : []);

/** A successful answer from an allowed route, projected for the phone (errors pass as `{error:{code,message}}`). */
export function projectResponse(path: string, status: number, body: unknown): unknown {
  const b = obj(body);
  if (status < 200 || status >= 300) {
    const e = b ? obj(b.error) : null;
    return { error: e ? pick(e, ["code", "message"]) : { code: `http_${status}`, message: "request failed" } };
  }
  if (!b) return null;
  if (path === "/v1/me") return me(b);
  if (path === "/v1/team") return team(b);
  if (path === "/v1/agents") return { agents: agents(b.agents) };
  if (path === "/v1/peers") return { nodes: nodes(b.nodes) };
  if (path === "/v1/events") return { events: events(b.events) };
  if (path === "/v1/asks") return { asks: (Array.isArray(b.asks) ? b.asks : []).map(ask).filter((a): a is Obj => a !== null) };
  if (path.startsWith("/v1/events/")) {
    const ev = phoneEvent(b.event);
    return ev ? { event: ev, replies: events(b.replies) } : { error: { code: "not_found", message: "no such event" } };
  }
  if (path === "/v1/post" || path === "/v1/answer") {
    const ev = phoneEvent(b.event);
    return { event: ev, ...(Array.isArray(b.redactions) ? { redactions: b.redactions.filter((r) => typeof r === "string") } : {}) };
  }
  return null;
}

/** The status a projected answer carries (an event detail of a kind the phone may not see is a 404). */
export function projectedStatus(path: string, status: number, body: unknown): number {
  if (status === 200 && path.startsWith("/v1/events/") && !phoneEvent(obj(body)?.event)) return 404;
  return status;
}

/**
 * A live-stream message projected for the phone; null drops it. Roster events (team.*, channel.upsert) never reach
 * the phone as events, but a sanitized `refresh` notice does ({what: "team" | "channels"}), so the app reloads its
 * team and channel views instead of going stale.
 */
export function projectStream(type: string, data: unknown): { type: string; data: unknown } | null {
  const d = obj(data);
  if (!d) return null;
  switch (type) {
    case "hello": return { type, data: { me: me(d.me) } };
    case "event": {
      const e = obj(d.event);
      const kind = typeof e?.kind === "string" ? e.kind : "";
      if (kind === "channel.upsert") return { type: "refresh", data: { what: "channels" } };
      if (kind.startsWith("team.")) return { type: "refresh", data: { what: "team" } };
      const ev = phoneEvent(e);
      return ev ? { type, data: { event: ev } } : null;
    }
    case "agents": return { type, data: { agents: agents(d.agents) } };
    case "nodes": return { type, data: { nodes: nodes(d.nodes) } };
    case "hidden": return { type, data: { ids: Array.isArray(d.ids) ? d.ids.filter((i) => typeof i === "string") : [] } };
    default: return null;
  }
}
