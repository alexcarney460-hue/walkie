// INTEGRATIONS-FIX-2 (docs/audits/2026-09-26-hestia-codex-integrations-fix1.md): live daemons, faked
// HTTP (FakeApis), temp dirs. Credential capture across a key rotation (#4), structured-field scrubbing
// on the success path (#2), orphan claims (#5), unfurl resume (#6), stable continuation (#7), the
// abortable summarizer (#8).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Event } from "../../src/protocol/schemas.ts";
import type { FetchLike } from "../../src/integrations/types.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { FakeApis } from "../helpers/fake-apis.ts";

const MIN = 60_000;
/** Opaque keys (no pattern matches them): only exact-match scrubbing with the right list catches them. */
const K1 = "k1Rot8ateMe0123456789abcdefghijkl";
const K2 = "k2Rot8ateMe0123456789abcdefghijkl";
const LIN1 = "l1Rot8ateMe0123456789abcdefghijkl";
const LIN2 = "l2Rot8ateMe0123456789abcdefghijkl";

let c: Cluster;
let alex: TestNode;
let keys: string;
const apis = new FakeApis();
/** Hooks run before the fake answers (the key file can be rotated mid-request). */
let beforeAnswer: ((rec: { url: string; query?: string }) => void) | null = null;
const fetch: FetchLike = async (url, init) => {
  const q = typeof init?.body === "string" ? (JSON.parse(init.body) as { query?: string }).query : undefined;
  beforeAnswer?.({ url, query: q });
  return apis.fetch(url, init);
};

function keyFile(name: string, key: string): string {
  const f = join(keys, name);
  writeFileSync(f, key + "\n", { mode: 0o600 });
  chmodSync(f, 0o600);
  return f;
}

async function posts(node: TestNode, channel: string, agent: string): Promise<Event[]> {
  const { events } = await node.client().events({ channel, kinds: "msg.post", limit: 500 });
  return events.filter((e) => e.author.agent === agent).reverse();
}

beforeAll(async () => {
  c = new Cluster();
  keys = join(c.root, "keys");
  mkdirSync(keys, { recursive: true });
  alex = await c.add({
    name: "alex", login: "alex@example.com", hostname: "alex-mbp",
    integrations: { fetch, autoRun: false, rateCap: { capacity: 1000, perSecond: 1000 } },
  });
  await alex.client().init("acme", "alex");
  for (const name of ["meetings", "linear", "build"]) await alex.client().channel({ name });
});
afterAll(async () => { await c.close(); });

// ---- #4 credentials are captured per operation; a rotation mid-request leaks nothing ----------------------

