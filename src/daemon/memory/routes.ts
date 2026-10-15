// Local personal-memory routes. Legacy deletion and learning confirmation require a dashboard session.
// The regular handlers refuse a dashboard session and a phone on read and on write. A scheduled Talkie turn is
// refused on read here (its writes are already refused for every route before dispatch). This person and their
// own agents can read and write. Nothing is emitted.
import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ORCHESTRATOR_AGENT } from "../../protocol/orchestrator.ts";
import { HttpError, json, parseWith, readJson } from "../http.ts";
import { limitWrite, route, scheduledChild, validAgentHeader, type RouteCtx } from "../local-routes.ts";
import { hostFor } from "../orchestrator/host.ts";
import { personOnly } from "../admin/gate.ts";
import { MemoryStore, MEMORY_FILE } from "./store.ts";
import { SemanticStore, semanticStatus, EDGE_TYPES } from "./semantic.ts";
import { automaticLearningRequestId, learningTextUnsafe } from "./learning.ts";
import { derivePrimer, recallPersonal } from "./primer.ts";
import { claudeMemProjects, searchClaudeMem, defaultClaudeMemPath, claudeMemPathAllowed, displayClaudeMemProject } from "./claude-mem.ts";
import { homedir } from "node:os";
import { findProject, visibleProjects } from "../projects/service.ts";
import { legacyOwner, personKey, startupAdmits } from "./ownership.ts";
import { MEMORY_LIST_DEFAULT, MEMORY_LIST_MAX, MEMORY_QUERY_MAX, MEMORY_SOURCES_MAX, MemoryError } from "./text.ts";
import { gbrainEnable, gbrainDisable, gbrainDelete, gbrainStatus, gbrainSync, gbrainSearch, type GbrainStatus } from "./gbrain.ts";
import { defaultKeyStore } from "../../accounts/vault/keystore.ts";
import { backupExport, backupKeyId, backupRestore, backupStatus, type BackupResult } from "./backup.ts";

const AddBody = z.object({
  kind: z.string().optional(),
  text: z.string(),
  sources: z.array(z.string()).max(MEMORY_SOURCES_MAX).optional(),
}).strict();

const RetractBody = z.object({
  id: z.string(),
}).strict();

const DeleteBody = z.object({ confirm: z.literal("delete legacy memory") }).strict();
const LearningWrite = z.object({
  action: z.enum(["add", "correct"]), category: z.string(), rule: z.string(), evidence: z.string(),
  confidence: z.number(), requestId: z.string().optional(), session: z.string().optional(), supersedes: z.string().optional(),
}).strict();
const LearningRetract = z.object({ action: z.literal("retract"), id: z.string(), requestId: z.string() }).strict();
const LearningConfirm = z.object({ id: z.string() }).strict();

