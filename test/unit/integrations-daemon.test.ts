// Connectors inside a real daemon with the HTTP layer faked (FakeApis) and the filesystem in temp dirs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Event } from "../../src/protocol/schemas.ts";
import { callTool } from "../../src/mcp/tools.ts";
import { SHARE_API } from "../../src/integrations/wispr-unfurl.ts";
import { FIREFLIES_OVERLAP_MS, parseFirefliesCursor } from "../../src/integrations/fireflies.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { FakeApis } from "../helpers/fake-apis.ts";

const FF_KEY = "ff_fixture_" + "key_0123456789abcdef";
const LIN_KEY = "linfixture_" + "KEY_0123456789abcdef";
const FIXTURES = join(import.meta.dir, "..", "fixtures");

let c: Cluster;
let alex: TestNode;
const apis = new FakeApis();
let keyFile: string;
let wisprDir: string;
let summarizerArgs: string;

async function posts(node: TestNode, channel: string, agent: string): Promise<Event[]> {
  const { events } = await node.client().events({ channel, kinds: "msg.post", limit: 200 });
  return events.filter((e) => e.author.agent === agent).reverse();
}

beforeAll(async () => {
  c = new Cluster();
  const keys = join(c.root, "keys");
  mkdirSync(keys, { recursive: true });
  keyFile = join(keys, "fireflies.txt");
  writeFileSync(keyFile, FF_KEY + "\n", { mode: 0o600 });
  summarizerArgs = join(c.root, "summarizer-args.txt");
  const bin = join(c.root, "fake-claude");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${summarizerArgs}\ncat > /dev/null\nprintf 'Summary:\\n- Billing moves to cents\\nAction items:\\n- Kira Moore: run the dry run\\n'\n`);
  chmodSync(bin, 0o755);
  wisprDir = join(c.root, "wispr-meetings");
  mkdirSync(wisprDir, { recursive: true });
  alex = await c.add({
    name: "alex", login: "alex@example.com", hostname: "alex-mbp",
    integrations: { fetch: apis.fetch, autoRun: false, summarize: { bin }, rateCap: { capacity: 1000, perSecond: 1000 } },
  });
  await alex.client().init("acme", "alex");
  await alex.client().invite("kira@example.com", "kira", "member", "Kira Moore");
  // Connectors never create channels: the person creates them first (INTEGRATIONS-FIX-1 #12).
  for (const name of ["meetings", "linear", "build"]) await alex.client().channel({ name });
});
afterAll(async () => { await c.close(); });

describe("fireflies", () => {
  test("enable with key_path: status shows the path, never the key", async () => {
    const res = await alex.client().configureIntegration("fireflies", { key_path: keyFile, channel: "meetings" });
    expect(res.integration).toMatchObject({ id: "fireflies", enabled: true, configured: true, key_source: "key_path", key_path: keyFile, channel: "meetings" });
    const list = JSON.stringify(await alex.client().integrations());
    expect(list).not.toContain(FF_KEY);
    expect(readFileSync(join(alex.home, "integrations.json"), "utf8")).not.toContain(FF_KEY);
    expect(statSync(join(alex.home, "integrations.json")).mode & 0o777).toBe(0o600);
  });

  test("a new transcript becomes one post (badge agent, mentions, link) with the transcript attached", async () => {
    apis.transcript({ id: "ff-1", date: Date.now() - 60 * 60_000 });
    const res = await alex.client().runIntegration("fireflies");
    expect(res.integration.last_error).toBeNull();
    expect(res.integration.items_posted).toBe(1);
    const [post] = await posts(alex, "meetings", "fireflies");
    expect(post?.author).toMatchObject({ handle: "alex", agent: "fireflies" });
    const text = String(post?.body.text);
    expect(text).toContain("**Meeting: Weekly sync**");
    expect(text).toContain("**Kira Moore** → @kira");
    expect(text).toContain("https://app.fireflies.ai/view/ff-1");
    expect(post?.body.mentions).toEqual(["@kira"]);
    const hash = (post?.body.artifacts as string[])[0] as string;
    const { replies } = await alex.client().event(post!.id);
    expect(replies.find((r) => r.kind === "artifact.share")?.body).toMatchObject({ hash, mime: "text/plain; charset=utf-8" });
    const transcript = new TextDecoder().decode(await alex.client().fetchArtifact(hash));
    expect(transcript).toContain("[1:05] Kira Moore: The dry run is green.");
    expect(apis.calls.filter((r) => r.url.includes("fireflies")).every((r) => r.auth === `Bearer ${FF_KEY}`)).toBe(true);
  });

  test("dedup: running again posts nothing new", async () => {
    await alex.client().runIntegration("fireflies");
    expect((await posts(alex, "meetings", "fireflies")).length).toBe(1);
  });

  test("the cursor survives a restart: no re-post, the next poll starts at the watermark minus the overlap, new meetings still arrive", async () => {
    const before = parseFirefliesCursor(alex.d.integrations.state.cursor("fireflies"));
    expect(before?.page).toBeUndefined(); // the last interval was read to the end
    await alex.restart();
    await alex.client().runIntegration("fireflies");
    expect((await posts(alex, "meetings", "fireflies")).length).toBe(1);
    const lastList = apis.calls.filter((r) => r.query?.includes("transcripts(")).at(-1);
    expect(Date.parse(String(lastList?.variables?.fromDate))).toBe(Math.max(before!.floor, before!.watermark - FIREFLIES_OVERLAP_MS));
    expect(Date.parse(String(lastList?.variables?.toDate))).toBeGreaterThanOrEqual(before!.watermark);
    apis.transcript({ id: "ff-2", date: Date.now() - 5 * 60_000, title: "Design review" });
    await alex.client().runIntegration("fireflies");
    const all = await posts(alex, "meetings", "fireflies");
    expect(all.map((p) => String(p.body.text).split("\n")[0])).toEqual(["**Meeting: Weekly sync**", "**Meeting: Design review**"]);
  });

  test("errors back off with jitter and growing delays; the key never reaches status, logs or config", async () => {
    apis.failWith = 500; // the fake echoes the Authorization header into its error text
    const m = alex.d.integrations;
    const gaps: number[] = [];
    for (let i = 0; i < 3; i++) {
      const v = (await alex.client().runIntegration("fireflies")).integration;
      expect(v.last_error).toContain("fireflies: HTTP 500");
      expect(v.last_error).not.toContain(FF_KEY);
      gaps.push((v.next_run as number) - (v.last_run as number));
    }
    expect(m.state.row("fireflies")?.failures).toBe(3);
    const interval = 300_000;
    expect(gaps[0]).toBeGreaterThanOrEqual(interval * 0.75);
    expect(gaps[0]).toBeLessThanOrEqual(interval * 1.25);
    expect(gaps[2]).toBeGreaterThanOrEqual(interval * 4 * 0.75);
    expect(gaps[2]).toBeLessThanOrEqual(interval * 4 * 1.25);
    expect(m.nextDelay("fireflies", 30)).toBeLessThanOrEqual(60 * 60_000 * 1.25); // capped at an hour
    apis.failWith = null;
    const ok = (await alex.client().runIntegration("fireflies")).integration;
    expect(ok.last_error).toBeNull();
    expect(m.state.row("fireflies")?.failures).toBe(0);
    const log = readFileSync(alex.d.paths.log, "utf8");
    expect(log).toContain("integration_run_failed");
    expect(log).not.toContain(FF_KEY);
    expect(JSON.stringify(await alex.client().integrations())).not.toContain(FF_KEY);
  });
});

describe("configuration rules", () => {
  test("a pasted key is stored 0600 under secrets/ and never returned", async () => {
    const res = await alex.client().configureIntegration("linear", { key: LIN_KEY, channel: "linear", default_team: "KST" });
    expect(res.integration).toMatchObject({ enabled: true, key_source: "secret", key_path: null });
    const f = join(alex.home, "secrets", "linear");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(join(alex.home, "secrets")).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(res)).not.toContain(LIN_KEY);
    expect(readFileSync(join(alex.home, "integrations.json"), "utf8")).not.toContain(LIN_KEY);
  });

  test("bad input is refused: wrong fields, missing key, unknown connector, agents", async () => {
    await expect(alex.client().configureIntegration("fireflies", { dir: "/tmp" })).rejects.toMatchObject({ status: 400 });
    await expect(alex.client().configureIntegration("wispr", { key: "abcdefgh" + "12345" })).rejects.toMatchObject({ status: 400 });
    await expect(alex.client().configureIntegration("nope", {})).rejects.toMatchObject({ status: 404 });
    await expect(alex.client().configureIntegration("fireflies", { key_path: join(c.root, "missing.txt") })).rejects.toMatchObject({ status: 400 });
    // AGENT-ADMIN-1: configuring integrations is admin: an agent is refused while its person has agent admin off.
    await alex.client().adminSwitches({ agent_admin: false });
    try {
      await expect(alex.client("cc-3f9a").configureIntegration("fireflies", { enabled: false })).rejects.toMatchObject({ status: 403, code: "agent_admin_off" });
      await expect(alex.client("cc-3f9a").removeIntegration("fireflies")).rejects.toMatchObject({ status: 403, code: "agent_admin_off" });
    } finally {
      await alex.client().adminSwitches({ agent_admin: true });
    }
  });

  test("connector agent names are reserved for connectors", async () => {
    await expect(alex.client("fireflies").post({ channel: "general", text: "spoofed" })).rejects.toMatchObject({ status: 403 });
    await expect(alex.client().status({ agent: "linear", state: "working" })).rejects.toMatchObject({ status: 403 });
  });

  test("loopback: config changes need the token and a same-origin Origin", async () => {
    const port = alex.d.localPort as number;
    const url = `http://127.0.0.1:${port}/v1/integrations/wispr`;
    const body = JSON.stringify({ enabled: false });
    const noToken = await fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json" } });
    expect(noToken.status).toBe(401);
    // a dashboard session (SEC-COOKIE-2: the X-Walkie-Session header), as `walkie dashboard` gets one
    const { nonce } = await alex.client().authNonce();
    const login = await fetch(`http://127.0.0.1:${port}/auth?nonce=${nonce}`, { redirect: "manual" });
    const sess = { "X-Walkie-Session": /#s=([0-9a-f]{64})$/.exec(login.headers.get("location") ?? "")?.[1] ?? "" };
    const badOrigin = await fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json", ...sess, Origin: "https://evil.example" } });
    expect(badOrigin.status).toBe(403);
    const sessionNoOrigin = await fetch(url, { method: "DELETE", headers: sess });
    expect(sessionNoOrigin.status).toBe(403);
    const ok = await fetch(`http://127.0.0.1:${port}/v1/integrations`, { headers: { Authorization: `Bearer ${alex.d.token}` } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).not.toContain(LIN_KEY);
  });
});

