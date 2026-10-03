// PROJECT-REPORTS-1 delivery, with the model's turn faked as a reply: each project's report is posted in its channel as
// WalkieTalkie, saved as the Data Room document `Status report` (a new version each time, the next file when one is pinned
// or full), and its time recorded where the schedules keep state; what the reply gets wrong costs only that project.
import { afterEach, describe, expect, test } from "bun:test";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import "../../src/daemon/projects/routes.ts";
import { addFile, fileContent } from "../../src/daemon/projects/room.ts";
import { latestStatusReport, prepareProjectReports } from "../../src/daemon/projects/status-report.ts";
import { updateCard, updateProject, type WriteCtx } from "../../src/daemon/projects/service.ts";
import { REPORT_MARKER_PREFIX, REPORT_TIMES_META, readReportTimes } from "../../src/daemon/orchestrator/report-times.ts";
import type { PreparedTurn, SkippedTurn } from "../../src/daemon/orchestrator/prepared.ts";
import type { StatusReportPayload } from "../../src/protocol/projects/status-report-setting.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { ROOM_LIMITS, versionCount } from "../../src/protocol/projects/room.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { feed } from "../helpers/core.ts";
import { ev, tnode } from "../helpers/events.ts";
import { reportsWorld } from "../helpers/project-reports.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });

const turn = (r: PreparedTurn | SkippedTurn): PreparedTurn => {
  if ("skip" in r) throw new Error(`expected a turn, got a skip: ${r.skip}`);
  return r;
};
const block = (channel: string, body: string) => `<status-report project="${channel}">\n${body}\n</status-report>`;
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const H = 3_600_000;
const BODY = "**On track:** the pricing page shipped.\n\n## Done since the last report\n- Shipped the pricing page.\n\n## Next\n- Checkout.";

/** A project with one card, a prepared turn for it, and what to call to deliver its reply. */
async function ready() {
  const t = reportsWorld(cleanups);
  const web = await t.project("Website", "WEB");
  t.card(web, "WEB-1 Pricing page");
  t.tick(); // the card is in before the facts are gathered
  const prepared = turn(await prepareProjectReports(t.deps, () => true));
  return { t, web, prepared, at: t.wall() };
}
const reportPosts = (t: ReturnType<typeof reportsWorld>, channel: string): Event[] =>
  t.core.store.queryEvents({ channel, kinds: ["msg.post"], limit: 200 }).map((r) => JSON.parse(r.json) as Event)
    .filter((e) => (e.body as { status_report?: unknown }).status_report !== undefined);

