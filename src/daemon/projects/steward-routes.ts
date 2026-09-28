// FO-6 board steward: local API routes. Imported by the daemon for its side effect of registering them.
//   POST /v1/steward/run     {project, dry_run?, repos?, stale_hours?}: plan, and unless dry make, the steward's moves
//                            (making them: people only; an agent gets dry runs)
//   GET  /v1/steward         this machine's steward settings
//   POST /v1/steward/config  {auto?, interval_min?, stale_hours?, repos?}: people only (config.json)
import { z } from "zod";
import { saveConfigField, StewardConfig } from "../config.ts";
import { HttpError, json, parseWith, readJson } from "../http.ts";
import { LOCAL_BODY_MAX, limitWrite, requireTeam, route, type RouteCtx } from "../local-routes.ts";
import { requirePerson } from "./service.ts";
import { runSteward, stewardConfig, type StewardDeps } from "./steward-run.ts";

const RunReq = z.object({
  project: z.string().min(1).max(60),
  dry_run: z.boolean().optional(),
  repos: z.array(z.string().min(1).max(1_000)).max(10).optional(),
  stale_hours: z.number().int().min(1).max(720).optional(),
}).strict();

const ConfigReq = z.object({
  auto: z.boolean().optional(),
  interval_min: z.number().int().min(5).max(1_440).optional(),
  stale_hours: z.number().int().min(1).max(720).optional(),
  /** Per project prefix; an empty list removes the prefix. */
  repos: z.record(z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/), z.array(z.string().min(1).max(1_000)).max(10)).optional(),
}).strict();

function deps(c: RouteCtx): StewardDeps {
  requireTeam(c);
  if (!c.projects) throw new HttpError(404, "not_found", "projects are not available on this daemon");
  return {
    core: c.core, idx: c.projects, sync: c.sync, client: c.client, catchUp: c.sync.requestCatchUp,
    ...(c.integrations ? { linear: c.integrations.linear } : {}),
  };
}

route("POST", "/v1/steward/run", async (c) => {
  const d = deps(c);
  const b = parseWith(RunReq, await readJson(c.req, LOCAL_BODY_MAX));
  // Moves are made by a person's request, this machine's auto loop, or the fleet desk in process (FLEET_AGENT is
  // reserved like `steward`, so no request carries it); an agent may only look (fix round 2, Opus HIGH 2).
  if (!b.dry_run) {
    requirePerson({ ...(c.agent ? { agent: c.agent } : {}), ...(c.underAgent ? { underAgent: true } : {}) }, "a board steward run that moves cards (agents: --dry-run)");
    limitWrite(c);
  }
  return json(await runSteward(d, b.project, {
    dryRun: b.dry_run === true, ...(b.repos ? { repos: b.repos } : {}), ...(b.stale_hours ? { staleHours: b.stale_hours } : {}),
    caller: c.agent || c.underAgent ? "agent" : "person",
  }));
});

route("GET", "/v1/steward", (c) => {
  deps(c);
  return json({ config: stewardConfig(c.core), node: c.core.nodeId });
});

route("POST", "/v1/steward/config", async (c) => {
  deps(c);
  requirePerson({ ...(c.agent ? { agent: c.agent } : {}), ...(c.underAgent ? { underAgent: true } : {}) }, "changing this machine's board steward");
  const b = parseWith(ConfigReq, await readJson(c.req, LOCAL_BODY_MAX));
  limitWrite(c);
  const cur = stewardConfig(c.core);
  const repos = { ...(cur.repos ?? {}), ...(b.repos ?? {}) };
  const next = StewardConfig.parse({
    ...cur, ...(b.auto !== undefined ? { auto: b.auto } : {}), ...(b.interval_min ? { interval_min: b.interval_min } : {}),
    ...(b.stale_hours ? { stale_hours: b.stale_hours } : {}),
    repos: Object.fromEntries(Object.entries(repos).filter(([, v]) => v.length > 0)),
    // Written by this version: the lease is the person's explicit choice from now on (no migration).
    lease_migrated: true,
  });
  saveConfigField(c.core.paths.config, "steward", next);
  return json({ config: next });
});
