import { z } from "zod";
import { randomUUID } from "node:crypto";
import { TOOLS } from "../../mcp/tools.ts";
import { listSkills } from "../../mcp/skills.ts";
import { HttpError, json, parseWith, readJson } from "../http.ts";
import { ensureChannel, limitWrite, requireOwner, requireTeam, route, type RouteCtx } from "../local-routes.ts";
import { agentCaller, personOnly } from "../admin/gate.ts";
import { recordAdmin } from "../admin/audit.ts";
import { TALKIE_SHELL_HEADER } from "../orchestrator/os-user.ts";
import { catalogRecords, catalogState, installedCatalog, reconcileCatalog, setCatalogOptOut } from "./install.ts";
import { parseCatalogSkill, privateProjectMentions, SKILLS_CHANNEL, skillHash, validCatalogEvent, validateCatalogProse, type CatalogRecord } from "./catalog.ts";

const names = TOOLS.map((tool) => tool.name);
function reconcile(c: RouteCtx) {
  const result = reconcileCatalog(c.core, names);
  c.core.catalogFailures = result.blocked;
  return result;
}
const Name = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Proposal = z.object({ text: z.string().min(1).max(64 * 1024), acknowledge_team: z.literal(true) }).strict();
const Revision = z.object({ name: Name, sha256: Hash, preview_token: z.string().uuid() }).strict();
const Named = z.object({ name: Name }).strict();
const Toggle = z.object({ name: Name, off: z.boolean() }).strict();
const previews = new WeakMap<RouteCtx["core"], Map<string, { token: string; expires: number }>>();

function previewToken(c: RouteCtx, name: string, sha256: string): string | undefined {
  if (c.via !== "cli" || agentCaller(c)) return undefined;
  const token = randomUUID();
  const held = previews.get(c.core) ?? new Map();
  held.set(`${name}:${sha256}`, { token, expires: Date.now() + 5 * 60_000 });
  previews.set(c.core, held);
  return token;
}
function consumePreview(c: RouteCtx, name: string, sha256: string, token: string): void {
  const key = `${name}:${sha256}`;
  const held = previews.get(c.core);
  const proof = held?.get(key);
  held?.delete(key);
  if (!proof || proof.token !== token || proof.expires < Date.now())
    throw new HttpError(403, "preview_required", "preview the exact skill text and sha256 on this machine before approving");
}

function local(c: RouteCtx): void {
  requireTeam(c);
  if (c.via === "phone" || c.dashboard || c.req.headers.has("x-walkie-admin-token"))
    throw new HttpError(403, "local_only", "skills catalog is available on the local terminal only");
}
function ownerPerson(c: RouteCtx): void {
  local(c);
  if (c.req.headers.get(TALKIE_SHELL_HEADER) === "1") throw new HttpError(403, "person_only", "Talkie shell cannot approve skills");
  personOnly(c, "approve, revoke or roll back a skill");
  requireOwner(c);
  limitWrite(c);
}

function recordDecision(c: RouteCtx, action: string, name: string, sha256?: string): void {
  recordAdmin(c.core, { actor: `@${c.core.myHandle()}/${c.core.hostname}`,
    action: `${action} team skill ${name}${sha256 ? ` sha256 ${sha256}` : ""}`,
    machine: c.core.hostname, via: "local" }, { post: true, notify: c.core.myHandle() ?? undefined });
}

async function postSkill(c: RouteCtx, op: CatalogRecord["kind"], skill: Record<string, unknown>) {
  await ensureChannel(c, SKILLS_CHANNEL);
  const channel = c.core.roster.channels.get(SKILLS_CHANNEL);
  if (!channel || channel.members || channel.archived)
    throw new HttpError(409, "catalog_channel_unavailable", "#skills must be a public team-wide channel");
  const revision = typeof skill.sha256 === "string" ? ` revision ${skill.sha256.slice(0, 12)}` : "";
  return c.core.emit("msg.post", { text: `${op === "propose" ? "proposed" : op === "approve" ? "approved" : op === "revoke" ? "revoked" : "rolled back"} skill ${skill.name}${revision}`,
    skill: { op, ...skill } }, { channel: SKILLS_CHANNEL, ...(op === "propose" ? { agent: c.agent } : {}) });
}