describe("a report that arrives", () => {
  test("is posted in the project's channel as WalkieTalkie, with its facts' time, and no card key", async () => {
    const { t, web, prepared, at } = await ready();
    const out = prepared.finish?.({ text: `Here you go.\n${block(web.channel, BODY.replace("pricing page", "pricing page (WEB-1)"))}`, ok: true }, at);
    expect(out).toEqual({ text: "Reported 1 of 1 changed project.", ok: true });
    const [post, ...rest] = reportPosts(t, web.channel);
    expect(rest).toEqual([]);
    expect(post?.author).toMatchObject({ handle: "alex", agent: "orchestrator" });
    expect((post?.body as { status_report: unknown }).status_report).toEqual({ v: 1, as_of: at });
    const text = (post?.body as { text: string }).text;
    expect(text.startsWith("**Status report · Website · as of ")).toBe(true);
    expect(text).toContain("**On track:** the pricing page shipped.");
    expect(text).not.toMatch(/WEB-\d/);
  });

  test("is saved as the Data Room document Status report, and the next one is a new version of it", async () => {
    const { t, web, prepared, at } = await ready();
    prepared.finish?.({ text: block(web.channel, BODY), ok: true }, at);
    const first = t.idx.room(web.channel).filter((f) => f.state === "active");
    expect(first.map((f) => [f.name, f.versions.length, f.pinned])).toEqual([["Status report", 1, false]]);
    const post = (reportPosts(t, web.channel)[0]?.body as { text: string }).text;
    expect(decode((await fileContent(t.w, web.channel, "Status report", undefined, async () => null)).bytes)).toBe(`${post}\n`);
    // Something changes; the next hour's report replaces it (a version), the channel gets a second post.
    t.tick();
    updateCard(t.w, t.idx.db.cards(web.channel, { states: ["open"], limit: 1 })[0]!.id, { column: "doing" });
    const second = turn(await prepareProjectReports(t.deps, () => true));
    expect(second.evidence).toContain("Last report: ");
    second.finish?.({ text: block(web.channel, "**Slipping:** checkout is late.\n\n## Next\n- Checkout."), ok: true }, t.core.clock());
    const room = t.idx.room(web.channel).filter((f) => f.state === "active");
    expect(room.map((f) => [f.name, f.versions.length])).toEqual([["Status report", 2]]);
    const latest = decode((await fileContent(t.w, web.channel, "Status report", undefined, async () => null)).bytes);
    expect(latest).toContain("**Slipping:** checkout is late.");
    expect(reportPosts(t, web.channel)).toHaveLength(2);
  });

  test("is recorded: the next prepare finds nothing new, and a successor lead reads the time from the team's marker", async () => {
    const { t, web, prepared, at } = await ready();
    prepared.finish?.({ text: block(web.channel, BODY), ok: true }, at);
    expect(readReportTimes(t.core).get(web.channel)).toBe(at);
    t.tick();
    expect(await prepareProjectReports(t.deps, () => true)).toEqual({ skip: "No changes since the last report (1 project checked); no model turn." });
    // Another machine has none of this daemon's cache: the signed marker in the schedule channel carries the time.
    t.core.store.deleteMeta(REPORT_TIMES_META);
    expect(readReportTimes(t.core).get(web.channel)).toBe(at);
    const marker = t.core.store.queryEvents({ channel: SCHEDULE_CHANNEL, kinds: ["msg.post"], limit: 20 }).map((r) => JSON.parse(r.json) as Event)
      .find((e) => (e.body as { text: string }).text.startsWith(REPORT_MARKER_PREFIX));
    expect(marker?.author.agent).toBeUndefined();
    expect(JSON.parse((marker?.body as { text: string }).text.slice(REPORT_MARKER_PREFIX.length))).toEqual({ reported: { [web.channel]: at } });
  });

  test("is remembered by this daemon even when the team's marker cannot be written", async () => {
    const { t, web, prepared, at } = await ready();
    const emit = t.core.emit.bind(t.core);
    t.core.emit = ((kind: Parameters<typeof emit>[0], body: Parameters<typeof emit>[1], opts: Parameters<typeof emit>[2]) => {
      if (opts?.channel === SCHEDULE_CHANNEL) throw new Error("schedule channel unavailable");
      return emit(kind, body, opts);
    }) as typeof emit;
    expect(prepared.finish?.({ text: block(web.channel, BODY), ok: true }, at)).toEqual({ text: "Reported 1 of 1 changed project.", ok: true });
    expect(readReportTimes(t.core).get(web.channel)).toBe(at);
    t.tick();
    expect(await prepareProjectReports(t.deps, () => true)).toMatchObject({ skip: expect.stringContaining("No changes") });
  });

  test("is delivered even when this daemon's own note of it cannot be written: the room has it, and the team's marker carries the time", async () => {
    const { t, web, prepared, at } = await ready();
    const setMeta = t.core.store.setMeta.bind(t.core.store);
    t.core.store.setMeta = ((key: string, value: string) => {
      if (key === REPORT_TIMES_META) throw new Error("disk full");
      return setMeta(key, value);
    }) as typeof setMeta;
    expect(prepared.finish?.({ text: block(web.channel, BODY), ok: true }, at)).toEqual({ text: "Reported 1 of 1 changed project.", ok: true });
    expect(reportPosts(t, web.channel)).toHaveLength(1);
    expect(t.idx.room(web.channel).filter((f) => f.state === "active").map((f) => f.name)).toEqual(["Status report"]);
    expect(readReportTimes(t.core).get(web.channel)).toBe(at);
  });

  test("only a person-signed marker counts as a report time", async () => {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB");
    t.core.emit("msg.post", { text: `${REPORT_MARKER_PREFIX}${JSON.stringify({ reported: { [web.channel]: 9_000 } })}` }, { channel: SCHEDULE_CHANNEL, agent: "cc-1" });
    t.core.emit("msg.post", { text: `${REPORT_MARKER_PREFIX}{"reported":{"not a channel":1}}` }, { channel: SCHEDULE_CHANNEL });
    t.core.emit("msg.post", { text: `${REPORT_MARKER_PREFIX}${JSON.stringify({ reported: { [web.channel]: 7_000 } })}` }, { channel: SCHEDULE_CHANNEL });
    expect(readReportTimes(t.core).get(web.channel)).toBe(7_000);
  });

  test("a marker older than 60 days is not read: that project reads as never reported", async () => {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB");
    t.core.emit("msg.post", { text: `${REPORT_MARKER_PREFIX}${JSON.stringify({ reported: { [web.channel]: 7_000 } })}` }, { channel: SCHEDULE_CHANNEL });
    expect(readReportTimes(t.core).get(web.channel)).toBe(7_000);
    t.tick(61 * 24 * 3_600_000);
    expect(readReportTimes(t.core).has(web.channel)).toBe(false);
  });

  test("a plain sentence with wk1 (week 1) is posted, saved and recorded: the daemon's own join-code check accepts it", async () => {
    const { t, web, prepared, at } = await ready();
    const out = prepared.finish?.({ text: block(web.channel, "**On track.** The wk1 launch checklist for the new pricing page rollout was finished early by the team and the next steps follow."), ok: true }, at);
    expect(out).toEqual({ text: "Reported 1 of 1 changed project.", ok: true });
    const text = (reportPosts(t, web.channel)[0]?.body as { text: string }).text;
    expect(text).toContain("The wk-1 launch checklist for the new pricing page rollout was finished early");
    expect(t.idx.room(web.channel).filter((f) => f.state === "active").map((f) => f.name)).toEqual(["Status report"]);
    expect(readReportTimes(t.core).get(web.channel)).toBe(at);
  });

  test("a code disguised with accents and fillers, written by the model into its report, is not posted, saved or recorded in any form", async () => {
    const { t, web, prepared, at } = await ready();
    const code = `wk1${"AbCdEfGhIjKlMnOpQrStUvWxYz".repeat(2)}`;
    const disguised = [...code].map((ch, i) => (i % 7 === 6 ? `${ch}\u3164` : ch)).join("").replace("A", "A\u0301");
    prepared.finish?.({ text: block(web.channel, `**On track.** The team pasted ${disguised} into a card today and nothing else changed this hour.`), ok: true }, at);
    const bare = (x: string) => x.normalize("NFKD").replace(/[^A-Za-z0-9]/g, "");
    const post = (reportPosts(t, web.channel)[0]?.body as { text: string } | undefined)?.text ?? "";
    const saved = t.idx.room(web.channel).length ? decode((await fileContent(t.w, web.channel, "Status report", undefined, async () => null)).bytes) : "";
    for (const text of [post, saved]) expect(bare(text)).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz");
  });

  test("is cleaned first: a secret is redacted and a stray tag dropped", async () => {
    const { t, web, prepared, at } = await ready();
    prepared.finish?.({ text: block(web.channel, `${BODY}\n- Key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA <status-report project="oops">`), ok: true }, at);
    const text = (reportPosts(t, web.channel)[0]?.body as { text: string }).text;
    expect(text).not.toContain("sk-ant-api03");
    expect(text).not.toContain("<status-report");
    const doc = decode((await fileContent(t.w, web.channel, "Status report", undefined, async () => null)).bytes);
    expect(doc).not.toContain("sk-ant-api03");
  });
});