describe("wispr flow", () => {
  function meeting(id: string, ageMin: number): void {
    const d = join(wisprDir, id);
    mkdirSync(d, { recursive: true });
    const lines = [
      { id: "1", timestamp: "00:03", text: "Quick check on the staging snapshot.", speaker: { id: 0, name: null, source: "fixture" } },
      { id: "2", timestamp: "04:10", text: "Restored and verified.", speaker: { id: 1, name: null, source: "fixture" } },
    ];
    writeFileSync(join(d, "refined.ndjson"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const t = new Date(Date.now() - ageMin * 60_000);
    utimesSync(join(d, "refined.ndjson"), t, t);
  }

  test("a completed meeting is posted once with a claude-CLI summary; a settling one waits", async () => {
    meeting("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", 20);
    meeting("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", 2);
    await alex.client().configureIntegration("wispr", { dir: wisprDir, summarize: "claude" });
    const v = (await alex.client().runIntegration("wispr")).integration;
    expect(v.last_error).toBeNull();
    const all = await posts(alex, "meetings", "wispr");
    expect(all.length).toBe(1);
    const text = String(all[0]?.body.text);
    expect(text).toContain("**Wispr Flow meeting**");
    expect(text).toContain("4 min");
    expect(text).toContain("Summary:");
    expect(text).toContain("Kira Moore: run the dry run → @kira");
    expect(text).toContain("> Speaker 1: Quick check on the staging snapshot.");
    const transcript = new TextDecoder().decode(await alex.client().fetchArtifact((all[0]?.body.artifacts as string[])[0] as string));
    expect(transcript).toContain("[4:10] Speaker 2: Restored and verified.");
    expect(readFileSync(summarizerArgs, "utf8").split("\n")).toContain("--no-session-persistence");
    await alex.client().runIntegration("wispr");
    expect((await posts(alex, "meetings", "wispr")).length).toBe(1);
  });

  test("share links are unfurled in the thread; JS-only pages are left alone; the JSON endpoint is a fallback", async () => {
    apis.pages.set("https://notes.wisprflow.ai/shared/fixtureSSR1", { status: 200, type: "text/html; charset=utf-8", body: readFileSync(join(FIXTURES, "wispr-share.html"), "utf8") });
    apis.pages.set("https://notes.wisprflow.ai/shared/fixtureJS22", { status: 200, type: "text/html", body: readFileSync(join(FIXTURES, "wispr-share-jsonly.html"), "utf8") });
    apis.pages.set("https://notes.wisprflow.ai/shared/fixtureAPI3", { status: 200, type: "text/html", body: readFileSync(join(FIXTURES, "wispr-share-jsonly.html"), "utf8") });
    apis.pages.set(`${SHARE_API}fixtureAPI3`, { status: 200, type: "application/json", body: JSON.stringify({ title: "Retro notes", summary: "We keep the Tuesday release train.", notes: null }) });
    const a = (await alex.client().post({ channel: "general", text: "notes: https://notes.wisprflow.ai/shared/fixtureSSR1" })).event;
    const b = (await alex.client().post({ channel: "general", text: "js only https://notes.wisprflow.ai/shared/fixtureJS22" })).event;
    const d = (await alex.client().post({ channel: "general", text: "api https://notes.wisprflow.ai/shared/fixtureAPI3" })).event;
    const reply = await waitFor(async () => (await alex.client().event(a.id)).replies.find((r) => r.author.agent === "wispr" && r.kind === "msg.post"), { what: "unfurl reply" });
    expect(String(reply.body.text)).toContain("**Kestrel standup & billing plan** (Wispr Flow note)");
    expect(String(reply.body.text)).toContain("> Maren confirmed the invoice totals");
    expect(reply.body.thread).toBe(a.id);
    const apiReply = await waitFor(async () => (await alex.client().event(d.id)).replies.find((r) => r.author.agent === "wispr" && r.kind === "msg.post"), { what: "api fallback reply" });
    expect(String(apiReply.body.text)).toContain("We keep the Tuesday release train.");
    await waitFor(() => alex.d.integrations.state.seen("wispr", `unfurl:${b.id}:fixtureJS22`), { what: "js-only link processed" });
    expect((await alex.client().event(b.id)).replies.length).toBe(0);
    // Connector posts are never unfurled (no loops), and the same post isn't unfurled twice.
    expect((await alex.client().event(a.id)).replies.filter((r) => r.author.agent === "wispr" && r.kind === "msg.post").length).toBe(1);
  });
});

describe("linear", () => {
  test("enrichment: title/state/link per key, cached for 5 minutes, unknown keys are null", async () => {
    apis.issue("KST-1", "Todo", { updatedAt: "2026-09-25T08:00:00.000Z" });
    const r1 = await alex.client().linearIssues(["KST-1", "KST-999"]);
    expect(r1.enabled).toBe(true);
    expect(r1.issues["KST-1"]).toMatchObject({ key: "KST-1", title: "Fictional issue KST-1", state: "Todo", url: "https://linear.app/kestrel/issue/kst-1" });
    expect(r1.issues["KST-999"]).toBeNull();
    const before = apis.count((r) => r.url.includes("linear"));
    await alex.client().linearIssues(["KST-1", "KST-999"]);
    expect(apis.count((r) => r.url.includes("linear"))).toBe(before);
    expect(apis.calls.filter((r) => r.url.includes("linear")).every((r) => r.auth === LIN_KEY)).toBe(true); // no Bearer prefix
    await expect(alex.client().linearIssues(["not-a-key"])).rejects.toMatchObject({ status: 400 });
  });

  test("activity: transitions of issues agents work on are posted once each", async () => {
    await alex.client("cc-1").status({ agent: "cc-1", state: "working", title: "cents migration", task: "KST-1" }, { title: "person", task: "person" });
    await waitFor(() => alex.d.core.store.agent(alex.d.nodeId, "cc-1"));
    await alex.client().runIntegration("linear");
    expect((await posts(alex, "linear", "linear")).length).toBe(0); // first sight = baseline
    apis.issue("KST-1", "In Progress", { updatedAt: new Date(Date.now() + 1000).toISOString() });
    await alex.client().runIntegration("linear");
    await alex.client().runIntegration("linear");
    const all = await posts(alex, "linear", "linear");
    expect(all.length).toBe(1);
    expect(String(all[0]?.body.text)).toContain("**KST-1** Todo → In Progress");
    expect(String(all[0]?.body.text)).toContain("https://linear.app/kestrel/issue/kst-1");
  });

  test("activity: history entries after the cursor are posted even for a newly referenced issue", async () => {
    const at = new Date(Date.now() + 5_000).toISOString();
    apis.issue("KST-2", "Done", { updatedAt: at, history: { nodes: [{ id: "hist-1", createdAt: at, fromState: { name: "In Review" }, toState: { id: "st-Done", name: "Done" }, actor: { name: "Ines" } }] } });
    await alex.client("cc-2").status({ agent: "cc-2", state: "working", title: "review", task: "KST-2" }, { title: "person", task: "person" });
    await waitFor(() => alex.d.core.store.agent(alex.d.nodeId, "cc-2"));
    await alex.client().runIntegration("linear");
    const texts = (await posts(alex, "linear", "linear")).map((p) => String(p.body.text));
    expect(texts.filter((t) => t.includes("**KST-2** In Review → Done (by Ines)")).length).toBe(1);
  });

  test("create: dry run sends no mutation; a real (mocked) create links the issue back into the thread", async () => {
    const root = (await alex.client().post({ channel: "build", text: "invoice totals drift by a cent on refunds" })).event;
    const reply = (await alex.client("cc-1").post({ channel: "build", text: "repro: refund 3 items at 0.335", thread: root.id })).event;
    const dry = await alex.client().linearCreate({ title: "Refund rounding drift", from: reply.id, dry_run: true });
    expect(dry.dry_run).toBe(true);
    expect(apis.created.length).toBe(0);
    expect(dry.mutation).toContain("issueCreate");
    const input = (dry.variables as { input: { teamId: string; description: string } }).input;
    expect(input.teamId).toBe("team-kst");
    expect(input.description).toContain("invoice totals drift by a cent on refunds");
    expect(input.description).toContain(`walkie://event/${reply.id}`);
    const res = await alex.client().linearCreate({ title: "Refund rounding drift", from: reply.id, team: "KST" });
    expect(apis.created.length).toBe(1);
    expect(res.issue?.identifier).toBe("KST-901");
    const { replies } = await alex.client().event(root.id);
    const link = replies.find((r) => r.author.agent === "linear");
    expect(String(link?.body.text)).toContain("Created Linear issue **KST-901**");
    expect(String(link?.body.text)).toContain("https://linear.app/kestrel/issue/kst-901");
  });

  test("FINAL Codex 6: a thread in an archived channel is refused BEFORE anything is created; a backlink that fails after creation is a 207 partial success and is posted by the next run", async () => {
    await alex.client().channel({ name: "linear-arch" });
    const root = (await alex.client().post({ channel: "linear-arch", text: "an idea worth an issue" })).event;
    await alex.client().channel({ name: "linear-arch", archived: true });
    const before = apis.created.length;
    const refused = await alex.client().linearCreate({ title: "Archived?", from: root.id, team: "KST" }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 409, code: "post_failed" });
    expect(String((refused as Error).message)).toContain("archived");
    expect(apis.created.length).toBe(before);
    // The race: the channel is archived while Linear is creating the issue. The issue exists; the backlink can't be posted.
    await alex.client().channel({ name: "linear-race" });
    const root2 = (await alex.client().post({ channel: "linear-race", text: "created under a closing door" })).event;
    let open!: () => void;
    apis.gate = new Promise<void>((r) => { open = r; });
    apis.gateQuery = "issueCreate";
    apis.onGate = () => { void alex.client().channel({ name: "linear-race", archived: true }).then(() => open()); };
    const res = await alex.client().linearCreate({ title: "Racy", from: root2.id, team: "KST" });
    apis.gate = null; apis.gateQuery = null; apis.onGate = null;
    expect(apis.created.length).toBe(before + 1);
    expect(res).toMatchObject({ issue: { identifier: "KST-902" }, event: null, backlink: "queued", partial: true });
    const queued = alex.d.integrations.state.retry("linear", "backlink:KST-902");
    expect(queued).not.toBeNull();
    expect((await alex.client().event(root2.id)).replies.filter((r) => r.author.agent === "linear")).toEqual([]);
    // Still archived: the run leaves the job queued (rescheduled). Re-opened: the next run posts the backlink once.
    alex.d.integrations.state.rescheduleRetry("linear", "backlink:KST-902", 0, 0);
    await alex.client().runIntegration("linear");
    expect(alex.d.integrations.state.retry("linear", "backlink:KST-902")?.attempts).toBe(1);
    await alex.client().channel({ name: "linear-race", archived: false });
    alex.d.integrations.state.rescheduleRetry("linear", "backlink:KST-902", 1, 0);
    await alex.client().runIntegration("linear");
    expect(alex.d.integrations.state.retry("linear", "backlink:KST-902")).toBeNull();
    const links = (await alex.client().event(root2.id)).replies.filter((r) => r.author.agent === "linear");
    expect(links.length).toBe(1);
    expect(String(links[0]?.body.text)).toContain("Created Linear issue **KST-902**");
    await alex.client().runIntegration("linear");
    expect((await alex.client().event(root2.id)).replies.filter((r) => r.author.agent === "linear").length).toBe(1);
  });
});

describe("MCP tools", () => {
  test("walkie_meetings lists meeting posts wrapped as external; walkie_meeting pages the transcript", async () => {
    const client = alex.client("cc-mcp");
    const list = await callTool(client, "walkie_meetings", { query: "design review" });
    const out = list.content[0]?.text ?? "";
    expect(out).toContain('trust="external"');
    expect(out).toContain("Design review");
    expect(out).not.toContain("Weekly sync");
    const ff = (await posts(alex, "meetings", "fireflies"))[0] as Event;
    const one = await callTool(client, "walkie_meeting", { event_id: ff.id, max_chars: 1000 });
    expect(one.isError).toBeUndefined();
    expect(one.content[0]?.text).toContain("Kira Moore: The dry run is green.");
    expect(one.content[0]?.text).toContain('trust="external"');
    const notMeeting = await callTool(client, "walkie_meeting", { event_id: (await posts(alex, "linear", "linear"))[0]?.id as string });
    expect(notMeeting.isError).toBe(true);
    const dry = await callTool(client, "walkie_linear_create", { title: "From MCP", dry_run: true });
    expect(dry.content[0]?.text).toContain("dry run, nothing created");
  });

  test("delete forgets settings, the stored secret and the sync state", async () => {
    await alex.client().removeIntegration("linear");
    expect(existsSync(join(alex.home, "secrets", "linear"))).toBe(false);
    const v = (await alex.client().integrations()).integrations.find((i) => i.id === "linear");
    expect(v).toMatchObject({ enabled: false, configured: false, items_posted: 0, last_run: null });
  });
});

describe("rate cap", () => {
  test("a run stops at the cap and continues from the same place later", async () => {
    const fake = new FakeApis();
    const sol = await c.add({ name: "sol", login: "sol@example.com", hostname: "sol-x1", integrations: { fetch: fake.fetch, autoRun: false, rateCap: { capacity: 2, perSecond: 1e-9 } } });
    await sol.client().init("solo", "sol");
    await sol.client().channel({ name: "meetings" });
    const kf = join(c.root, "keys", "ff-sol.txt");
    writeFileSync(kf, FF_KEY, { mode: 0o600 });
    for (let i = 1; i <= 3; i++) fake.transcript({ id: `cap-${i}`, date: Date.now() - (10 - i) * 60_000, title: `Meeting ${i}` });
    await sol.client().configureIntegration("fireflies", { key_path: kf });
    await sol.client().runIntegration("fireflies");
    expect((await posts(sol, "meetings", "fireflies")).map((p) => String(p.body.text).split("\n")[0])).toEqual(["**Meeting: Meeting 1**", "**Meeting: Meeting 2**"]);
    expect(sol.d.integrations.state.seen("fireflies", "cap-3")).toBe(false);
    // The interval is unfinished: the watermark stays, the page to continue from is persisted.
    const cur = parseFirefliesCursor(sol.d.integrations.state.cursor("fireflies"));
    expect(cur?.page?.skip).toBe(0);
    expect(cur?.watermark).toBe(cur?.floor);
  });
});
