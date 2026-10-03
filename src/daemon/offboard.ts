// WALK-72 phase 0: `walkie team offboard --plan` (read-only) and `--apply` of steps that already exist.
// Suspend is a team.member role=observer; removal is the existing team.member role=removed (nodes revoked,
// restricted channels dropped). A follower catches up the authority's roster before it decides, and a roster
// write is never left queued. This machine's own queued role requests for that login are dropped before the
// first write, after a bounded wait for a flush that is already sending. On this machine, the SSH step removes
// the key of the owner who minted the grant. Card
// reassignment is ordinary signed card ops, paid from the import budget so a large board does not stall on
// the 1/s human limiter.
// No new event kind, no memory or thread policy, nothing replicated that a pre.12 peer would reject.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseAddress } from "../protocol/address.ts";
import { Handle, type BodyOf } from "../protocol/schemas.ts";
import { IMPORT_WRITE_LIMIT } from "./ratelimit.ts";
import { HttpError } from "./http.ts";
import { OFFBOARD_AUTHORITY_HOPS, OFFBOARD_FLUSH_WAIT_MS } from "./peer-timeouts.ts";
import { authoritySendBlock, rosterMemberSendInFlight, submitRequest, waitForRosterFlush } from "./requests.ts";
import { canSeeChannel, memberByHandle, ownerCount, type MemberRec } from "./roster.ts";
import { askView } from "./views.ts";
import { readSchedules } from "./orchestrator/schedules.ts";
import { seatsList } from "./seats/view.ts";
import { readGrant, type Grant } from "./provision/grant.ts";
import { appendAudit } from "./admin/audit.ts";
import { denySshInMemory } from "./ssh/state.ts";
import { closeSshTunnelsQuietly } from "./ssh/tunnel.ts";
import { noteRevocationOutcome, revokeSshAccess } from "./ssh/revoke.ts";
import { publishSshRevocation, teamSshRevoked } from "./ssh/team-revocation.ts";
import { importBudgetKey } from "./projects/batch.ts";
import { updateCard, visibleProjects, type WriteCtx } from "./projects/service.ts";
import type { RouteCtx } from "./local-routes.ts";

const CARD_CAP = 2_000;
const APPLY_ORDER = ["suspend", "remove", "ssh_grant", "reassign_cards"] as const;

export interface OffboardStep { step: string; status: "done" | "skipped"; detail: string }

const WILL_NOT = {
  synced_data: "Synced data stays on their machines. Walkie cannot recall it.",
  memory_and_threads: "No memory or thread policy is applied.",
  files: "Files they added stay in the Data Room.",
  vault: "Vault shares are not changed.",
  asks: "Open asks are not cancelled.",
  schedules: "Schedules are not removed.",
  integrations: "Integrations are not disabled.",
  seats_on_other_hosts: "A seat that is already running on someone else's machine is not stopped. A seat paused there is stopped if that machine tries to resume it after the launcher was removed, made an observer, or had their machine revoked. A seat only queued there is not started.",
  remote_guests_and_ssh: "Guest tokens on other machines are not touched. SSH grants on other machines are not revoked from here.",
  unseen_project_cards: "Cards in private projects the caller cannot see are neither listed nor reassigned.",
};

function addressHandle(addr: string | null | undefined): string | null {
  if (!addr || !addr.startsWith("@")) return null;
  const handle = parseAddress(addr).handle;
  return Handle.safeParse(handle).success ? handle : null;
}

function failed(err: unknown, steps: readonly OffboardStep[]): HttpError {
  if (err instanceof HttpError) return new HttpError(err.status, err.code, err.message, { ...err.details, steps });
  return new HttpError(500, "offboard_failed", err instanceof Error ? err.message : "offboard step failed", { steps });
}

/** A person on the team, still or already removed. 404 when the handle is unknown. */
function member(c: RouteCtx, handle: string): MemberRec {
  const found = memberByHandle(c.core.roster, handle);
  if (!found) throw new HttpError(404, "not_found", `no member @${handle}`);
  return found;
}