describe("a reply that is not right", () => {
  async function two() {
    const t = reportsWorld(cleanups);
    const web = await t.project("Website", "WEB");
    const ops = await t.project("Ops", "OPS");
    t.card(web, "Pricing page");
    t.card(ops, "Pager rota");
    t.tick();
    const prepared = turn(await prepareProjectReports(t.deps, () => true));
    return { t, web, ops, prepared, at: t.wall() };
  }

  test("a project it left out costs only that project: the other is delivered, the missing one is tried again", async () => {
    const { t, web, ops, prepared, at } = await two();
    const out = prepared.finish?.({ text: block(web.channel, BODY), ok: true }, at);
    expect(out).toEqual({ text: "Reported 1 of 2 changed projects; 1 had no usable report and is tried again next hour.", ok: true });
    expect(readReportTimes(t.core).has(web.channel)).toBe(true);
    expect(readReportTimes(t.core).has(ops.channel)).toBe(false);
    expect(reportPosts(t, ops.channel)).toEqual([]);
    t.tick();
    const next = turn(await prepareProjectReports(t.deps, () => true));
    expect(next.evidence).toContain(`=== PROJECT ${ops.channel} ===`);
    expect(next.evidence).not.toContain(`=== PROJECT ${web.channel} ===`);
  });

  test("a join code split past recognition costs only that project its report: nothing is posted, the other is delivered", async () => {
    const { t, web, ops, prepared, at } = await two();
    const split = `wk1${"Z".repeat(20)} ${"Z".repeat(40)}`;
    const out = prepared.finish?.({ text: `${block(web.channel, `**Fine.** code ${split} here and more text to be long enough.`)}\n${block(ops.channel, BODY)}`, ok: true }, at);
    expect(out).toEqual({ text: "Reported 1 of 2 changed projects; 1 had no usable report and is tried again next hour.", ok: true });
    expect(reportPosts(t, web.channel)).toEqual([]);
    expect(reportPosts(t, ops.channel)).toHaveLength(1);
  });

  test("a reply with no usable report at all is a failed run and posts nothing", async () => {
    const { t, web, ops, prepared, at } = await two();
    const out = prepared.finish?.({ text: `${block("p-deadbeef", BODY)}\n${block(web.channel, "ok")}\nI could not.`, ok: true }, at);
    expect(out).toMatchObject({ ok: false });
    expect(out?.text).toBe("Reported 0 of 2 changed projects; 2 had no usable report and are tried again next hour.");
    expect(reportPosts(t, web.channel)).toEqual([]);
    expect(reportPosts(t, ops.channel)).toEqual([]);
    expect(readReportTimes(t.core).size).toBe(0);
  });

  test("a project switched off while the turn ran gets no report", async () => {
    const { t, web, prepared, at } = await ready();
    await updateProject(t.w, web.channel, { status_report: "off" });
    const out = prepared.finish?.({ text: block(web.channel, BODY), ok: true }, at);
    expect(out).toEqual({ text: "Reported 0 of 1 changed project.", ok: true });
    expect(reportPosts(t, web.channel)).toEqual([]);
    expect(readReportTimes(t.core).has(web.channel)).toBe(false);
  });

  test("a project archived while the turn ran gets no report either", async () => {
    const { t, web, prepared, at } = await ready();
    await updateProject(t.w, web.channel, { state: "archived" });
    const out = prepared.finish?.({ text: block(web.channel, BODY), ok: true }, at);
    expect(out).toEqual({ text: "Reported 0 of 1 changed project.", ok: true });
    expect(reportPosts(t, web.channel)).toEqual([]);
    expect(readReportTimes(t.core).has(web.channel)).toBe(false);
  });

  test("anything that goes wrong inside one project's delivery is that project's failure: the others are delivered and the team's marker is written", async () => {
    const { t, web, ops, prepared, at } = await two();
    const project = t.idx.project.bind(t.idx);
    t.idx.project = ((channel: string) => {
      if (channel === ops.channel) throw new Error("sqlite: disk I/O error");
      return project(channel);
    }) as typeof project;
    const out = prepared.finish?.({ text: `${block(web.channel, BODY)}\n${block(ops.channel, BODY)}`, ok: true }, at);
    expect(out).toEqual({ text: "Reported 1 of 2 changed projects; 1 could not be posted and is tried again next hour.", ok: true });
    expect(reportPosts(t, web.channel)).toHaveLength(1);
    // The team's marker, not only this daemon's cache, carries the delivered project's time.
    t.core.store.deleteMeta(REPORT_TIMES_META);
    expect(readReportTimes(t.core).get(web.channel)).toBe(at);
    expect(readReportTimes(t.core).has(ops.channel)).toBe(false);
  });

  test("a post that fails is not recorded and does not stop the others", async () => {
    const { t, web, ops, prepared, at } = await two();
    const emit = t.core.emit.bind(t.core);
    t.core.emit = ((kind: Parameters<typeof emit>[0], body: Parameters<typeof emit>[1], opts: Parameters<typeof emit>[2]) => {
      if (opts?.channel === web.channel && (body as { status_report?: unknown }).status_report) throw new Error("channel unavailable");
      return emit(kind, body, opts);
    }) as typeof emit;
    const out = prepared.finish?.({ text: `${block(web.channel, BODY)}\n${block(ops.channel, BODY)}`, ok: true }, at);
    expect(out).toEqual({ text: "Reported 1 of 2 changed projects; 1 could not be posted and is tried again next hour.", ok: true });
    expect(reportPosts(t, ops.channel)).toHaveLength(1);
    expect(readReportTimes(t.core).has(web.channel)).toBe(false);
    expect(t.idx.room(web.channel)).toEqual([]);
  });
});

