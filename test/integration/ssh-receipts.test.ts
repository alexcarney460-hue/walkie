// SSH revocation receipts are posts the roster authority publishes on a node's behalf: who may ask, how often, how
// many one node may have, and what counts as the same receipt (round 12; the reviewer's B2 and B3 shapes).
import { expect, setDefaultTimeout, test } from "bun:test";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { grantFor } from "../helpers/ssh-team.ts";
import { PeerCallError } from "../../src/daemon/peer-client.ts";
import { DEFAULT_LIMITS } from "../../src/daemon/ratelimit.ts";
import { canonicalJson } from "../../src/protocol/canonical.ts";
import { publishSshRevocation, RECEIPT_SQL, RECEIPT_WINDOW_MS, RECEIPTS_PER_TARGET, retainSshRevocation, signSshRevocation, teamSshRevoked,
  type SshRevocationPacket } from "../../src/daemon/ssh/team-revocation.ts";

setDefaultTimeout(30_000);
const PREFIX = "walkie:ssh-revoke:v1:";
const DAY = 86_400_000;

interface Team { cluster: Cluster; lead: TestNode; member: TestNode; observer: TestNode }

/** The authority, a member's machine and an observer's machine; `production`: the shipped peer limits. */
async function receiptTeam(name: string, production = false): Promise<Team> {
  const cluster = new Cluster();
  const limits = production ? { limits: DEFAULT_LIMITS } : {};
  const lead = await cluster.add({ name: "lead", login: "-", hostname: "lead-mac", direct: true, ...limits });
  const member = await cluster.add({ name: "member", login: "-", hostname: "member-mac", direct: true, ...limits });
  const observer = await cluster.add({ name: "observer", login: "-", hostname: "observer-mac", direct: true, ...limits });
  await lead.client().init(name, "alex");
  expect((await member.client().join((await lead.client().inviteCode("kira")).code)).admitted).toBe(true);
  expect((await observer.client().join((await lead.client().inviteCode("watcher", "observer")).code)).admitted).toBe(true);
  await waitFor(() => [member, observer].every((n) => n.d.core.roster.nodes.has(lead.d.nodeId) && lead.d.core.roster.nodes.has(n.d.nodeId)),
    { what: "roster" });
  return { cluster, lead, member, observer };
}

const receiptRows = (node: TestNode): number => node.d.core.store.db.query<{ c: number }, []>(
  "SELECT count(*) AS c FROM events WHERE kind = 'msg.post' AND channel = 'general' AND status = 'ok' AND json_extract(body, '$.text') LIKE 'walkie:ssh-revoke:v1:%'").get()?.c ?? 0;

/** A receipt the node signs for itself. A different `keyHash` changes every byte, the signature included. */
function receipt(node: TestNode, createdAt: number, keyHash = "b".repeat(64)): SshRevocationPacket {
  const unsigned = { v: 1 as const, team: node.d.core.teamId as string, target: node.d.nodeId, grant_created_at: createdAt,
    owner_node: "a".repeat(16), owner_key_hash: keyHash };
  return { ...unsigned, sig: node.d.core.keys.sign(`${PREFIX}${canonicalJson(unsigned)}`) };
}

const authorityAddr = (node: TestNode, lead: TestNode) => node.d.client.addrOf(node.d.core.roster.nodes.get(lead.d.nodeId)!)!;

function refusal(run: () => unknown): { status: number; code: string } {
  try { run(); } catch (err) { const e = err as { status: number; code: string }; return { status: e.status, code: e.code }; }
  throw new Error("expected a refusal");
}

test("an observer's machine cannot make the authority publish receipts", async () => {
  const t = await receiptTeam("receipts-observer");
  try {
    const addr = authorityAddr(t.observer, t.lead);
    const base = Date.now() - 1_000;
    for (let i = 0; i < 25; i++) {
      await expect(t.observer.d.client.sshRevoke(addr, receipt(t.observer, base - i))).rejects.toMatchObject({ status: 403 });
    }
    expect(receiptRows(t.lead)).toBe(0);
  } finally { await t.cluster.close(); }
});

test("under the shipped peer limits an observer gets nothing accepted and a member gets five", async () => {
  const t = await receiptTeam("receipts-limits", true);
  try {
    const burst = async (node: TestNode): Promise<{ accepted: number; codes: Set<string> }> => {
      const addr = authorityAddr(node, t.lead);
      const codes = new Set<string>();
      const base = Date.now() - 1_000; // 100 distinct grants
      let accepted = 0;
      for (let i = 0; i < 100; i++) {
        try { await node.d.client.sshRevoke(addr, receipt(node, base - i)); accepted++; }
        catch (err) { codes.add((err as PeerCallError).code); }
      }
      return { accepted, codes };
    };
    expect((await burst(t.observer)).accepted).toBe(0);
    const member = await burst(t.member);
    expect(member.accepted).toBe(5);
    expect([...member.codes]).toEqual(["rate_limited"]);
    expect(receiptRows(t.lead)).toBe(5);
  } finally { await t.cluster.close(); }
});

