// WALK-72 OFFBOARD-1 phase 0, fix round: `walkie team offboard --plan` (read-only) and `--apply`.
// Suspend, then the existing removal. On this machine, revoke the key of the owner who minted the grant
// (owner_ssh.owner_handle), never the caller's own line. No guest-token step. A roster write is never left queued.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WalkieClient, WalkieError } from "../../src/client/index.ts";
import { mintOwnerSshGrant } from "../../src/daemon/ssh/grant.ts";
import { authorizeOwnerKey, hasOwnerKey } from "../../src/daemon/ssh/authorized-keys.ts";
import { Vault } from "../../src/accounts/vault/vault.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { flushRequests } from "../../src/daemon/requests.ts";
import { OFFBOARD_APPLY_TIMEOUT_MS, OFFBOARD_AUTHORITY_HOPS, OFFBOARD_FLUSH_WAIT_MS, OFFBOARD_HOP_TIMEOUT_MS, OFFBOARD_SEND_TIMEOUT_MS } from "../../src/daemon/peer-timeouts.ts";
import { RECEIPT_PEER_TIMEOUT_MS } from "../../src/daemon/ssh/team-revocation.ts";
import { Cluster, TEST_LIMITS, waitFor, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson, runConfirmed } from "../helpers/person-cli.ts";
import { publicKey } from "../helpers/ssh-team.ts";

/** The reply when the 20 s flush wait ends while this person's row is still inside send. */
const STILL_IN_FLIGHT = "a roster send for @noor was still in flight when offboard proceeded; re-run --plan to confirm";

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
const HIDDEN_CHANNEL = "noor-maren-private";
const ARCHIVED_CHANNEL = "noor-archive";

interface Plan {
  handle: string;
  role: string;
  scope: "this-machine";
  read_only: true;
  will: {
    suspend_to_observer: boolean;
    remove: boolean;
    revoke_nodes: { node_id: string; hostname: string }[];
    drop_restricted_channels: string[];
    hidden_restricted_channels: number;
    revoke_ssh_grant: boolean;
  };
  will_not: Record<string, string>;
  found: {
    cards: { key: string; assignee: string | null; reviewer: string | null; matches: string[] }[];
    asks: { id: string; to: string; state: string }[];
    schedules: { id: string; name: string; created_by: string }[];
    integrations: { connector: string; node_id: string; hostname: string }[];
    seats: { id: string; host_handle: string; launcher_handle: string }[];
    vault_shares: { id: string; policy: string; share_with: string[]; why: string }[];
    files: { name: string; why: string }[];
  };
  limits: string[];
  facts: string[];
  apply: { order: string[]; refused?: string };
}
interface Step { step: string; status: "done" | "skipped"; detail: string }
interface Applied { handle: string; role: string; steps: Step[] }

let c: Cluster;
let alex: TestNode;
let noor: TestNode;
let maren: TestNode;
let bea: TestNode;
let sshHome = "";
let channel = "";
let deletedId = "";
let scheduleId = "";

const planOf = (node: TestNode, handle: string) => node.client().request<Plan>("GET", `/v1/team/offboard/plan?handle=${encodeURIComponent(handle)}`);
const applyOf = (node: TestNode, handle: string, reassign?: string) => node.client().request<Applied>("POST", "/v1/team/offboard", {
  handle, ...(reassign ? { reassign_to: reassign } : {}),
});

function walkie(node: TestNode, args: string[], env: Record<string, string> = {}) {
  return runAsPerson([process.execPath, CLI, ...args], {
    PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: node.home, WALKIE_SOCKET: node.socket, ...env,
  });
}

function memberEvents(node: TestNode, handle: string): Event[] {
  return node.d.core.rosterEntries().filter((e) => e.kind === "team.member" && (e.body as { handle?: string }).handle === handle);
}

function memberRoles(node: TestNode, handle: string): string[] {
  return memberEvents(node, handle).map((e) => `${(e.body as { role?: string }).role}@${e.seq}`);
}

/** True when an observer role is signed after the first removal. A catch-up that already shows removed must not do that. */
function observerAfterRemoved(node: TestNode, handle: string): boolean {
  const roles = memberRoles(node, handle);
  const removedAt = roles.findIndex((role) => role.startsWith("removed@"));
  return removedAt >= 0 && roles.slice(removedAt + 1).some((role) => role.startsWith("observer@"));
}

function sshReceipts(node: TestNode): number {
  return node.d.core.store.queryEvents({ channel: "general", kinds: ["msg.post"], limit: 500 })
    .filter((row) => String((JSON.parse(row.json) as { body?: { text?: string } }).body?.text ?? "").startsWith("walkie:ssh-revoke:v1:")).length;
}

