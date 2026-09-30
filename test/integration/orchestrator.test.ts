// Orchestrator end to end (PROTOCOL §8, ORCH-FIX-11/12) with a FAKE claude on PATH (test/fixtures/fake-claude/claude):
// the person talks to their machine's own orchestrator LOCALLY (the CLI over the unix socket, the dashboard with a
// session); the conversation lives in that machine's store only. Nothing of it reaches a teammate, a same-login
// machine, the event log or a paired phone; agents can't read or drive it; a queued message whose session ended first
// never runs; a 1.5 MB reply is capped and the phone's stream survives it; channels named orch-… are ordinary; a crash
// restarts Claude and resumes the session; the stop button interrupts; history survives a daemon restart.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WalkieClient } from "../../src/client/index.ts";
import { hkdfKey, pairingKeys, unb64u } from "../../src/mobile/crypto.ts";
import { MobileLink, type Registered } from "../../src/mobile/client.ts";
import { MAX_REPLY_BYTES, ORCHESTRATOR_AGENT, ORCHESTRATOR_TOKEN_HEADER, REPLY_TRUNCATED_MARKER, type OrchMessage } from "../../src/protocol/orchestrator.ts";
import { startRelay, type RelayHandle } from "../../src/relay/server.ts";
import { hostFor } from "../../src/daemon/orchestrator/host.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";
import { signedPeerFetch } from "../helpers/signed-peer-fetch.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

const FAKE_DIR = join(import.meta.dir, "..", "fixtures", "fake-claude");
const MARK = `LOCAL-ONLY-${crypto.randomUUID()}`;

let c: Cluster;
let alex: TestNode;
let kira: TestNode;
let kira2: TestNode;
let state: string;
let launches: string;
let path: string;
let relay: RelayHandle;
let relayUrl: string;

function person(n: TestNode): WalkieClient { return n.client(""); }

async function messages(n: TestNode, thread?: string): Promise<OrchMessage[]> {
  return (await person(n).orchestratorMessages({ ...(thread ? { thread } : {}), limit: 2_000 })).messages;
}

/** The orchestrator's replies in `thread` after message `after`, once there are `count`. */
async function replies(n: TestNode, thread: string, after: string, count = 1, timeoutMs = 15_000): Promise<OrchMessage[]> {
  return waitFor(async () => {
    const all = await messages(n, thread);
    const i = all.findIndex((m) => m.id === after);
    const r = all.slice(i + 1).filter((m) => m.role === "orchestrator");
    return i >= 0 && r.length >= count ? r : null;
  }, { timeoutMs, what: `orchestrator reply in ${thread}` });
}

function turns(): string[] {
  if (!existsSync(launches)) return [];
  return readFileSync(launches, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { turn?: string }).filter((l) => l.turn).map((l) => l.turn as string);
}

function launchArgs(): string[][] {
  if (!existsSync(launches)) return [];
  return readFileSync(launches, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv?: string[] }).filter((l) => l.argv).map((l) => l.argv as string[]);
}

/** Every file of a node's home (database, WAL, logs) searched for `needle`. */
function holds(n: TestNode, needle: string): boolean {
  const walk = (dir: string): boolean => readdirSync(dir).some((f) => {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) return walk(p);
    return st.isFile() && readFileSync(p).includes(Buffer.from(needle));
  });
  return walk(n.home);
}

// ---- the dashboard (a session over the loopback port) ----
const url = (n: TestNode, p: string) => `http://127.0.0.1:${n.d.localPort as number}${p}`;
async function session(n: TestNode): Promise<Record<string, string>> {
  const { nonce } = await n.client().authNonce();
  const res = await fetch(url(n, `/auth?nonce=${nonce}`), { redirect: "manual" });
  const value = /#s=([0-9a-f]{64})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
  if (!value) throw new Error("no dashboard session");
  return { "X-Walkie-Session": value, Origin: `http://127.0.0.1:${n.d.localPort as number}` };
}
async function dashSay(n: TestNode, h: Record<string, string>, text: string, thread?: string): Promise<Response> {
  return fetch(url(n, "/v1/orchestrator/say"), {
    method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ text, ...(thread ? { thread } : {}) }),
  });
}