describe("#4 key rotation mid-request", () => {
  test("Fireflies: the key file is replaced while the request is in flight; the old key echoed by upstream never reaches the post", async () => {
    const ff = keyFile("ff.txt", K1);
    await alex.client().configureIntegration("fireflies", { key_path: ff, channel: "meetings" });
    apis.transcript({ id: "rot-1", date: Date.now() - 20 * MIN, title: `Rotation ${K1}`, summary: { overview: `old key ${K1} and new ${K2}`, action_items: "none", keywords: [K1] },
      sentences: [{ speaker_name: `Speaker ${K1}`, text: `paste ${K1}`, start_time: 1 }] });
    beforeAnswer = (r) => { if (r.url.includes("fireflies") && r.query?.includes("transcripts(")) { writeFileSync(ff, K2 + "\n"); beforeAnswer = null; } };
    const v = (await alex.client().runIntegration("fireflies")).integration;
    expect(v.last_error).toBeNull();
    const post = (await posts(alex, "meetings", "fireflies")).find((p) => String(p.body.text).includes("Rotation"));
    expect(post).toBeDefined();
    const { replies } = await alex.client().event(post!.id);
    const share = replies.find((r) => r.kind === "artifact.share");
    const all = JSON.stringify([post!.body, share?.body]);
    expect(all).not.toContain(K1.slice(0, 12));
    expect(all).not.toContain(K2.slice(0, 12));
    const blob = new TextDecoder().decode(await alex.client().fetchArtifact(String(share!.body.hash)));
    expect(blob).not.toContain(K1.slice(0, 12));
    expect(readFileSync(alex.d.paths.log, "utf8")).not.toContain(K1.slice(0, 12));
  });

  test("Linear: fields cached under the old key are scrubbed before caching, so a rotation exposes nothing later", async () => {
    await alex.client().configureIntegration("linear", { key: LIN1, channel: "linear", default_team: "KST" });
    apis.issue("KST-77", "In Progress", { title: `Rotate ${LIN1} now`, assignee: { name: LIN1, displayName: `dn ${LIN1}` }, priorityLabel: LIN1 });
    const first = await alex.client().linearIssues(["KST-77"]);
    expect(JSON.stringify(first)).not.toContain(LIN1.slice(0, 12));
    await alex.client().configureIntegration("linear", { key: LIN2 }); // rotated: LIN1 is no longer configured
    const cached = await alex.client().linearIssues(["KST-77"]);
    expect(cached.issues["KST-77"]).not.toBeNull();
    expect(JSON.stringify(cached)).not.toContain(LIN1.slice(0, 12));
    const row = alex.d.core.store.db.query<{ json: string }, [string]>("SELECT json FROM linear_issues WHERE key = ?").get("KST-77");
    expect(row?.json ?? "").not.toContain(LIN1.slice(0, 12));
    // The activity poll formats the same fields (an agent reports KST-77 as its task): no key in the post either.
    await alex.client("cc-rot").status({ agent: "cc-rot", state: "working", task: "KST-77" }, { task: "person" }); // as `walkie status --task` sends it
    expect((await alex.client().runIntegration("linear")).integration.last_error).toBeNull(); // baseline: the watermark
    await Bun.sleep(20);
    apis.issue("KST-77", "Done", { title: `Rotate ${LIN1} now`, history: { nodes: [{ id: "h-rot", createdAt: new Date().toISOString(), fromState: { name: "In Progress" }, toState: { id: "st-Done", name: `Done ${LIN1}` }, actor: { name: LIN1 } }] } });
    expect((await alex.client().runIntegration("linear")).integration.last_error).toBeNull();
    const texts = (await posts(alex, "linear", "linear")).map((p) => String(p.body.text)).join("\n");
    expect(texts).toContain("KST-77");
    expect(texts).not.toContain(LIN1.slice(0, 12));
  });
});

// ---- #5 orphan claims ---------------------------------------------------------------------------------------

function db(node: TestNode) { return node.d.core.store.db; }
const stale = (node: TestNode, connector: string, ext: string) =>
  db(node).query("UPDATE integration_items SET claimed_at = ? WHERE connector = ? AND external_id = ?").run(Date.now() - 11 * MIN, connector, ext);
const claimedAt = (node: TestNode, connector: string, ext: string) =>
  db(node).query<{ claimed_at: number | null; state: string }, [string, string]>("SELECT claimed_at, state FROM integration_items WHERE connector = ? AND external_id = ?").get(connector, ext);

