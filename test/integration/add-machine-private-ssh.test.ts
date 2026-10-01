// The owner SSH packet an add-machine link carries (ENROLL-SSH, `&ssh=` in the link, `--owner-ssh` in the command) reaches
// an agent that minted the link only as a private message to its person: the agent's own reply, the team's #general and
// every other place this machine keeps text never hold it. The person's own call still gets it in the reply. Real Walkie
// Direct daemons; the packet is looked for in every database table and every file under both Walkie homes.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TALKIE_SHELL_HEADER } from "../../src/daemon/orchestrator/os-user.ts";
import { decodeOwnerSshGrant, verifyOwnerSshGrant } from "../../src/daemon/ssh/grant.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";

setDefaultTimeout(60_000);
let c: Cluster;
let alex: TestNode;
let kira: TestNode;

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "-", hostname: "alex-mbp", direct: true });
  kira = await c.add({ name: "kira", login: "-", hostname: "kiras-mbp", direct: true });
  await alex.client().init("aka", "alex");
  expect((await kira.client().join((await alex.client().inviteCode("kira", "member")).code)).admitted).toBe(true);
}, 60_000);
afterAll(async () => { await c.close(); });

/** Where `node` keeps `needle`: any database table or file of its Walkie home except the private conversation (orch_messages), which holds the message. */
function holders(node: TestNode, needle: string): string[] {
  const where: string[] = [];
  const db = node.d.core.store.db;
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) {
    if (name === "orch_messages") continue;
    for (const row of db.query<Record<string, unknown>, []>(`SELECT * FROM "${name}"`).all()) {
      if (JSON.stringify(row, (_key, value) => (value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : value)).includes(needle)) where.push(`db:${name}`);
    }
  }
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile() || /\.sock$|walkie\.db/.test(entry.name)) continue;
      try { if (readFileSync(path).includes(needle)) where.push(`file:${path.slice(node.home.length)}`); } catch { /* unreadable */ }
    }
  };
  walk(node.home);
  return where;
}

const privateMessages = () => alex.d.core.store.orchMessages({ limit: 20 }).filter((m) => m.via === "private" && m.text.includes("Add a machine for @kira"));

describe("an agent's add-machine", () => {
  test("the agent gets a receipt; the packet is in the person's private message only, in the link's fragment and the Install line, and nowhere on disk", async () => {
    const before = privateMessages().length;
    const reply = await alex.client("helper").request<Record<string, unknown>>("POST", "/v1/team/add-machine", { handle: "kira" });
    const wire = JSON.stringify(reply);
    expect(reply.delivered).toBe(true);
    for (const secret of ["wk1", "ssh=", "owner-ssh"]) expect(wire).not.toContain(secret);
    const sent = privateMessages();
    expect(sent).toHaveLength(before + 1);
    const text = sent.at(-1)!.text;
    const link = /Link: (\S+)/.exec(text)?.[1] as string;
    const install = /Install: (.+)$/m.exec(text)?.[1] as string;
    const url = new URL(link);
    expect(url.search).toBe(""); // nothing a server would see
    expect(url.hash).toMatch(/^#wk1[A-Za-z0-9_-]+&v=.*&a=1&ssh=[A-Za-z0-9_-]+$/);
    const packet = /ssh=([A-Za-z0-9_-]+)/.exec(url.hash)?.[1] as string;
    expect(install).toContain(`--owner-ssh ${packet}`);
    expect(install).toContain("--company-machine");
    // The packet is the owner's own signed authorization, for kira.
    const ssh = verifyOwnerSshGrant(decodeOwnerSshGrant(packet), alex.d.core.keys.pubkey, Date.now());
    expect([ssh.owner_node, ssh.recipient]).toEqual([alex.d.nodeId, "kira"]);
    for (const node of [alex, kira]) expect(holders(node, packet.slice(0, 40))).toEqual([]);
  });

  test("a WalkieTalkie shell caller (private delivery by header, no agent name) is delivered the same way", async () => {
    const response = await fetch("http://walkie/v1/team/add-machine", { method: "POST", unix: alex.socket,
      headers: { "Content-Type": "application/json", [TALKIE_SHELL_HEADER]: "1" }, body: JSON.stringify({ handle: "kira" }) } as RequestInit);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).not.toContain("ssh=");
    expect(body).not.toContain("wk1");
    const packet = /ssh=([A-Za-z0-9_-]+)/.exec(privateMessages().at(-1)!.text)?.[1] as string;
    expect(packet).toBeTruthy();
    expect(holders(alex, packet.slice(0, 40))).toEqual([]);
  });

  test("the person's own call still gets the packet in the reply, and #general carries only the content-free line", async () => {
    const own = await alex.client("").request<{ link: string; command: string; owner_ssh: string }>("POST", "/v1/team/add-machine", { handle: "kira" });
    expect(own.link).toContain(`&ssh=${own.owner_ssh}`);
    expect(own.command).toContain(`--owner-ssh ${own.owner_ssh}`);
    expect(new URL(own.link).search).toBe("");
    const posts = await alex.client().events({ channel: "general", kinds: "msg.post", limit: 200 });
    expect(posts.events.some((e) => JSON.stringify(e.body).includes(own.owner_ssh.slice(0, 40)))).toBe(false);
    // What the earlier agent mints left in #general is the audit line alone: who minted for whom, never a code or a packet.
    const lines = posts.events.map((e) => (e.body as { text?: string }).text ?? "").filter((text) => text.includes("add-machine"));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((text) => !text.includes("wk1") && !text.includes("ssh="))).toBe(true);
  });
});
