// PROJECT-PAGES-1 through real daemons (the in-process Cluster): the real CLI sets facts and adds screens, a second member's
// daemon folds the same page and fetches the same image bytes, a named agent writes and an unnamed one is refused, a project
// of the team's owners is not there for a member, WalkieTalkie's report post carries the story to every member, and a real
// dashboard SESSION (obtained as the dashboard obtains one) reads the page and the image and is refused every write.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WalkieClient, WalkieError } from "../../src/client/index.ts";
import { sniffImage } from "../../src/protocol/projects/page-image.ts";
import type { ProjectView } from "../../src/protocol/projects/schema.ts";
import type { StatusPagePayload } from "../../src/protocol/projects/status-page.ts";
import type { BodyOf } from "../../src/protocol/schemas.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { png } from "../helpers/images.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
async function walkie(node: TestNode, args: string[], env: Record<string, string> = {}) {
  return runAsPerson([process.execPath, CLI, ...args], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: node.home, WALKIE_SOCKET: node.socket, ...env });
}

let c: Cluster;
let alex: TestNode, bob: TestNode;
let web: ProjectView;
let dir: string;
const url = (n: TestNode, path: string) => `http://127.0.0.1:${n.d.localPort as number}${path}`;
const err = (p: Promise<unknown>) => p.then(() => null, (e: WalkieError) => e);
const page = (n: TestNode, channel = web.channel): Promise<StatusPagePayload> => { n.d.projects.flushAll(); return n.client().statusPage(channel); };
const file = (name: string, w: number, h: number, salt = 0) => { const p = join(dir, name); writeFileSync(p, png(w, h, salt)); return p; };
/** A dashboard SESSION, obtained the way the dashboard gets one (a nonce, then /auth): what its requests carry, not the durable token. */
async function session(n: TestNode): Promise<Record<string, string>> {
  const { nonce } = await n.client().authNonce();
  const res = await fetch(url(n, `/auth?nonce=${nonce}`), { redirect: "manual" });
  const value = /#s=([0-9a-f]{64})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
  if (!value) throw new Error("no dashboard session");
  return { "X-Walkie-Session": value, Origin: `http://127.0.0.1:${n.d.localPort as number}`, Accept: "application/json" };
}

beforeAll(async () => {
  dir = mkdtempSync("/tmp/walkie-pages-");
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  bob = await c.add({ name: "bob", login: "bob@example.com", hostname: "bobs-mbp" });
  await alex.client().init("aka", "alex");
  await alex.client().invite("bob@example.com", "bob", "member");
  expect((await bob.client().join(alex.peerAddr)).admitted).toBe(true);
  web = (await alex.client().createProject({ name: "Website relaunch", prefix: "WEB" })).project;
  await waitFor(async () => { bob.d.projects.flushAll(); return (await bob.client().projects()).projects.find((p) => p.channel === web.channel); }, { timeoutMs: 15_000, what: "bob sees the project" });
}, 60_000);

afterAll(async () => { await c.close(); rmSync(dir, { recursive: true, force: true }); });

describe("the real CLI", () => {
  test("turns the page on, sets a fact and lists it", async () => {
    expect((await walkie(alex, ["projects", "report", "WEB", "on"])).code).toBe(0);
    const set = await walkie(alex, ["projects", "fact", "WEB", "Live build", "ddee2f0bca"]);
    expect([set.code, set.out]).toEqual([0, expect.stringContaining("set Live build = ddee2f0bca")]);
    const list = await walkie(alex, ["projects", "fact", "WEB"]);
    expect(list.out).toContain("Live build");
    expect(list.out).toContain("ddee2f0bca");
    expect(JSON.parse((await walkie(alex, ["projects", "fact", "WEB", "--json"])).out).facts).toHaveLength(1);
    const again = await walkie(alex, ["projects", "fact", "WEB", "Live build", "ddee2f0bca"]);
    expect(again.out).toContain("unchanged");
  }, 60_000);

  test("adds a screen with the status as a value (it is a switch elsewhere), replaces it, lists it and takes it off", async () => {
    const add = await walkie(alex, ["projects", "screen", "WEB", file("a.png", 1280, 720, 1), "--title", "Dispatch board", "--group", "Carrier", "--status", "works", "--about", "The board of booked loads.", "--route", "/carrier/dispatch"]);
    expect([add.code, add.out]).toEqual([0, expect.stringContaining("added Carrier / Dispatch board")]);
    const replace = await walkie(alex, ["projects", "screen", "WEB", file("b.png", 1280, 720, 2), "--title", "Dispatch board", "--group", "Carrier", "--status", "partial", "--about", "Crew board still missing."]);
    expect(replace.out).toContain("replaced");
    const list = await walkie(alex, ["projects", "screen", "WEB"]);
    expect(list.out).toContain("Carrier (1)");
    expect(list.out).toContain("partial");
    const bad = await walkie(alex, ["projects", "screen", "WEB", file("c.png", 10, 10), "--title", "T", "--group", "G", "--status", "broken", "--about", "A"]);
    expect(bad.code).not.toBe(0);
    expect(bad.err + bad.out).toContain("--status is one of works, partial, empty, not-built");
    const svg = join(dir, "x.png");
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const notImage = await walkie(alex, ["projects", "screen", "WEB", svg, "--title", "T", "--group", "G", "--status", "works", "--about", "A"]);
    expect(notImage.code).not.toBe(0);
    expect(notImage.err + notImage.out).toContain("PNG, JPEG or WebP");
    expect((await walkie(alex, ["projects", "screen", "WEB", "--remove", "--group", "Carrier", "--title", "Dispatch board"])).out).toContain("removed Carrier / Dispatch board");
    expect((await walkie(alex, ["projects", "screen", "WEB"])).out).toContain("no screens yet");
    // Put one back for the tests below.
    await walkie(alex, ["projects", "screen", "WEB", file("d.png", 1280, 720, 3), "--title", "Dispatch board", "--group", "Carrier", "--status", "works", "--about", "The board of booked loads."]);
  }, 60_000);
});

