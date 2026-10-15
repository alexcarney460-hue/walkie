import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { validateCatalogProse, projectCatalog, privateProjectMentions, type CatalogRecord } from "./catalog.ts";
import { afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { feed, makeCore } from "../../../test/helpers/core.ts";
import { createTeam, now, tnode } from "../../../test/helpers/events.ts";
import { catalogState, installedCatalog, reconcileCatalog } from "./install.ts";
import { skillHash } from "./catalog.ts";
import { dispatch, type RouteCtx } from "../local-routes.ts";
import "./routes.ts";
import { callSkillTool } from "../../mcp/skills.ts";
import { TOOLS } from "../../mcp/tools.ts";
import type { WalkieClient } from "../../client/index.ts";
import type { Core } from "../core.ts";
import { catalogOperation } from "./catalog.ts";

const body = "---\nname: careful-review\ndescription: Review a change carefully.\nuses: [walkie_skill]\n---\n\nRead the diff and report defects.\n";
const source = body.replace("\n---\n\n", "\n---\n");
const hash = createHash("sha256").update(source).digest("hex");
const event = (kind: CatalogRecord["kind"], data: Record<string, unknown>, seq: number, owner = true): CatalogRecord =>
  ({ id: `0000000000000001:${seq}`, kind, body: { op: kind, ...data }, owner, person: true, signatureValid: true });

test("proposal scanner blocks secrets, executables and oversized text", () => {
  expect(validateCatalogProse(source, ["walkie_skill"])).toEqual([]);
  expect(validateCatalogProse(source.replaceAll("\n", "\r\n"), ["walkie_skill"])).toEqual([]);
  expect(validateCatalogProse(source + "\napi_key=FAKE_CREDENTIAL_VALUE_12345", ["walkie_skill"]).length).toBeGreaterThan(0);
  expect(validateCatalogProse(source + "\n```bash\necho hi\n```", ["walkie_skill"])).toContain("executable content");
  expect(validateCatalogProse(source + "<img src=x>", ["walkie_skill"])).toContain("executable content");
  expect(validateCatalogProse(source + "\0", ["walkie_skill"])).toContain("non-prose bytes");
  expect(validateCatalogProse(source + "a".repeat(65 * 1024), ["walkie_skill"])).toContain("skill exceeds 64 KiB");
  expect(validateCatalogProse(source, [])).toContain("unavailable tool walkie_skill");
});

test("only an exact person-owner approval activates; revocation and rollback replay offline", () => {
  const proposal = event("propose", { name: "careful-review", text: source, sha256: hash }, 1, false);
  const approve = event("approve", { name: "careful-review", sha256: hash }, 2);
  const revoked = event("revoke", { name: "careful-review", prev: approve.id }, 3);
  const rollback = event("rollback", { name: "careful-review", sha256: hash, prev: revoked.id }, 4);
  expect(projectCatalog([proposal], ["walkie_skill"]).active).toEqual([]);
  expect(projectCatalog([proposal, { ...approve, person: false }], ["walkie_skill"]).active).toEqual([]);
  expect(projectCatalog([proposal, { ...approve, owner: false }], ["walkie_skill"]).active).toEqual([]);
  expect(projectCatalog([proposal, approve], ["walkie_skill"]).active.map((s) => s.sha256)).toEqual([hash]);
  expect(projectCatalog([proposal, approve, revoked], ["walkie_skill"]).active).toEqual([]);
  expect(projectCatalog([proposal, approve, revoked, rollback], ["walkie_skill"]).active.map((s) => s.sha256)).toEqual([hash]);
  expect(projectCatalog([proposal, { ...approve, signatureValid: false }], ["walkie_skill"]).active).toEqual([]);
  expect(projectCatalog([{ ...proposal, body: { ...proposal.body, text: source + "tamper" } }, approve], ["walkie_skill"]).active).toEqual([]);
  expect(projectCatalog([proposal, rollback], ["walkie_skill"]).active).toEqual([]);
});

test("causal decisions ignore clock order and a concurrent revocation defeats an approval", () => {
  const proposal = event("propose", { name: "careful-review", text: source, sha256: hash }, 1);
  const approval = event("approve", { name: "careful-review", sha256: hash }, 2);
  const revoke = event("revoke", { name: "careful-review", prev: approval.id }, 3);
  expect(projectCatalog([proposal, revoke, approval], ["walkie_skill"]).active).toEqual([]);
  const concurrent = event("revoke", { name: "careful-review" }, 4);
  expect(projectCatalog([proposal, approval, concurrent], ["walkie_skill"]).active).toEqual([]);
  const staleApproval = event("approve", { name: "careful-review", sha256: hash }, 5);
  expect(projectCatalog([proposal, approval, revoke, staleApproval], ["walkie_skill"]).active).toEqual([]);
});

test("team-wide proposals refuse known private project names and card keys", () => {
  const privateProjects = [{ name: "Secret Orchard", prefix: "SO", prior_prefixes: ["OLD"], private: true }];
  expect(privateProjectMentions(source + "Secret Orchard", privateProjects)).toEqual(["private project text"]);
  expect(privateProjectMentions(source + " SO-42", privateProjects)).toEqual(["private project text"]);
  expect(privateProjectMentions(source + " OLD-3", privateProjects)).toEqual(["private project text"]);
  expect(privateProjectMentions(source + " ordinary prose", privateProjects)).toEqual([]);
});

test("malformed and unauthorised skill bodies remain ordinary messages", () => {
  const owner = tnode("owner"), member = tnode("member");
  const { team, create } = createTeam(owner);
  const first = makeCore(owner, team, cleanups);
  first.ingest(create, "local");
  const roster = [first.emit("team.member", { login: member.login, handle: member.handle, role: "member" }),
    first.emit("team.node", { node_id: member.keys.nodeId, login: member.login,
      hostname: member.hostname, pubkey: member.keys.pubkey, ip: "127.0.0.1" }),
    first.emit("channel.upsert", { name: "skills" }),
    first.emit("channel.upsert", { name: "general" })];
  const proposal = emitSkill(first, "propose", { name: "careful-review", sha256: hash, text: source });
  const second = makeCore(member, team, cleanups);
  feed(second, [create, ...roster, proposal]);
  const unauthorised = emitSkill(second, "approve", { name: "careful-review", sha256: hash });
  const malformed = first.emit("msg.post", { text: "approval claim", skill: { op: "approve", name: "careful-review", sha256: hash, extra: true } }, { channel: "skills" });
  const wrongChannel = first.emit("msg.post", { text: "approval claim", skill: { op: "approve", name: "careful-review", sha256: hash } }, { channel: "general" });
  feed(first, [unauthorised]);
  expect([unauthorised, malformed, wrongChannel].map((ev) => first.store.getRow(ev.id)?.status)).toEqual(["ok", "ok", "ok"]);
  expect(catalogState(first, ["walkie_skill"]).active).toEqual([]);
  expect(catalogState(second, ["walkie_skill"]).active).toEqual([]);
});

const emitSkill = (core: Core, op: CatalogRecord["kind"], skill: Record<string, unknown>, agent?: string) =>
  core.emit("msg.post", { text: `${op} skill ${skill.name}`, skill: { op, ...skill } },
    { channel: "skills", ...(agent ? { agent } : {}) });

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

test("proposal route creates a public catalog channel and signs a readable post", async () => {
  const owner = tnode("owner");
  const { team, create } = createTeam(owner);
  const core = makeCore(owner, team, cleanups);
  core.ingest(create, "local");
  const req = new Request("http://localhost/v1/skills/propose", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ text: source, acknowledge_team: true }) });
  const response = await dispatch({ core, req, url: new URL(req.url), via: "cli",
    sync: {} as RouteCtx["sync"], client: {} as RouteCtx["client"], noTimeout: () => {} });
  expect(response.status).toBe(200);
  expect(core.roster.channels.get("skills")?.members).toBeUndefined();
  const posts = core.store.catalogEvents();
  expect(posts).toHaveLength(1);
  expect(posts[0]?.kind).toBe("msg.post");
  expect(posts[0]?.body).toEqual({ text: "proposed skill careful-review revision " + hash.slice(0, 12),
    skill: { op: "propose", name: "careful-review", sha256: hash, text: source } });
  core.emit("channel.upsert", { name: "skills", members: [owner.handle] });
  const restrictedReq = new Request(req.url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: source, acknowledge_team: true }) });
  await expect(dispatch({ core, req: restrictedReq, url: new URL(req.url), via: "cli",
    sync: {} as RouteCtx["sync"], client: {} as RouteCtx["client"], noTimeout: () => {} }))
    .rejects.toThrow("#skills must be a public team-wide channel");
});

