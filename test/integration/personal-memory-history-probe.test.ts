import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { copyFileSync, mkdirSync, unlinkSync } from "node:fs";
import { Cluster, TestNode } from "../helpers/cluster.ts";

function seedLegacy(home: string, createdAt: number): void {
  const db = new Database(join(home, "memory.db"), { create: true });
  db.exec(`CREATE TABLE memory (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL, sources TEXT NOT NULL,
    created_at INTEGER NOT NULL, retracted INTEGER NOT NULL, retracted_at INTEGER,
    actor TEXT NOT NULL, redactions TEXT NOT NULL
  )`);
  db.query("INSERT INTO memory VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "m-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "decision", "Alex private recovery note", "[]",
    createdAt, 0, null, "person", "[]",
  );
  db.close();
}

test("the reviewer probe keeps an earlier holder's note hidden after key and memory recovery", async () => {
  const cluster = new Cluster();
  try {
    const alex = await cluster.add({ name: "alex", login: "alex@example.com" });
    await alex.client().init("first-team", "alex");
    const oldNode = alex.d.nodeId;
    const firstTeam = alex.d.core.teamId!;
    await alex.stop();
    unlinkSync(join(alex.home, "memory.db"));
    unlinkSync(join(alex.home, "memory-owner.json"));
    seedLegacy(alex.home, Date.now() - 30_000);
    await alex.start(); // First migration runs against Alex's original team.
    const first = new Database(join(alex.home, "memory.db"));
    expect(first.query<{ team: string; node: string; person: string }, []>(
      "SELECT team, node, person FROM memory_legacy_decision WHERE id = 1").get()).toEqual({
        team: alex.d.core.teamId ?? "", node: oldNode, person: "alex",
      });
    first.close();
    await alex.stop();
    const samHome = join(cluster.root, "recovered");
    mkdirSync(samHome, { mode: 0o700 });
    copyFileSync(join(alex.home, "node.key"), join(samHome, "node.key"));
    copyFileSync(join(alex.home, "memory.db"), join(samHome, "memory.db"));
    const sam = new TestNode(cluster, { name: "recovered", login: "sam@example.com",
      clock: () => Date.now() - 60_000 }, samHome, 0);
    cluster.nodes.push(sam);
    await sam.start();
    expect(sam.d.nodeId).toBe(oldNode);
    await sam.client().init("second-team", "sam");
    const local = `http://127.0.0.1:${sam.d.localPort}`;
    const nonceResponse = await fetch("http://walkie/v1/auth/nonce", {
      unix: sam.socket, method: "POST",
    } as RequestInit);
    expect(nonceResponse.status).toBe(200);
    const { nonce } = await nonceResponse.json() as { nonce: string };
    const login = await fetch(`${local}/auth?nonce=${nonce}`, { redirect: "manual" });
    expect(login.status).toBe(302);
    const session = /#s=([0-9a-f]{64})$/.exec(login.headers.get("Location") ?? "")?.[1] ?? "";
    expect(session).toHaveLength(64);
    const headers = { "X-Walkie-Session": session, Origin: local, "Content-Type": "application/json" };
    const claim = await fetch(`${local}/v1/memory/claim-legacy`, {
      method: "POST", headers, body: JSON.stringify({ confirm: "claim legacy memory" }),
    });
    expect(claim.status).toBe(403);
    const read = await fetch("http://walkie/v1/recall?q=recovery", { unix: sam.socket } as RequestInit);
    expect(JSON.stringify(await read.json())).not.toContain("Alex private recovery note");
    const rows = new Database(join(sam.home, "memory.db"));
    expect(rows.query<{ owner: string }, []>("SELECT owner FROM memory").get()?.owner).toContain(firstTeam);
    rows.close();
    const deleted = await fetch(`${local}/v1/memory/delete-legacy`, {
      method: "POST", headers, body: JSON.stringify({ confirm: "delete legacy memory" }),
    });
    expect(await deleted.json()).toEqual({ deleted: 0 });
  } finally { await cluster.close(); }
});

test("an in-place upgrade assigns a legacy note regardless of clock order", async () => {
  const cluster = new Cluster();
  try {
    const alex = await cluster.add({ name: "alex", login: "alex@example.com" });
    await alex.client().init("acme", "alex");
    await alex.stop();
    unlinkSync(join(alex.home, "memory.db"));
    unlinkSync(join(alex.home, "memory-owner.json"));
    seedLegacy(alex.home, 1);
    await alex.start();
    const read = await fetch("http://walkie/v1/recall?q=recovery", { unix: alex.socket } as RequestInit);
    expect(JSON.stringify(await read.json())).toContain("Alex private recovery note");
  } finally { await cluster.close(); }
});

test("a file found before enrollment has no owner decision and stays quarantined", async () => {
  const cluster = new Cluster();
  try {
    const alex = await cluster.add({ name: "alex", login: "alex@example.com" });
    await alex.client().init("first-team", "alex");
    await alex.stop();
    const samHome = join(cluster.root, "recovered");
    mkdirSync(samHome, { mode: 0o700 });
    copyFileSync(join(alex.home, "node.key"), join(samHome, "node.key"));
    seedLegacy(samHome, Date.now() - 30_000);
    const sam = new TestNode(cluster, { name: "recovered", login: "sam@example.com",
      clock: () => Date.now() - 60_000 }, samHome, 0);
    cluster.nodes.push(sam);
    await sam.start();
    await sam.client().init("second-team", "sam");
    const read = await fetch("http://walkie/v1/recall?q=recovery", { unix: sam.socket } as RequestInit);
    expect(JSON.stringify(await read.json())).not.toContain("Alex private recovery note");
    const db = new Database(join(samHome, "memory.db"));
    expect(db.query<{ owner: string }, []>("SELECT owner FROM memory").get()?.owner).toBe("!legacy-quarantined");
    db.close();
  } finally { await cluster.close(); }
});