/** Someone else's current membership. Checked before any roster write. */
function reassignTarget(c: RouteCtx, raw: string | undefined, handle: string): string | null {
  if (raw === undefined) return null;
  const bare = raw.trim().replace(/^@/, "");
  if (!bare || bare.includes("/")) throw new HttpError(400, "invalid", "reassign to a person (@handle), not a machine or an agent");
  if (!Handle.safeParse(bare).success) throw new HttpError(400, "invalid", "reassign to a handle such as @alex");
  if (bare === handle) throw new HttpError(400, "invalid", "reassign their cards to someone else");
  const who = memberByHandle(c.core.roster, bare);
  if (!who || who.role === "removed") throw new HttpError(404, "not_found", `no current member @${bare}`);
  return `@${bare}`;
}

function refuseSelf(c: RouteCtx, who: MemberRec): void {
  // The caller has to stay an owner across both roster writes. Suspending yourself first would make the
  // removal (and any later card post) fail, and the last owner cannot be demoted or removed at all.
  if (who.role === "owner" && ownerCount(c.core.roster) <= 1) {
    throw new HttpError(409, "last_owner", "the last owner can't be offboarded; add another owner first");
  }
  if (who.handle === c.core.myHandle()) {
    throw new HttpError(409, "self", "you can't offboard yourself from this machine; another owner runs walkie team offboard");
  }
}

interface SshFact { revoke: boolean; note: string | null }

function loadGrant(c: RouteCtx): Grant | null {
  return readGrant(c.core.paths.home);
}

/** Locally denied, and the team log already holds the receipt. A denial with no receipt is still owed. */
function sshFullyRevoked(c: RouteCtx, grant: Grant): boolean {
  const denied = !!(grant.revoked_at || grant.ssh_state === "denied");
  return denied && teamSshRevoked(c.core, grant);
}

/**
 * This machine's grant names the person who minted it (`owner_ssh.owner_handle`). The recipient is always this
 * machine's own person. Revoke that owner's key line, never the caller's.
 */
function sshRevokePending(c: RouteCtx, grant: Grant, handle: string): boolean {
  const owner = grant.owner_ssh?.owner_handle;
  if (!owner || owner !== handle || owner === c.core.myHandle()) return false;
  return !sshFullyRevoked(c, grant);
}

function sshFact(c: RouteCtx, handle: string): SshFact {
  let grant: Grant | null;
  try { grant = loadGrant(c); }
  catch (err) {
    return { revoke: false, note: `this machine's SSH grant could not be read (${err instanceof Error ? err.message : "unreadable"})` };
  }
  if (!grant?.owner_ssh) return { revoke: false, note: null };
  return { revoke: sshRevokePending(c, grant, handle), note: null };
}

/** Restricted channels they are in: names the caller can see, and a count of the rest (archived included). */
function restrictedFor(c: RouteCtx, handle: string): { visible: string[]; hidden: number } {
  const caller = c.core.myHandle();
  const visible: string[] = [];
  let hidden = 0;
  for (const ch of c.core.roster.channels.values()) {
    if (!ch.members?.includes(handle)) continue;
    if (canSeeChannel(c.core.roster, ch.name, caller)) visible.push(ch.name);
    else hidden++;
  }
  visible.sort();
  return { visible, hidden };
}

interface VaultShare { id: string; policy: string; share_with: string[]; why: "they_share" | "shared_with_them" }
function vaultShares(home: string, handle: string, local: string | null): { shares: VaultShare[]; note: string | null } {
  // Vault.open creates the database. A read-only plan must not.
  const path = join(home, "vault.db");
  if (!existsSync(path)) return { shares: [], note: null };
  let db: Database;
  try { db = new Database(path, { readonly: true }); }
  catch { return { shares: [], note: "this machine's vault could not be opened" }; }
  try {
    const rows = db.query("SELECT id, policy, share_with FROM accounts").all() as { id: string; policy: string; share_with: string }[];
    const shares: VaultShare[] = [];
    for (const row of rows) {
      let share: string[] = [];
      try {
        const parsed = JSON.parse(row.share_with) as unknown;
        share = Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === "string" && Handle.safeParse(h).success) : [];
      } catch { share = []; }
      const lends = local === handle && row.policy === "shared";
      const sharedWith = share.includes(handle);
      if (!lends && !sharedWith) continue;
      shares.push({ id: String(row.id), policy: String(row.policy), share_with: share, why: lends ? "they_share" : "shared_with_them" });
    }
    return { shares, note: null };
  } catch {
    return { shares: [], note: "this machine's vault could not be read" };
  } finally { db.close(); }
}

