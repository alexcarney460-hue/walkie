import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Cluster, TestNode } from "../helpers/cluster.ts";

test("new team with the same handle cannot read prior person's newer note and primer", async () => {
  const cluster = new Cluster();
  try {
    const alex = await cluster.add({ name: "alex", login: "alex@example.com" });
    await alex.client().init("first-team", "shared");
    const firstTeam = alex.d.core.teamId!;
    await alex.stop();
    unlinkSync(join(alex.home, "memory.db"));
    unlinkSync(join(alex.home, "memory-owner.json"));
    const old = new Database(join(alex.home, "memory.db"), { create: true });
    old.exec(`CREATE TABLE memory (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL,
      sources TEXT NOT NULL, created_at INTEGER NOT NULL, retracted INTEGER NOT NULL,
      retracted_at INTEGER, actor TEXT NOT NULL, redactions TEXT NOT NULL)`);
    old.query("INSERT INTO memory VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "m-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "fact", "Alex legacy private note", "[]", 1, 0, null, "person", "[]");
    old.close();
    await alex.start();
    const add = await fetch("http://walkie/v1/memory", { unix: alex.socket, method: "POST",
      body: JSON.stringify({ kind: "fact", text: "Alex new private note" }) } as RequestInit);
    expect(add.status).toBe(200);
    const primer = await fetch("http://walkie/v1/primer", { unix: alex.socket, method: "POST",
      body: JSON.stringify({ project: "global", inProgress: "Alex private project", nextStep: "Alex private next step", blockers: [] }) } as RequestInit);
    expect(primer.status).toBe(200);
    const original = new Database(join(alex.home, "memory.db"));
    expect(original.query<{ team: string; person: string }, []>(
      "SELECT team, person FROM memory_legacy_decision WHERE id = 1").get()).toEqual({ team: firstTeam, person: "shared" });
    original.close();
    const nodeId = alex.d.nodeId;
    await alex.stop();

    const samHome = join(cluster.root, "recovered");
    mkdirSync(samHome, { mode: 0o700 });
    copyFileSync(join(alex.home, "node.key"), join(samHome, "node.key"));
    copyFileSync(join(alex.home, "memory.db"), join(samHome, "memory.db"));
    const sam = new TestNode(cluster, { name: "recovered", login: "sam@example.com" }, samHome, 0);
    cluster.nodes.push(sam);
    await sam.start();
    expect(sam.d.nodeId).toBe(nodeId);
    await sam.client().init("second-team", "shared");
    expect(sam.d.core.teamId).not.toBe(firstTeam);

    const recall = await fetch("http://walkie/v1/recall?q=private", { unix: sam.socket } as RequestInit);
    const recallBody = JSON.stringify(await recall.json());
    expect(recall.status).toBe(200);
    expect(recallBody).not.toContain("Alex legacy private note");
    expect(recallBody).not.toContain("Alex new private note");
    const raw = await fetch("http://walkie/v1/memory?q=private", { unix: sam.socket } as RequestInit);
    expect(JSON.stringify(await raw.json())).not.toContain("Alex new private note");
    const p = await fetch("http://walkie/v1/primer?project=global", { unix: sam.socket } as RequestInit);
    expect(JSON.stringify(await p.json())).not.toContain("Alex private next step");
    const after = new Database(join(samHome, "memory.db"));
    expect(after.query<{ owner: string }, []>("SELECT owner FROM memory WHERE body = 'Alex legacy private note'").get()?.owner)
      .toContain(firstTeam);
    after.close();
  } finally { await cluster.close(); }
});

test("database swapped after first daemon start cannot be assigned to next team", async () => {
  const cluster = new Cluster();
  try {
    const alex = await cluster.add({ name: "alex", login: "alex@example.com" });
    await alex.client().init("first-team", "alex");
    unlinkSync(join(alex.home, "memory.db"));
    const old = new Database(join(alex.home, "memory.db"), { create: true });
    old.exec(`CREATE TABLE memory (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL,
      sources TEXT NOT NULL, created_at INTEGER NOT NULL, retracted INTEGER NOT NULL,
      retracted_at INTEGER, actor TEXT NOT NULL, redactions TEXT NOT NULL)`);
    old.query("INSERT INTO memory VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "m-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "fact", "Alex old private note", "[]", 1, 0, null, "person", "[]");
    old.close();
    const firstTeam = alex.d.core.teamId;
    const oldNode = alex.d.nodeId;
    await alex.stop();

    const samHome = join(cluster.root, "recovered");
    mkdirSync(samHome, { mode: 0o700 });
    copyFileSync(join(alex.home, "node.key"), join(samHome, "node.key"));
    copyFileSync(join(alex.home, "memory.db"), join(samHome, "memory.db"));
    const sam = new TestNode(cluster, { name: "recovered", login: "sam@example.com" }, samHome, 0);
    cluster.nodes.push(sam);
    await sam.start();
    expect(sam.d.nodeId).toBe(oldNode);
    await sam.client().init("second-team", "sam");
    expect(sam.d.core.teamId).not.toBe(firstTeam);
    const read = await fetch("http://walkie/v1/recall?q=private", { unix: sam.socket } as RequestInit);
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).not.toContain("Alex old private note");
    const migrated = new Database(join(samHome, "memory.db"));
    expect(migrated.query<{ owner: string }, []>("SELECT owner FROM memory").get()?.owner).toBe("!legacy-quarantined");
    migrated.close();
  } finally { await cluster.close(); }
});
