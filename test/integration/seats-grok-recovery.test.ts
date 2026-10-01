import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cluster, TestNode } from "../helpers/cluster.ts";

test("restart removes a Grok auth link left by a crash before conclusion", async () => {
  const cluster = new Cluster();
  const home = join(cluster.root, "arvid-home");
  const seatDir = join(home, "seat-fixture");
  const grokHome = join(seatDir, "grok-home");
  mkdirSync(grokHome, { recursive: true });
  const credential = join(home, "fixture-auth.json");
  writeFileSync(credential, "fixture-only", { mode: 0o600 });
  symlinkSync(credential, join(grokHome, "auth.json"));
  writeFileSync(join(home, "seats.json"), JSON.stringify({ handled: {}, running: [{ id: "0123456789abcdef:1", dir: seatDir, runtime: "grok" }] }), { mode: 0o600 });
  const node = new TestNode(cluster, { name: "arvid", login: "arvid@example.com", hostname: "arvid-mac" }, home, 0);
  try {
    await node.start();
    expect(existsSync(grokHome)).toBe(false);
    expect(existsSync(credential)).toBe(true);
  } finally {
    await node.stop();
    await cluster.close();
  }
}, 20_000);

test("restart preserves a non-Grok seat's directory named grok-home", async () => {
  const cluster = new Cluster();
  const home = join(cluster.root, "arvid-home");
  const seatDir = join(home, "seat-fixture");
  const grokHome = join(seatDir, "grok-home");
  mkdirSync(grokHome, { recursive: true });
  writeFileSync(join(grokHome, "fixture.txt"), "keep", { mode: 0o600 });
  writeFileSync(join(home, "seats.json"), JSON.stringify({ handled: {}, running: [{ id: "0123456789abcdef:1", dir: seatDir, runtime: "claude" }] }), { mode: 0o600 });
  const node = new TestNode(cluster, { name: "arvid", login: "arvid@example.com", hostname: "arvid-mac" }, home, 0);
  try {
    await node.start();
    expect(existsSync(join(grokHome, "fixture.txt"))).toBe(true);
  } finally {
    await node.stop();
    await cluster.close();
  }
}, 20_000);

test("restart preserves grok-home when the saved runtime is unknown", async () => {
  const cluster = new Cluster();
  const home = join(cluster.root, "arvid-home");
  const seatDir = join(home, "seat-fixture");
  const grokHome = join(seatDir, "grok-home");
  mkdirSync(grokHome, { recursive: true });
  writeFileSync(join(grokHome, "fixture.txt"), "keep", { mode: 0o600 });
  writeFileSync(join(home, "seats.json"), JSON.stringify({ handled: {}, running: [{ id: "0123456789abcdef:1", dir: seatDir }] }), { mode: 0o600 });
  const node = new TestNode(cluster, { name: "arvid", login: "arvid@example.com", hostname: "arvid-mac" }, home, 0);
  try {
    await node.start();
    expect(existsSync(join(grokHome, "fixture.txt"))).toBe(true);
    const entries = readFileSync(node.d.paths.log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.find((entry) => entry.msg === "seats_unknown_runtime_home_preserved"))
      .toMatchObject({ dir: seatDir, home: grokHome });
  } finally {
    await node.stop();
    await cluster.close();
  }
}, 20_000);