test("signed prose revision reaches an offline second machine, verifies, loads, revokes and rolls back", async () => {
  const owner = tnode("owner"), peer = tnode("peer");
  const { team, create } = createTeam(owner);
  const first = makeCore(owner, team, cleanups);
  expect(first.ingest(create, "local").status).toBe("accepted");
  const roster = [first.emit("team.member", { login: peer.login, handle: peer.handle, role: "member" }),
    first.emit("team.node", { node_id: peer.keys.nodeId, login: peer.login, hostname: peer.hostname, pubkey: peer.keys.pubkey, ip: "127.0.0.1" }),
    first.emit("channel.upsert", { name: "skills" })];
  const proposal = emitSkill(first, "propose", { name: "careful-review", sha256: skillHash(source), text: source });
  expect(reconcileCatalog(first, ["walkie_skill"]).active).toEqual([]);
  const agentApproval = emitSkill(first, "approve", { name: "careful-review", sha256: hash }, "worker");
  expect(catalogState(first, ["walkie_skill"]).active).toEqual([]);
  const approval = emitSkill(first, "approve", { name: "careful-review", sha256: hash });
  const second = makeCore(peer, team, cleanups);
  feed(second, [create, ...roster, proposal, agentApproval, approval]);
  emitSkill(second, "approve", { name: "careful-review", sha256: hash });
  expect(catalogState(second, ["walkie_skill"]).heads["careful-review"]).toBe(approval.id);
  expect(reconcileCatalog(second, ["walkie_skill"]).active).toEqual(["careful-review"]);
  expect(readFileSync(join(second.paths.home, "skills/catalog/careful-review/SKILL.md"), "utf8")).toBe(source);
  writeFileSync(join(second.paths.home, "skills/catalog/careful-review/SKILL.md"), `${source}tampered`);
  expect(installedCatalog(second.paths.home, second, ["walkie_skill"])).toEqual([]);
  expect(reconcileCatalog(second, ["walkie_skill"]).active).toEqual(["careful-review"]);
  const client = { agent: "orchestrator", request: async (method: string, path: string) => {
    const req = new Request(`http://localhost${path}`, { method });
    const response = await dispatch({ core: second, req, url: new URL(req.url), via: "cli", agent: "orchestrator",
      sync: {} as RouteCtx["sync"], client: {} as RouteCtx["client"], noTimeout: () => {} });
    return response.json();
  } } as unknown as WalkieClient;
  const loaded = await callSkillTool(client, "walkie_skill", { name: "careful-review" }, TOOLS);
  expect(loaded.content[0]?.text).toContain(`team="${team}"`);
  expect(loaded.content[0]?.text).toContain(`revision="${hash}"`);
  expect(loaded.content[0]?.text).toContain("Read the diff and report defects.");
  expect(installedCatalog(second.paths.home, second, []).length).toBe(0);
  expect(reconcileCatalog(second, []).active).toEqual([]);
  const memberText = source.replace("careful-review", "member-review");
  const memberProposal = emitSkill(second, "propose", { name: "member-review", sha256: skillHash(memberText), text: memberText }, "worker");
  expect(memberProposal.author.agent).toBe("worker");
  expect(reconcileCatalog(second, ["walkie_skill"]).active).toEqual(["careful-review"]);
  const unavailable = source.replace("[walkie_skill]", "[missing_tool]");
  const next = emitSkill(first, "propose", { name: "careful-review", sha256: skillHash(unavailable), text: unavailable });
  const nextApproval = emitSkill(first, "approve", { name: "careful-review", sha256: skillHash(unavailable), prev: catalogState(first, ["walkie_skill"]).heads["careful-review"] });
  feed(second, [next, nextApproval]);
  expect(reconcileCatalog(second, ["walkie_skill"]).active).toEqual(["careful-review"]);
  expect(readFileSync(join(second.paths.home, "skills/catalog/careful-review/SKILL.md"), "utf8")).toBe(source);
  const newerText = source.replace("report defects.", "report verified defects.");
  const newer = emitSkill(first, "propose", { name: "careful-review", sha256: skillHash(newerText), text: newerText });
  const newerApproval = emitSkill(first, "approve", { name: "careful-review", sha256: skillHash(newerText), prev: catalogState(first, ["walkie_skill"]).heads["careful-review"] });
  feed(second, [newer, newerApproval]);
  expect(installedCatalog(second.paths.home, second, ["walkie_skill"]).map((s) => s.sha256)).toEqual([]);
  expect(reconcileCatalog(second, ["walkie_skill"]).active).toEqual(["careful-review"]);
  expect(readFileSync(join(second.paths.home, "skills/catalog/careful-review/SKILL.md"), "utf8")).toBe(newerText);
  writeFileSync(join(second.paths.home, "skills/catalog/careful-review/SKILL.md"), source);
  expect(installedCatalog(second.paths.home, second, ["walkie_skill"])).toEqual([]);
  reconcileCatalog(second, ["walkie_skill"]);
  const revoked = emitSkill(first, "revoke", { name: "careful-review", prev: catalogState(first, ["walkie_skill"]).heads["careful-review"] });
  // The second machine was offline for the revoke and catches up when it reconnects.
  feed(second, [revoked]);
  expect(reconcileCatalog(second, ["walkie_skill"]).active).toEqual([]);
  expect((await callSkillTool(client, "walkie_skill", { name: "careful-review" }, TOOLS)).content[0]?.text).toContain("Available skills");
  expect(existsSync(join(second.paths.home, "skills/catalog/careful-review/SKILL.md"))).toBe(false);
  const rollback = emitSkill(first, "rollback", { name: "careful-review", sha256: hash, prev: catalogState(first, ["walkie_skill"]).heads["careful-review"] });
  feed(second, [rollback]);
  expect(reconcileCatalog(second, ["walkie_skill"]).active).toEqual(["careful-review"]);
  const tampered = { ...approval, body: { text: "approved skill careful-review", skill: { op: "approve", name: "careful-review", sha256: "0".repeat(64) } } };
  const third = makeCore(tnode("third"), team, cleanups);
  feed(third, [create, ...roster, proposal]);
  expect(third.ingest(tampered, "remote").status).toBe("rejected");
  expect(reconcileCatalog(third, ["walkie_skill"]).active).toEqual([]);
});