test("one grant has one receipt, however it was signed", async () => {
  const t = await receiptTeam("receipts-dedupe");
  try {
    const addr = authorityAddr(t.member, t.lead);
    const createdAt = Date.now() - 5_000;
    const first = receipt(t.member, createdAt, "b".repeat(64));
    const other = receipt(t.member, createdAt, "c".repeat(64));
    expect(other.sig).not.toBe(first.sig);
    const stored = await t.member.d.client.sshRevoke(addr, first);
    expect((await t.member.d.client.sshRevoke(addr, other)).event_id).toBe(stored.event_id);
    expect(receiptRows(t.lead)).toBe(1);
    // A different grant is a different receipt.
    expect((await t.member.d.client.sshRevoke(addr, receipt(t.member, createdAt - 1))).event_id).not.toBe(stored.event_id);
    expect(receiptRows(t.lead)).toBe(2);
  } finally { await t.cluster.close(); }
});

test("a receipt for a grant older than a grant can live is refused", async () => {
  const t = await receiptTeam("receipts-window");
  try {
    expect(RECEIPT_WINDOW_MS).toBe(91 * DAY);
    const addr = authorityAddr(t.member, t.lead);
    await expect(t.member.d.client.sshRevoke(addr, receipt(t.member, Date.now() - RECEIPT_WINDOW_MS - DAY)))
      .rejects.toMatchObject({ status: 400, code: "ssh_revocation_stale" });
    expect(receiptRows(t.lead)).toBe(0);
    await t.member.d.client.sshRevoke(addr, receipt(t.member, Date.now() - RECEIPT_WINDOW_MS + DAY));
    expect(receiptRows(t.lead)).toBe(1);
  } finally { await t.cluster.close(); }
});

test("a node has at most ten receipts in the window, and old ones stop counting after it", async () => {
  const t = await receiptTeam("receipts-cap");
  try {
    const core = t.lead.d.core;
    const caller = t.member.d.nodeId;
    const now = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < RECEIPTS_PER_TARGET; i++) {
      ids.push(retainSshRevocation(core, caller, receipt(t.member, now - 10_000 - i), now + i * 15_000));
    }
    const later = now + RECEIPTS_PER_TARGET * 15_000;
    expect(refusal(() => retainSshRevocation(core, caller, receipt(t.member, now - 20_000), later))).toEqual({ status: 429, code: "ssh_receipts_capped" });
    // A receipt it already has is still answered, and another node is unaffected by this node's count.
    expect(retainSshRevocation(core, caller, receipt(t.member, now - 10_000), later)).toBe(ids[0] as string);
    expect(retainSshRevocation(core, t.lead.d.nodeId, receipt(t.lead, now - 10_000), later)).toBeString();
    expect(receiptRows(t.lead)).toBe(RECEIPTS_PER_TARGET + 1);
    // Ninety-two days on, those ten are outside the window and the node can store a new one.
    const aged = now + 92 * DAY;
    expect(retainSshRevocation(core, caller, receipt(t.member, aged - DAY), aged)).toBeString();
  } finally { await t.cluster.close(); }
});

test("an observer's machine says its receipt stays on this machine, without asking the authority", async () => {
  const t = await receiptTeam("receipts-observer-client");
  try {
    let calls = 0;
    t.observer.d.client.sshRevoke = async () => { calls++; return { event_id: "unused" }; };
    await expect(publishSshRevocation(t.observer.d.core, t.observer.d.client, grantFor(t.observer, t.lead))).rejects.toThrow("observer");
    expect(calls).toBe(0);
  } finally { await t.cluster.close(); }
});

test("the receipt lookups visit only the admin agent's posts", async () => {
  const t = await receiptTeam("receipts-plan");
  try {
    const plan = t.lead.d.core.store.db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${RECEIPT_SQL}`).all().map((r) => r.detail).join(" | ");
    expect(plan).toContain("events_author_agent_ts");
  } finally { await t.cluster.close(); }
});

test("the revoked verdict is reused until the store changes, and any change is seen", async () => {
  const t = await receiptTeam("receipts-cache");
  try {
    const core = t.member.d.core;
    const grant = grantFor(t.member, t.lead);
    const db = core.store.db as unknown as { query: (sql: string) => unknown };
    const query = db.query.bind(db);
    let scans = 0;
    db.query = (sql: string) => { if (sql.includes("walkie:ssh-revoke")) scans++; return query(sql); };
    try {
      // No await between these calls, so nothing else writes to the store while they run.
      expect(teamSshRevoked(core, grant)).toBe(false);
      const warm = scans;
      for (let i = 0; i < 20; i++) expect(teamSshRevoked(core, grant)).toBe(false);
      expect(scans).toBe(warm);
      core.store.setMeta("cache-probe", "1"); // any write moves the version
      expect(teamSshRevoked(core, grant)).toBe(false);
      expect(scans).toBe(warm + 1);
      expect(teamSshRevoked(core, grant)).toBe(false);
      expect(scans).toBe(warm + 1);
    } finally { db.query = query; }
    // A receipt arriving from the authority is a write: the cached "not revoked" cannot outlive it.
    retainSshRevocation(t.lead.d.core, t.member.d.nodeId, signSshRevocation(core, grant));
    await waitFor(() => teamSshRevoked(core, grant), { what: "receipt replicated to the target" });
    const row = core.store.db.query<{ id: string }, []>(RECEIPT_SQL).get();
    expect(row).not.toBeNull();
    // A re-validation can hide or restore a post without moving the version vector: the verdict follows the row.
    core.store.db.query("UPDATE events SET status = 'rejected' WHERE id = ?").run(row!.id);
    expect(teamSshRevoked(core, grant)).toBe(false);
    core.store.db.query("UPDATE events SET status = 'ok' WHERE id = ?").run(row!.id);
    expect(teamSshRevoked(core, grant)).toBe(true);
  } finally { await t.cluster.close(); }
});
