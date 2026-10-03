// Local routes for `walkie team offboard` (WALK-72 phase 0). Not a dashboard route and not a phone route:
// the same person-only gate as removing a member. Registered by importing this module from the daemon.
import { z } from "zod";
import { personOnly } from "./admin/gate.ts";
import { HttpError, json, parseWith, readJson } from "./http.ts";
import { LOCAL_BODY_MAX, route, type RouteCtx } from "./local-routes.ts";
import { Handle } from "../protocol/schemas.ts";
import { applyOffboard, offboardPlan } from "./offboard.ts";

function guard(c: RouteCtx): void {
  if (!c.core.teamId) throw new HttpError(409, "no_team", "not in a team yet (run: walkie init <name> --handle <you> or walkie join <peer>)");
  if (c.core.me()?.role !== "owner") throw new HttpError(403, "forbidden", "owner role required");
  if (c.via === "phone") throw new HttpError(403, "person_only", "offboard a teammate at this machine's terminal (walkie team offboard)");
  // The dashboard cannot call this route, so the refusal names the terminal only. Other person-only actions keep
  // the shared sentence (a person, in the dashboard or in their own terminal).
  personOnly(c, "offboard a teammate", "at this machine's terminal (walkie team offboard)");
}

function parseHandle(raw: string): string {
  const handle = raw.trim().replace(/^@/, "");
  if (handle.includes("/")) throw new HttpError(400, "invalid", "offboard a person (@handle), not a machine or an agent");
  if (!Handle.safeParse(handle).success) throw new HttpError(400, "invalid", "handle must be a short name such as noor");
  return handle;
}

route("GET", "/v1/team/offboard/plan", (c) => {
  guard(c);
  return json(offboardPlan(c, parseHandle(c.url.searchParams.get("handle") ?? "")));
});

const ApplyReq = z.object({
  handle: z.string().min(1).max(80),
  reassign_to: z.string().min(1).max(80).optional(),
}).strict();

route("POST", "/v1/team/offboard", async (c) => {
  guard(c);
  const body = parseWith(ApplyReq, await readJson(c.req, LOCAL_BODY_MAX));
  return json(await applyOffboard(c, parseHandle(body.handle), body.reassign_to));
});