describe("a second member's daemon", () => {
  test("folds the same page: the fact, the screen and its image bytes, fetched from the machine that has them", async () => {
    await waitFor(async () => { const p = await page(bob); return p.facts.set.length === 1 && p.screens.total === 1; }, { timeoutMs: 20_000, what: "bob has the page" });
    const p = await page(bob);
    expect(p.mode).toBe("hourly");
    expect(p.facts.set[0]).toMatchObject({ label: "Live build", value: "ddee2f0bca", by: { handle: "alex" } });
    const shot = p.screens.groups[0]?.screens[0];
    expect(shot).toMatchObject({ title: "Dispatch board", group: "Carrier", status: "works", w: 1280, h: 720, mime: "image/png", available: true });
    const bytes = await bob.client().roomContent(web.channel, shot?.id ?? "");
    expect(sniffImage(bytes.bytes)).toEqual({ mime: "image/png", width: 1280, height: 720 });
    expect(bytes.bytes).toEqual(png(1280, 720, 3));
  }, 40_000);

  test("a member sets a fact as a person and adds a screen as a named agent; the owner's page shows both with who", async () => {
    expect((await walkie(bob, ["projects", "fact", "WEB", "Next release", "Friday"])).out).toContain("set Next release");
    const agent = new WalkieClient({ socket: bob.socket, agent: "cc-bob", timeoutMs: 15_000 });
    const res = await agent.addScreen(web.channel, png(390, 844, 4), { title: "Today", group: "Driver app", status: "empty", about: "No loads assigned." });
    expect(res.screen.by).toEqual({ handle: "bob", agent: "cc-bob" });
    await waitFor(async () => { const p = await page(alex); return p.facts.set.length === 2 && p.screens.total === 2; }, { timeoutMs: 20_000, what: "alex has bob's page ops" });
    const p = await page(alex);
    expect(p.facts.set.map((f) => [f.label, f.by.handle])).toEqual([["Live build", "alex"], ["Next release", "bob"]]);
    expect(p.screens.groups.map((g) => [g.name, g.screens.length])).toEqual([["Carrier", 1], ["Driver app", 1]]);
  }, 40_000);

  test("an agent that does not name itself is refused, and so is the reserved name", async () => {
    const unnamed = new WalkieClient({ socket: bob.socket, underAgent: true, timeoutMs: 15_000 });
    expect((await err(unnamed.setFact(web.channel, { label: "x", value: "y" })))?.code).toBe("agent_unnamed");
    const reserved = new WalkieClient({ socket: bob.socket, agent: "orchestrator", timeoutMs: 15_000 });
    expect((await err(reserved.setFact(web.channel, { label: "x", value: "y" })))?.status).toBe(403);
    expect((await page(bob)).facts.set.map((f) => f.label)).not.toContain("x");
  });
});

describe("a project of the team's owners", () => {
  test("is not there for a member: the list has none of it, and every page route answers 404", async () => {
    const secret = (await alex.client().createProject({ name: "Confidential plan", private: true })).project;
    await alex.client().setFact(secret.channel, { label: "Phase", value: "one" });
    expect((await page(alex, secret.channel)).facts.set).toHaveLength(1);
    const seen = (await bob.client().projects()).projects.map((p) => p.channel);
    expect(seen).not.toContain(secret.channel);
    expect((await err(bob.client().statusPage(secret.channel)))?.status).toBe(404);
    expect((await err(bob.client().setFact(secret.channel, { label: "x", value: "y" })))?.status).toBe(404);
    expect((await err(bob.client().addScreen(secret.channel, png(10, 10), { title: "T", group: "G", status: "works", about: "A" })))?.status).toBe(404);
  }, 30_000);
});