function writeGrant(home: string, teamId: string, owner: TestNode, ownerHandle: string, recipient: string, target: string, sshState: "active" | "denied"): void {
  const ownerSsh = mintOwnerSshGrant(owner.d.core.keys, {
    team_id: teamId, owner_handle: ownerHandle, recipient,
    invite_id: "ab".repeat(16), public_key: publicKey(), expires_at: Date.now() + 10 * 86_400_000,
  });
  const grant = {
    team_id: teamId, owner_node: owner.d.nodeId, target_node: target, recipient,
    consent_text: "Allow the offboard fixture to revoke this test grant.", consent_version: 1, company_mode: true,
    launchers: ["@alex"], seat_cap: 2, profiles: [{ id: "developer-worker", version: 3 }],
    owner_ssh: ownerSsh, ssh_state: sshState, created_at: Date.now(), expires_at: Date.now() + 10 * 86_400_000,
  };
  const path = join(home, "provision-grant.json");
  writeFileSync(path, `${JSON.stringify(grant)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

beforeAll(async () => {
  c = new Cluster();
  sshHome = join(c.root, "ssh-home");
  mkdirSync(sshHome, { recursive: true });
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", sshUserHome: sshHome });
  noor = await c.add({ name: "noor", login: "noor@example.com", hostname: "noor-mbp" });
  maren = await c.add({ name: "maren", login: "maren@example.com", hostname: "maren-mbp" });
  bea = await c.add({ name: "bea", login: "bea@example.com", hostname: "bea-mbp" });
  await alex.client().init("acme", "alex");
  await alex.client().invite("noor@example.com", "noor", "member");
  await alex.client().invite("maren@example.com", "maren", "member");
  await alex.client().invite("bea@example.com", "bea", "owner");
  expect((await noor.client().join(alex.peerAddr)).admitted).toBe(true);
  expect((await maren.client().join(alex.peerAddr)).admitted).toBe(true);
  expect((await bea.client().join(alex.peerAddr)).admitted).toBe(true);
  await waitFor(() => noor.d.core.roster.nodes.has(alex.d.nodeId) && alex.d.core.roster.nodes.has(bea.d.nodeId), { what: "team synced" });
  await alex.client().setRole("maren", "observer");

  const project = (await alex.client().createProject({ name: "Offboard" })).project;
  channel = project.channel;
  const assigned = (await alex.client().createTask({ project: project.prefix, title: "Assigned", assignee: "@noor" })).task;
  await alex.client().createTask({ project: project.prefix, title: "Reviewed", assignee: "@alex", reviewer: "@noor" });
  await alex.client().createTask({ project: project.prefix, title: "Agent card", assignee: "@noor/noor-mbp/helper" });
  await alex.client().createTask({ project: project.prefix, title: "Someone else", assignee: "@alex" });
  const gone = (await alex.client().createTask({ project: project.prefix, title: "Gone", assignee: "@noor" })).task;
  deletedId = gone.id;
  await alex.client().updateTask(gone.key, { state: "deleted" });
  expect(assigned.key).toMatch(/-1$/);

  await alex.client().request("POST", "/v1/channels", { name: "owners-room", members: ["alex", "noor"] });
  await alex.client().request("POST", "/v1/channels", { name: "lobby" });
  // Restricted channels the caller is not in, one of them archived. The plan may count them, not name them.
  alex.d.core.emit("channel.upsert", { name: HIDDEN_CHANNEL, members: ["noor", "maren"] });
  alex.d.core.emit("channel.upsert", { name: ARCHIVED_CHANNEL, members: ["noor"], archived: true });

  const openPerson = (await alex.client().ask({ to: "@noor", text: "are you there?" })).event.id;
  const openAgent = (await alex.client().ask({ to: "@noor/noor-mbp/helper", text: "agent ping" })).event.id;
  await alex.client().ask({ to: "@alex", text: "note to self" });
  const answered = (await alex.client().ask({ to: "@noor", text: "status?" })).event;
  await waitFor(() => noor.d.core.store.asks().some((row) => row.id === answered.id), { what: "noor has the ask" });
  await noor.client().answer({ ask: answered.id, text: "done" });
  await waitFor(() => alex.d.core.store.replies(answered.id).length > 0, { what: "answer synced" });
  alex.d.core.emit("ask", { to: "@noor/cloud/dots-helper", text: "cloud ping", expires_at: Date.now() + 60_000 });
  void openPerson; void openAgent;

  await alex.client().roomAdd(channel, new TextEncoder().encode("alex notes"), { name: "alex-notes.txt", mime: "text/plain" });
  await waitFor(() => { noor.d.projects.flushAll(); return noor.d.projects.room(channel).some((f) => f.name === "alex-notes.txt"); }, { what: "noor sees the room" });
  const alexFile = noor.d.projects.room(channel).find((f) => f.name === "alex-notes.txt");
  await noor.client().roomAdd(channel, new TextEncoder().encode("noor version"), { name: "alex-notes.txt", mime: "text/plain", file: alexFile?.id });
  await noor.client().roomAdd(channel, new TextEncoder().encode("noor notes"), { name: "noor-notes.txt", mime: "text/plain" });
  await waitFor(() => {
    alex.d.projects.flushAll();
    return alex.d.projects.room(channel).some((f) => f.name === "noor-notes.txt" && f.state === "active");
  }, { what: "alex sees noor's file" });

  alex.d.core.emit("channel.upsert", { name: "talkie-schedules" });
  const put = (created_by: string, name: string) => {
    const id = crypto.randomUUID();
    const schedule = {
      id, name, cron: "15 9 * * 1", task: { prompt: "look at the board" }, enabled: true, created_by,
      last_run: null, next_run: null, last_result: null, failures: 0, run_id: null,
    };
    alex.d.core.emit("msg.post", {
      text: `walkie-talkie-schedule:v1:${JSON.stringify({ op: "put", schedule, term: 0, after: null })}`,
    }, { channel: "talkie-schedules" });
    return id;
  };
  scheduleId = put("noor", "Noor duty");
  put("alex", "Alex duty");

  alex.d.core.emit("team.integration", { connector: "linear", node: noor.d.nodeId, enabled: true });
  alex.d.core.emit("team.integration", { connector: "wispr", node: alex.d.nodeId, enabled: true });

  // This machine's grant was minted by bea. The recipient is this machine's own person, as the product always sets it.
  writeGrant(alex.home, alex.d.core.teamId as string, bea, "bea", "alex", alex.d.nodeId, "active");
  authorizeOwnerKey(sshHome, alex.d.core.teamId as string, "bea", publicKey());
  authorizeOwnerKey(sshHome, alex.d.core.teamId as string, "alex", publicKey());
}, 120_000);

afterAll(async () => { await c?.close(); });

describe("walkie team offboard phase 0", () => {
  test("plan lists what removal will and will not do, and changes nothing", async () => {
    const chain = alex.d.core.chainLength;
    alex.d.projects.flushAll();
    const beforeCard = alex.d.projects.db.cards(channel, { limit: 20 }).find((card) => card.title === "Assigned");
    const plan = await planOf(alex, "noor");
    expect(alex.d.core.chainLength).toBe(chain);
    alex.d.projects.flushAll();
    expect(alex.d.projects.db.cards(channel, { limit: 20 }).find((card) => card.title === "Assigned")?.assignee).toBe(beforeCard?.assignee);
    expect(hasOwnerKey(sshHome, alex.d.core.teamId as string, "bea")).toBe(true);
    expect(hasOwnerKey(sshHome, alex.d.core.teamId as string, "alex")).toBe(true);

    expect(plan.handle).toBe("noor");
    expect(plan.role).toBe("member");
    expect(plan.scope).toBe("this-machine");
    expect(plan.read_only).toBe(true);
    expect(plan.will.suspend_to_observer).toBe(true);
    expect(plan.will.remove).toBe(true);
    expect(plan.will.revoke_nodes.map((n) => n.hostname)).toEqual(["noor-mbp"]);
    expect(plan.will.drop_restricted_channels).toEqual(["owners-room"]);
    expect(plan.will.hidden_restricted_channels).toBe(2);
    expect(plan.will.revoke_ssh_grant).toBe(false);
    expect(plan.will).not.toHaveProperty("revoke_guest_tokens");
    expect(plan.found).not.toHaveProperty("guest_tokens");
    expect(plan.apply.order).toEqual(["suspend", "remove", "ssh_grant", "reassign_cards"]);
    const dumped = JSON.stringify(plan);
    expect(dumped).not.toContain(HIDDEN_CHANNEL);
    expect(dumped).not.toContain(ARCHIVED_CHANNEL);

    const beaPlan = await planOf(alex, "bea");
    expect(beaPlan.will.revoke_ssh_grant).toBe(true);
    expect(JSON.stringify(beaPlan)).not.toContain(HIDDEN_CHANNEL);

    expect(plan.found.cards.map((card) => card.key).sort()).toEqual(
      plan.found.cards.filter((card) => card.key.endsWith("-1") || card.key.endsWith("-2") || card.key.endsWith("-3")).map((card) => card.key).sort(),
    );
    const byTitle = new Map(alex.d.projects.db.cards(channel, { limit: 20 }).map((card) => [card.title, card]));
    const keys = new Map(plan.found.cards.map((card) => [card.key, card]));
    expect(keys.get(byTitle.get("Assigned")!.key)?.matches).toEqual(["assignee"]);
    expect(keys.get(byTitle.get("Reviewed")!.key)?.matches.sort()).toEqual(["reviewer"]);
    expect(keys.get(byTitle.get("Agent card")!.key)?.matches).toEqual(["assignee"]);
    expect(keys.has(byTitle.get("Someone else")!.key)).toBe(false);
    expect(keys.has(byTitle.get("Gone")!.key)).toBe(false);

    expect(plan.found.asks.map((ask) => ask.to).sort()).toEqual(["@noor", "@noor/cloud/dots-helper", "@noor/noor-mbp/helper"]);
    expect(plan.found.asks.every((ask) => ask.state === "open")).toBe(true);
    expect(plan.found.schedules).toEqual([{ id: scheduleId, name: "Noor duty", created_by: "noor" }]);
    expect(plan.found.integrations).toEqual([{ connector: "linear", node_id: noor.d.nodeId, hostname: "noor-mbp" }]);
    expect(plan.found.seats).toEqual([]);
    expect(plan.found.files.map((f) => `${f.name}:${f.why}`).sort()).toEqual(["alex-notes.txt:version", "noor-notes.txt:created"]);
    expect(plan.found.vault_shares).toEqual([]);

    const text = JSON.stringify(plan.will_not) + plan.facts.join(" ") + plan.limits.join(" ");
    expect(text).toMatch(/stay/i);
    expect(text).toMatch(/memory/i);
    expect(text).toMatch(/other machines/i);
    expect(text).toMatch(/not stopped/i);
    expect(text).toMatch(/paused/i);
    expect(text).toMatch(/queued/i);
    expect(text).toMatch(/private projects the caller cannot see are neither listed nor reassigned/i);
    expect(text).toMatch(/guest tokens issued on their own machines/i);
    expect(text).toMatch(/guest tokens on other machines are not touched/i);

    const vault = Vault.open(alex.home);
    vault.close();
    const db = new Database(join(alex.home, "vault.db"));
    const now = Date.now();
    db.query(`INSERT INTO accounts (id, provider, label, plan, policy, share_with, created_at, expires_at, secret, home, linked, gen, home_at, personal)
      VALUES ('shared-with-noor', 'claude', 'Shared login', NULL, 'shared', '["noor"]', ?, NULL, NULL, NULL, 0, '', ?, 0)`).run(now, now);
    db.query(`INSERT INTO accounts (id, provider, label, plan, policy, share_with, created_at, expires_at, secret, home, linked, gen, home_at, personal)
      VALUES ('local-only', 'claude', 'Local login', NULL, 'local', '[]', ?, NULL, NULL, NULL, 0, '', ?, 0)`).run(now, now);
    db.close();
    const again = await planOf(alex, "@noor");
    expect(again.found.vault_shares).toEqual([{ id: "shared-with-noor", policy: "shared", share_with: ["noor"], why: "shared_with_them" }]);
    expect(again.read_only).toBe(true);

    const jsonPlan = await walkie(alex, ["team", "--json", "offboard", "noor", "--plan"]);
    expect(jsonPlan.code).toBe(0);
    const parsed = JSON.parse(jsonPlan.out) as Plan;
    expect(parsed.handle).toBe("noor");
    expect(parsed.will.hidden_restricted_channels).toBe(2);
    expect(jsonPlan.out).not.toContain(HIDDEN_CHANNEL);
    const plain = await walkie(alex, ["team", "offboard", "noor", "--plan"]);
    expect(plain.code).toBe(0);
    expect(plain.out).toMatch(/hidden from this caller/i);
    expect(plain.out).not.toContain(HIDDEN_CHANNEL);
  }, 60_000);

  test("refuses agents, the dashboard, self, and a bad reassign target", async () => {
    const role = () => alex.d.core.roster.members.get("noor@example.com")?.role;
    const before = role();
    let agentMessage = "";
    try {
      await alex.client("helper").request("GET", "/v1/team/offboard/plan?handle=noor");
    } catch (err) {
      agentMessage = err instanceof Error ? err.message : String(err);
      expect(err).toMatchObject({ status: 403, code: "person_only" });
    }
    expect(agentMessage).not.toMatch(/dashboard/i);
    expect(agentMessage).toMatch(/terminal/i);
    await expect(alex.client("helper").request("POST", "/v1/team/offboard", { handle: "noor" })).rejects.toMatchObject({ status: 403, code: "person_only" });
    // bea is still an owner, so this is self, not the last owner.
    await expect(alex.client().request("POST", "/v1/team/offboard", { handle: "alex" })).rejects.toMatchObject({ status: 409, code: "self" });
    await expect(alex.client().request("POST", "/v1/team/offboard", { handle: "nobody" })).rejects.toMatchObject({ status: 404 });
    try {
      await alex.client().request("POST", "/v1/team/offboard", { handle: "Nope" });
      throw new Error("expected a bad handle to be refused");
    } catch (err) {
      expect(err).toMatchObject({ status: 400 });
      expect(err).toBeInstanceOf(WalkieError);
      expect((err as Error).message).toMatch(/noor/);
    }
    await expect(alex.client().request("POST", "/v1/team/offboard", { handle: "noor/noor-mbp" })).rejects.toMatchObject({ status: 400 });
    await expect(alex.client().request("POST", "/v1/team/offboard", { handle: "noor", reassign_to: "@noor/noor-mbp" })).rejects.toMatchObject({ status: 400 });
    await expect(alex.client().request("POST", "/v1/team/offboard", { handle: "noor", reassign_to: "@nobody" })).rejects.toMatchObject({ status: 404 });
    await expect(noor.client().request("POST", "/v1/team/offboard", { handle: "maren" })).rejects.toMatchObject({ status: 403 });
    expect(role()).toBe(before);
    expect(alex.d.core.me()?.role).toBe("owner");

    const port = alex.d.localPort as number;
    const origin = `http://127.0.0.1:${port}`;
    const nonce = (await alex.client().authNonce()).nonce;
    const login = await fetch(`${origin}/auth?nonce=${nonce}`, { redirect: "manual" });
    const session = /^\/#s=([0-9a-f]{64})$/.exec(login.headers.get("location") ?? "")?.[1];
    expect(session).toMatch(/^[0-9a-f]{64}$/);
    const headers = { Origin: origin, "X-Walkie-Session": session as string, "Content-Type": "application/json" };
    const dashPlan = await fetch(`${origin}/v1/team/offboard/plan?handle=noor`, { headers });
    const dashApply = await fetch(`${origin}/v1/team/offboard`, { method: "POST", headers, body: JSON.stringify({ handle: "noor" }) });
    expect(dashPlan.status).toBe(403);
    expect(dashApply.status).toBe(403);
    expect(role()).toBe(before);
  }, 30_000);

  test("apply of an observer skips suspend, then removes them", async () => {
    const before = memberEvents(alex, "maren").length;
    const observers = memberEvents(alex, "maren").filter((e) => (e.body as { role?: string }).role === "observer").length;
    const applied = await applyOf(alex, "maren");
    expect(applied.steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      "queued_roles:skipped", "suspend:skipped", "remove:done", "ssh_grant:skipped", "reassign_cards:skipped",
    ]);
    expect(alex.d.core.roster.members.get("maren@example.com")?.role).toBe("removed");
    expect(memberEvents(alex, "maren").length).toBe(before + 1);
    expect(memberEvents(alex, "maren").filter((e) => (e.body as { role?: string }).role === "observer").length).toBe(observers);
    expect(hasOwnerKey(sshHome, alex.d.core.teamId as string, "bea")).toBe(true);
    expect(hasOwnerKey(sshHome, alex.d.core.teamId as string, "alex")).toBe(true);
  }, 30_000);

  test("apply suspends, removes, leaves the caller's key, and reassigns only visible cards", async () => {
    const applied = await applyOf(alex, "noor", "@alex");
    expect(applied.steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      "queued_roles:skipped", "suspend:done", "remove:done", "ssh_grant:skipped", "reassign_cards:done",
    ]);
    expect(applied.steps.find((s) => s.step === "ssh_grant")?.detail).toMatch(/minted by @bea/);
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("removed");
    expect(alex.d.core.roster.nodes.get(noor.d.nodeId)?.revoked).toBe(true);
    expect(alex.d.core.roster.channels.get("owners-room")?.members ?? []).not.toContain("noor");
    expect(hasOwnerKey(sshHome, alex.d.core.teamId as string, "bea")).toBe(true);
    expect(hasOwnerKey(sshHome, alex.d.core.teamId as string, "alex")).toBe(true);

    const noorMembers = memberEvents(alex, "noor");
    const observer = noorMembers.find((e) => (e.body as { role?: string }).role === "observer");
    const removed = noorMembers.find((e) => (e.body as { role?: string }).role === "removed");
    expect(observer && removed && observer.seq < removed.seq).toBe(true);
    alex.d.projects.flushAll();
    const cards = alex.d.projects.db.cards(channel, { limit: 20 });
    expect(cards.find((card) => card.title === "Assigned")?.assignee).toBe("@alex");
    expect(cards.find((card) => card.title === "Reviewed")?.reviewer).toBe("@alex");
    expect(cards.find((card) => card.title === "Reviewed")?.assignee).toBe("@alex");
    expect(cards.find((card) => card.title === "Agent card")?.assignee).toBe("@alex");
    expect(cards.find((card) => card.title === "Someone else")?.assignee).toBe("@alex");
    expect(alex.d.projects.db.card(deletedId)?.assignee).toBe("@noor");
    const posts = alex.d.core.store.queryEvents({ kinds: ["msg.post"], limit: 2_000 });
    const cardSeqs = posts.filter((row) => {
      if (row.channel !== channel || !removed || row.seq <= removed.seq) return false;
      const op = ((JSON.parse(row.json) as Event).body as { board?: { op?: string; assignee?: string; reviewer?: string } }).board;
      return op?.op === "card" && (op.assignee === "@alex" || op.reviewer === "@alex");
    }).map((row) => row.seq);
    expect(cardSeqs.length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  test("a second apply is idempotent and does not re-admit them", async () => {
    const before = memberEvents(alex, "noor").length;
    const chain = alex.d.core.chainLength;
    const boardPosts = alex.d.core.store.channelEventCount(channel);
    const generalPosts = alex.d.core.store.channelEventCount("general");
    const again = await applyOf(alex, "noor", "@alex");
    expect(again.steps.every((s) => s.status === "skipped")).toBe(true);
    expect(again.steps.map((s) => s.step)).toEqual(["queued_roles", "suspend", "remove", "ssh_grant", "reassign_cards"]);
    expect(memberEvents(alex, "noor").length).toBe(before);
    expect(alex.d.core.chainLength).toBe(chain);
    expect(alex.d.core.store.channelEventCount(channel)).toBe(boardPosts);
    expect(alex.d.core.store.channelEventCount("general")).toBe(generalPosts);
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("removed");
    const removedSeq = memberEvents(alex, "noor").find((e) => (e.body as { role?: string }).role === "removed")?.seq ?? 0;
    expect(memberEvents(alex, "noor").some((e) => (e.body as { role?: string }).role === "observer" && e.seq > removedSeq)).toBe(false);
    alex.d.projects.flushAll();
    expect(alex.d.projects.db.cards(channel, { limit: 20 }).find((card) => card.title === "Assigned")?.assignee).toBe("@alex");
  }, 30_000);

  test("apply removes the departing owner's key line and keeps the caller's", async () => {
    const receipts = sshReceipts(alex);
    const general = alex.d.core.store.channelEventCount("general");
    const applied = await applyOf(alex, "bea");
    expect(applied.steps.map((s) => `${s.step}:${s.status}`)).toEqual([
      "queued_roles:skipped", "suspend:done", "remove:done", "ssh_grant:done", "reassign_cards:skipped",
    ]);
    expect(alex.d.core.roster.members.get("bea@example.com")?.role).toBe("removed");
    expect(hasOwnerKey(sshHome, alex.d.core.teamId as string, "bea")).toBe(false);
    expect(hasOwnerKey(sshHome, alex.d.core.teamId as string, "alex")).toBe(true);
    expect(sshReceipts(alex)).toBe(receipts + 1);
    const removed = memberEvents(alex, "bea").find((e) => (e.body as { role?: string }).role === "removed");
    const receipt = alex.d.core.store.queryEvents({ channel: "general", kinds: ["msg.post"], limit: 500 }).find((row) => {
      return String((JSON.parse(row.json) as { body?: { text?: string } }).body?.text ?? "").startsWith("walkie:ssh-revoke:v1:");
    });
    expect(receipt && removed && receipt.seq > removed.seq).toBe(true);
    expect(alex.d.core.store.channelEventCount("general")).toBeGreaterThan(general);

    const chain = alex.d.core.chainLength;
    const posts = alex.d.core.store.channelEventCount("general");
    const again = await applyOf(alex, "bea");
    expect(again.steps.every((s) => s.status === "skipped")).toBe(true);
    expect(again.steps.find((s) => s.step === "ssh_grant")?.status).toBe("skipped");
    expect(sshReceipts(alex)).toBe(receipts + 1);
    expect(alex.d.core.chainLength).toBe(chain);
    expect(alex.d.core.store.channelEventCount("general")).toBe(posts);
    expect(hasOwnerKey(sshHome, alex.d.core.teamId as string, "alex")).toBe(true);
    const removedSeq = removed?.seq ?? 0;
    expect(memberEvents(alex, "bea").some((e) => (e.body as { role?: string }).role === "observer" && e.seq > removedSeq)).toBe(false);
  }, 30_000);

  test("the last remaining owner cannot be offboarded", async () => {
    await expect(alex.client().request("POST", "/v1/team/offboard", { handle: "alex" })).rejects.toMatchObject({ status: 409, code: "last_owner" });
    expect(alex.d.core.me()?.role).toBe("owner");
  });

  test("the CLI plans without a prompt and confirms before apply", async () => {
    const usage = await walkie(alex, ["team", "offboard", "noor"]);
    expect(usage.code).not.toBe(0);
    expect(usage.err).toMatch(/--plan or --apply/);
    const help = await walkie(alex, ["help"]);
    expect(help.out).toMatch(/team offboard/);
    const agent = await walkie(alex, ["team", "offboard", "noor", "--plan"], { WALKIE_AGENT: "helper" });
    expect(agent.code).not.toBe(0);
    expect(agent.err + agent.out).toMatch(/person_only|agents can't/);
    expect(agent.err + agent.out).not.toMatch(/dashboard/i);
    const plain = await walkie(alex, ["team", "offboard", "@noor", "--plan"]);
    expect(plain.code).toBe(0);
    expect(plain.out).toMatch(/stays on their machines/i);
    expect(plain.out).toMatch(/memory/i);
    const flagged = await walkie(alex, ["team", "--json", "offboard", "noor", "--plan"]);
    expect(flagged.code).toBe(0);
    expect((JSON.parse(flagged.out) as Plan).handle).toBe("noor");
    const confirmed = await runConfirmed([process.execPath, CLI, "team", "offboard", "noor", "--apply", "--reassign-to", "@alex", "--json"], {
      PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: alex.home, WALKIE_SOCKET: alex.socket,
    }, "noor");
    expect(confirmed.code).toBe(0);
    const body = JSON.parse(confirmed.out) as Applied;
    expect(body.steps.every((s) => s.status === "skipped")).toBe(true);
    expect(body.steps.map((s) => s.step)).not.toContain("guest_tokens");
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("removed");
  }, 60_000);
});

describe("offboard does not queue a role change while the authority is down", () => {
  let cluster: Cluster;
  let authority: TestNode;
  let olive: TestNode;
  let member: TestNode;

  beforeAll(async () => {
    cluster = new Cluster();
    authority = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
    member = await cluster.add({ name: "noor", login: "noor@example.com", hostname: "noor-mbp" });
    olive = await cluster.add({ name: "olive", login: "olive@example.com", hostname: "olive-mbp" });
    await authority.client().init("acme", "alex");
    await authority.client().invite("noor@example.com", "noor", "member");
    await authority.client().invite("olive@example.com", "olive", "owner");
    expect((await member.client().join(authority.peerAddr)).admitted).toBe(true);
    expect((await olive.client().join(authority.peerAddr)).admitted).toBe(true);
    await waitFor(() => olive.d.core.roster.members.get("noor@example.com")?.role === "member" && !olive.d.core.isAuthority(), { what: "olive sees noor and is not the authority" });
  }, 60_000);

  afterAll(async () => { await cluster?.close(); });

  test("authority down returns an error, leaves the queue empty, and a later removal stays removed", async () => {
    await authority.stop();
    await expect(olive.client().request("POST", "/v1/team/offboard", { handle: "noor" })).rejects.toMatchObject({
      status: 409, code: "offboard_unreachable",
      message: expect.stringMatching(/was not changed by this step[\s\S]*nothing was signed or queued[\s\S]*re-running walkie team offboard is safe/i),
    });
    expect(olive.d.core.store.queuedRequests()).toEqual([]);
    expect(olive.d.core.roster.members.get("noor@example.com")?.role).toBe("member");
    await authority.start();
    authority.d.core.emit("team.member", { login: "noor@example.com", handle: "noor", role: "removed" });
    await waitFor(() => olive.d.core.roster.members.get("noor@example.com")?.role === "removed", { what: "removal synced", timeoutMs: 20_000 });
    expect(olive.d.core.store.queuedRequests()).toEqual([]);
    expect(authority.d.core.roster.members.get("noor@example.com")?.role).toBe("removed");
    const after = (node: TestNode) => {
      const events = memberEvents(node, "noor");
      const removedSeq = events.find((e) => (e.body as { role?: string }).role === "removed")?.seq ?? 0;
      return events.some((e) => (e.body as { role?: string }).role === "observer" && e.seq > removedSeq);
    };
    expect(after(authority)).toBe(false);
    expect(after(olive)).toBe(false);
  }, 60_000);
});

describe("a roster send that fails after it was attempted", () => {
  let cluster: Cluster;
  let alex: TestNode;
  let olive: TestNode;

  beforeAll(async () => {
    cluster = new Cluster();
    alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", limits: { ...TEST_LIMITS, humanWrite: { capacity: 1_000, perSecond: 0.001 } } });
    const noor = await cluster.add({ name: "noor", login: "noor@example.com", hostname: "noor-mbp" });
    olive = await cluster.add({ name: "olive", login: "olive@example.com", hostname: "olive-mbp" });
    await alex.client().init("acme", "alex");
    await alex.client().invite("noor@example.com", "noor", "member");
    await alex.client().invite("olive@example.com", "olive", "owner");
    expect((await noor.client().join(alex.peerAddr)).admitted).toBe(true);
    expect((await olive.client().join(alex.peerAddr)).admitted).toBe(true);
    await waitFor(() => olive.d.core.roster.members.get("noor@example.com")?.role === "member" && !olive.d.core.isAuthority(), { what: "olive synced" });
  }, 60_000);

  afterAll(async () => { await cluster?.close(); });

  test("HTTP 429 after the catch-up says the change may or may not have been applied and queues nothing", async () => {
    const key = `roster:${olive.d.nodeId}`;
    const spec = alex.d.core.limits.humanWrite;
    while (alex.d.core.limiter.take(key, spec)) { /* olive's next roster request is refused */ }
    await expect(olive.client().request("POST", "/v1/team/offboard", { handle: "noor" })).rejects.toMatchObject({
      status: 409, code: "offboard_unreachable",
      message: expect.stringMatching(/may or may not have been applied[\s\S]*re-running walkie team offboard is safe/i),
    });
    expect(olive.d.core.store.queuedRequests()).toEqual([]);
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("member");
    expect(memberRoles(alex, "noor").some((row) => row.startsWith("observer@"))).toBe(false);
  }, 30_000);
});

describe("offboard retries an SSH team receipt that was never posted", () => {
  let cluster: Cluster;
  let owner: TestNode;
  let departing: TestNode;
  let home = "";

  beforeAll(async () => {
    cluster = new Cluster();
    home = join(cluster.root, "ssh-home");
    mkdirSync(home, { recursive: true });
    owner = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", sshUserHome: home });
    departing = await cluster.add({ name: "bea", login: "bea@example.com", hostname: "bea-mbp" });
    await owner.client().init("acme", "alex");
    await owner.client().invite("bea@example.com", "bea", "owner");
    expect((await departing.client().join(owner.peerAddr)).admitted).toBe(true);
    await waitFor(() => owner.d.core.roster.nodes.has(departing.d.nodeId), { what: "bea joined" });
    writeGrant(owner.home, owner.d.core.teamId as string, departing, "bea", "alex", owner.d.nodeId, "denied");
    authorizeOwnerKey(home, owner.d.core.teamId as string, "bea", publicKey());
    authorizeOwnerKey(home, owner.d.core.teamId as string, "alex", publicKey());
    expect(sshReceipts(owner)).toBe(0);
  }, 60_000);

  afterAll(async () => { await cluster?.close(); });

  test("a denied grant with no receipt still removes that owner's line and posts the receipt", async () => {
    const applied = await applyOf(owner, "bea");
    expect(applied.steps.find((s) => s.step === "ssh_grant")?.status).toBe("done");
    expect(hasOwnerKey(home, owner.d.core.teamId as string, "bea")).toBe(false);
    expect(hasOwnerKey(home, owner.d.core.teamId as string, "alex")).toBe(true);
    expect(sshReceipts(owner)).toBe(1);
    const again = await applyOf(owner, "bea");
    expect(again.steps.find((s) => s.step === "ssh_grant")?.status).toBe("skipped");
    expect(sshReceipts(owner)).toBe(1);
    expect(hasOwnerKey(home, owner.d.core.teamId as string, "alex")).toBe(true);
  }, 30_000);
});

describe("offboard catches up a removed member and drops this machine's queued role changes", () => {
  let cluster: Cluster;
  let alex: TestNode;
  let noor: TestNode;
  let bea: TestNode;
  let olive: TestNode;

  beforeAll(async () => {
    cluster = new Cluster();
    // Roster requests are limited per requesting node. A slow refill lets the stale-roster probe spend one token.
    alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", limits: { ...TEST_LIMITS, humanWrite: { capacity: 1_000, perSecond: 0.001 } } });
    noor = await cluster.add({ name: "noor", login: "noor@example.com", hostname: "noor-mbp" });
    bea = await cluster.add({ name: "bea", login: "bea@example.com", hostname: "bea-mbp" });
    olive = await cluster.add({ name: "olive", login: "olive@example.com", hostname: "olive-mbp" });
    await alex.client().init("acme", "alex");
    await alex.client().invite("noor@example.com", "noor", "member");
    await alex.client().invite("bea@example.com", "bea", "member");
    await alex.client().invite("olive@example.com", "olive", "owner");
    expect((await noor.client().join(alex.peerAddr)).admitted).toBe(true);
    expect((await bea.client().join(alex.peerAddr)).admitted).toBe(true);
    expect((await olive.client().join(alex.peerAddr)).admitted).toBe(true);
    await waitFor(() => olive.d.core.roster.members.get("noor@example.com")?.role === "member"
      && olive.d.core.roster.members.get("bea@example.com")?.role === "member"
      && olive.d.core.me()?.role === "owner" && !olive.d.core.isAuthority(), { what: "olive synced" });
  }, 60_000);

  afterAll(async () => { await cluster?.close(); });

  test("the plan says apply will be refused when the person owns the roster authority", async () => {
    const plan = await planOf(olive, "alex");
    expect(plan.will.suspend_to_observer).toBe(false);
    expect(plan.will.remove).toBe(false);
    expect(plan.will.revoke_nodes).toEqual([]);
    expect(plan.will.revoke_ssh_grant).toBe(false);
    expect(plan.will.drop_restricted_channels).toEqual([]);
    expect(plan.will.hidden_restricted_channels).toBe(0);
    expect(plan.apply.refused).toBe("authority_must_stay_owner");
    expect(plan.facts.join("\n")).toMatch(/will be refused/i);
    expect(plan.facts.join("\n")).toMatch(/walkie team authority/);
    const before = memberRoles(alex, "alex");
    await expect(olive.client().request("POST", "/v1/team/offboard", { handle: "alex" })).rejects.toMatchObject({
      status: 403, code: "authority_must_stay_owner",
    });
    expect(alex.d.core.roster.members.get("alex@example.com")?.role).toBe("owner");
    expect(memberRoles(alex, "alex")).toEqual(before);
    expect(olive.d.core.store.queuedRequests()).toEqual([]);
  }, 30_000);

  test("a stale follower roster does not sign observer for someone the authority already removed", async () => {
    alex.d.sync.stop();
    olive.d.sync.stop();
    alex.d.core.emit("team.member", { login: "noor@example.com", handle: "noor", role: "removed" });
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("removed");
    expect(olive.d.core.roster.members.get("noor@example.com")?.role).toBe("member");
    const applied = await olive.client().request<Applied>("POST", "/v1/team/offboard", { handle: "noor" }, 30_000);
    expect(applied.steps.find((s) => s.step === "suspend")?.detail).toMatch(/already removed/);
    expect(applied.steps.find((s) => s.step === "remove")?.detail).toMatch(/already removed/);
    expect(applied.steps.map((s) => `${s.step}:${s.status}`)).toContain("suspend:skipped");
    expect(applied.steps.map((s) => `${s.step}:${s.status}`)).toContain("remove:skipped");
    expect(observerAfterRemoved(alex, "noor")).toBe(false);
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("removed");
    expect(olive.d.core.store.queuedRequests()).toEqual([]);
    expect(applied.steps.find((s) => s.detail.includes("dropped 0 queued role change(s) for @noor"))).toBeDefined();
  }, 30_000);

  test("a rate limit after a stale suspend does not leave a removed member as an observer", async () => {
    expect(alex.d.core.roster.members.get("bea@example.com")?.role).toBe("member");
    alex.d.core.emit("team.member", { login: "bea@example.com", handle: "bea", role: "removed" });
    expect(alex.d.core.roster.members.get("bea@example.com")?.role).toBe("removed");
    expect(olive.d.core.roster.members.get("bea@example.com")?.role).toBe("member");
    const key = `roster:${olive.d.nodeId}`;
    const spec = alex.d.core.limits.humanWrite;
    while (alex.d.core.limiter.take(key, spec)) { /* drain olive's roster-request tokens */ }
    alex.d.core.limiter.refund(key, spec, 1);
    const applied = await olive.client().request<Applied>("POST", "/v1/team/offboard", { handle: "bea" }, 30_000);
    expect(applied.steps.find((s) => s.step === "suspend")?.status).toBe("skipped");
    expect(applied.steps.find((s) => s.step === "remove")?.detail).toMatch(/already removed/);
    expect(alex.d.core.roster.members.get("bea@example.com")?.role).toBe("removed");
    expect(observerAfterRemoved(alex, "bea")).toBe(false);
    expect(olive.d.core.store.queuedRequests()).toEqual([]);
  }, 30_000);
});

describe("offboard drops a role change this machine queued before the authority returned", () => {
  let cluster: Cluster;
  let alex: TestNode;
  let noor: TestNode;
  let bea: TestNode;
  let olive: TestNode;

  beforeAll(async () => {
    cluster = new Cluster();
    alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
    noor = await cluster.add({ name: "noor", login: "noor@example.com", hostname: "noor-mbp" });
    bea = await cluster.add({ name: "bea", login: "bea@example.com", hostname: "bea-mbp" });
    olive = await cluster.add({ name: "olive", login: "olive@example.com", hostname: "olive-mbp" });
    await alex.client().init("acme", "alex");
    await alex.client().invite("noor@example.com", "noor", "member");
    await alex.client().invite("bea@example.com", "bea", "member");
    await alex.client().invite("olive@example.com", "olive", "owner");
    expect((await noor.client().join(alex.peerAddr)).admitted).toBe(true);
    expect((await bea.client().join(alex.peerAddr)).admitted).toBe(true);
    expect((await olive.client().join(alex.peerAddr)).admitted).toBe(true);
    await waitFor(() => olive.d.core.roster.members.get("noor@example.com")?.role === "member"
      && olive.d.core.roster.members.get("bea@example.com")?.role === "member"
      && olive.d.core.me()?.role === "owner", { what: "olive synced" });
  }, 60_000);

  afterAll(async () => { await cluster?.close(); });

  test("an older queued role request is dropped before removal and does not re-admit them", async () => {
    await alex.stop();
    const queuedNoor = await olive.client().request<{ queued?: boolean }>("POST", "/v1/team/member", { handle: "noor", role: "observer" });
    const queuedBea = await olive.client().request<{ queued?: boolean }>("POST", "/v1/team/member", { handle: "bea", role: "observer" });
    expect(queuedNoor.queued).toBe(true);
    expect(queuedBea.queued).toBe(true);
    expect(olive.d.core.store.queuedRequests().length).toBe(2);
    olive.d.sync.stop();
    await alex.start();
    const applied = await olive.client().request<Applied>("POST", "/v1/team/offboard", { handle: "noor" }, 30_000);
    expect(applied.steps.find((s) => s.detail === "dropped 1 queued role change(s) for @noor")).toBeDefined();
    expect(applied.role).toBe("removed");
    const left = olive.d.core.store.queuedRequests();
    expect(left.length).toBe(1);
    expect((JSON.parse(left[0]?.json ?? "{}") as { body?: { login?: string } }).body?.login).toBe("bea@example.com");
    await flushRequests(olive.d.core, olive.d.client, olive.d.sync.requestCatchUp);
    expect(olive.d.core.store.queuedRequests()).toEqual([]);
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("removed");
    expect(observerAfterRemoved(alex, "noor")).toBe(false);
    expect(memberRoles(alex, "noor").at(-1)).toMatch(/^removed@/);
    expect(alex.d.core.roster.members.get("bea@example.com")?.role).toBe("observer");
  }, 60_000);
});

describe("an owed SSH receipt says when the key line was already gone", () => {
  let cluster: Cluster;
  let owner: TestNode;
  let departing: TestNode;
  let home = "";

  beforeAll(async () => {
    cluster = new Cluster();
    home = join(cluster.root, "ssh-retry");
    mkdirSync(home, { recursive: true });
    owner = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", sshUserHome: home });
    departing = await cluster.add({ name: "bea", login: "bea@example.com", hostname: "bea-mbp" });
    await owner.client().init("acme", "alex");
    await owner.client().invite("bea@example.com", "bea", "owner");
    expect((await departing.client().join(owner.peerAddr)).admitted).toBe(true);
    await waitFor(() => owner.d.core.roster.nodes.has(departing.d.nodeId), { what: "bea joined" });
    // Denied already, and the key line is not installed: the receipt is what this run still owes.
    writeGrant(owner.home, owner.d.core.teamId as string, departing, "bea", "alex", owner.d.nodeId, "denied");
    expect(sshReceipts(owner)).toBe(0);
    expect(hasOwnerKey(home, owner.d.core.teamId as string, "bea")).toBe(false);
  }, 60_000);

  afterAll(async () => { await cluster?.close(); });

  test("a receipt with no key line covers a line that was never installed", async () => {
    const applied = await applyOf(owner, "bea");
    expect(applied.steps.find((s) => s.step === "ssh_grant")?.status).toBe("done");
    expect(applied.steps.find((s) => s.step === "ssh_grant")?.detail).toBe("no key line for @bea was installed here; posted the receipt");
    expect(sshReceipts(owner)).toBe(1);
    expect(hasOwnerKey(home, owner.d.core.teamId as string, "alex")).toBe(false);
  }, 30_000);
});

describe("a flush that already loaded a row does not send it after offboard drops it", () => {
  let cluster: Cluster;
  let alex: TestNode;
  let olive: TestNode;

  beforeAll(async () => {
    cluster = new Cluster();
    alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
    const noor = await cluster.add({ name: "noor", login: "noor@example.com", hostname: "noor-mbp" });
    const bea = await cluster.add({ name: "bea", login: "bea@example.com", hostname: "bea-mbp" });
    olive = await cluster.add({ name: "olive", login: "olive@example.com", hostname: "olive-mbp" });
    await alex.client().init("acme", "alex");
    await alex.client().invite("noor@example.com", "noor", "member");
    await alex.client().invite("bea@example.com", "bea", "member");
    await alex.client().invite("olive@example.com", "olive", "owner");
    expect((await noor.client().join(alex.peerAddr)).admitted).toBe(true);
    expect((await bea.client().join(alex.peerAddr)).admitted).toBe(true);
    expect((await olive.client().join(alex.peerAddr)).admitted).toBe(true);
    await waitFor(() => olive.d.core.roster.members.get("noor@example.com")?.role === "member"
      && olive.d.core.me()?.role === "owner" && !olive.d.core.isAuthority(), { what: "olive synced" });
  }, 60_000);

  afterAll(async () => { await cluster?.close(); });

  test("offboard drops the queued change and the in-flight flush does not re-admit them", async () => {
    await alex.stop();
    const queuedBea = await olive.client().request<{ queued?: boolean }>("POST", "/v1/team/member", { handle: "bea", role: "observer" });
    // A later millisecond, so bea's row is sent first (rows of the same millisecond are ordered by their random ids).
    await Bun.sleep(5);
    const queuedNoor = await olive.client().request<{ queued?: boolean }>("POST", "/v1/team/member", { handle: "noor", role: "observer" });
    expect(queuedBea.queued && queuedNoor.queued).toBe(true);
    olive.d.sync.stop();
    await alex.start();
    const client = olive.d.client as unknown as { rosterRequest: (addr: unknown, req: unknown) => Promise<unknown> };
    const orig = client.rosterRequest.bind(client);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let hit!: () => void;
    const hitP = new Promise<void>((resolve) => { hit = resolve; });
    // Bea's send, whichever order the queue holds the two rows in (same-millisecond rows are ordered by random ids).
    let first = true;
    const isBeas = (req: unknown) => { const j = JSON.stringify(req); return j.includes('"bea@example.com"') || j.includes('"handle":"bea"'); };
    client.rosterRequest = async (addr, req) => {
      if (first && isBeas(req)) { first = false; hit(); await gate; }
      return orig(addr, req);
    };
    // The flush has both rows in memory and is inside bea's send when offboard drops noor.
    const flushing = flushRequests(olive.d.core, olive.d.client, olive.d.sync.requestCatchUp);
    await hitP;
    const applied = await olive.client().request<Applied>("POST", "/v1/team/offboard", { handle: "noor" }, 45_000);
    expect(applied.steps.find((s) => s.step === "queued_roles")?.detail).toBe("dropped 1 queued role change(s) for @noor");
    // The flush is inside bea's send, not noor's. The in-flight note is only for this person's row.
    expect(applied.steps.some((s) => s.detail.includes("still in flight"))).toBe(false);
    release();
    await flushing;
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("removed");
    expect(observerAfterRemoved(alex, "noor")).toBe(false);
    expect(memberRoles(alex, "noor").at(-1)).toMatch(/^removed@/);
  }, 60_000);
});

describe("a removal that arrives after offboard has read the roster", () => {
  let cluster: Cluster;
  let alex: TestNode;
  let olive: TestNode;

  beforeAll(async () => {
    cluster = new Cluster();
    alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
    const noor = await cluster.add({ name: "noor", login: "noor@example.com", hostname: "noor-mbp" });
    olive = await cluster.add({ name: "olive", login: "olive@example.com", hostname: "olive-mbp" });
    await alex.client().init("acme", "alex");
    await alex.client().invite("noor@example.com", "noor", "member");
    await alex.client().invite("olive@example.com", "olive", "owner");
    expect((await noor.client().join(alex.peerAddr)).admitted).toBe(true);
    expect((await olive.client().join(alex.peerAddr)).admitted).toBe(true);
    await waitFor(() => olive.d.core.roster.members.get("noor@example.com")?.role === "member"
      && olive.d.core.me()?.role === "owner" && !olive.d.core.isAuthority(), { what: "olive synced" });
    alex.d.sync.stop();
    olive.d.sync.stop();
  }, 60_000);

  afterAll(async () => { await cluster?.close(); });

  test("both writes succeed, so the person ends removed", async () => {
    const client = olive.d.client as unknown as { vv: (addr: unknown, pubkey?: string) => Promise<unknown> };
    const orig = client.vv.bind(client);
    let once = true;
    client.vv = async (addr, pubkey) => {
      const res = await orig(addr, pubkey);
      // After the version vector this command reads, the other owner removes them. That event is not in the snapshot.
      if (once) { once = false; alex.d.core.emit("team.member", { login: "noor@example.com", handle: "noor", role: "removed" }); }
      return res;
    };
    const applied = await olive.client().request<Applied>("POST", "/v1/team/offboard", { handle: "noor" }, 30_000);
    expect(applied.role).toBe("removed");
    expect(applied.steps.find((s) => s.step === "remove")?.status).toBe("done");
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("removed");
    expect(memberRoles(alex, "noor").at(-1)).toMatch(/^removed@/);
    // The observer write still follows the other owner's removal. The removal after it is what makes the end state removed.
    expect(observerAfterRemoved(alex, "noor")).toBe(true);
  }, 30_000);
});

describe("a transfer back to an authority this catch-up already read", () => {
  let cluster: Cluster;
  let alex: TestNode;
  let pat: TestNode;
  let olive: TestNode;

  beforeAll(async () => {
    cluster = new Cluster();
    alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
    pat = await cluster.add({ name: "pat", login: "pat@example.com", hostname: "pat-mbp" });
    const noor = await cluster.add({ name: "noor", login: "noor@example.com", hostname: "noor-mbp" });
    olive = await cluster.add({ name: "olive", login: "olive@example.com", hostname: "olive-mbp" });
    await alex.client().init("acme", "alex");
    await alex.client().invite("pat@example.com", "pat", "owner");
    await alex.client().invite("noor@example.com", "noor", "member");
    await alex.client().invite("olive@example.com", "olive", "owner");
    expect((await pat.client().join(alex.peerAddr)).admitted).toBe(true);
    expect((await noor.client().join(alex.peerAddr)).admitted).toBe(true);
    expect((await olive.client().join(alex.peerAddr)).admitted).toBe(true);
    await waitFor(() => olive.d.core.roster.members.get("noor@example.com")?.role === "member"
      && olive.d.core.roster.nodes.has(pat.d.nodeId) && !olive.d.core.isAuthority(), { what: "olive synced" });
  }, 60_000);

  afterAll(async () => { await cluster?.close(); });

  test("reads that authority again and skips both writes when it already removed them", async () => {
    alex.d.sync.stop();
    pat.d.sync.stop();
    olive.d.sync.stop();
    const moved = await alex.client().setAuthority("pat-mbp");
    expect("queued" in moved).toBe(false);
    const alexNode = pat.d.core.roster.nodes.get(alex.d.nodeId);
    const alexAddr = alexNode ? pat.d.client.addrOf(alexNode) : null;
    if (!alexAddr) throw new Error("no address for alex");
    await pat.d.sync.requestCatchUp(alexAddr, alex.d.nodeId, alex.d.core.store.vvOf(alex.d.nodeId));
    expect(pat.d.core.isAuthority()).toBe(true);
    expect(olive.d.core.authority).toBe(alex.d.nodeId);

    const client = olive.d.client as unknown as { vv: (addr: unknown, pubkey?: string) => Promise<unknown> };
    const orig = client.vv.bind(client);
    let calls = 0;
    client.vv = async (addr, pubkey) => {
      calls++;
      // The first read is alex, and its pull finishes before the next read. Only then does authority move back:
      // a pull of alex cannot see a removal that does not exist yet. The second read is pat.
      if (calls === 2) {
        const back = await pat.client().setAuthority("alex-mbp");
        expect("queued" in back).toBe(false);
        const patNode = alex.d.core.roster.nodes.get(pat.d.nodeId);
        const patAddr = patNode ? alex.d.client.addrOf(patNode) : null;
        if (!patAddr) throw new Error("no address for pat");
        await alex.d.sync.requestCatchUp(patAddr, pat.d.nodeId, pat.d.core.store.vvOf(pat.d.nodeId));
        expect(alex.d.core.isAuthority()).toBe(true);
        alex.d.core.emit("team.member", { login: "noor@example.com", handle: "noor", role: "removed" });
      }
      return orig(addr, pubkey);
    };

    const applied = await olive.client().request<Applied>("POST", "/v1/team/offboard", { handle: "noor" }, 30_000);
    expect(applied.steps.find((s) => s.step === "suspend")?.detail).toMatch(/already removed/);
    expect(applied.steps.find((s) => s.step === "remove")?.detail).toMatch(/already removed/);
    expect(observerAfterRemoved(alex, "noor")).toBe(false);
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("removed");
    expect(olive.d.core.authority).toBe(alex.d.nodeId);
  }, 60_000);
});

describe("walkie team offboard --apply waits for the catch-up and both sends", () => {
  let cluster: Cluster;
  let alex: TestNode;
  let olive: TestNode;

  beforeAll(async () => {
    cluster = new Cluster();
    alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
    const noor = await cluster.add({ name: "noor", login: "noor@example.com", hostname: "noor-mbp" });
    olive = await cluster.add({ name: "olive", login: "olive@example.com", hostname: "olive-mbp" });
    await alex.client().init("acme", "alex");
    await alex.client().invite("noor@example.com", "noor", "member");
    await alex.client().invite("olive@example.com", "olive", "owner");
    expect((await noor.client().join(alex.peerAddr)).admitted).toBe(true);
    expect((await olive.client().join(alex.peerAddr)).admitted).toBe(true);
    await waitFor(() => olive.d.core.roster.members.get("noor@example.com")?.role === "member" && olive.d.core.me()?.role === "owner", { what: "olive synced" });
  }, 60_000);

  afterAll(async () => { await cluster?.close(); });

  test("a slow version vector and two slow roster writes still finish, and the client does not say the daemon is down", async () => {
    alex.d.sync.stop();
    olive.d.sync.stop();
    const client = olive.d.client as unknown as {
      vv: (addr: unknown, pubkey?: string) => Promise<unknown>;
      rosterRequest: (addr: unknown, req: unknown) => Promise<unknown>;
    };
    const vv = client.vv.bind(client);
    const rosterRequest = client.rosterRequest.bind(client);
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    client.vv = async (addr, pubkey) => { const out = await vv(addr, pubkey); await sleep(4_000); return out; };
    client.rosterRequest = async (addr, req) => { await sleep(3_500); return rosterRequest(addr, req); };
    const confirmed = await runConfirmed([process.execPath, CLI, "team", "offboard", "noor", "--apply", "--json"], {
      PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: olive.home, WALKIE_SOCKET: olive.socket,
    }, "noor");
    expect(confirmed.code).toBe(0);
    expect(confirmed.out).not.toMatch(/daemon not reachable/);
    expect(confirmed.out).not.toMatch(/walkie daemon start/);
    const body = JSON.parse(confirmed.out) as Applied;
    expect(body.role).toBe("removed");
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("removed");
  }, 90_000);
});

describe("offboard apply client timeout", () => {
  test("a daemon that accepts and does not answer says the offboard may still be running", async () => {
    const message = "offboard may still be running; re-run `walkie team offboard @noor --plan` to see the result";
    const dir = mkdtempSync(join(tmpdir(), "walkie-offboard-timeout-"));
    const socket = join(dir, "walkie.sock");
    const server = Bun.listen({ unix: socket, socket: { open() {}, data() {} } });
    try {
      const client = new WalkieClient({ socket, timeoutMs: 10_000 });
      const hung = await client.request("POST", "/v1/team/offboard", { handle: "noor" }, 300, message).then(() => null, (err: unknown) => err);
      expect(hung).toMatchObject({ code: "timeout", message });
      const down = await new WalkieClient({ socket: join(dir, "missing.sock"), timeoutMs: 300 })
        .request("POST", "/v1/team/offboard", { handle: "noor" }, 300, message).then(() => null, (err: unknown) => err);
      expect(down).toMatchObject({ code: "daemon_unreachable" });
      expect((down as WalkieError).message).toMatch(/daemon not reachable/);
      expect((down as WalkieError).message).not.toMatch(/may still be running/);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("offboard docs match the race they still allow", () => {
  test("protocol and security do not claim offboard's own writes can never restore observer", () => {
    const protocol = readFileSync(join(import.meta.dir, "../../docs/PROTOCOL.md"), "utf8");
    const security = readFileSync(join(import.meta.dir, "../../docs/SECURITY.md"), "utf8");
    const changelog = readFileSync(join(import.meta.dir, "../../CHANGELOG.md"), "utf8");
    const claim = "A removal that arrives after that read can still be followed by offboard's observer write until the authority checks a precondition (tracked on WALK-109).";
    expect(protocol).toContain(claim);
    expect(security).toContain(claim);
    expect(protocol).not.toContain("Offboard's own writes never set a removed member back to observer");
    expect(security).not.toContain("offboard's own writes never set a removed member back to observer");
    expect(protocol).toContain("no key line for that person was installed here");
    expect(security).toContain("no key line for that person was installed here");
    expect(changelog).not.toContain("a later sync cannot put them back");
    expect(changelog).not.toContain("key line was already removed");
    expect(changelog).toContain("may still be running");
    const unreleasedEnd = changelog.indexOf("## v0.2.0-pre.12");
    const unreleased = unreleasedEnd === -1 ? changelog : changelog.slice(0, unreleasedEnd);
    expect(unreleased).not.toContain("a flush of many queued requests");
    expect(unreleased).toContain("The flush wait is capped at 20 s");
    expect(unreleased).toContain("removal is not confirmed");
    expect(unreleased).toContain("still in flight");
    expect(unreleased).toContain("exits 2");
    const timeouts = readFileSync(join(import.meta.dir, "../../src/daemon/peer-timeouts.ts"), "utf8");
    expect(timeouts).not.toContain("a flush of many queued requests");
    expect(timeouts).toContain("The flush wait is capped at 20 s");
    expect(protocol).toContain("removal is not confirmed");
    expect(protocol).toContain("still in flight");
    expect(protocol).not.toContain("the later steps still run");
    expect(security).toContain("removal is not confirmed");
    expect(security).toContain("still in flight");
  });
});

describe("the apply budget counts the SSH receipt, and the flush wait stays capped", () => {
  test("OFFBOARD_APPLY_TIMEOUT_MS is the flush cap, four hops, both sends, and the receipt", () => {
    expect(OFFBOARD_FLUSH_WAIT_MS).toBe(20_000);
    expect(RECEIPT_PEER_TIMEOUT_MS).toBe(3_000);
    expect(OFFBOARD_APPLY_TIMEOUT_MS).toBe(
      OFFBOARD_FLUSH_WAIT_MS
      + OFFBOARD_AUTHORITY_HOPS * OFFBOARD_HOP_TIMEOUT_MS
      + 2 * OFFBOARD_SEND_TIMEOUT_MS
      + RECEIPT_PEER_TIMEOUT_MS,
    );
  });
});

/** Queue noor's row first so the flush's first send is this person's own role change. */
async function queueOwnRowFirst(cluster: Cluster): Promise<{ alex: TestNode; olive: TestNode }> {
  const alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  const noor = await cluster.add({ name: "noor", login: "noor@example.com", hostname: "noor-mbp" });
  const bea = await cluster.add({ name: "bea", login: "bea@example.com", hostname: "bea-mbp" });
  const olive = await cluster.add({ name: "olive", login: "olive@example.com", hostname: "olive-mbp" });
  await alex.client().init("acme", "alex");
  await alex.client().invite("noor@example.com", "noor", "member");
  await alex.client().invite("bea@example.com", "bea", "member");
  await alex.client().invite("olive@example.com", "olive", "owner");
  expect((await noor.client().join(alex.peerAddr)).admitted).toBe(true);
  expect((await bea.client().join(alex.peerAddr)).admitted).toBe(true);
  expect((await olive.client().join(alex.peerAddr)).admitted).toBe(true);
  await waitFor(() => olive.d.core.roster.members.get("noor@example.com")?.role === "member"
    && olive.d.core.me()?.role === "owner" && !olive.d.core.isAuthority(), { what: "olive synced" });
  await alex.stop();
  const queuedNoor = await olive.client().request<{ queued?: boolean }>("POST", "/v1/team/member", { handle: "noor", role: "observer" });
  const queuedBea = await olive.client().request<{ queued?: boolean }>("POST", "/v1/team/member", { handle: "bea", role: "observer" });
  expect(queuedNoor.queued && queuedBea.queued).toBe(true);
  olive.d.sync.stop();
  await alex.start();
  return { alex, olive };
}

function holdFirstRosterSend(olive: TestNode): { release: () => void; hit: Promise<void>; flushing: Promise<void> } {
  const client = olive.d.client as unknown as { rosterRequest: (addr: unknown, req: unknown) => Promise<unknown> };
  const orig = client.rosterRequest.bind(client);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let hit!: () => void;
  const hitP = new Promise<void>((resolve) => { hit = resolve; });
  // The send of noor's own row, whichever order the queue holds the two rows in: rows queued in the same millisecond
  // are ordered by their random ids (WALK-72 review SHOULD-1), so "the first send" was noor's only some of the time.
  let first = true;
  const isNoors = (req: unknown) => { const j = JSON.stringify(req); return j.includes('"noor@example.com"') || j.includes('"handle":"noor"'); };
  client.rosterRequest = async (addr, req) => {
    if (first && isNoors(req)) { first = false; hit(); await gate; }
    return orig(addr, req);
  };
  const flushing = flushRequests(olive.d.core, olive.d.client, olive.d.sync.requestCatchUp);
  return { release, hit: hitP, flushing };
}

describe("offboard waits out a send of this person's own row", () => {
  let cluster: Cluster;
  let alex: TestNode;
  let olive: TestNode;

  beforeAll(async () => {
    cluster = new Cluster();
    ({ alex, olive } = await queueOwnRowFirst(cluster));
  }, 60_000);
  afterAll(async () => { await cluster?.close(); });

  test("F2 a 3 s send finishes during the wait, so the drop is 0 and the role ends removed", async () => {
    const held = holdFirstRosterSend(olive);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await held.hit;
      const started = Date.now();
      const applying = olive.client().request<Applied>("POST", "/v1/team/offboard", { handle: "noor" }, 60_000);
      timer = setTimeout(held.release, 3_000);
      const applied = await applying;
      // The gate is still shut for 3 s. A wait of 0 returns while it is shut, reports dropped 1, and the send then leaves observer.
      expect(Date.now() - started).toBeGreaterThan(2_500);
      expect(applied.steps.find((s) => s.step === "queued_roles")?.detail).toBe("dropped 0 queued role change(s) for @noor");
      expect(applied.steps.some((s) => s.detail.includes("still in flight"))).toBe(false);
    } finally {
      if (timer) clearTimeout(timer);
      held.release();
      await held.flushing.catch(() => undefined);
    }
    await Bun.sleep(200);
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("removed");
    expect(memberRoles(alex, "noor").at(-1)).toMatch(/^removed@/);
  }, 60_000);
});

describe("a send of this person's row that outlasts the flush wait is named", () => {
  let cluster: Cluster;
  let alex: TestNode;
  let olive: TestNode;

  beforeAll(async () => {
    cluster = new Cluster();
    ({ alex, olive } = await queueOwnRowFirst(cluster));
  }, 60_000);
  afterAll(async () => { await cluster?.close(); });

  test("F3 the reply says the roster send was still in flight", async () => {
    const held = holdFirstRosterSend(olive);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await held.hit;
      const started = Date.now();
      const applying = olive.client().request<Applied>("POST", "/v1/team/offboard", { handle: "noor" }, 60_000);
      // Longer than the 20 s cap, so the wait ends while this send is still inside rosterRequest.
      timer = setTimeout(held.release, OFFBOARD_FLUSH_WAIT_MS + 5_000);
      const applied = await applying;
      expect(Date.now() - started).toBeGreaterThan(OFFBOARD_FLUSH_WAIT_MS - 2_000);
      expect(applied.steps.find((s) => s.step === "queued_roles")?.detail).toBe("dropped 1 queued role change(s) for @noor");
      expect(applied.steps.some((s) => s.detail === STILL_IN_FLIGHT)).toBe(true);
    } finally {
      if (timer) clearTimeout(timer);
      held.release();
      await held.flushing.catch(() => undefined);
    }
    await Bun.sleep(200);
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("observer");
  }, 90_000);
});

describe("a local removal is not confirmation when the authority was not read", () => {
  let cluster: Cluster;
  let alex: TestNode;
  let olive: TestNode;

  beforeAll(async () => {
    cluster = new Cluster();
    alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
    const noor = await cluster.add({ name: "noor", login: "noor@example.com", hostname: "noor-mbp" });
    olive = await cluster.add({ name: "olive", login: "olive@example.com", hostname: "olive-mbp" });
    await alex.client().init("acme", "alex");
    await alex.client().invite("noor@example.com", "noor", "member");
    await alex.client().invite("olive@example.com", "olive", "owner");
    expect((await noor.client().join(alex.peerAddr)).admitted).toBe(true);
    expect((await olive.client().join(alex.peerAddr)).admitted).toBe(true);
    await waitFor(() => olive.d.core.roster.members.get("noor@example.com")?.role === "member" && olive.d.core.me()?.role === "owner", { what: "olive synced" });
  }, 60_000);
  afterAll(async () => { await cluster?.close(); });

  test("R1 re-invited on an unreachable authority is 409 and nothing is signed or queued", async () => {
    alex.d.core.emit("team.member", { login: "noor@example.com", handle: "noor", role: "removed" });
    await waitFor(() => olive.d.core.roster.members.get("noor@example.com")?.role === "removed", { what: "olive sees removed" });
    olive.d.sync.stop();
    alex.d.sync.stop();
    await alex.client().invite("noor@example.com", "noor", "member");
    const chain = memberRoles(alex, "noor").map((row) => row.split("@")[0]);
    expect(chain).toEqual(["member", "removed", "member"]);
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("member");
    await alex.stop();
    const queued = await olive.client().request<{ queued?: boolean }>("POST", "/v1/team/member", { handle: "noor", role: "observer" });
    expect(queued.queued).toBe(true);
    const queuedIds = olive.d.core.store.queuedRequests().map((row) => row.id);
    expect(queuedIds.length).toBe(1);
    await expect(olive.client().request("POST", "/v1/team/offboard", { handle: "noor" }, 30_000)).rejects.toMatchObject({
      status: 409,
      code: "offboard_unreachable",
      message: "the roster authority could not be read, so @noor's removal is not confirmed; nothing was changed, including the SSH key line this step removes on this machine (if @noor granted this machine's SSH access, walkie ssh revoke removes it now); re-run when it is reachable",
    });
    expect(olive.d.core.store.queuedRequests().map((row) => row.id)).toEqual(queuedIds);
    expect(olive.d.core.roster.members.get("noor@example.com")?.role).toBe("removed");
    await alex.start();
    expect(memberRoles(alex, "noor").map((row) => row.split("@")[0])).toEqual(["member", "removed", "member"]);
    expect(alex.d.core.roster.members.get("noor@example.com")?.role).toBe("member");
  }, 60_000);
});

describe("offboard apply timeout exits 2", () => {
  test("a daemon that accepts and never answers exits 2, and an HTTP 408 stays exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "walkie-offboard-exit-"));
    const hungSocket = join(dir, "hung.sock");
    const httpSocket = join(dir, "http.sock");
    const home = join(dir, "home");
    mkdirSync(home);
    const hung = Bun.listen({ unix: hungSocket, socket: { open() {}, data() {} } });
    const http = Bun.serve({
      unix: httpSocket,
      fetch() {
        return new Response(JSON.stringify({ error: { code: "timeout", message: "the request body didn't arrive in time" } }), {
          status: 408,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    try {
      const env = { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: home };
      const refused = await runAsPerson([process.execPath, CLI, "team", "offboard", "noor", "--plan"], { ...env, WALKIE_SOCKET: httpSocket });
      expect(refused.code).toBe(1);
      expect(refused.out + refused.err).not.toMatch(/offboard may still be running/);
      const started = Date.now();
      const timedOut = await runAsPerson([process.execPath, CLI, "team", "offboard", "noor", "--apply"], {
        ...env, WALKIE_SOCKET: hungSocket,
      }, { tty: true, type: { after: "to confirm: ", text: "noor" }, timeoutMs: OFFBOARD_APPLY_TIMEOUT_MS + 40_000 });
      expect(Date.now() - started).toBeGreaterThan(OFFBOARD_APPLY_TIMEOUT_MS - 5_000);
      expect(timedOut.code).toBe(2);
      expect(timedOut.out + timedOut.err).toMatch(/offboard may still be running/);
      expect(timedOut.out + timedOut.err).not.toMatch(/walkie daemon start/);
    } finally {
      hung.stop(true);
      http.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
