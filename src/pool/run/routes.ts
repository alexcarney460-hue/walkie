// Local API routes for split runs (WALKIE-POOL-2, PROTOCOL §5). Imported by the daemon for its side effect of
// registering routes. Reading the state is open to every local caller; sharing this machine and starting or stopping
// a run are for people only: an X-Walkie-Agent header is refused (403), like invites and integrations.
import { adminGate } from "../../daemon/admin/gate.ts";
import { z } from "zod";
import { HttpError, json, parseWith, readJson } from "../../daemon/http.ts";
import { LOCAL_BODY_MAX, limitWrite, requireTeam, route, type RouteCtx } from "../../daemon/local-routes.ts";
import { nodesView } from "../../daemon/views.ts";
import { PeerCallError } from "../../daemon/peer-client.ts";
import { CATALOG } from "../catalog.ts";
import { catalogNeed, PlanError, resolveMachine, serveHosts } from "./plan.ts";
import { RunError } from "./runner.ts";
import { freshGpuStats, type PoolService } from "./service.ts";
import type { MachineStats } from "../../protocol/machine-stats.ts";
import type { PoolModelsView } from "../../protocol/pool.ts";

function pool(c: RouteCtx): PoolService {
  if (!c.core.pool) throw new HttpError(404, "not_found", "split runs are not available on this daemon");
  return c.core.pool;
}


route("GET", "/v1/pool", (c) => json(pool(c).view()));

/** The model list as the wire form: the catalog only when asked for (the dashboard polls with `brief=1` while it refreshes). */
function modelsView(c: RouteCtx): PoolModelsView {
  const src = pool(c).models;
  const v = src.peek();
  const brief = c.url.searchParams.get("brief") === "1";
  return { source: v.source, state: v.state, checked_at: v.checkedAt, note: v.note, refreshing: src.refreshing, ...(brief ? {} : { catalog: v.catalog }) };
}

// Opening the suggestions is what reads Hugging Face: when the list is missing or over a day old this starts the read
// (in the background of this request; the answer is what there is now, with `refreshing: true`). Never on a timer.
route("GET", "/v1/pool/models", (c) => {
  void pool(c).models.load().catch(() => undefined);
  return json(modelsView(c));
});

route("POST", "/v1/pool/models/refresh", (c) => {
  limitWrite(c);
  void pool(c).models.load({ refresh: true }).catch(() => undefined);
  return json(modelsView(c), 202);
});

/** The node list with this machine's stats carrying free VRAM read now (service.ts freshGpuStats). */
async function withFreshSelf<T extends { self: boolean; stats?: MachineStats }>(c: RouteCtx, nodes: T[]): Promise<T[]> {
  const fresh = await freshGpuStats(() => c.core.machineStats);
  return fresh ? nodes.map((n) => (n.self ? { ...n, stats: fresh } : n)) : nodes;
}

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
    // This machine's own free VRAM read now, not the last sample (a GPU a run or model just gave back counts).
    const nodes = await withFreshSelf(c, nodesView(c.core, c.sync));
    const run = pool(c).runner.start({
      ...(b.model ? { model: b.model } : {}), ...(b.quant ? { quant: b.quant } : {}), ...(b.file ? { file: b.file } : {}),
      ...(b.machines ? { machines: b.machines } : {}),
    }, nodes);
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

// ---- POOL-REAL-1: serve a model whole on one machine, connect to it from any member machine ----

/** A peer's refusal (its status and message) as this API's own error. */
function peerError(err: unknown, where: string): never {
  if (err instanceof PeerCallError) throw new HttpError(err.status >= 400 && err.status < 600 ? err.status : 502, err.code, `${where}: ${err.message}`);
  throw err;
}

const ServeBody = z.object({
  model: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,48}$/),
  quant: z.enum(["q4", "q8"]).optional(),
  on: z.string().min(1).max(120).optional(),
}).strict();