describe("WalkieTalkie's report", () => {
  test("its post carries the story to every member: the page shows it with when the facts are as of", async () => {
    const asOf = Date.now();
    // The daemon's own WalkieTalkie host checks its lease before it signs under its name; no host runs in this test, so the lease is stood in for.
    alex.d.core.orchestratorCanAct = () => true;
    alex.d.core.emit("msg.post", {
      text: "**Status report · Website relaunch · as of now**\n\n**On track:** sign-in shipped.", status_report: { v: 1, as_of: asOf },
      status_page: { v: 1, headline: "The portal is on track: sign-in is live", lede: "This page shows what the portal does today. Billing is still being built.", live_now: ["Customers can sign in."], landing_next: ["Billing is next."] },
    } as BodyOf<"msg.post">, { channel: web.channel, agent: "orchestrator" });
    delete alex.d.core.orchestratorCanAct;
    for (const n of [alex, bob]) {
      await waitFor(async () => (await page(n)).story !== null, { timeoutMs: 20_000, what: `${n.spec.name} has the story` });
      expect((await page(n)).story).toMatchObject({ headline: "The portal is on track: sign-in is live", live_now: ["Customers can sign in."], as_of: asOf, by: { handle: "alex", agent: "orchestrator" } });
    }
  }, 40_000);
});

describe("a real dashboard session", () => {
  test("reads the page and the image bytes, and is refused every write; the same read with no credential is refused", async () => {
    const h = await session(alex);
    const read = await fetch(url(alex, `/v1/projects/${web.channel}/page`), { headers: h });
    expect(read.status).toBe(200);
    const p = (await read.json()) as StatusPagePayload;
    expect(p.facts.set.length).toBeGreaterThan(0);
    expect(p.story?.headline).toContain("on track");
    const first = p.screens.groups[0]?.screens[0];
    const image = await fetch(url(alex, `/v1/projects/${web.channel}/room/${encodeURIComponent(first?.id ?? "")}/content`), { headers: h });
    expect(image.status).toBe(200);
    expect(image.headers.get("x-walkie-mime")).toBe("image/png");
    expect(sniffImage(new Uint8Array(await image.arrayBuffer()))).toMatchObject({ mime: "image/png" });
    const refused = [
      await fetch(url(alex, `/v1/projects/${web.channel}/page/facts`), { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ label: "x", value: "y" }) }),
      await fetch(url(alex, `/v1/projects/${web.channel}/page/screens`), { method: "POST", headers: { ...h, "Content-Type": "application/octet-stream", "X-Walkie-Screen": encodeURIComponent(JSON.stringify({ title: "T", group: "G", status: "works", about: "A" })) }, body: png(10, 10) as unknown as BodyInit }),
      await fetch(url(alex, `/v1/projects/${web.channel}/page/screens/remove`), { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ group: "Carrier", title: "Dispatch board" }) }),
    ];
    for (const r of refused) expect([401, 403, 404]).toContain(r.status);
    expect((await page(alex)).facts.set.map((f) => f.label)).not.toContain("x");
    const anonymous = await fetch(url(alex, `/v1/projects/${web.channel}/page`), { headers: { Accept: "application/json" } });
    expect([401, 403]).toContain(anonymous.status);
  }, 30_000);
});

describe("a watching dashboard", () => {
  test("is told over its stream when a fact is set, a report arrives or a screen is added, so an open page looks again", async () => {
    const h = await session(alex);
    const res = await fetch(url(alex, "/v1/stream"), { headers: h });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const seen: Array<Record<string, unknown>> = [];
    const decoder = new TextDecoder();
    let buf = "";
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done || !value) return;
        buf += decoder.decode(value);
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const data = buf.slice(0, i).split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
          buf = buf.slice(i + 2);
          if (data) { try { seen.push(JSON.parse(data) as Record<string, unknown>); } catch { /* a heartbeat */ } }
        }
      }
    })();
    const told = (key: "page" | "room") => seen.some((m) => m.type === "board" && m.channel === web.channel && m[key] === true);
    try {
      await alex.client().setFact(web.channel, { label: "Stream check", value: "1" });
      await waitFor(() => told("page"), { timeoutMs: 15_000, what: "a page delta after a fact" });
      const pages = seen.filter((m) => m.type === "board" && m.page === true).length;
      alex.d.core.orchestratorCanAct = () => true;
      alex.d.core.emit("msg.post", { text: "**Status report · Website relaunch · as of now**\n\nBody.", status_report: { v: 1, as_of: Date.now() } } as BodyOf<"msg.post">, { channel: web.channel, agent: "orchestrator" });
      delete alex.d.core.orchestratorCanAct;
      await waitFor(() => seen.filter((m) => m.type === "board" && m.page === true).length > pages, { timeoutMs: 15_000, what: "a page delta after a report" });
      await alex.client("cc-stream").addScreen(web.channel, png(64, 64, 9), { title: "Stream check", group: "Carrier", status: "works", about: "A screen added while the dashboard watches." });
      await waitFor(() => told("room"), { timeoutMs: 15_000, what: "a room delta after a screen" });
      // None of it asked a dashboard to refetch the board.
      expect(seen.filter((m) => m.type === "board" && m.channel === web.channel && (m.reset === true || Array.isArray(m.cards) && (m.cards as unknown[]).length > 0))).toEqual([]);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }, 60_000);
});
