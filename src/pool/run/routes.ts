// Local API routes for split runs (WALKIE-POOL-2, PROTOCOL §5). Imported by the daemon for its side effect of
// registering routes. Reading the state is open to every local caller; sharing this machine and starting or stopping
// a run are for people only: an X-Walkie-Agent header is refused (403), like invites and integrations.
import { adminGate } from "../../daemon/admin/gate.ts";
import { z } from "zod";
import { HttpError, json, parseWith, readJson } from "../../daemon/http.ts";
import { LOCAL_BODY_MAX, limitWrite, requireTeam, route, type RouteCtx } from "../../daemon/local-routes.ts";
import { nodesView } from "../../daemon/views.ts";
import { RunError } from "./runner.ts";
import type { PoolService } from "./service.ts";

function pool(c: RouteCtx): PoolService {
  if (!c.core.pool) throw new HttpError(404, "not_found", "split runs are not available on this daemon");
  return c.core.pool;
}


route("GET", "/v1/pool", (c) => json(pool(c).view()));

const ShareReq = z.object({ on: z.boolean(), max_gb: z.number().positive().max(16_384).nullable().optional() }).strict();
route("POST", "/v1/pool/share", async (c) => {
  limitWrite(c);
  const b = parseWith(ShareReq, await readJson(c.req, LOCAL_BODY_MAX));
  adminGate(c, `turned pool sharing ${b.on ? "on" : "off"}${b.max_gb ? ` (max ${b.max_gb} GB)` : ""}`);
  await pool(c).setShare(b.on, b.max_gb);
  return json(pool(c).view());
});

const RunReq = z.object({
  model: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,48}$/).optional(),
  quant: z.enum(["q4", "q8"]).optional(),
  file: z.string().min(1).max(4096).startsWith("/").optional(),
  machines: z.array(z.string().min(1).max(120)).max(16).optional(),
}).strict().refine((b) => !!b.model !== !!b.file, { message: "give model or file" });

route("POST", "/v1/pool/run", async (c) => {
  adminGate(c, "started a split run");
  requireTeam(c);
  limitWrite(c);
  const b = parseWith(RunReq, await readJson(c.req, LOCAL_BODY_MAX));
  try {
    const run = pool(c).runner.start({
      ...(b.model ? { model: b.model } : {}), ...(b.quant ? { quant: b.quant } : {}), ...(b.file ? { file: b.file } : {}),
      ...(b.machines ? { machines: b.machines } : {}),
    }, nodesView(c.core, c.sync));
    return json({ run }, 202);
  } catch (err) {
    if (err instanceof RunError) throw new HttpError(err.status, err.code, err.message);
    throw err;
  }
});

route("POST", "/v1/pool/stop", async (c) => {
  adminGate(c, "stopped a split run");
  limitWrite(c);
  return json({ run: await pool(c).runner.stop() });
});