function actorOf(c: RouteCtx, write: boolean): string {
  if (c.via === "phone") throw new HttpError(403, "forbidden", "personal memory stays on this machine");
  if (c.dashboard) {
    throw new HttpError(403, "forbidden", write
      ? "the dashboard cannot change personal memory; use the terminal (walkie memory)"
      : "the dashboard cannot read personal memory; use the terminal (walkie memory)");
  }
  // Writes never reach here while a scheduled turn is held (dispatch refuses them). Reads would, and the child can still post.
  if (!write && scheduledChild(c)) throw new HttpError(403, "scheduled_turn_cannot_act", "a scheduled Talkie turn cannot read personal memory");
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

function useStore<T>(c: RouteCtx, fn: (store: MemoryStore) => T, resolve = true): T {
  let store: MemoryStore | undefined;
  try {
    store = MemoryStore.open(c.core.paths.home);
    if (resolve) {
      const proof = legacyOwner(c.core);
      store.resolveLegacy(proof, startupAdmits(c.core.paths.home, store, proof));
    }
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
  const owner = person(c, false);
  if (c.url.searchParams.has("scope")) throw new HttpError(400, "invalid", "personal memory has no team or org scope");
  const limit = limitOf(c);
  const all = allOf(c);
  const rawQ = c.url.searchParams.get("q") ?? "";
  // A NUL survives URL decoding. SQLite would treat it as the end of the string and the pattern would match every note.
  if (rawQ.includes("\0")) throw new HttpError(400, "invalid", "a search cannot contain a NUL character");
  const q = rawQ.trim();
  if (q.length > MEMORY_QUERY_MAX) throw new HttpError(400, "invalid", `a search is at most ${MEMORY_QUERY_MAX} characters`);
  const entries = useStore(c, (store) => (q ? store.search(q, limit, owner) : store.list({ limit, includeRetracted: all, owner })));
  return json({ entries });
});

route("POST", "/v1/memory", async (c) => {
  const actor = actorOf(c, true);
  const owner = personKey(c.core);
  if (!owner) throw new HttpError(409, "no_person", "personal memory needs an enrolled person");
  const body = parseWith(AddBody, await readJson(c.req, 64 * 1024));
  const entry = useStore(c, (store) => store.add({ kind: body.kind, text: body.text, sources: body.sources, actor, owner }), false);
  const gbrain = await gbrainSync(c.core.paths.home, owner);
  return json({ entry, gbrain });
});

route("GET", "/v1/learn", (c) => {
  const owner = person(c, false);
  if (c.url.searchParams.has("scope")) throw new HttpError(400, "invalid", "learnings are personal only");
  const entries = useStore(c, (store) => store.learnings().list(owner, allOf(c), limitOf(c)));
  return json({ entries });
});

route("POST", "/v1/learn", async (c) => {
  const caller = actorOf(c, true);
  const actor = c.agent || c.underAgent ? `claimed:${caller}` : caller;
  const owner = personKey(c.core);
  if (!owner) throw new HttpError(409, "no_person", "personal learning needs an enrolled person");
  const raw = await readJson(c.req, 8192);
  const body = raw && typeof raw === "object" && "action" in raw && raw.action === "retract"
    ? parseWith(LearningRetract, raw) : parseWith(LearningWrite, raw);
  if (body.action === "retract") {
    const entry = useStore(c, (store) => store.learnings().retract(body.id, owner, body.requestId), false);
    const gbrain = await gbrainSync(c.core.paths.home, owner);
    return json({ entry, gbrain });
  }
  if (body.action === "correct" && !body.supersedes) throw new HttpError(400, "invalid", "correction needs a prior learning id");
  if (body.action === "add" && body.supersedes) throw new HttpError(400, "invalid", "add cannot supersede a learning");
  const session = c.orchestratorToken ? hostFor(c.core)?.view().session : undefined;
  const writerBody = { ...body, session: session ?? "" };
  const entry = useStore(c, (store) => body.action === "correct"
      ? store.learnings().correct({ ...writerBody, owner, actor, machine: c.core.nodeId, supersedes: body.supersedes!,
        requestId: body.requestId ?? automaticLearningRequestId(writerBody) })
      : store.learnings().add({ ...writerBody, owner, actor, machine: c.core.nodeId,
        requestId: body.requestId ?? automaticLearningRequestId(writerBody) }), false);
  const gbrain = await gbrainSync(c.core.paths.home, owner);
  return json({ entry, gbrain });
});

route("POST", "/v1/learn/confirm", async (c) => {
  if (!c.dashboard || c.via !== "dashboard" || c.listener !== "tcp" || c.credentialExpiresAt === undefined
    || c.req.headers.has("x-walkie-admin-token")) {
    throw new HttpError(403, "person_only", "confirm a learning in an authenticated dashboard session");
  }
  personOnly(c, "confirm a learning", "in this machine's dashboard");
  limitWrite(c);
  const owner = personKey(c.core);
  if (!owner) throw new HttpError(409, "no_person", "personal learning needs an enrolled person");
  const body = parseWith(LearningConfirm, await readJson(c.req, 1024));
  const entry = useStore(c, (store) => store.learnings().confirm(body.id, owner), false);
  const gbrain = await gbrainSync(c.core.paths.home, owner);
  return json({ entry, gbrain });
});

const PrimerBody = z.object({
  project: z.string().min(1).max(80),
  inProgress: z.string().min(1).max(500),
  nextStep: z.string().min(1).max(500),
  blockers: z.array(z.string().min(1).max(300)).max(8),
}).strict();

function person(c: RouteCtx, write: boolean): string {
  actorOf(c, write);
  const owner = personKey(c.core);
  if (!owner) throw new HttpError(409, "no_person", "personal recall needs an enrolled person");
  return owner;
}

function projectOf(c: RouteCtx, ref: string | null): string {
  if (!ref || ref === "global") return "global";
  if (!c.projects) throw new HttpError(409, "projects_unavailable", "project index is unavailable");
  return findProject({ core: c.core, idx: c.projects }, ref).channel;
}

route("GET", "/v1/primer", (c) => {
  const owner = person(c, false);
  const project = projectOf(c, c.url.searchParams.get("project"));
  if (!existsSync(join(c.core.paths.home, MEMORY_FILE))) return json({ status: "unavailable", primer: null });
  const written = useStore(c, (store) => store.primer(owner, project));
  const view = project !== "global" && c.projects ? c.projects.project(project) : null;
  const cards = view && c.projects ? c.projects.db.cards(project, { states: ["open"], limit: 20_000 }).map((card) => ({
    ...card, active: view.boards.some((board) => board.id === card.board && board.columns.some((column) => column.id === card.column && column.role === "active")),
  })) : [];
  const primer = written ?? derivePrimer(owner, project, cards);
  return json({ status: primer ? "ok" : "empty", primer });
});

route("POST", "/v1/primer", async (c) => {
  const owner = person(c, true);
  const body = parseWith(PrimerBody, await readJson(c.req, 4096));
  if ((c.agent || c.underAgent) && [body.inProgress, body.nextStep, ...body.blockers].some(learningTextUnsafe)) {
    throw new HttpError(400, "quarantined", "agent primer text was quarantined: unsafe instruction-like or sensitive content");
  }
  const project = projectOf(c, body.project);
  const primer = useStore(c, (store) => store.setPrimer(owner, project, body), false);
  return json({ status: "ok", primer });
});

route("GET", "/v1/recall", async (c) => {
  const owner = person(c, false);
  const q = c.url.searchParams.get("q")?.trim() ?? "";
  if (!q || q.length > MEMORY_QUERY_MAX || q.includes("\0")) throw new HttpError(400, "invalid", "recall query must be 1..200 characters");
  const project = c.url.searchParams.has("project") ? projectOf(c, c.url.searchParams.get("project")) : undefined;
  if (!existsSync(join(c.core.paths.home, MEMORY_FILE))) return json({ status: "unavailable", items: [], gbrain: { state: "not_enabled" }, semantic: { status: "withheld", reason: "memory.db missing" }, sourceStatus: "claude-mem disabled" });
  const visible = () => c.projects ? visibleProjects({ core: c.core, idx: c.projects }).filter((p) => p.state !== "deleted") : [];
  const eligible = (entries: ReturnType<MemoryStore["recallEntries"]>, channels: ReadonlySet<string>) => entries.filter((entry) => {
    const scopes = entry.sources.filter((source) => source.startsWith("project:")).map((source) => source.slice(8));
    return scopes.every((scope) => channels.has(scope)) && (!project || !scopes.length || scopes.includes(project));
  });
  const beforeChannels = new Set(visible().map((p) => p.channel));
  const before = useStore(c, (store) => eligible(store.recallEntries(owner), beforeChannels));
  const gbrain = await gbrainSearch(c.core.paths.home, owner, q, before);
  // The child process can take time. Recheck owner rows and project visibility after it exits.
  const nowVisible = visible();
  const channels = new Set(nowVisible.map((p) => p.channel));
  const cards = nowVisible.flatMap((p) => c.projects!.db.cards(p.channel, { states: ["open", "archived"], limit: 20_000 }));
  const snapshot = useStore(c, (store) => ({
    lexical: recallPersonal(store, q, owner, cards, channels, project),
    entries: eligible(store.recallEntries(owner), channels),
    claudeMem: searchClaudeMem(store.claudeMemSettings(owner), q),
  }));
  const approved = new Set(snapshot.entries.map((entry) => entry.id));
  const added = gbrain.items.filter((hit) => approved.has(hit.id) && !snapshot.lexical.items.some((item) => item.id === hit.id)).map((hit) => ({
    id: hit.id, source: "gbrain" as const, slug: hit.slug, text: hit.text,
    updatedAt: hit.updatedAt, score: hit.score,
  }));
  const observations = snapshot.claudeMem.items.filter((item) => !project || item.project === project).map((item) => ({
    id: `claude-mem:${item.id}`, source: "claude-mem" as const,
    text: `${item.project} (${item.date})\n${item.text}`, project: item.project,
    updatedAt: item.updatedAt, score: Math.min(item.score, 5),
  }));
  const items = [...snapshot.lexical.items.slice(0, 10 - Math.min(3, added.length) - Math.min(2, observations.length)),
    ...added.slice(0, 3), ...observations.slice(0, 2)]
    .sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  return json({ status: items.length ? "ok" : snapshot.lexical.status, items, gbrain: gbrain.status,
    semantic: snapshot.lexical.semantic,
    sourceStatus: `claude-mem ${snapshot.claudeMem.state}${snapshot.claudeMem.reason ? `: ${snapshot.claudeMem.reason}` : ""}` });
});

route("GET", "/v1/memory/status", async (c) => {
  const owner = person(c, false);
  const claudeMem = c.agent || c.underAgent ? { state: "person_only" } : useStore(c, (store) => {
    const settings = store.claudeMemSettings(owner);
    const probe = searchClaudeMem(settings, "status");
    return { state: probe.state, reason: probe.reason,
      allowedProjects: settings.allowedProjects.map(displayClaudeMemProject) };
  });
  return json({ gbrain: await gbrainStatus(c.core.paths.home, owner), semantic: semanticStatus(c.core.paths.home, owner), claudeMem, backup: c.agent || c.underAgent ? null : backupStatus(c.core.paths.home) });
});

const BackupAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("export"), to: z.string().min(1).max(4096), replace: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("restore"), file: z.string().min(1).max(4096), key: z.string().regex(/^[0-9a-f]{64}$/), replace: z.boolean().optional() }).strict(),
]);