route("GET", "/v1/skills", (c) => {
  local(c);
  const state = catalogState(c.core, names);
  const agent = agentCaller(c);
  return json({ team: c.core.teamId, bundled: listSkills(), active: installedCatalog(c.core.paths.home, c.core, names).map(({ text: _text, ...skill }) => skill),
    pending: agent ? [] : state.pending.map(({ text: _text, ...skill }) => skill),
    blocked: agent ? [] : [...new Set([...state.blocked, ...c.core.catalogFailures])] });
});

route("GET", /^\/v1\/skills\/([a-z][a-z0-9-]{0,63})$/, (c, [name]) => {
  local(c);
  const ref = parseWith(Name, name);
  const state = catalogState(c.core, names);
  const versions = (agentCaller(c) ? installedCatalog(c.core.paths.home, c.core, names) : [...state.active, ...state.pending])
    .filter((skill) => skill.name === ref);
  if (!versions.length) throw new HttpError(404, "not_found", "skill not found");
  return json({ name: ref, versions: versions.map((skill) => {
    const token = previewToken(c, skill.name, skill.sha256);
    return token ? { ...skill, preview_token: token } : skill;
  }),
    blocked: agentCaller(c) ? [] : [...new Set([...state.blocked, ...c.core.catalogFailures])] });
});

route("POST", "/v1/skills/propose", async (c) => {
  local(c);
  limitWrite(c);
  const { text } = parseWith(Proposal, await readJson(c.req, 70 * 1024));
  c.projects?.flushAll();
  const restricted = c.projects?.projects().filter((project) => project.private || !!c.core.roster.channels.get(project.channel)?.members)
    .map((project) => ({ ...project, private: true })) ?? [];
  if (!c.projects && [...c.core.roster.channels.entries()].some(([name, channel]) => c.core.isProjectChannel(name) && channel.members))
    throw new HttpError(503, "projects_unavailable", "private project index is unavailable");
  const issues = [...validateCatalogProse(text, names), ...privateProjectMentions(text, restricted)];
  if (issues.length) throw new HttpError(400, "blocked", `skill proposal blocked: ${issues.join(", ")}`, { reasons: issues });
  const parsed = parseCatalogSkill(text);
  const sha256 = skillHash(text);
  const event = await postSkill(c, "propose", { name: parsed.name, sha256, text });
  return json({ name: parsed.name, sha256, revision: event.id, status: "pending" });
});

route("POST", "/v1/skills/approve", async (c) => {
  ownerPerson(c);
  const body = parseWith(Revision, await readJson(c.req, 2048));
  consumePreview(c, body.name, body.sha256, body.preview_token);
  const proposed = catalogState(c.core, names).pending.find((s) => s.name === body.name && s.sha256 === body.sha256);
  if (!proposed) throw new HttpError(404, "revision_missing", "exact pending revision not found");
  const prev = catalogState(c.core, names).heads[body.name];
  const event = await postSkill(c, "approve", { name: body.name, sha256: body.sha256, ...(prev ? { prev } : {}) });
  recordDecision(c, "approved", body.name, body.sha256);
  return json({ event: event.id, ...reconcile(c) });
});

route("POST", "/v1/skills/revoke", async (c) => {
  ownerPerson(c);
  const body = parseWith(Named, await readJson(c.req, 2048));
  const prev = catalogState(c.core, names).heads[body.name];
  const event = await postSkill(c, "revoke", { ...body, ...(prev ? { prev } : {}) });
  recordDecision(c, "revoked", body.name);
  return json({ event: event.id, ...reconcile(c) });
});

route("POST", "/v1/skills/rollback", async (c) => {
  ownerPerson(c);
  const body = parseWith(Revision, await readJson(c.req, 2048));
  consumePreview(c, body.name, body.sha256, body.preview_token);
  const historical = catalogRecords(c.core).some((record) => record.kind === "approve"
    && record.body.name === body.name && record.body.sha256 === body.sha256 && validCatalogEvent(record));
  if (!historical) throw new HttpError(404, "revision_missing", "exact historical revision not found");
  const prev = catalogState(c.core, names).heads[body.name];
  const event = await postSkill(c, "rollback", { name: body.name, sha256: body.sha256, ...(prev ? { prev } : {}) });
  recordDecision(c, "rolled back", body.name, body.sha256);
  return json({ event: event.id, ...reconcile(c) });
});

route("POST", "/v1/skills/local", async (c) => {
  local(c);
  personOnly(c, "change local skill activation");
  limitWrite(c);
  const body = parseWith(Toggle, await readJson(c.req, 2048));
  setCatalogOptOut(c.core.paths.home, body.name, body.off);
  return json({ name: body.name, off: body.off, ...reconcile(c) });
});