test("local approval route refuses an agent and a phone before signing", async () => {
  const owner = tnode("owner");
  const { team, create } = createTeam(owner);
  const core = makeCore(owner, team, cleanups);
  core.ingest(create, "local");
  core.emit("channel.upsert", { name: "general" });
  core.emit("channel.upsert", { name: "skills" });
  emitSkill(core, "propose", { name: "careful-review", sha256: hash, text: source });
  const req = new Request("http://localhost/v1/skills/approve", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "careful-review", sha256: hash }) });
  const context = (extras: Partial<RouteCtx>): RouteCtx => ({ core, req, url: new URL(req.url), via: "cli",
    sync: {} as RouteCtx["sync"], client: {} as RouteCtx["client"], noTimeout: () => {}, ...extras });
  await expect(dispatch(context({ agent: "worker" }))).rejects.toThrow("agents can't approve");
  await expect(dispatch(context({ via: "phone" }))).rejects.toThrow("local terminal only");
  expect(core.store.catalogEvents().filter((e) => catalogOperation(e) === "approve")).toHaveLength(0);
  await expect(dispatch(context({}))).rejects.toThrow();
  const shown = new Request("http://localhost/v1/skills/careful-review");
  const detail = await dispatch(context({ req: shown, url: new URL(shown.url) }));
  const preview = (await detail.json()) as { versions: Array<{ preview_token: string; text: string }> };
  expect(preview.versions[0]?.text).toBe(source);
  const approved = new Request(req.url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "careful-review", sha256: hash, preview_token: preview.versions[0]?.preview_token }) });
  expect((await dispatch(context({ req: approved, url: new URL(approved.url) }))).status).toBe(200);
  expect(readFileSync(join(core.paths.home, "admin-audit.jsonl"), "utf8")).toContain(`approved team skill careful-review sha256 ${hash}`);
  expect(core.store.rowsForSync(core.nodeId, 0, core.store.vvOf(core.nodeId), 100).some((row) =>
    row.kind === "msg.post" && row.json.includes("approved team skill careful-review"))).toBe(true);
  const repeated = new Request(req.url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "careful-review", sha256: hash, preview_token: preview.versions[0]?.preview_token }) });
  await expect(dispatch(context({ req: repeated, url: new URL(repeated.url) }))).rejects.toThrow("preview the exact");
  const shell = new Request(req.url, { method: "POST", headers: { "content-type": "application/json", "X-Walkie-Talkie-Shell": "1" },
    body: JSON.stringify({ name: "careful-review", sha256: hash, preview_token: preview.versions[0]?.preview_token }) });
  await expect(dispatch(context({ req: shell, url: new URL(shell.url) }))).rejects.toThrow("Talkie shell cannot approve skills");
});