export async function finishBackupRestore(restored: BackupResult, home: string, owner: string,
  status: (home: string, owner: string) => Promise<GbrainStatus> = gbrainStatus,
  sync: (home: string, owner: string) => Promise<GbrainStatus> = gbrainSync): Promise<BackupResult> {
  let reason: string | undefined;
  try {
    if ((await status(home, owner)).state === "not_enabled") return restored;
    const result = await sync(home, owner);
    if (result.state === "unavailable") reason = result.reason ?? "gbrain unavailable";
  } catch (err) { reason = err instanceof Error ? err.message : "gbrain unavailable"; }
  if (!reason) return restored;
  const warning = `gbrain could not be rebuilt: ${reason}; run walkie memory gbrain sync`;
  return { ...restored, warning: restored.warning ? `${restored.warning} ${warning}` : warning };
}

route("GET", "/v1/memory/backup/identity", (c) => {
  personOnly(c, "initialize personal memory backup", "in their own terminal");
  const owner = person(c, false);
  return json({ keyId: backupKeyId(owner), home: c.core.paths.home });
});

route("POST", "/v1/memory/backup", async (c) => {
  personOnly(c, "export or restore personal memory", "in their own terminal");
  const owner = person(c, true);
  const body = parseWith(BackupAction, await readJson(c.req, 8192));
  const home = c.core.paths.home;
  try {
    if (body.action === "export") {
      const keys = await defaultKeyStore(home, homedir());
      return json(await backupExport(home, owner, body.to, keys, body.replace));
    }
    const keys = await defaultKeyStore(home, homedir());
    const restored = await backupRestore(home, owner, body.file, Buffer.from(body.key, "hex"), body.replace, keys);
    return json(await finishBackupRestore(restored, home, owner));
  } catch (err) {
    throw new HttpError(400, "backup_failed", err instanceof Error ? err.message : "memory backup failed");
  }
});