describe("the Data Room document", () => {
  test("a document a person pinned cannot take agent versions: the report goes to the next file and the channel is unaffected", async () => {
    const { t, web, prepared, at } = await ready();
    addFile(t.w, web.channel, new TextEncoder().encode("# Pinned by hand\n"), { name: "Status report", mime: "text/markdown", pin: true });
    prepared.finish?.({ text: block(web.channel, BODY), ok: true }, at);
    expect(t.idx.room(web.channel).filter((f) => f.state === "active").map((f) => [f.name, f.pinned, f.versions.length])).toEqual([["Status report", true, 1], ["Status report (2)", false, 1]]);
    expect(reportPosts(t, web.channel)).toHaveLength(1);
  });

  test("a file that holds 90 of WalkieTalkie's versions is full: the report starts the next one, and later ones follow it", async () => {
    const { t, web, prepared, at } = await ready();
    const agent: WriteCtx = { ...t.w, agent: "orchestrator", underAgent: true };
    for (let i = 0; i < 90; i++) addFile(agent, web.channel, new TextEncoder().encode(`version ${i}\n`), { name: "Status report", mime: "text/markdown" });
    expect(versionCount(t.idx.room(web.channel)[0]!.versions).agent).toBe(90);
    prepared.finish?.({ text: block(web.channel, BODY), ok: true }, at);
    expect(t.idx.room(web.channel).filter((f) => f.state === "active").map((f) => [f.name, f.versions.length])).toEqual([["Status report", 90], ["Status report (2)", 1]]);
    t.tick();
    updateCard(t.w, t.idx.db.cards(web.channel, { states: ["open"], limit: 1 })[0]!.id, { column: "doing" });
    turn(await prepareProjectReports(t.deps, () => true)).finish?.({ text: block(web.channel, "**Slipping:** late.\n\n## Next\n- Checkout."), ok: true }, t.core.clock());
    expect(t.idx.room(web.channel).filter((f) => f.state === "active").map((f) => [f.name, f.versions.length])).toEqual([["Status report", 90], ["Status report (2)", 2]]);
  });
});