test("agent routes expose only installed active revisions and proposal admission refuses private text", async () => {
  const owner = tnode("owner");
  const { team, create } = createTeam(owner);
  const core = makeCore(owner, team, cleanups);
  core.ingest(create, "local");
  core.emit("channel.upsert", { name: "skills" });
  emitSkill(core, "propose", { name: "careful-review", sha256: hash, text: source });
  const pending = source.replace("report defects.", "report more defects.");
  emitSkill(core, "propose", { name: "careful-review", sha256: skillHash(pending), text: pending });
  emitSkill(core, "approve", { name: "careful-review", sha256: hash });
  reconcileCatalog(core, ["walkie_skill"]);
  const call = async (path: string, agent?: string, method = "GET", data?: unknown, projects?: RouteCtx["projects"]) => {
    const req = new Request(`http://localhost${path}`, { method,
      ...(data ? { headers: { "content-type": "application/json" }, body: JSON.stringify(data) } : {}) });
    return dispatch({ core, req, url: new URL(req.url), via: "cli", agent, projects,
      sync: {} as RouteCtx["sync"], client: {} as RouteCtx["client"], noTimeout: () => {} });
  };
  const list = await (await call("/v1/skills", "worker")).json() as { pending: unknown[]; active: unknown[] };
  expect(list.pending).toEqual([]);
  expect(list.active).toHaveLength(1);
  const shown = await (await call("/v1/skills/careful-review", "worker")).json() as { versions: Array<{ text: string }> };
  expect(shown.versions.map((s) => s.text)).toEqual([source]);
  const projectIndex = { flushAll: () => {}, projects: () => [{ name: "Secret Orchard", prefix: "SO", private: true }] } as unknown as RouteCtx["projects"];
  await expect(call("/v1/skills/propose", "worker", "POST", { text: source + " Secret Orchard", acknowledge_team: true }, projectIndex))
    .rejects.toThrow("private project text");
});