const GbrainAction = z.object({ action: z.enum(["enable", "disable", "delete", "sync"]),
  binary: z.string().min(1).max(1024).optional(), confirm: z.string().optional() }).strict();

route("POST", "/v1/memory/gbrain", async (c) => {
  const owner = person(c, true);
  const body = parseWith(GbrainAction, await readJson(c.req, 2048));
  if (body.action !== "sync") {
    personOnly(c, `${body.action} gbrain`, "in their own terminal");
    if (c.via !== "cli" || c.dashboard || c.req.headers.has("x-walkie-admin-token")) {
      throw new HttpError(403, "person_only", "gbrain configuration requires a person-run local CLI");
    }
  }
  if (body.action === "enable") {
    const enabled = await gbrainEnable(c.core.paths.home, owner, body.binary);
    if (enabled.state !== "ready") return json({ gbrain: enabled });
  } else if (body.action === "disable") return json({ gbrain: await gbrainDisable(c.core.paths.home, owner) });
  else if (body.action === "delete") {
    if (body.confirm !== "delete my gbrain") throw new HttpError(400, "invalid", "confirm with 'delete my gbrain'");
    await gbrainDelete(c.core.paths.home, owner);
    return json({ gbrain: { state: "not_enabled" } });
  }
  return json({ gbrain: await gbrainSync(c.core.paths.home, owner) });
});