route("POST", "/v1/pool/serve", async (c) => {
  limitWrite(c);
  const b = parseWith(ServeBody, await readJson(c.req, LOCAL_BODY_MAX));
  adminGate(c, `served ${b.model}${b.quant ? ` (${b.quant})` : ""}${b.on ? ` on ${b.on}` : ""}`);
  const p = pool(c);
  const quant = b.quant ?? "q4";
  const m = CATALOG.models.find((x) => x.id === b.model);
  if (!m) throw new HttpError(400, "unknown_model", `no model "${b.model}" in the catalog (walkie pool lists them)`);
  let need: number;
  try { need = catalogNeed(m, quant); } catch (err) { throw new HttpError(400, (err as PlanError).code, (err as Error).message); }
  const nodes = await withFreshSelf(c, nodesView(c.core, c.sync));
  let target;
  try {
    // Named, else a machine already serving this model, else the fastest GPU it fits on now.
    target = b.on ? resolveMachine(nodes, b.on)
      : nodes.find((n) => n.pool?.serving?.model_id === m.id && n.pool.serving.quant === quant && (n.self || (n.online && n.pool.serving.open)))
        ?? serveHosts(nodes, need)[0]?.node;
  } catch (err) {
    if (err instanceof PlanError) throw new HttpError(409, err.code, err.message);
    throw err;
  }
  if (!target) {
    throw new HttpError(409, "does_not_fit", `no machine here or sharing has ${(need / 1024 ** 3).toFixed(1)} GB of GPU memory free for ${m.name} (${quant === "q8" ? "8-bit" : "4-bit"}); split it across machines instead: walkie pool run ${m.id}`);
  }
  const on = { node_id: target.node_id, hostname: target.hostname, self: target.self };
  // Known to share without the serve API (an older Walkie): say so. Not yet known (just joined): the machine answers.
  if (!target.self && target.pool && target.pool.serve !== true) {
    throw new HttpError(409, "no_serve_support", `${target.hostname} runs a Walkie without serving models (its owner updates Walkie there)`);
  }
  if (target.self) return json({ on, serve: await p.server.start(m.id, quant, null) }, 202);
  requireTeam(c);
  try {
    await p.peerServe(target.node_id, { action: "start", model: m.id, quant });
  } catch (err) { peerError(err, target.hostname); }
  try {
    return json({ on, connection: await p.connections.connect(target.node_id) }, 202);
  } catch (err) { peerError(err, target.hostname); }
});

const OnBody = z.object({ on: z.string().min(1).max(120).optional() }).strict();

route("POST", "/v1/pool/serve/stop", async (c) => {
  limitWrite(c);
  const b = parseWith(OnBody, await readJson(c.req, LOCAL_BODY_MAX));
  adminGate(c, `stopped a served model${b.on ? ` on ${b.on}` : ""}`);
  const p = pool(c);
  const target = b.on ? (() => { try { return resolveMachine(nodesView(c.core, c.sync), b.on!); } catch (err) { throw new HttpError(404, (err as PlanError).code ?? "unknown_machine", (err as Error).message); } })() : null;
  if (!target || target.self) return json({ serve: await p.server.stop() });
  const id = target.pool?.serving?.id ?? p.connections.view().find((x) => x.node_id === target.node_id)?.id;
  if (!id) throw new HttpError(404, "not_serving", `${target.hostname} serves no model now`);
  try {
    await p.peerServe(target.node_id, { action: "stop", id });
  } catch (err) { peerError(err, target.hostname); }
  return json({ connection: await p.connections.disconnect(target.node_id) });
});

const MachineBody = z.object({ machine: z.string().min(1).max(120) }).strict();

function machineOf(c: RouteCtx, name: string) {
  try {
    return resolveMachine(nodesView(c.core, c.sync), name);
  } catch (err) {
    throw new HttpError(404, (err as PlanError).code ?? "unknown_machine", (err as Error).message);
  }
}

route("POST", "/v1/pool/connect", async (c) => {
  requireTeam(c);
  limitWrite(c);
  const b = parseWith(MachineBody, await readJson(c.req, LOCAL_BODY_MAX));
  adminGate(c, `connected to the model served on ${b.machine}`);
  const target = machineOf(c, b.machine);
  if (target.self) throw new HttpError(400, "self", "this machine's own model is on its endpoint already (walkie pool status)");
  try {
    return json({ connection: await pool(c).connections.connect(target.node_id) });
  } catch (err) { peerError(err, target.hostname); }
});

route("POST", "/v1/pool/disconnect", async (c) => {
  limitWrite(c);
  const b = parseWith(MachineBody, await readJson(c.req, LOCAL_BODY_MAX));
  adminGate(c, `disconnected from the model served on ${b.machine}`);
  const target = machineOf(c, b.machine);
  return json({ connection: await pool(c).connections.disconnect(target.node_id) });
});

const PrepareBody = z.object({ model: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,48}$/), quant: z.enum(["q4", "q8"]).optional() }).strict();

route("POST", "/v1/pool/prepare", async (c) => {
  limitWrite(c);
  const b = parseWith(PrepareBody, await readJson(c.req, LOCAL_BODY_MAX));
  adminGate(c, `prepared ${b.model}${b.quant ? ` (${b.quant})` : ""} for split runs`);
  return json({ prepare: pool(c).prepare(b.model, b.quant ?? "q4") }, 202);
});

/**
 * POOL-REAL-1 (Alex: "people shouldn't do chores agents can do"): installing the pinned, sha256-checked runtime is a
 * chore, so a NAMED agent may do it (X-Walkie-Agent); an agent that doesn't say who it is gets 403 agent_unnamed.
 * Sharing, split runs and serving stay person-only: those are the trust decisions.
 */
route("POST", "/v1/pool/install", async (c) => {
  if (c.underAgent && !c.agent) throw new HttpError(403, "agent_unnamed", "an agent installing the runtime must name itself (WALKIE_AGENT=<name>, or --agent)");
  adminGate(c, "installed the llama.cpp runtime");
  limitWrite(c);
  return json({ install: await pool(c).install(c.agent ?? null) }, 202);
});