describe("a Data Room that cannot take the report", () => {
  test("leaves the channel post, is still recorded, and the run says what happened", async () => {
    const { t, web, prepared, at } = await ready();
    const room = ROOM_LIMITS.files;
    ROOM_LIMITS.files = 0; // the Data Room is "full"
    try {
      const out = prepared.finish?.({ text: block(web.channel, BODY), ok: true }, at);
      expect(out).toEqual({ text: "Reported 1 of 1 changed project. Website: the report is in the channel, not the Data Room (a Data Room holds at most 0 files; remove some first).", ok: true });
    } finally { ROOM_LIMITS.files = room; }
    expect(reportPosts(t, web.channel)).toHaveLength(1);
    expect(readReportTimes(t.core).get(web.channel)).toBe(at);
    expect(t.idx.room(web.channel)).toEqual([]);
  });
});

describe("the latest report, as the dashboard reads it", () => {
  test("is the newest post WalkieTalkie wrote with the marker, from an owner", async () => {
    const { t, web, prepared, at } = await ready();
    expect(latestStatusReport(t.core, t.idx, web.channel)).toBeNull();
    prepared.finish?.({ text: block(web.channel, BODY), ok: true }, at);
    const got = latestStatusReport(t.core, t.idx, web.channel);
    expect(got).toMatchObject({ as_of: at, by: { handle: "alex", agent: "orchestrator" } });
    expect(got?.text).toContain("**On track:** the pricing page shipped.");
  });

  test("ignores a post that only looks like one: a person's, another agent's, and a member's WalkieTalkie", async () => {
    const { t, web } = await ready();
    const marker = { v: 1, as_of: 123 };
    t.core.emit("msg.post", { text: "**Status report · Website · as of x**\n\nfake by a person", status_report: marker } as never, { channel: web.channel });
    t.core.emit("msg.post", { text: "**Status report · Website · as of x**\n\nfake by another agent", status_report: marker } as never, { channel: web.channel, agent: "cc-1" });
    expect(latestStatusReport(t.core, t.idx, web.channel)).toBeNull();
    // A member (not an owner) running a WalkieTalkie of their own: not a report the team's owners wrote.
    const dave = tnode("dave");
    t.core.emit("team.member", { login: dave.login, handle: dave.handle, role: "member" });
    t.core.emit("team.node", { node_id: dave.keys.nodeId, login: dave.login, hostname: dave.hostname, pubkey: dave.keys.pubkey, ip: "127.0.0.1" });
    feed(t.core, [ev(t.team, dave, "msg.post", { text: "**Status report · Website · as of x**\n\nfake by a member", status_report: marker } as never, { channel: web.channel, agent: "orchestrator" })]);
    expect(latestStatusReport(t.core, t.idx, web.channel)).toBeNull();
  });
});