function personSemantic(c: RouteCtx): string {
  const owner = person(c, false);
  personOnly(c, "change or inspect semantic entities", "in this machine's terminal");
  return owner;
}

function graph(c: RouteCtx, owner: string, action: (store: SemanticStore) => unknown): Response {
  try {
    const store = SemanticStore.create(c.core.paths.home);
    try { return json({ result: action(store), semantic: store.status(owner) }); }
    finally { store.close(); }
  } catch (err) { throw new HttpError(400, "semantic_unavailable", err instanceof Error ? err.message : "semantic.db unreadable"); }
}

route("GET", "/v1/memory/semantic/status", (c) => {
  const owner = personSemantic(c);
  return json(semanticStatus(c.core.paths.home, owner));
});

route("POST", "/v1/memory/semantic/rebuild", (c) => {
  const owner = personSemantic(c);
  limitWrite(c);
  return useStore(c, (store) => graph(c, owner, (semantic) => semantic.rebuild(owner, store)));
});

route("GET", "/v1/memory/entity", (c) => {
  const owner = personSemantic(c);
  const store = SemanticStore.open(c.core.paths.home);
  if (!store) return json({ entities: [], aliases: [], edges: [], semantic: { status: "withheld", reason: "semantic.db missing" } });
  try { return json({ ...store.list(owner), semantic: store.status(owner) }); } finally { store.close(); }
});

route("GET", "/v1/memory/entity/export", (c) => {
  const owner = personSemantic(c);
  const store = SemanticStore.open(c.core.paths.home);
  if (!store) throw new HttpError(404, "semantic_missing", "semantic.db missing");
  try { return json({ export: JSON.parse(store.export(owner)) }); } finally { store.close(); }
});

const EntityAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), slug: z.string(), kind: z.string(), name: z.string(), summary: z.string(), validAsOf: z.number(), confidence: z.number() }).strict(),
  z.object({ action: z.literal("alias"), id: z.string(), name: z.string() }).strict(),
  z.object({ action: z.literal("link"), source: z.string(), target: z.string(), type: z.enum(EDGE_TYPES), evidenceRecordId: z.string().optional() }).strict(),
  z.object({ action: z.literal("unlink"), source: z.string(), target: z.string(), type: z.enum(EDGE_TYPES) }).strict(),
  z.object({ action: z.literal("remove"), id: z.string() }).strict(),
  z.object({ action: z.literal("import"), export: z.unknown() }).strict(),
]);

route("POST", "/v1/memory/entity", async (c) => {
  const owner = personSemantic(c);
  limitWrite(c);
  const body = parseWith(EntityAction, await readJson(c.req, 256 * 1024));
  return graph(c, owner, (store) => {
    switch (body.action) {
      case "add": return store.addEntity(owner, body);
      case "alias": return store.addAlias(owner, body.id, body.name);
      case "link": return store.link(owner, body.source, body.target, body.type, body.evidenceRecordId);
      case "unlink": return store.unlink(owner, body.source, body.target, body.type);
      case "remove": return store.remove(owner, body.id);
      case "import": return store.import(owner, JSON.stringify(body.export));
    }
  });
});

const ClaudeMemChange = z.object({
  action: z.enum(["enable", "disable", "allow", "deny", "freshness"]),
  path: z.string().max(4096).optional(), project: z.string().min(1).max(500).optional(),
  freshnessDays: z.number().int().min(1).max(3650).optional(),
}).strict();

function claudeMemPerson(c: RouteCtx, write: boolean): string {
  personOnly(c, "change claude-mem settings", "in their own terminal");
  return person(c, write);
}