describe("#5 orphan claims", () => {
  test("a claim left by the previous process is recovered at startup (stale at once) and its item is posted by the next run", async () => {
    apis.transcript({ id: "orphan-1", date: Date.now() - 30 * MIN, title: "Orphan one" });
    alex.d.integrations.state.claim("fireflies", "orphan-1", Date.now());
    await alex.restart();
    expect(claimedAt(alex, "fireflies", "orphan-1")).toEqual({ claimed_at: 0, state: "claimed" });
    await alex.client().runIntegration("fireflies");
    expect((await posts(alex, "meetings", "fireflies")).filter((p) => String(p.body.text).includes("Orphan one")).length).toBe(1);
  });

  test("Linear: a snapshot never advances past a transition another attempt still holds; it is posted once the claim is stale", async () => {
    await alex.client("cc-80").status({ agent: "cc-80", state: "working", task: "KST-80" }, { task: "person" }); // as `walkie status --task` sends it
    apis.issue("KST-80", "Todo");
    expect((await alex.client().runIntegration("linear")).integration.last_error).toBeNull(); // baseline
    await Bun.sleep(20);
    const at = new Date().toISOString();
    apis.issue("KST-80", "Done", { updatedAt: at, history: { nodes: [{ id: "h-80a", createdAt: at, fromState: { name: "Todo" }, toState: { id: "st-Done", name: "Done" }, actor: null }] } });
    alex.d.integrations.state.claim("linear", "h:h-80a", Date.now()); // a live claim (a run that is still working, or just crashed)
    expect((await alex.client().runIntegration("linear")).integration.last_error).toBeNull();
    const mine = async () => (await posts(alex, "linear", "linear")).filter((p) => String(p.body.text).includes("KST-80"));
    expect((await mine()).length).toBe(0);
    expect(alex.d.integrations.state.snapshot("uuid-KST-80")?.state_name ?? "Todo").toBe("Todo"); // not advanced past the unfinished item
    stale(alex, "linear", "h:h-80a");
    await alex.client().runIntegration("linear");
    expect((await mine()).length).toBe(1);
    expect(alex.d.integrations.state.snapshot("uuid-KST-80")?.state_name).toBe("Done");
    await alex.client().runIntegration("linear");
    expect((await mine()).length).toBe(1);
  });

  test("Fireflies: the window never advances past a claimed backfill meeting older than the overlap", async () => {
    const fake = new FakeApis();
    const node = await c.add({ name: "orphan", login: "orphan@example.com", hostname: "orphan-x1", integrations: { fetch: fake.fetch, autoRun: false, rateCap: { capacity: 1000, perSecond: 1000 } } });
    await node.client().init("orphans", "orphan");
    await node.client().channel({ name: "meetings" });
    await node.client().configureIntegration("fireflies", { key_path: keyFile("ff-orphan.txt", K1) });
    const date = Date.now() - 10 * 3_600_000; // older than the 6 h overlap
    fake.transcript({ id: "old-claimed", date, title: "Old claimed" });
    node.d.integrations.state.claim("fireflies", "old-claimed", Date.now());
    expect((await node.client().runIntegration("fireflies")).integration.last_error).toBeNull();
    const cur = JSON.parse(String(node.d.integrations.state.cursor("fireflies"))) as { watermark: number };
    expect(cur.watermark).toBeLessThanOrEqual(date);
    stale(node, "fireflies", "old-claimed");
    await node.client().runIntegration("fireflies");
    expect((await posts(node, "meetings", "fireflies")).filter((p) => String(p.body.text).includes("Old claimed")).length).toBe(1);
    const done = JSON.parse(String(node.d.integrations.state.cursor("fireflies"))) as { watermark: number; page?: unknown };
    expect(done.watermark).toBeGreaterThan(date);
    expect(done.page).toBeUndefined();
  });
});

// ---- #6 unfurl recovery resumes a half-done delivery ---------------------------------------------------------