test("a later owner demotion does not erase a valid approval made while owner", () => {
  const owner = tnode("owner"), nextOwner = tnode("nextowner");
  const { team, create } = createTeam(owner);
  const first = makeCore(owner, team, cleanups);
  first.ingest(create, "local");
  const roster = [first.emit("team.member", { login: nextOwner.login, handle: nextOwner.handle, role: "owner" }),
    first.emit("team.node", { node_id: nextOwner.keys.nodeId, login: nextOwner.login,
      hostname: nextOwner.hostname, pubkey: nextOwner.keys.pubkey, ip: "127.0.0.1" }),
    first.emit("channel.upsert", { name: "skills" })];
  const proposal = emitSkill(first, "propose", { name: "careful-review", sha256: hash, text: source });
  const approval = emitSkill(first, "approve", { name: "careful-review", sha256: hash });
  const transfer = first.emit("team.authority", { node_id: nextOwner.keys.nodeId });
  const second = makeCore(nextOwner, team, cleanups);
  feed(second, [create, ...roster, proposal, approval, transfer]);
  second.emit("team.member", { login: owner.login, handle: owner.handle, role: "member" });
  expect(second.roster.members.get(owner.login)?.role).toBe("member");
  expect(second.rosterAt(approval.origin, approval.seq).members.get(owner.login)?.role).toBe("owner");
  expect(reconcileCatalog(second, ["walkie_skill"]).active).toEqual(["careful-review"]);
});

test("a second owner's revoke with a clock twenty seconds behind defeats approval on both machines", () => {
  const firstOwner = tnode("first"), secondOwner = tnode("second");
  const { team, create } = createTeam(firstOwner);
  const first = makeCore(firstOwner, team, cleanups, { clock: () => now() + 20_000 });
  first.ingest(create, "local");
  const roster = [first.emit("team.member", { login: secondOwner.login, handle: secondOwner.handle, role: "owner" }),
    first.emit("team.node", { node_id: secondOwner.keys.nodeId, login: secondOwner.login,
      hostname: secondOwner.hostname, pubkey: secondOwner.keys.pubkey, ip: "127.0.0.1" }),
    first.emit("channel.upsert", { name: "skills" })];
  const proposal = emitSkill(first, "propose", { name: "careful-review", sha256: hash, text: source });
  const approval = emitSkill(first, "approve", { name: "careful-review", sha256: hash });
  const second = makeCore(secondOwner, team, cleanups, { clock: now });
  feed(second, [create, ...roster, proposal, approval]);
  const revoke = emitSkill(second, "revoke", { name: "careful-review", prev: approval.id });
  expect(revoke.ts).toBeLessThan(approval.ts);
  expect(reconcileCatalog(second, ["walkie_skill"]).active).toEqual([]);
  feed(first, [revoke]);
  expect(reconcileCatalog(first, ["walkie_skill"]).active).toEqual([]);
});