beforeAll(async () => {
  relay = startRelay({ port: 0, hostname: "127.0.0.1", connectRate: { capacity: 1_000, perSecond: 1_000 }, perIpConnections: 1_000 });
  relayUrl = `ws://127.0.0.1:${relay.port}`;
  c = new Cluster();
  state = join(c.root, "fake-state");
  mkdirSync(state, { recursive: true });
  launches = join(c.root, "fake-launches.jsonl");
  path = `${FAKE_DIR}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  const orchestrator = {
    autoCheckMs: 500, restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 50,
    env: { ...process.env, PATH: "/usr/bin:/bin", FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: launches },
  };
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp", orchestrator });
  kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mbp", orchestrator, mobile: { relayUrl, appUrl: "http://127.0.0.1:1/m" } });
  kira2 = await c.add({ name: "kira2", login: "kira@example.com", hostname: "kiras-studio", orchestrator });
  await alex.client().init("acme", "alex");
  await alex.client().invite("kira@example.com", "kira", "member");
  expect((await kira.client().join(alex.peerAddr)).admitted).toBe(true);
  expect(await kira2.client().join(kira.peerAddr)).toMatchObject({ admitted: false, reason: "pending_approval" });
  await alex.client().request("POST", "/v1/team/admit", { node_id: kira2.d.nodeId, approve: true });
  expect((await kira2.client().join(kira.peerAddr)).admitted).toBe(true);
  await alex.client().post({ channel: "general", text: "hello team" });
}, 60_000);

afterAll(async () => { await c.close(); relay.stop(); });

/** A dashboard session's stream on `n`: every SSE frame it gets, parsed, with its arrival time. */
async function dashStream(n: TestNode): Promise<{ frames: { type: string; data: Record<string, unknown>; at: number }[]; stop: () => Promise<void> }> {
  const h = await session(n);
  const ac = new AbortController();
  const res = await fetch(url(n, "/v1/stream"), { headers: h, signal: ac.signal });
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const frames: { type: string; data: Record<string, unknown>; at: number }[] = [];
  let buf = "";
  const pumping = (async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) return;
      buf += new TextDecoder().decode(r.value);
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const type = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (type && data) frames.push({ type, data: JSON.parse(data) as Record<string, unknown>, at: Date.now() });
      }
    }
  })().catch(() => undefined);
  return { frames, stop: async () => { ac.abort(); await pumping; } };
}

/** A phone paired with `n` (the same code the phone app runs, src/mobile/client.ts), linked through the local relay. */
async function phone(n: TestNode): Promise<MobileLink> {
  const p = await n.client().mobilePair();
  const code = /#pair=([A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22})/.exec(p.url)?.[1];
  if (!code) throw new Error("no pairing code");
  const k = await pairingKeys(code);
  const pairing = await MobileLink.open({ relay: relayUrl, room: k.room, kid: "pair", psk: k.psk });
  const reg: Registered = await pairing.register("Kira's phone");
  pairing.close();
  return MobileLink.open({ relay: relayUrl, room: reg.room, kid: `d:${reg.device.id}`, psk: await hkdfKey(unb64u(reg.key)) });
}

describe("the local orchestrator (ORCH-FIX-11)", () => {
  let first = "";

  test("start on kiras-mbp creates no channel; a team channel named orch-… is an ordinary channel (ORCH-FIX-12)", async () => {
    const v = await person(kira).orchestratorStart({ cwd: c.root, path });
    expect(v.local.running).toBe(true);
    await waitFor(async () => (await kira.client().orchestrator()).local.state === "idle", { what: "idle" });
    const before = (await alex.client().team()).channels.map((x) => x.name);
    expect(before.some((n) => n.startsWith("orch-"))).toBe(false);
    // #orch-infra, #orch-kira: ordinary channels, created, listed, written and read by people and agents alike
    for (const name of ["orch-infra", "orch-kira"]) {
      await alex.client().channel({ name });
      await waitFor(() => kira2.d.core.roster.channels.has(name), { what: `${name} on kira2` });
      await kira.client().post({ channel: name, text: `infra note in ${name}` });
      const { event } = await kira2.client("cc-ops123").post({ channel: name, text: `agent note in ${name}` });
      await waitFor(async () => (await alex.client().events({ channel: name, limit: 10 })).events.some((e) => e.id === event.id), { what: `${name} synced` });
      for (const n of [alex, kira, kira2]) expect((await n.client().team()).channels.some((x) => x.name === name)).toBe(true);
    }
    expect(await messages(kira)).toEqual([]); // nothing of it is the orchestrator's
  }, 30_000);

  test("the CLI (unix socket) says; the host's Claude answers into kiras-mbp's store", async () => {
    const t0 = Date.now();
    const { message } = await person(kira).orchestratorSay(`hello orchestrator ${MARK}`);
    first = message.thread;
    expect(message).toMatchObject({ role: "person", via: "cli", thread: message.id });
    await waitFor(() => turns().some((t) => t.includes(MARK)), { what: "turn at claude" });
    expect(Date.now() - t0).toBeLessThan(3_000);
    const [reply] = await replies(kira, first, message.id);
    expect(reply?.text).toBe(`pong: hello orchestrator ${MARK}`);
    expect((await messages(kira, first)).find((m) => m.id === message.id)?.state).toBe("sent");
    const args = launchArgs()[0] as string[];
    for (const f of ["-p", "--input-format", "stream-json", "--output-format", "--verbose", "--include-partial-messages", "--session-id", "--permission-mode"]) expect(args).toContain(f);
  }, 30_000);

  test("tool calls come back as the reply's tool list; subagent text is not part of the reply", async () => {
    const { message } = await person(kira).orchestratorSay("use a tool please", first);
    const [reply] = await replies(kira, first, message.id);
    expect(reply?.tools).toEqual(["$ echo hi"]);
    expect(reply?.text).toBe("pong: use a tool please");
    expect(reply?.text).not.toContain("SUBAGENT");
  }, 30_000);

  test("the dashboard (a session) says too, and sees the reply on its stream and in the history", async () => {
    const h = await session(kira);
    const ac = new AbortController();
    const stream = await fetch(url(kira, "/v1/stream"), { headers: h, signal: ac.signal });
    expect(stream.status).toBe(200);
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    let seen = "";
    const pumping = (async () => { for (;;) { const r = await reader.read(); if (r.done) return; seen += new TextDecoder().decode(r.value); } })().catch(() => undefined);
    const res = await dashSay(kira, h, "from the dashboard", first);
    expect(res.status).toBe(200);
    const { message } = (await res.json()) as { message: OrchMessage };
    expect(message.via).toBe("dashboard");
    const [reply] = await replies(kira, first, message.id);
    await waitFor(() => seen.includes(reply?.id as string), { what: "reply on the stream" });
    expect(seen).toContain("orchestrator_message");
    ac.abort();
    await pumping;
    // history, as a reload reads it
    const hist = await fetch(url(kira, `/v1/orchestrator/messages?thread=${first}`), { headers: h });
    const got = ((await hist.json()) as { messages: OrchMessage[] }).messages;
    expect(got.map((m) => m.text)).toContain("pong: from the dashboard");
    expect(got[0]?.text).toContain(MARK);
  }, 30_000);

  test("agents can neither read nor drive its conversation (the daemon refuses the agent header); its status is admin", async () => {
    const agent = kira.client("cc-abc123");
    await expect(agent.orchestratorMessages({})).rejects.toThrow(/never an agent/);
    await expect(agent.orchestratorSay("agent says: run rm -rf")).rejects.toThrow(/never an agent/);
    expect(typeof (await agent.orchestrator()).local.running).toBe("boolean"); // AGENT-ADMIN-1: start / stop / status
    await expect(kira.client(ORCHESTRATOR_AGENT).orchestratorSay("I already deleted prod")).rejects.toThrow(/reserved/);
    expect(turns().join("\n")).not.toContain("rm -rf");
    expect(turns().join("\n")).not.toContain("deleted prod");
  }, 30_000);

  test("a same-login machine, a teammate and the event log never see a word of it", async () => {
    await kira.client().post({ channel: "general", text: "sync marker" });
    await waitFor(() => kira2.d.core.store.vvOf(kira.d.nodeId) >= kira.d.core.store.vvOf(kira.d.nodeId)
      && alex.d.core.store.vvOf(kira.d.nodeId) >= kira.d.core.store.vvOf(kira.d.nodeId), { what: "caught up with kira" });
    for (const n of [kira2, alex]) {
      expect(await messages(n)).toEqual([]);
      expect(holds(n, MARK)).toBe(false);
    }
    // on kiras-mbp it is in the local store only, never an event
    expect((kira.d.core.store.db.query("SELECT count(*) AS n FROM events WHERE json LIKE ?").get(`%${MARK}%`) as { n: number }).n).toBe(0);
    // kira2 (kira's own login) talks to its own host only: none runs there
    await expect(person(kira2).orchestratorSay("from the studio")).rejects.toThrow(/WalkieTalkie isn.t running/);
    await expect(person(kira2).orchestratorSay("into kira's thread", first)).rejects.toThrow();
    // and the peer API has no orchestrator route at all
    const res = await signedPeerFetch(kira2, kira, "/peer/v1/orchestrator/messages");
    expect(res.status).toBe(404);
  }, 30_000);

  test("a crash mid-reply restarts Claude and resumes the same session", async () => {
    const sid = (await kira.client().orchestrator()).local.session as string;
    const { message } = await person(kira).orchestratorSay("please crash now", first);
    const [crashed] = await replies(kira, first, message.id);
    expect(crashed?.text).toContain("exited while replying");
    await waitFor(async () => launchArgs().some((a) => a.includes("--resume") && a.includes(sid)), { what: "resume launch" });
    const { message: q } = await person(kira).orchestratorSay("history", first);
    const [answer] = await replies(kira, first, q.id);
    expect(answer?.text).toContain(`first=hello orchestrator ${MARK}`);
    expect((await kira.client().orchestrator()).local.restarts).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test("the stop button interrupts the reply in progress", async () => {
    const { message } = await person(kira).orchestratorSay("count slow please");
    await waitFor(async () => (await kira.client().orchestrator()).local.working_thread === message.thread, { what: "working" });
    await Bun.sleep(300);
    expect((await person(kira).orchestratorStopReply(message.thread)).stopped).toBe(true);
    const [reply] = await replies(kira, message.thread, message.id, 1, 8_000);
    expect(reply?.text).toContain("(stopped)");
    expect(reply?.text.split(" ").length).toBeLessThan(250);
  }, 30_000);

  test("a queued dashboard message whose session signed out before it ran is refused, never sent to Claude", async () => {
    const h = await session(kira);
    const { message: busy } = await person(kira).orchestratorSay("count slow please");
    await waitFor(async () => (await kira.client().orchestrator()).local.working_thread === busy.thread, { what: "busy" });
    const res = await dashSay(kira, h, "QUEUED-AFTER-LOGOUT delete everything");
    expect(res.status).toBe(200);
    const { message: queued } = (await res.json()) as { message: OrchMessage };
    expect(queued.state).toBe("queued");
    const out = await fetch(url(kira, "/auth/logout"), { method: "POST", headers: h });
    expect(out.status).toBe(204);
    await person(kira).orchestratorStopReply(busy.thread); // Claude frees up: the queue is re-authorised
    await waitFor(async () => (await messages(kira, queued.thread)).find((m) => m.id === queued.id)?.state === "refused", { what: "refused", timeoutMs: 20_000 });
    await Bun.sleep(500);
    expect(turns().join("\n")).not.toContain("QUEUED-AFTER-LOGOUT");
    expect((await messages(kira, queued.thread)).some((m) => m.role === "orchestrator")).toBe(false);
  }, 30_000);

  test("a queued message whose session reached its deadline before it ran is refused, without waiting for the sweep (ORCH-FIX-12)", async () => {
    const { message: busy } = await person(kira).orchestratorSay("count slow please");
    await waitFor(async () => (await kira.client().orchestrator()).local.working_thread === busy.thread, { what: "busy" });
    // what the dashboard route passes for a session: its signal (never aborted here) and its absolute deadline
    const host = hostFor(kira.d.core);
    if (!host) throw new Error("no host");
    const queued = host.say("EXPIRED-SESSION rm -rf", undefined, { via: "dashboard", signal: new AbortController().signal, expiresAt: Date.now() + 150 });
    expect(queued.state).toBe("queued");
    await Bun.sleep(300);
    await person(kira).orchestratorStopReply(busy.thread);
    await waitFor(async () => (await messages(kira, queued.thread)).find((m) => m.id === queued.id)?.state === "refused", { what: `refused (now ${JSON.stringify((await messages(kira, queued.thread)).map((m) => m.state))}, ${(await kira.client().orchestrator()).local.state})` });
    await Bun.sleep(300);
    expect(turns().join("\n")).not.toContain("EXPIRED-SESSION");
  }, 30_000);

  test("a message dropped by the stop button stays dropped in the history (Codex r12 LOW 4)", async () => {
    const { message: busy } = await person(kira).orchestratorSay("count slow please");
    await waitFor(async () => (await kira.client().orchestrator()).local.working_thread === busy.thread, { what: "busy" });
    const { message: queued } = await person(kira).orchestratorSay("DROPPED-BY-STOP", busy.thread);
    await person(kira).orchestratorStopReply(busy.thread);
    await waitFor(async () => (await messages(kira, busy.thread)).find((m) => m.id === queued.id)?.state === "dropped", { what: "dropped" });
    expect(turns().join("\n")).not.toContain("DROPPED-BY-STOP");
  }, 30_000);

  test("a new conversation gets a new Claude session", async () => {
    const { message } = await person(kira).orchestratorSay("history");
    const [reply] = await replies(kira, message.thread, message.id);
    expect(reply?.text).toContain("turns=1 first=history");
  }, 30_000);

  test("a 1.5 MB reply is capped at 256 KiB; the dashboard gets it; the phone's stream never carries it and survives", async () => {
    const link = await phone(kira);
    try {
      // the phone reaches no orchestrator route
      for (const [m, p, body] of [["GET", "/v1/orchestrator"], ["GET", "/v1/orchestrator/messages"], ["POST", "/v1/orchestrator/say", { text: "from the phone" }]] as const) {
        const r = await link.request(m, p, body);
        expect({ p, status: r.status }).toEqual({ p, status: 403 });
      }
      const onPhone: { type: string; data: unknown }[] = [];
      let ended = false;
      const cancel = link.stream("/v1/stream", (type, data) => onPhone.push({ type, data }), () => { ended = true; });
      await waitFor(() => onPhone.some((m) => m.type === "hello"), { what: "phone stream hello" });
      const h = await session(kira);
      const ac = new AbortController();
      const stream = await fetch(url(kira, "/v1/stream"), { headers: h, signal: ac.signal });
      const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
      let seen = 0;
      let dashText = "";
      const pumping = (async () => { for (;;) { const r = await reader.read(); if (r.done) return; seen += r.value.byteLength; dashText = (dashText + new TextDecoder().decode(r.value)).slice(-400); } })().catch(() => undefined);
      // a CLI stream over the unix socket (`walkie subscribe`): not a dashboard, so none of it either
      const cliAc = new AbortController();
      const cliStream = await fetch("http://walkie/v1/stream", { unix: kira.socket, signal: cliAc.signal } as RequestInit);
      const cliReader = (cliStream.body as ReadableStream<Uint8Array>).getReader();
      let cliText = "";
      const cliPumping = (async () => { for (;;) { const r = await cliReader.read(); if (r.done) return; cliText += new TextDecoder().decode(r.value); } })().catch(() => undefined);
      const { message } = await person(kira).orchestratorSay("HUGE please");
      const [reply] = await replies(kira, message.thread, message.id, 1, 30_000);
      expect(new TextEncoder().encode(reply?.text ?? "").length).toBeLessThanOrEqual(MAX_REPLY_BYTES);
      expect(reply?.text.endsWith(REPLY_TRUNCATED_MARKER)).toBe(true);
      await waitFor(() => dashText.includes(reply?.id as string) || seen > MAX_REPLY_BYTES, { what: "reply on the dashboard stream" });
      // the phone: still streaming, no orchestrator message ever
      await kira.client().post({ channel: "general", text: "after the huge reply" });
      await waitFor(() => onPhone.some((m) => m.type === "event" && JSON.stringify(m.data).includes("after the huge reply")), { what: "phone stream alive" });
      expect(ended).toBe(false);
      expect(onPhone.some((m) => m.type.startsWith("orchestrator"))).toBe(false);
      expect(cliText).toContain("after the huge reply");
      expect(cliText.includes("event: orchestrator")).toBe(false);
      cliAc.abort();
      await cliPumping;
      cancel();
      ac.abort();
      await pumping;
    } finally { link.close(); }
  }, 60_000);

  test("live progress is bounded (ORCH-FIX-13): ≤ 12 tool frames, ~10 text frames a second, redacted, whole lines only", async () => {
    const dash = await dashStream(kira);
    await waitFor(() => dash.frames.some((f) => f.type === "hello"), { what: "hello" });
    const live = (turn: string, phase: string) => dash.frames.filter((f) => f.type === "orchestrator" && (f.data.live as { turn: string; phase: string }).turn === turn && (f.data.live as { phase: string }).phase === phase);
    // 1 000 tools: stored as 12 + "+988 more", 12 live frames
    const { message: many } = await person(kira).orchestratorSay("MANYTOOLS please");
    const [r1] = await replies(kira, many.thread, many.id, 1, 20_000);
    expect(r1?.tools?.length).toBe(13);
    expect(r1?.tools?.at(-1)).toBe("+988 more");
    expect(r1?.reply_to).toBe(many.id);
    await waitFor(() => live(many.id, "end").length > 0, { what: "end frame" });
    expect(live(many.id, "tool").length).toBe(12);
    // a credential written across deltas never goes out live, and only whole lines do
    const { message: sec } = await person(kira).orchestratorSay("SECRETLINES please");
    const [r2] = await replies(kira, sec.thread, sec.id);
    await waitFor(() => live(sec.id, "end").length > 0, { what: "end frame" });
    const sent = live(sec.id, "delta").map((f) => (f.data.live as { text: string }).text);
    expect(sent.join("")).not.toContain("A1b2C3d4");
    for (const t of sent) expect(t.endsWith("\n")).toBe(true);
    expect(r2?.text).not.toContain("A1b2C3d4");
    // 3 000 deltas as fast as they come: a handful of frames, never more than ~10 in any second
    const { message: flood } = await person(kira).orchestratorSay("FLOOD please");
    await replies(kira, flood.thread, flood.id, 1, 20_000);
    await waitFor(() => live(flood.id, "end").length > 0, { what: "end frame" });
    const at = live(flood.id, "delta").map((f) => f.at);
    expect(at.length).toBeLessThan(100);
    for (let i = 0; i + 11 < at.length; i++) expect((at[i + 11] as number) - (at[i] as number)).toBeGreaterThanOrEqual(1_000);
    await dash.stop();
  }, 60_000);

  test("the CLI's say waits for the reply to ITS message, not an earlier one stored after it (Codex r13 MEDIUM 4)", async () => {
    const { message: a } = await person(kira).orchestratorSay("count slow please");
    await waitFor(async () => (await kira.client().orchestrator()).local.working_thread === a.thread, { what: "busy" });
    // as a person's terminal runs it (no agent runtime among its ancestors: test/helpers/person-cli.ts)
    const { out, code } = await runAsPerson([process.execPath, join(import.meta.dir, "../../src/cli/main.ts"), "orchestrator", "say", "SECOND-IN-THREAD", "--thread", a.thread, "--timeout", "40"],
      { PATH: process.env.PATH ?? "", NO_COLOR: "1", HOME: process.env.HOME ?? "/tmp", WALKIE_HOME: kira.home, WALKIE_SOCKET: kira.socket }, { tty: true });
    expect(code).toBe(0);
    expect(out).toContain("pong: SECOND-IN-THREAD");
    expect(out).not.toMatch(/^1 2 3/m); // not the slow count that answered the first message
    const all = await messages(kira, a.thread);
    const second = all.find((m) => m.text === "SECOND-IN-THREAD");
    expect(all.find((m) => m.role === "orchestrator" && m.reply_to === second?.id)?.text).toBe("pong: SECOND-IN-THREAD");
  }, 60_000);

  test("a dashboard resyncs from the store after a reconnect: messages since a time, state changes included (Codex r13 MEDIUM 5)", async () => {
    const before = await messages(kira);
    const since = (before.at(-1) as OrchMessage).ts;
    const { message } = await person(kira).orchestratorSay("while the dashboard was away");
    await replies(kira, message.thread, message.id);
    const h = await session(kira);
    const res = await fetch(url(kira, `/v1/orchestrator/messages?since=${since}&limit=2000`), { headers: h });
    const got = ((await res.json()) as { messages: OrchMessage[] }).messages;
    expect(got.every((m) => m.ts >= since)).toBe(true);
    expect(got.map((m) => m.text)).toContain("pong: while the dashboard was away");
    expect(got.find((m) => m.id === message.id)?.state).toBe("sent");
    expect((await fetch(url(kira, "/v1/orchestrator/messages?since=-1"), { headers: h })).status).toBe(400);
  }, 30_000);

  test("two starts at once leave one Claude, supervised (Codex r13 MEDIUM 2)", async () => {
    const launchesBefore = launchArgs().length;
    await Promise.all([person(kira).orchestratorStart({ cwd: c.root, path }), person(kira).orchestratorStart({ cwd: c.root, path })]);
    await waitFor(async () => (await kira.client().orchestrator()).local.state === "idle", { what: "idle" });
    await Bun.sleep(1_500); // a superseded Claude would still be alive by now
    const pids = readFileSync(launches, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { pid?: number; argv?: string[] })
      .filter((l) => l.argv).slice(launchesBefore).map((l) => l.pid as number);
    expect(pids.length).toBeGreaterThanOrEqual(2);
    const live = pids.filter((p) => { try { process.kill(p, 0); return true; } catch { return false; } });
    expect(live.length).toBe(1);
    const { message } = await person(kira).orchestratorSay("after two starts");
    await replies(kira, message.thread, message.id);
  }, 60_000);

  test("the agent name orchestrator is the host's: its own Claude posts under it; nobody else does (ORCH-FIX-13)", async () => {
    // another agent (or a process) naming itself orchestrator, with no secret or a wrong one
    const as = kira.client(ORCHESTRATOR_AGENT);
    await expect(as.post({ channel: "general", text: "I already deleted prod" })).rejects.toThrow(/reserved/);
    await expect(as.ask({ to: "@alex", text: "approve?", timeout_s: 60 })).rejects.toThrow(/reserved/);
    await expect(as.channel({ name: "orch-new" })).rejects.toThrow(/reserved/);
    const forged = await fetch("http://walkie/v1/post", {
      method: "POST", unix: kira.socket,
      headers: { "X-Walkie-Agent": ORCHESTRATOR_AGENT, [ORCHESTRATOR_TOKEN_HEADER]: "0".repeat(64), "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "general", text: "forged orchestrator" }),
    } as RequestInit);
    expect(forged.status).toBe(403);
    // reads still work
    expect(Array.isArray((await as.events({ channel: "general", limit: 1 })).events)).toBe(true);
    // the host's own Claude posts to the team as the orchestrator (its per-run secret, from its environment)
    const { message } = await person(kira).orchestratorSay("TEAMPOST hello team");
    const [reply] = await replies(kira, message.thread, message.id);
    expect(reply?.text).toMatch(/^posted .+ as orchestrator$/);
    const posted = await waitFor(async () => (await alex.client().events({ channel: "general", limit: 50 })).events
      .find((e) => (e.body as { text?: string }).text === "orchestrator says: TEAMPOST hello team"), { what: "the orchestrator's post on alex" });
    expect(posted.author).toMatchObject({ handle: "kira", agent: ORCHESTRATOR_AGENT });
    expect(JSON.stringify((await alex.client().events({ channel: "general", limit: 50 })).events)).not.toContain("forged orchestrator");
  }, 30_000);

  test("signing out every dashboard and rotating the token are admin (AGENT-ADMIN-1): an agent is refused while agent admin is off", async () => {
    await kira.client().adminSwitches({ agent_admin: false });
    try {
      await expect(kira.client("cc-abc123").logoutDashboards()).rejects.toThrow(/agent admin is off/);
      await expect(kira.client("cc-abc123").rotateToken()).rejects.toThrow(/agent admin is off/);
    } finally {
      await kira.client().adminSwitches({ agent_admin: true });
    }
  }, 30_000);

  test("history survives a daemon restart; the orchestrator resumes; stop stops it", async () => {
    const before = await messages(kira);
    await kira.restart();
    const after = await messages(kira);
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
    await waitFor(async () => (await kira.client().orchestrator()).local.running, { what: "resumed" });
    const res = await person(kira).orchestratorStop();
    expect(res.stopped).toBe("local");
    expect((await kira.client().orchestrator()).local.running).toBe(false);
    await expect(person(kira).orchestratorSay("anyone?")).rejects.toThrow(/WalkieTalkie isn.t running/);
  }, 60_000);
});