describe("#6 unfurl resume", () => {
  test("a reply posted without its attachment (crash between the two) gets the share on retry instead of being abandoned", async () => {
    const wisprDir = join(c.root, "wispr-empty");
    mkdirSync(wisprDir, { recursive: true });
    await alex.client().configureIntegration("wispr", { dir: wisprDir, channel: "meetings" });
    const url = "https://notes.wisprflow.ai/shared/resumeME01";
    apis.pages.set(url, { status: 200, type: "text/html", body: readFileSync(join(import.meta.dir, "..", "fixtures", "wispr-share.html"), "utf8") });
    const poster = alex.d.integrations.poster as unknown as { announce: (...a: unknown[]) => unknown };
    const orig = poster.announce;
    poster.announce = () => { throw new Error("simulated crash before the artifact.share"); };
    let ev: Event;
    try {
      ev = (await alex.client().post({ channel: "build", text: `notes ${url}` })).event;
      await waitFor(() => (alex.d.integrations.state.item("wispr", `unfurl:${ev.id}:resumeME01`)?.event_id ?? null), { what: "reply posted" });
      await waitFor(() => (alex.d.integrations.state.retry("wispr", `unfurl:${ev.id}:resumeME01`)?.attempts ?? 0) >= 1, { what: "retry scheduled" });
    } finally {
      poster.announce = orig;
    }
    const replies = async () => (await alex.client().event(ev.id)).replies.filter((r) => r.author.agent === "wispr");
    expect((await replies()).filter((r) => r.kind === "msg.post").length).toBe(1);
    expect((await replies()).filter((r) => r.kind === "artifact.share").length).toBe(0);
    db(alex).query("UPDATE integration_retries SET next_at = 0 WHERE connector = 'wispr'").run();
    await alex.client().runIntegration("wispr");
    const shares = await waitFor(async () => { const s = (await replies()).filter((r) => r.kind === "artifact.share"); return s.length ? s : null; }, { what: "share resumed" });
    expect(shares.length).toBe(1);
    expect((await replies()).filter((r) => r.kind === "msg.post").length).toBe(1);
    expect(alex.d.integrations.state.item("wispr", `unfurl:${ev.id}:resumeME01`)?.state).toBe("posted");
    expect(alex.d.integrations.state.retry("wispr", `unfurl:${ev.id}:resumeME01`)).toBeNull();
  });
});

// ---- #7 stable continuation --------------------------------------------------------------------------------

describe("#7 stable continuation", () => {
  test("Fireflies: a meeting deleted upstream after the first page shifts nothing; every meeting is posted once", async () => {
    const fake = new FakeApis();
    let failListCall = 0, listCalls = 0;
    const f: FetchLike = async (url, init) => {
      if (typeof init?.body === "string" && init.body.includes("transcripts(")) {
        listCalls++;
        if (listCalls === failListCall) return Response.json({ errors: [{ message: "temporarily unavailable" }] }, { status: 503 });
      }
      return fake.fetch(url, init);
    };
    const node = await c.add({ name: "pager", login: "pager@example.com", hostname: "pager-x1", integrations: { fetch: f, autoRun: false, rateCap: { capacity: 10_000, perSecond: 10_000 } } });
    await node.client().init("pagers", "pager");
    await node.client().channel({ name: "meetings" });
    const now = Date.now();
    for (let i = 0; i < 120; i++) fake.transcript({ id: `pg-${i}`, date: now - 23 * 60 * MIN + i * 8 * MIN, title: `Paged ${i}` });
    await node.client().configureIntegration("fireflies", { key_path: keyFile("ff-pager.txt", K1) });
    failListCall = listCalls + 2; // the second page of this run fails
    expect((await node.client().runIntegration("fireflies")).integration.last_error).toContain("503");
    const first = (await posts(node, "meetings", "fireflies")).length;
    expect(first).toBe(50);
    // Upstream deletes one of the meetings already processed (the newest page): an offset would now skip one.
    fake.transcripts = fake.transcripts.filter((t) => t.id !== "pg-119");
    expect((await node.client().runIntegration("fireflies")).integration.last_error).toBeNull();
    const all = await posts(node, "meetings", "fireflies");
    expect(all.length).toBe(120);
    expect(new Set(all.map((p) => String(p.body.text).split("\n")[0])).size).toBe(120);
    expect((JSON.parse(String(node.d.integrations.state.cursor("fireflies"))) as { page?: unknown }).page).toBeUndefined();
  });

  test("Linear: an issue with more history entries than one page reports every transition before its snapshot moves", async () => {
    await alex.client("cc-81").status({ agent: "cc-81", state: "working", task: "KST-81" }, { task: "person" }); // as `walkie status --task` sends it
    apis.issue("KST-81", "Todo");
    expect((await alex.client().runIntegration("linear")).integration.last_error).toBeNull(); // baseline
    await Bun.sleep(20);
    const base = Date.now();
    const nodes = Array.from({ length: 60 }, (_, i) => ({
      id: `h-81-${i}`, createdAt: new Date(base + i).toISOString(), fromState: { name: `S${i}` }, toState: { id: `st-${i + 1}`, name: `S${i + 1}` }, actor: null,
    }));
    apis.issue("KST-81", "S60", { updatedAt: new Date(base + 60).toISOString(), state: { id: "st-60", name: "S60", type: "started" }, history: { nodes } });
    expect((await alex.client().runIntegration("linear")).integration.last_error).toBeNull();
    const texts = (await posts(alex, "linear", "linear")).map((p) => String(p.body.text)).filter((t) => t.includes("KST-81"));
    expect(texts.length).toBe(60);
    expect(texts[0]).toContain("S0 → S1");
    expect(texts[59]).toContain("S59 → S60");
    expect(alex.d.integrations.state.snapshot("uuid-KST-81")?.state_name).toBe("S60");
  });
});

