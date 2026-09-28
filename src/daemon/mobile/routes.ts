// Local API routes for Walkie on your phone (PROTOCOL §5, WALKIE-PWA-1). Imported by the daemon for its side effect
// of registering routes. People only (an X-Walkie-Agent or X-Walkie-Under-Agent header is refused). A desktop dashboard session may read the
// status, open a pairing and revoke one device (local-api.ts DASHBOARD_ROUTES); revoking every device is CLI only.
// The phone itself reaches none of these: its requests run through tunnel.ts's allow-list.
import { HttpError, json } from "../http.ts";
import { route, type RouteCtx } from "../local-routes.ts";
import type { MobileManager } from "./manager.ts";
import { adminGate, adminRead, personOnly } from "../admin/gate.ts";

function need(c: RouteCtx): MobileManager {
  if (!c.mobile) throw new HttpError(404, "not_found", "Walkie on your phone is not available on this daemon");
  return c.mobile;
}

route("GET", "/v1/mobile", (c) => { adminRead(c); return json(need(c).status()); });

// A pairing code is a credential handed out in plain text (AGENT-ADMIN-1 §3): a person's, never an agent's.
route("POST", "/v1/mobile/pair", async (c) => { personOnly(c, "pair a phone (the pairing code is a credential)"); return json(await need(c).pair()); });

route("DELETE", /^\/v1\/mobile\/devices\/([0-9a-f]{12})$/, async (c, [id]) => {
  adminGate(c, `signed out the paired phone ${id}`);
  const m = need(c);
  if (!(await m.revoke(id as string))) throw new HttpError(404, "not_found", "no such device");
  return json({ revoked: true });
});

route("DELETE", "/v1/mobile/devices", async (c) => { adminGate(c, "signed out every paired phone"); return json({ revoked: await need(c).revokeAll() }); });