route("GET", "/v1/memory/claude-mem", (c) => {
  const owner = claudeMemPerson(c, false);
  return json(useStore(c, (store) => {
    const settings = store.claudeMemSettings(owner);
    const probe = searchClaudeMem(settings, "status");
    return { state: probe.state, reason: probe.reason, enabled: settings.enabled,
      allowedProjects: settings.allowedProjects.map(displayClaudeMemProject), freshnessDays: settings.freshnessDays,
      path: settings.path };
  }));
});

route("GET", "/v1/memory/claude-mem/projects", (c) => {
  const owner = claudeMemPerson(c, false);
  return json(useStore(c, (store) => claudeMemProjects(store.claudeMemSettings(owner))));
});

route("POST", "/v1/memory/claude-mem", async (c) => {
  const owner = claudeMemPerson(c, true);
  const body = parseWith(ClaudeMemChange, await readJson(c.req, 8192));
  return json(useStore(c, (store) => {
    const old = store.claudeMemSettings(owner);
    if (body.action === "enable" && !claudeMemPathAllowed(body.path ?? defaultClaudeMemPath(homedir()))) {
      throw new HttpError(400, "invalid", "--db must be a regular file path inside your home, with no symlink");
    }
    if ((body.action === "allow" || body.action === "deny") && !body.project) throw new HttpError(400, "invalid", "project is required");
    if (body.action === "freshness" && !body.freshnessDays) throw new HttpError(400, "invalid", "freshness days are required");
    if (body.action === "allow") {
      const available = claudeMemProjects(old);
      if (available.state !== "ready") throw new HttpError(409, "unavailable", "claude-mem projects are unavailable");
      if (!available.projects.some((p) => p.name === body.project)) throw new HttpError(404, "not_found", "no such claude-mem project");
    }
    const next = {
      enabled: body.action === "enable" ? true : body.action === "disable" ? false : old.enabled,
      path: body.action === "enable" ? body.path ?? defaultClaudeMemPath(homedir()) : old.path,
      freshnessDays: body.action === "freshness" ? body.freshnessDays! : old.freshnessDays,
      allowedProjects: body.action === "allow" ? [...new Set([...old.allowedProjects, body.project!])]
        : body.action === "deny" ? old.allowedProjects.filter((p) => p !== body.project) : old.allowedProjects,
    };
    const saved = store.setClaudeMemSettings(owner, next);
    const probe = searchClaudeMem(saved, "status");
    return { state: probe.state, reason: probe.reason, enabled: saved.enabled,
      allowedProjects: saved.allowedProjects.map(displayClaudeMemProject), freshnessDays: saved.freshnessDays, path: saved.path };
  }, false));
});

route("POST", "/v1/memory/delete-legacy", async (c) => {
  // local-api.ts sets dashboard and credentialExpiresAt only after checking a live dashboard session.
  // The bearer token on the same listener, or an unmarked Unix-socket process, is insufficient.
  if (!c.dashboard || c.via !== "dashboard" || c.listener !== "tcp" || c.credentialExpiresAt === undefined) {
    throw new HttpError(403, "person_only", "delete quarantined legacy memory in an authenticated dashboard session");
  }
  personOnly(c, "delete quarantined legacy memory", "in this machine's dashboard");
  if (c.req.headers.has("x-walkie-admin-token")) throw new HttpError(403, "person_only", "delete quarantined legacy memory in the dashboard");
  limitWrite(c);
  parseWith(DeleteBody, await readJson(c.req, 1024));
  const owner = personKey(c.core);
  if (!owner) throw new HttpError(409, "no_person", "personal memory needs an enrolled person");
  const deleted = useStore(c, (store) => store.deleteLegacy());
  return json({ deleted });
});

route("GET", "/v1/memory/capabilities", (c) => {
  person(c, false);
  return json({
    claude: { context_injected: "requires verified SessionStart hook", recall_available: true },
    codex: { context_injected: false, recall_available: true, reason: "native startup injection unsupported; use CLI or MCP" },
    kimi: { context_injected: false, recall_available: true, reason: "native startup injection unsupported; use CLI or MCP" },
    seat: { context_injected: "owned-machine-v2-brief", recall_available: true },
  });
});

route("POST", "/v1/memory/retract", async (c) => {
  const owner = person(c, true);
  const body = parseWith(RetractBody, await readJson(c.req, 1024));
  const entry = useStore(c, (store) => store.retract(body.id, owner), false);
  const gbrain = await gbrainSync(c.core.paths.home, owner);
  return json({ entry, gbrain });
});