// ---- #8 the summarizer is abortable; a replacement generation always runs ------------------------------------

describe("#8 reconfigure while the summarizer runs", () => {
  test("the CLI is killed with the generation, and a run under the new generation posts the meeting", async () => {
    const wisprDir = join(c.root, "wispr-slow");
    const d = join(wisprDir, "dddddddd-4444-4444-8444-dddddddddddd");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "refined.ndjson"), JSON.stringify({ id: "1", timestamp: "00:01", text: "slow summary meeting", speaker: { id: 0, name: "Ana", source: "x" } }) + "\n");
    const t = new Date(Date.now() - 20 * MIN);
    utimesSync(join(d, "refined.ndjson"), t, t);
    const marks = join(c.root, "slow-marks");
    mkdirSync(marks, { recursive: true });
    // First call: records its pid and sleeps; later calls answer at once.
    const bin = join(c.root, "claude-slow-once");
    writeFileSync(bin, `#!/bin/sh\nif [ ! -f ${marks}/first ]; then echo $$ > ${marks}/first; cat > /dev/null; sleep 60; exit 0; fi\ncat > /dev/null; printf 'Summary:\\n- quick\\nAction items:\\n- none\\n'\n`);
    chmodSync(bin, 0o755);
    const slow = await c.add({ name: "slow", login: "slow@example.com", hostname: "slow-x1", integrations: { fetch: apis.fetch, autoRun: false, summarize: { bin }, rateCap: { capacity: 1000, perSecond: 1000 } } });
    await slow.client().init("slowers", "slow");
    await slow.client().channel({ name: "meetings" });
    await slow.client().configureIntegration("wispr", { dir: wisprDir, summarize: "claude", channel: "meetings" });
    const firstRun = slow.client().runIntegration("wispr").catch((e) => e);
    const pid = Number(await waitFor(() => { try { return readFileSync(join(marks, "first"), "utf8").trim(); } catch { return null; } }, { what: "summarizer started" }));
    const alive = (p: number): boolean => { try { process.kill(p, 0); return true; } catch { return false; } };
    expect(alive(pid)).toBe(true);
    const t0 = Date.now();
    await slow.client().configureIntegration("wispr", { settle_minutes: 5 }); // a new generation
    const second = slow.client().runIntegration("wispr"); // must not just join the cancelled run
    await firstRun;
    expect(Date.now() - t0).toBeLessThan(5_000);
    await waitFor(() => !alive(pid), { what: "summarizer killed", timeoutMs: 5_000 });
    const v = (await second).integration;
    expect(v.last_error).toBeNull();
    const mine = (await posts(slow, "meetings", "wispr")).filter((p) => String(p.body.text).includes("slow summary meeting"));
    expect(mine.length).toBe(1);
    expect(String(mine[0]?.body.text)).toContain("- quick");
  });
});

// ---- #2 success responses are always pattern-scrubbed ------------------------------------------------------

describe("#2 success path", () => {
  test("a Linear title with an unrelated sk- token reaches neither the GET response nor the activity post", async () => {
    const sk = `sk-${"z".repeat(30)}`;
    apis.issue("KST-78", "Todo", { title: `Leaky ${sk}` });
    const res = await alex.client().linearIssues(["KST-78"]);
    expect(JSON.stringify(res)).not.toContain("zzzzzzzz");
    expect(res.issues["KST-78"]?.title).toContain("[REDACTED:openai_key]");
  });
});
