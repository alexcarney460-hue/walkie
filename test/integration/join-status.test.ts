// JOIN-STATUS-1 (WALK-50 "Doctor, recovery"): once a machine joins a team, one plain #general status from
// `walkie-admin` naming it — its Walkie version, its seat capacity, and whether Claude/Codex are ready — retried
// until #general is synced here, and never posted twice for the same admission (a restart, or this node re-joining
// to re-pin its own IP, is idempotent).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../../src/daemon/version.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

async function joinStatusPosts(n: TestNode): Promise<string[]> {
  const got = await n.client().events({ channel: "general", kinds: "msg.post", limit: 200 });
  return got.events
    .filter((e: Event) => e.author.agent === "walkie-admin" && /^(Ready|Partial):/.test((e.body as { text: string }).text))
    .map((e) => (e.body as { text: string }).text);
}

describe("join status: one #general post after a machine joins a team", () => {
  let cluster: Cluster;
  let alex: TestNode;
  let kira: TestNode;

  beforeAll(async () => {
    cluster = new Cluster();
    alex = await cluster.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
    kira = await cluster.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp" });
    await alex.client().init("acme", "alex");
    await alex.client().invite("kira@example.com", "kira", "member");
  });
  afterAll(async () => { await cluster.close(); });

  test("names this machine, this Walkie's version and its seat capacity; never posts twice", async () => {
    // alex's own `init` already founded the team: its machine gets a join status of its own (WALK-50 covers
    // both join.ts and setup). Only kira's post is this test's subject.
    await waitFor(async () => (await joinStatusPosts(alex)).some((p) => p.includes("@alex's alex-mbp")), { what: "alex's own join status" });

    const joined = await kira.client().join(alex.peerAddr);
    expect(joined.admitted).toBe(true);

    const kiraPost = await waitFor(async () => {
      const p = (await joinStatusPosts(kira)).filter((t) => t.includes("@kira's kiras-mbp"));
      return p.length ? p[0] : null;
    }, { what: "kira's join status post" });
    expect(kiraPost).toContain(`Walkie ${VERSION}`);
    expect(kiraPost).toMatch(/seats \d+\/\d+/);

    // The other side sees the same post (it replicates like any other #general message).
    await waitFor(async () => (await joinStatusPosts(alex)).some((p) => p.includes("@kira's kiras-mbp")), { what: "the post to replicate to alex" });

    // A marker keyed by team id makes it durable: a crash between posting and marking can't be told apart from
    // one before the post (the JoinStatusReporter constructor reads it fresh on every daemon start).
    const marker = readFileSync(join(kira.home, "join-status-posted-v1"), "utf8").trim();
    expect(kira.d.core.teamId).not.toBeNull();
    expect(marker).toBe(kira.d.core.teamId as string);

    const total = (await joinStatusPosts(kira)).length;

    // A restart of the newly joined machine (the case the marker exists for) doesn't post a second time.
    await kira.restart();
    await Bun.sleep(300);
    expect(await joinStatusPosts(kira)).toHaveLength(total);

    // Re-joining the same team (join.ts `adopt`: an already-admitted node re-pinning its own IP) doesn't either.
    const rejoined = await kira.client().join(alex.peerAddr);
    expect(rejoined.admitted).toBe(true);
    await Bun.sleep(300);
    expect(await joinStatusPosts(kira)).toHaveLength(total);
  });
});