describe("the latest report, whatever the clocks say", () => {
  test("a post whose marker is not a usable time is not a report", async () => {
    const { t, web } = await ready();
    for (const as_of of ["yesterday", -5, 1.5, 1e20, null]) {
      t.core.emit("msg.post", { text: "**Status report · Website · as of x**\n\nodd", status_report: { v: 1, as_of } } as never, { channel: web.channel, agent: "orchestrator" });
    }
    expect(latestStatusReport(t.core, t.idx, web.channel)).toBeNull();
  });

  test("a report stamped by an owner's clock that ran ahead does not stay on top of a later one", async () => {
    const { t, web, prepared, at } = await ready();
    const bob = t.teammate("bob", "owner");
    t.tick(H);
    bob.post(web.channel, { text: "**Status report · Website · as of x**\n\nfrom a fast clock", status_report: { v: 1, as_of: at } }, t.wall() + 3 * H, "orchestrator");
    t.tick();
    prepared.finish?.({ text: block(web.channel, BODY), ok: true }, at);
    expect(latestStatusReport(t.core, t.idx, web.channel)?.by.handle).toBe("alex");
  });
});

describe("an owner's older report that reaches this daemon later", () => {
  test("does not displace a newer one (a machine syncing history out of order)", async () => {
    const { t, web, prepared, at } = await ready();
    prepared.finish?.({ text: block(web.channel, BODY), ok: true }, at);
    const bob = t.teammate("bob", "owner");
    t.tick(H);
    bob.post(web.channel, { text: "**Status report · Website · as of x**\n\nolder report from bob", status_report: { v: 1, as_of: at - 5 * H } }, t.wall() - 6 * H, "orchestrator");
    expect(latestStatusReport(t.core, t.idx, web.channel)?.by.handle).toBe("alex");
  });
});

describe("the latest report among forged ones", () => {
  test("a member's WalkieTalkie posting report-shaped messages by the dozen does not push the owner's report out", async () => {
    const { t, web, prepared, at } = await ready();
    prepared.finish?.({ text: block(web.channel, BODY), ok: true }, at);
    const dave = t.teammate("dave");
    t.tick();
    for (let i = 0; i < 12; i++) dave.post(web.channel, { text: `**Status report · Website · as of x**\n\nforged ${i}`, status_report: { v: 1, as_of: at + 1_000 + i } }, t.wall() + i, "orchestrator");
    const got = latestStatusReport(t.core, t.idx, web.channel);
    expect(got?.as_of).toBe(at);
    expect(got?.by).toMatchObject({ handle: "alex", agent: "orchestrator" });
    expect(got?.text).not.toContain("forged");
  });
});

describe("GET /v1/projects/:channel/status-report", () => {
  const get = (t: ReturnType<typeof reportsWorld>, channel: string) => {
    const req = new Request(`http://localhost/v1/projects/${channel}/status-report`);
    return dispatch({ core: t.core, sync: { requestCatchUp: async () => {} }, client: {}, req, url: new URL(req.url), via: "cli", listener: "unix",
      projects: t.idx, noTimeout: () => {} } as unknown as RouteCtx);
  };

  test("says the setting and no report yet; after a delivery, the report under its own heading with the time its facts are as of", async () => {
    const { t, web, prepared, at } = await ready();
    const before = await (await get(t, web.channel)).json() as StatusReportPayload;
    expect(before).toEqual({ mode: "hourly", report: null });
    prepared.finish?.({ text: block(web.channel, BODY), ok: true }, at);
    const after = await (await get(t, web.channel)).json() as StatusReportPayload;
    expect(after.mode).toBe("hourly");
    expect(after.report).toMatchObject({ markdown: BODY, as_of: at, by: { handle: "alex", agent: "orchestrator" } });
    expect(after.report?.header).toMatch(/^\*\*Status report · Website · as of \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\*\*$/);
  });

  test("an unknown project is not found, and a project with reports off says so", async () => {
    const t = reportsWorld(cleanups);
    const quiet = await t.project("Quiet", "QUI", { off: true });
    expect(await (await get(t, quiet.channel)).json()).toEqual({ mode: "off", report: null });
    await expect(get(t, "p-ffffffff")).rejects.toMatchObject({ status: 404 });
  });
});