/** What removal will and will not do. Reads only: no roster write, no vault create, no revoke. */
export function offboardPlan(c: RouteCtx, handle: string): Record<string, unknown> {
  const who = member(c, handle);
  const limits: string[] = [
    "Guest tokens, SSH grants and vaults on other machines are not visible from here.",
    "Schedules are team-wide (who created them), not stored per node.",
    "Open asks are the newest 500 asks on this machine.",
    "A seat that is already running on someone else's machine is not stopped. A seat paused there is stopped if that machine tries to resume it after the launcher was removed, made an observer, or had their machine revoked. A seat only queued there is not started.",
    "Cards in private projects the caller cannot see are neither listed nor reassigned.",
  ];
  const nodes = [...c.core.roster.nodes.values()]
    .filter((n) => n.login === who.login && !n.revoked)
    .map((n) => ({ node_id: n.node_id, hostname: n.hostname }))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
  const channels = restrictedFor(c, handle);

  const cards: { key: string; assignee: string | null; reviewer: string | null; matches: string[] }[] = [];
  const files: { name: string; why: "created" | "version" }[] = [];
  const idx = c.projects;
  if (idx) {
    idx.flushAll();
    for (const project of visibleProjects({ core: c.core, idx })) {
      if (project.state === "deleted") continue;
      const rows = idx.db.cards(project.channel, { limit: CARD_CAP });
      if (rows.length >= CARD_CAP) limits.push(`card list for ${project.name} stopped at ${CARD_CAP}`);
      for (const card of rows) {
        if (card.state === "deleted") continue;
        const matches: string[] = [];
        if (addressHandle(card.assignee) === handle) matches.push("assignee");
        if (addressHandle(card.reviewer) === handle) matches.push("reviewer");
        if (matches.length) cards.push({ key: card.key, assignee: card.assignee, reviewer: card.reviewer, matches });
      }
      let room;
      try { room = idx.room(project.channel); }
      catch { limits.push(`Data Room for ${project.name} could not be read`); continue; }
      for (const file of room) {
        if (file.state !== "active") continue;
        const created = file.created_by.handle === handle;
        const version = file.versions.some((v) => v.by.handle === handle);
        if (!created && !version) continue;
        files.push({ name: file.name, why: created ? "created" : "version" });
      }
    }
  } else limits.push("projects are not available on this daemon");
  cards.sort((a, b) => a.key.localeCompare(b.key));
  files.sort((a, b) => a.name.localeCompare(b.name) || a.why.localeCompare(b.why));

  const asks: { id: string; to: string; state: "open" }[] = [];
  for (const row of c.core.store.asks()) {
    const view = askView(c.core, row);
    if (!c.core.visible(view.ask) || view.state !== "open") continue;
    const to = (view.ask.body as { to?: unknown }).to;
    if (typeof to !== "string" || addressHandle(to) !== handle) continue;
    asks.push({ id: view.ask.id, to, state: "open" });
  }
  asks.sort((a, b) => a.to.localeCompare(b.to) || a.id.localeCompare(b.id));

  let schedules: { id: string; name: string; created_by: string }[] = [];
  try {
    schedules = readSchedules(c.core).filter((s) => s.created_by === handle)
      .map((s) => ({ id: s.id, name: s.name, created_by: s.created_by }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch { limits.push("schedules could not be read"); }

  const integrations: { connector: string; node_id: string; hostname: string }[] = [];
  for (const [connector, set] of c.core.roster.integrations ?? new Map<string, ReadonlySet<string>>()) {
    for (const nodeId of set) {
      const node = c.core.roster.nodes.get(nodeId);
      if (!node || node.login !== who.login) continue;
      integrations.push({ connector, node_id: nodeId, hostname: node.hostname });
    }
  }
  integrations.sort((a, b) => a.connector.localeCompare(b.connector) || a.hostname.localeCompare(b.hostname));

  const listedSeats = seatsList(c.core);
  if (listedSeats.length >= 100) limits.push("seat list is capped at 100");
  const seats = listedSeats
    .filter((s) => s.launcher.handle === handle || s.host.handle === handle)
    .map((s) => ({ id: s.id, host_handle: s.host.handle, launcher_handle: s.launcher.handle }));

  const ssh = sshFact(c, handle);
  if (ssh.note) limits.push(ssh.note);
  const vault = vaultShares(c.core.paths.home, handle, c.core.myHandle());
  if (vault.note) limits.push(vault.note);
  const authorityHost = authorityMachine(c, who);
  const blocked = authorityHost !== null;

  return {
    handle, role: who.role, scope: "this-machine", read_only: true,
    will: blocked ? {
      suspend_to_observer: false,
      remove: false,
      revoke_nodes: [],
      drop_restricted_channels: [],
      hidden_restricted_channels: 0,
      revoke_ssh_grant: false,
    } : {
      suspend_to_observer: who.role !== "observer" && who.role !== "removed",
      remove: who.role !== "removed",
      revoke_nodes: nodes,
      drop_restricted_channels: channels.visible,
      hidden_restricted_channels: channels.hidden,
      revoke_ssh_grant: ssh.revoke,
    },
    will_not: WILL_NOT,
    found: {
      cards, asks, schedules, integrations, seats, vault_shares: vault.shares, files,
    },
    limits,
    facts: [
      ...(blocked ? [`Apply will be refused: @${handle} owns the roster authority (${authorityHost}). No step below will happen. Move the roster authority first with \`walkie team authority <other-owner-machine>\`, then run this again.`] : []),
      "Removal revokes every node of their login. A later re-invite does not restore those machines; each one has to join again.",
      "Removal drops them from every restricted channel they are in, including archived ones. This plan names only the restricted channels this caller can see, and counts the rest.",
      "Synced data stays on their machines. Walkie cannot recall it.",
      "Seats on their own machines stop when that machine applies the change: becoming an observer, or having its node revoked, ends every seat there. A seat that is already running on someone else's machine is not stopped. A seat paused there is stopped if that machine tries to resume it after the launcher was removed, made an observer, or had their machine revoked. A seat only queued there is not started.",
      "Guest tokens issued on their own machines stop authenticating once that machine applies the removal, because that machine's guest gate requires its own current member and the tokens it issues name that person. This command does not delete those tokens. Guest tokens on other machines are not touched.",
      "Cards in private projects the caller cannot see are neither listed nor reassigned. A private project's channel is kept to the team's owners, so an owner running this command sees those projects.",
      "This command does not apply a memory or thread policy.",
    ],
    apply: blocked ? { order: [], refused: "authority_must_stay_owner" } : { order: [...APPLY_ORDER] },
  };
}

/** Catch-up never reached the authority, so this command signed nothing. */
function notReached(handle: string): HttpError {
  return new HttpError(409, "offboard_unreachable", `the roster authority is not reachable, so @${handle} was not changed by this step and nothing was signed or queued. Re-running walkie team offboard is safe.`);
}

/** Catch-up did not read the authority. A local roster that already shows this person removed is not confirmation. */
function removalUnconfirmed(handle: string): HttpError {
  return new HttpError(409, "offboard_unreachable", `the roster authority could not be read, so @${handle}'s removal is not confirmed; nothing was changed, including the SSH key line this step removes on this machine (if @${handle} granted this machine's SSH access, walkie ssh revoke removes it now); re-run when it is reachable`);
}

/** A roster send was attempted and the authority did not confirm it. A timeout can mean it already applied. */
function notConfirmed(handle: string): HttpError {
  return new HttpError(409, "offboard_unreachable", `the roster authority did not confirm this step for @${handle}. The change may or may not have been applied, and nothing was left queued. Re-running walkie team offboard is safe.`);
}

/** The roster-authority machine, when this login owns it. Apply cannot demote or remove that person. */
function authorityMachine(c: RouteCtx, who: MemberRec): string | null {
  const id = c.core.authority;
  if (!id) return null;
  const node = c.core.roster.nodes.get(id);
  if (!node || node.revoked || node.login !== who.login) return null;
  return node.hostname;
}

/**
 * One sync with the current roster authority, then with the authority a transfer in that sync names, up to
 * OFFBOARD_AUTHORITY_HOPS. False when this machine cannot read that roster: the caller must not sign a role
 * from what it already had. True when this machine is the authority, or the machine it just read is still the
 * authority. A transfer back to an authority this call already read is read again. Past the hop limit, while
 * the roster is still moving, this returns false (the caller answers 409).
 */
async function catchUpAuthorityRoster(c: RouteCtx): Promise<boolean> {
  for (let hop = 0; hop < OFFBOARD_AUTHORITY_HOPS; hop++) {
    if (c.core.isAuthority()) return true;
    const id = c.core.authority;
    if (!id) return false;
    const node = c.core.roster.nodes.get(id);
    const addr = node && !node.revoked ? c.client.addrOf(node) : null;
    if (!node || node.revoked || !addr) return false;
    let reported: { vv: Record<string, number>; verified?: boolean };
    try { reported = await c.client.vv(addr, node.pubkey); }
    catch { return false; }
    if (reported.verified !== true) return false;
    const target = reported.vv[id] ?? 0;
    if (c.core.store.vvOf(id) < target) {
      try { await c.sync.requestCatchUp(addr, id, target); }
      catch { return false; }
      if (c.core.store.vvOf(id) < target) return false;
    }
    // Current only while the roster still names the machine this hop just read. A move, including a move
    // back to an authority already followed, is another hop and another read.
    if (c.core.authority === id) return true;
  }
  return false;
}

/**
 * Apply one role on the authority. Never leaves a roster request queued: a miss is an error and nothing is stored.
 * Never signs observer for a login the roster now shows removed (`removed` / `same` write nothing).
 */
async function writeRole(c: RouteCtx, who: MemberRec, role: "observer" | "removed"): Promise<"wrote" | "removed" | "same"> {
  const current = memberByHandle(c.core.roster, who.handle);
  if (role === "observer" && current?.role === "removed") return "removed";
  if (current?.role === role) return "same";
  const body = { login: who.login, handle: who.handle, role, ...(who.display_name ? { display_name: who.display_name } : {}) };
  if (c.core.isAuthority()) {
    c.core.emit("team.member", body as BodyOf<"team.member">);
    return "wrote";
  }
  // Same early check send() uses. A missing transport writes nothing, not even a signed request.
  if (authoritySendBlock(c.core, c.client)) throw notReached(who.handle);
  const res = await submitRequest(c.core, c.client, c.sync.requestCatchUp, "team.member", body, { queue: false });
  if ("queued" in res) {
    c.core.store.dequeueRequest(res.request_id);
    throw notConfirmed(who.handle);
  }
  if ("unreachable" in res) throw notConfirmed(who.handle);
  const now = memberByHandle(c.core.roster, who.handle);
  if (role === "observer" && now?.role === "removed") return "removed";
  if (now?.role !== role) {
    throw new HttpError(409, "offboard_unconfirmed", `this machine has not confirmed @${who.handle} → ${role}. The change may already be applied. Re-running walkie team offboard is safe; later steps were not done.`);
  }
  return "wrote";
}

/**
 * The existing SSH revoke path (POST /v1/ssh/revoke), when this machine's grant was minted by the person being
 * offboarded. A local denial with no team receipt is run again; a denial that already has a receipt is skipped.
 * The caller's own key line is never removed.
 */
async function revokeSsh(c: RouteCtx, handle: string): Promise<OffboardStep> {
  let grant: Grant | null;
  try { grant = loadGrant(c); }
  catch (err) {
    throw new HttpError(409, "ssh_grant_unreadable", `this machine's SSH grant could not be read (${err instanceof Error ? err.message : "unreadable"}); later steps were not done`);
  }
  if (!grant?.owner_ssh) return { step: "ssh_grant", status: "skipped", detail: "no owner SSH grant on this machine" };
  const owner = grant.owner_ssh.owner_handle;
  if (owner === c.core.myHandle()) return { step: "ssh_grant", status: "skipped", detail: "not removing this machine's own key" };
  if (owner !== handle) {
    return { step: "ssh_grant", status: "skipped", detail: `this machine's SSH grant was minted by @${owner}, not @${handle}. Their key line stays. Grants on other machines are not revoked from here.` };
  }
  if (sshFullyRevoked(c, grant)) return { step: "ssh_grant", status: "skipped", detail: "already denied on this machine and the team receipt is posted" };
  denySshInMemory(c.core.paths.home);
  closeSshTunnelsQuietly(c.core);
  let removed = 0;
  let localFailure: unknown;
  try { removed = revokeSshAccess(c.core, grant); }
  catch (err) { localFailure = err; }
  let teamFailure: unknown;
  try { await publishSshRevocation(c.core, c.client, grant); }
  catch (err) { teamFailure = err; }
  const refusal = noteRevocationOutcome(c.core.paths.home, localFailure ?? null, !teamFailure);
  if (localFailure) throw refusal ?? (localFailure instanceof Error ? localFailure : new Error("SSH revocation failed"));
  if (teamFailure) throw new HttpError(503, "ssh_team_receipt_unavailable", teamFailure instanceof Error ? teamFailure.message : "SSH revocation receipt was not stored");
  appendAudit(c.core, { actor: `@${grant.recipient}`, action: `revoked owner SSH key; removed=${removed}`, machine: c.core.hostname, via: "local" });
  const detail = removed === 0
    ? `no key line for @${handle} was installed here; posted the receipt`
    : `removed @${handle}'s key line on this machine (removed ${removed} authorized_keys line(s)) and posted the team receipt`;
  return { step: "ssh_grant", status: "done", detail };
}

function cardChanges(c: RouteCtx, handle: string, target: string): { id: string; key: string; assignee?: string; reviewer?: string }[] {
  const idx = c.projects;
  if (!idx) throw new HttpError(409, "projects_unavailable", "projects are not available on this daemon; cards were not reassigned");
  idx.flushAll();
  const out: { id: string; key: string; assignee?: string; reviewer?: string }[] = [];
  for (const project of visibleProjects({ core: c.core, idx })) {
    if (project.state === "deleted") continue;
    for (const card of idx.db.cards(project.channel, { limit: CARD_CAP })) {
      if (card.state === "deleted") continue;
      const change: { id: string; key: string; assignee?: string; reviewer?: string } = { id: card.id, key: card.key };
      if (addressHandle(card.assignee) === handle) change.assignee = target;
      if (addressHandle(card.reviewer) === handle) change.reviewer = target;
      if (change.assignee !== undefined || change.reviewer !== undefined) out.push(change);
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id));
}

function reassignCards(c: RouteCtx, handle: string, target: string): OffboardStep {
  const changes = cardChanges(c, handle, target);
  if (!changes.length) return { step: "reassign_cards", status: "skipped", detail: "no cards left assigned to or reviewed by them" };
  const idx = c.projects;
  if (!idx) throw new HttpError(409, "projects_unavailable", "projects are not available on this daemon; cards were not reassigned");
  const spec = c.core.limits.importWrite ?? IMPORT_WRITE_LIMIT;
  const budgetKey = importBudgetKey(c.rateKey);
  if (!c.core.limiter.take(budgetKey, spec, Date.now(), changes.length)) {
    throw new HttpError(429, "rate_limited", `the import budget cannot cover ${changes.length} card reassignments right now; run the same command again to continue`);
  }
  const w: WriteCtx = {
    core: c.core, idx, client: c.client, catchUp: c.sync.requestCatchUp,
    ...(c.agent ? { agent: c.agent } : {}), ...(c.underAgent ? { underAgent: true } : {}),
  };
  let done = 0;
  try {
    for (const change of changes) {
      updateCard(w, change.id, {
        ...(change.assignee !== undefined ? { assignee: change.assignee } : {}),
        ...(change.reviewer !== undefined ? { reviewer: change.reviewer } : {}),
      });
      done++;
    }
  } catch (err) {
    const left = changes.length - done;
    if (left > 0) c.core.limiter.refund(budgetKey, spec, left);
    const key = changes[done]?.key ?? "a card";
    const message = err instanceof Error ? err.message : "card reassignment failed";
    throw new HttpError(err instanceof HttpError ? err.status : 500, err instanceof HttpError ? err.code : "offboard_failed", `${key}: ${message}`);
  }
  return { step: "reassign_cards", status: "done", detail: `reassigned ${done} card(s) to ${target}` };
}

/** The person who owns the roster-authority machine cannot be offboarded until that machine is no longer the authority. */
function refuseAuthorityOwner(c: RouteCtx, who: MemberRec): void {
  const host = authorityMachine(c, who);
  if (!host) return;
  throw new HttpError(403, "authority_must_stay_owner", `@${who.handle} owns the roster authority (${host}). Apply will be refused until the roster authority is moved. Move it first with: walkie team authority <other-owner-machine>`);
}

function removedSteps(): OffboardStep[] {
  return [
    { step: "suspend", status: "skipped", detail: "already removed; not set back to observer" },
    { step: "remove", status: "skipped", detail: "already removed" },
  ];
}

/**
 * Suspend, then the existing removal, then this machine's SSH key for the owner who minted the grant, then
 * optional card reassignment. Stops at the first failure. A roster write is never left queued. A follower
 * catches up the authority before deciding. This machine's queued role requests for that login are dropped
 * in one store transaction before the first write, after waiting for a flush that is already in progress.
 * Offboard decides from the roster that catch-up just read. A removal that arrives after that read can still
 * be followed by the observer write (WALK-109); this command then removes the person again. A second call
 * skips what is already done. If the catch-up did not read the authority, this answers 409 and signs nothing,
 * including when the local roster already shows them removed.
 */
export async function applyOffboard(c: RouteCtx, handle: string, reassignTo: string | undefined): Promise<{ handle: string; role: string; steps: OffboardStep[] }> {
  const known = member(c, handle);
  // Format and "someone else" checks before any sync. Membership is checked again after the catch-up.
  if (reassignTo !== undefined) reassignTarget(c, reassignTo, handle);
  if (known.handle === c.core.myHandle()) refuseSelf(c, known);
  let caughtUp = true;
  if (!c.core.isAuthority()) caughtUp = await catchUpAuthorityRoster(c);
  const who = member(c, handle);
  // A local "removed" row is not confirmation: the authority may have re-invited them since this machine last synced.
  if (!caughtUp) throw who.role === "removed" ? removalUnconfirmed(who.handle) : notReached(handle);
  const target = reassignTarget(c, reassignTo, handle);
  refuseSelf(c, who);
  refuseAuthorityOwner(c, who);
  // A flush that already passed its re-read can still deliver. Wait for one that is in progress, then drop.
  // The wait is bounded: a flush that outlasts it is not cancelled, and its send can still land.
  await waitForRosterFlush(OFFBOARD_FLUSH_WAIT_MS);
  // Before any further await. A flush that finished clears this in `finally` before its promise settles.
  const sendStillGoing = rosterMemberSendInFlight(c.core, who.login);
  const dropped = c.core.store.dropQueuedMemberRoles(who.login);
  const steps: OffboardStep[] = [{
    step: "queued_roles",
    status: dropped > 0 ? "done" : "skipped",
    detail: `dropped ${dropped} queued role change(s) for @${who.handle}`,
  }];
  if (sendStillGoing) {
    steps.push({
      step: "roster_send",
      status: "skipped",
      detail: `a roster send for @${who.handle} was still in flight when offboard proceeded; re-run --plan to confirm`,
    });
  }
  try {
    if (who.role === "removed") {
      steps.push(...removedSteps());
    } else if (who.role === "observer") {
      steps.push({ step: "suspend", status: "skipped", detail: "already an observer" });
      const removed = await writeRole(c, who, "removed");
      steps.push(removed === "same"
        ? { step: "remove", status: "skipped", detail: "already removed" }
        : { step: "remove", status: "done", detail: "role is removed; their nodes are revoked and they leave restricted channels" });
    } else {
      const suspend = await writeRole(c, who, "observer");
      if (suspend === "removed") {
        steps.push(...removedSteps());
      } else {
        steps.push(suspend === "wrote"
          ? { step: "suspend", status: "done", detail: "role is observer" }
          : { step: "suspend", status: "skipped", detail: "already an observer" });
        const after = memberByHandle(c.core.roster, who.handle);
        if (after?.role === "removed") {
          steps.push({ step: "remove", status: "skipped", detail: "already removed" });
        } else {
          await writeRole(c, who, "removed");
          steps.push({ step: "remove", status: "done", detail: "role is removed; their nodes are revoked and they leave restricted channels" });
        }
      }
    }
    steps.push(await revokeSsh(c, handle));
    steps.push(target
      ? reassignCards(c, handle, target)
      : { step: "reassign_cards", status: "skipped", detail: "no --reassign-to" });
  } catch (err) {
    throw failed(err, steps);
  }
  const role = memberByHandle(c.core.roster, handle)?.role ?? who.role;
  return { handle, role, steps };
}
