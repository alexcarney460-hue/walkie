// Local API routes of the Linear import (LINEAR-IMPORT-1, PROTOCOL §5 "Linear import"). Registered through the
// integrations wrapper, so every response and error is scrubbed of configured keys and secret-shaped tokens; the
// service scrubs the operation's own key too. A dry run (plan) and the status are for anyone local, agents included;
// everything that writes (run, resume, cancel, sync, settings) is for people only.
import { z } from "zod";
import { join } from "node:path";
import { HttpError, json, parseWith, readJson } from "../../daemon/http.ts";
import { LOCAL_BODY_MAX, requireTeam, type RouteCtx } from "../../daemon/local-routes.ts";
import { requirePerson } from "../../daemon/projects/service.ts";
import { integrationRoute as route } from "../routes.ts";
import { expandKeyPath } from "../secrets.ts";
import { PlanOptions, Selection } from "./plan.ts";
import type { LinearImportService } from "./service.ts";

const Key = {
  /** LINEAR_API_KEY as the CLI read it (never stored, never returned). */
  key: z.string().min(1).max(1024).optional(),
  /** A key file path (checked like an integration's key_path). */
  key_file: z.string().min(1).max(1024).optional(),
};
const PlanReq = z.object({ options: PlanOptions, ...Key }).strict();
const RunReq = z.object({ selection: Selection, ...Key }).strict();
const KeyReq = z.object({ ...Key }).strict();
const SyncReq = z.object({ two_way: z.boolean().optional(), ...Key }).strict();
const SettingsReq = z.object({
  enabled: z.boolean().optional(), two_way: z.boolean().optional(), interval_min: z.number().int().min(2).max(1_440).optional(),
  key_file: z.string().min(1).max(1024).nullable().optional(),
}).strict();

/** A selection lists up to 20 000 unticked issue ids per project. */
const RUN_BODY_MAX = 4 * 1024 * 1024;
/** Workspace-wide: switching agent names or local transports must not multiply upstream read budgets. */
const PLAN_LIMIT = { capacity: 10, perSecond: 1 / 60 };

function checkPlanAccess(c: RouteCtx, keyFile?: string): void {
  if ((c.agent || c.underAgent) && keyFile) {
    const configured = c.integrations?.manager.settings("linear").key_path ?? join(c.core.paths.home, "secrets", "linear");
    let allowed = false;
    try { allowed = expandKeyPath(keyFile) === expandKeyPath(configured); } catch { /* refuse invalid paths too */ }
    if (!allowed) throw new HttpError(403, "forbidden", "agents may only use the Linear integration's own key file for a dry run");
  }
  if (!c.core.limiter.take("linear-import:plan", PLAN_LIMIT)) {
    throw new HttpError(429, "rate_limited", "too many Linear dry runs; retry in 60 s", { retry_after_s: 60 });
  }
}

function svc(c: RouteCtx): LinearImportService {
  requireTeam(c);
  const s = c.integrations?.linearImport;
  if (!s) throw new HttpError(404, "not_found", "the Linear import is not available on this daemon");
  return s;
}

function person(c: RouteCtx, what: string): void {
  requirePerson({ ...(c.agent ? { agent: c.agent } : {}), ...(c.underAgent ? { underAgent: true } : {}) }, what);
}

route("POST", "/v1/import/linear/plan", async (c) => {
  const s = svc(c);
  const b = parseWith(PlanReq, await readJson(c.req, LOCAL_BODY_MAX));
  checkPlanAccess(c, b.key_file);
  c.noTimeout();
  return json({ plan: await s.plan(b.options, { ...(b.key ? { key: b.key } : {}), ...(b.key_file ? { key_file: b.key_file } : {}) }) });
});

route("POST", "/v1/import/linear/run", async (c) => {
  const s = svc(c);
  person(c, "importing from Linear");
  const b = parseWith(RunReq, await readJson(c.req, RUN_BODY_MAX));
  return json({ job: s.startRun(b.selection, { ...(b.key ? { key: b.key } : {}), ...(b.key_file ? { key_file: b.key_file } : {}) }) }, 202);
});

route("POST", "/v1/import/linear/resume", async (c) => {
  const s = svc(c);
  person(c, "importing from Linear");
  const b = parseWith(KeyReq, await readJson(c.req, LOCAL_BODY_MAX));
  return json({ job: s.resume({ ...(b.key ? { key: b.key } : {}), ...(b.key_file ? { key_file: b.key_file } : {}) }) }, 202);
});

route("POST", "/v1/import/linear/cancel", async (c) => {
  const s = svc(c);
  person(c, "cancelling a Linear import");
  parseWith(z.object({}).strict(), await readJson(c.req, LOCAL_BODY_MAX));
  return json({ job: s.cancel() });
});

route("GET", "/v1/import/linear/status", (c) => json(svc(c).status()));

route("POST", "/v1/import/linear/sync", async (c) => {
  const s = svc(c);
  person(c, "syncing with Linear");
  const b = parseWith(SyncReq, await readJson(c.req, LOCAL_BODY_MAX));
  c.noTimeout();
  return json({ result: await s.syncOnce({ ...(b.two_way !== undefined ? { two_way: b.two_way } : {}) }, { ...(b.key ? { key: b.key } : {}), ...(b.key_file ? { key_file: b.key_file } : {}) }) });
});

route("POST", "/v1/import/linear/settings", async (c) => {
  const s = svc(c);
  person(c, "changing the Linear sync");
  const b = parseWith(SettingsReq, await readJson(c.req, LOCAL_BODY_MAX));
  return json({ sync: s.settings(b) });
});
