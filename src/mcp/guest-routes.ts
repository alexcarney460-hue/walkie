// Person-only local administration. A token is shown once at issue; it never enters the team event log.
import { z } from "zod";
import type { Core } from "../daemon/core.ts";
import { personOnly } from "../daemon/admin/gate.ts";
import { HttpError, json, parseWith, readJson } from "../daemon/http.ts";
import { limitWrite, requireTeam, route, type RouteCtx } from "../daemon/local-routes.ts";
import type { GuestData } from "./guest-scope.ts";
import { GUEST_TOOLS, guestEligible } from "./guest-scope.ts";
import { grantGuest } from "./guest-admin.ts";
import { GuestRegistry } from "./guest-registry.ts";

function offline(c: RouteCtx, agent: string, family: "dots" | "grokbot"): void {
  c.core.statuses.submitFinal(agent, { agent, state: "offline", runtime: "other", runtime_name: family,
    title: "Walkie access revoked", activity: "Access revoked by owner", ask_policy: "off" },
  { title: "person", activity: "phrase" });
}

const registered = new WeakMap<Core, { registry: GuestRegistry; data: GuestData }>();
export function registerGuests(core: Core, registry: GuestRegistry, data: GuestData): void { registered.set(core, { registry, data }); }
function service(c: RouteCtx) {
  personOnly(c, "manage cloud guests");
  if (c.via === "phone") throw new HttpError(403, "forbidden", "guest credentials are managed on this machine");
  requireTeam(c);
  const found = registered.get(c.core);
  if (!found || !c.core.myHandle()) throw new HttpError(503, "unavailable", "guest registry unavailable");
  return found;
}

const GrantReq = z.object({
  family: z.enum(["dots", "grokbot"]), name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,32}$/),
  subject: z.string().min(1).max(200),
  cardIds: z.array(z.string().regex(/^[0-9a-f]{16}:[1-9][0-9]*$/)).min(1).max(32),
  tools: z.array(z.string().refine((v) => GUEST_TOOLS.includes(v))).min(1).max(16),
  ttlMs: z.number().int().min(1_000).max(3_600_000),
}).strict();

route("GET", "/v1/guests", (c) => {
  const { registry, data } = service(c);
  const guests = registry.list().map((guest) => ({ ...guest, lastReportAt: c.core.store.agent(c.core.nodeId, guest.agent)?.ts ?? null,
    cards: guest.cardIds.flatMap((id) => {
    const card = data.card(id);
    if (!card || !guestEligible(guest, card, data.project(card.channel))) return [];
    return [{ id, key: card.key }];
  }) }));
  return json({ guests, killed: registry.killed() });
});
route("GET", "/v1/guests/audit", (c) => {
  const { registry } = service(c);
  return json({ audit: registry.audit().slice(-200) });
});
route("POST", "/v1/guests", async (c) => {
  const { registry, data } = service(c);
  const req = parseWith(GrantReq, await readJson(c.req, 16_384));
  limitWrite(c);
  try {
    const { ttlMs, ...grant } = req;
    return json(grantGuest(registry, data, c.core.myHandle() as string, c.core.nodeId, grant, ttlMs), 201);
  } catch {
    throw new HttpError(403, "forbidden", "guest grant is not allowed for the supplied assignment");
  }
});
route("POST", /^\/v1\/guests\/([a-z0-9-]+)\/revoke$/, (c, [agent]) => {
  const { registry } = service(c);
  limitWrite(c);
  const guest = registry.list().find((row) => row.id === `${c.core.nodeId}/${agent}`);
  if (!guest) throw new HttpError(404, "not_found", "no such guest");
  registry.revoke(guest.id);
  offline(c, guest.agent, guest.family);
  return json({ revoked: true });
});
route("POST", "/v1/guests/kill", async (c) => {
  const { registry } = service(c);
  const req = parseWith(z.object({ killed: z.boolean() }).strict(), await readJson(c.req, 1_024));
  limitWrite(c);
  registry.killAll(req.killed);
  if (req.killed) for (const guest of registry.list()) if (!guest.revoked) offline(c, guest.agent, guest.family);
  return json({ killed: registry.killed() });
});
