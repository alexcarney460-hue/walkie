// SEATS-FIX-8 (docs/audits/2026-09-26-*-seats-r8.md), unit level: a seats channel carries seat requests and its
// host's posts only, and the Free exemption needs an active machine of a current member (Opus r8 1, Codex r8 MEDIUM
// 4); seats get access-token-only copies of the machine's sign-ins (Opus r8 2); an operation whose liveness can't be
// told stays held, and the helper needs its own identity (Codex r8 MEDIUM 1, Opus r8 LOW); a sweep root that can't
// be walked is never verified (Codex r8 MEDIUM 3); round-6 ledgers migrate; one person per machine.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger, processAlive } from "../../src/daemon/seats/admin-ledger.ts";
import { accessOnlyClaude, accessOnlyCodex } from "../../src/daemon/seats/host.ts";
import { fakeOwned } from "../../src/daemon/seats/runner-sweep.ts";
import { SEAT_OWNER_FILE, seatOwnerProblem } from "../../src/daemon/seats/seat-user.ts";
import { sweepVerified } from "../../src/daemon/seats/sweep.ts";
import { planLimitFor } from "../../src/license/enforce.ts";
import { runText, SEATS_AGENT, seatsChannel, seatsChannelContent } from "../../src/protocol/seats.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const DAY = 86_400_000;
const tmp = () => { const d = mkdtempSync("/tmp/walkie-fix8-"); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d; };

describe("a seats channel is no general restricted channel (Opus r8 1, Codex r8 MEDIUM 4)", () => {
  const host = "0123456789abcdef";
  const ch = seatsChannel(host);
  const post = (over: Record<string, unknown>) => ({ kind: "msg.post", origin: "fedcba9876543210", channel: ch, author: {}, body: { text: "hi" }, ...over });
  test("seat requests and the host's own posts only", () => {
    expect(seatsChannelContent(post({}))).toBe("seats_channel_protocol_only");
    expect(seatsChannelContent(post({ kind: "artifact.share", body: { hash: "a".repeat(64), name: "x", size: 1, mime: "application/x-git-bundle" } }))).toBe("seats_channel_protocol_only");
    const run = { op: "run", v: 1, runtime: "codex", prompt: "go", timeout_s: 60, max_concurrent: 1 } as const;
    expect(seatsChannelContent(post({ body: { text: runText(run, "arvid-mac"), seat: run } }))).toBeNull();
    const stop = { op: "stop", v: 1, seat: "fedcba9876543210:4" } as const;
    expect(seatsChannelContent(post({ body: { text: "Stop seat fedcba9876543210:4", thread: stop.seat, seat: stop } }))).toBeNull();
    expect(seatsChannelContent(post({ origin: host, author: { agent: SEATS_AGENT } }))).toBeNull();
    expect(seatsChannelContent(post({ origin: host, author: {} }))).toBe("seats_channel_protocol_only"); // its person, not its daemon
    expect(seatsChannelContent(post({ channel: "general" }))).toBeNull();
  });

  test("a request's text is exactly the daemon's; asks and answers never (Opus r9 MEDIUM, Codex r9 MEDIUM 2)", () => {
    const run = { op: "run", v: 1, runtime: "codex", prompt: "line one\nline two", timeout_s: 600, max_concurrent: 1 } as const;
    const ok = runText(run, "arvid-mac");
    expect(seatsChannelContent(post({ body: { text: ok, seat: run } }))).toBeNull();
    const bad = (body: unknown) => expect(seatsChannelContent(post({ body }))).toBe("seats_channel_protocol_only");
    bad({ text: "our private chat", seat: run }); // free text riding on a request
    bad({ text: `${ok}\n\nand a note`, seat: run });
    bad({ text: runText(run, "a\nhidden line"), seat: run }); // the hostname slot is one line
    bad({ text: runText(run, "h".repeat(64)), seat: run });
    bad({ text: ok, seat: run, artifacts: ["a".repeat(64)] });
    bad({ text: ok, seat: run, mentions: ["@alex"] });
    bad({ text: ok, seat: run, thread: "fedcba9876543210:1" });
    const stop = { op: "stop", v: 1, seat: "fedcba9876543210:4" } as const;
    bad({ text: "Stop seat fedcba9876543210:4 please", thread: stop.seat, seat: stop });
    bad({ text: "Stop seat fedcba9876543210:4", seat: stop }); // not threaded under its request
    bad({ text: "Stop seat fedcba9876543210:4", thread: "fedcba9876543210:5", seat: stop });
    const ask = { to: "@arvid", text: "hi", expires_at: 1 };
    expect(seatsChannelContent(post({ kind: "ask", body: ask }))).toBe("seats_channel_protocol_only");
    expect(seatsChannelContent(post({ kind: "answer", origin: host, author: { agent: SEATS_AGENT }, body: { ask: "fedcba9876543210:1", text: "x" } }))).toBe("seats_channel_protocol_only");
    expect(seatsChannelContent(post({ kind: "ask", channel: "general", body: ask }))).toBeNull();
  });

  test("every replica rejects an ask or answer in someone's seats channel", () => {
    const alex = tnode("alex");
    const arvid = tnode("arvid");
    const { team: id, create } = createTeam(alex);
    const core = makeCore(arvid, id, cleanups);
    const name = seatsChannel(arvid.keys.nodeId);
    feed(core, [create, memberEv(id, alex, arvid, "member"), nodeEv(id, alex, arvid), ev(id, alex, "channel.upsert", { name, members: ["arvid", "alex"], seats: true })]);
    const ask = ev(id, alex, "ask", { to: "@arvid", text: "our private chat", expires_at: Date.now() + 60_000 }, { channel: name });
    const answer = ev(id, alex, "answer", { ask: ask.id, text: "and the reply" }, { channel: name }); // judged before whose ask it is
    feed(core, [ask, answer]);
    expect(core.store.getRow(ask.id)?.status).not.toBe("ok");
    expect(core.store.getRow(ask.id)?.reason).toBe("seats_channel_protocol_only");
    expect(core.store.getRow(answer.id)?.status).not.toBe("ok");
    expect(core.store.getRow(answer.id)?.reason).toBe("seats_channel_protocol_only");
  });

  test("PRE4 delta: an UNMARKED channel with a seats name is ordinary: its ask and post are accepted", () => {
    const alex = tnode("alex");
    const arvid = tnode("arvid");
    const { team: id, create } = createTeam(alex);
    const core = makeCore(arvid, id, cleanups);
    const name = seatsChannel(arvid.keys.nodeId);
    feed(core, [create, memberEv(id, alex, arvid, "member"), nodeEv(id, alex, arvid), ev(id, alex, "channel.upsert", { name, members: ["arvid", "alex"] })]);
    const ask = ev(id, alex, "ask", { to: "@arvid", text: "an ordinary question", expires_at: Date.now() + 60_000 }, { channel: name });
    const plain = ev(id, alex, "msg.post", { text: "an ordinary chat" }, { channel: name });
    feed(core, [ask, plain]);
    expect([core.store.getRow(ask.id)?.status, core.store.getRow(plain.id)?.status]).toEqual(["ok", "ok"]);
  });

  test("every replica rejects a teammate's ordinary post in someone's seats channel", () => {
    const alex = tnode("alex");
    const arvid = tnode("arvid");
    const { team: id, create } = createTeam(alex);
    const core = makeCore(arvid, id, cleanups);
    const name = seatsChannel(arvid.keys.nodeId);
    feed(core, [create, memberEv(id, alex, arvid, "member"), nodeEv(id, alex, arvid), ev(id, alex, "channel.upsert", { name, members: ["arvid", "alex"], seats: true })]);
    expect(core.roster.channels.get(name)?.members).toEqual(["arvid", "alex"]);
    const plain = ev(id, alex, "msg.post", { text: "our private chat" }, { channel: name });
    feed(core, [plain]);
    expect(core.store.getRow(plain.id)?.status).not.toBe("ok");
  });

  test("the Free exemption: an active machine of a current member, that member in it, every member current", () => {
    const alex = tnode("alex");
    const arvid = tnode("arvid");
    const { team: id, create } = createTeam(alex);
    const core = makeCore(arvid, id, cleanups);
    feed(core, [create, memberEv(id, alex, arvid, "member"), nodeEv(id, alex, arvid)]);
    const afterTrial = (core.roster.team?.created_ts ?? 0) + 61 * DAY;
    const name = seatsChannel(arvid.keys.nodeId);
    const limit = (members: string[], marked = true) => planLimitFor(core.roster, "channel.upsert", { name, members, ...(marked ? { seats: true as const } : {}) }, afterTrial)?.resource ?? null;
    expect(limit(["arvid", "alex"])).toBeNull();
    // PRE4 delta: an UNMARKED seats-<own node> channel is an ordinary restricted channel after the trial.
    expect(limit(["arvid", "alex"], false)).toBe("restricted_channels");
    expect(limit(["alex"])).toBe("restricted_channels"); // its own person not in it
    expect(limit(["arvid", "nobody"])).toBe("restricted_channels"); // not a current member
    feed(core, [nodeEv(id, alex, arvid, true)]); // the machine revoked
    expect(limit(["arvid", "alex"])).toBe("restricted_channels");
  });
});

describe("seats get access tokens only (Opus r8 2)", () => {
  test("Claude: the refresh token is dropped; an expiring access token isn't handed over", () => {
    const now = Date.now();
    const file = JSON.stringify({ claudeAiOauth: { accessToken: "access-token", refreshToken: "rt", expiresAt: now + 8 * 3_600_000, scopes: ["user:inference"] } });
    expect(JSON.parse(accessOnlyClaude(file, now) as string)).toEqual({ claudeAiOauth: { accessToken: "access-token", expiresAt: now + 8 * 3_600_000, scopes: ["user:inference"] } });
    expect(accessOnlyClaude(JSON.stringify({ claudeAiOauth: { accessToken: "access-token", refreshToken: "rt", expiresAt: now + 60_000 } }), now)).toBeNull();
    expect(accessOnlyClaude(JSON.stringify({ claudeAiOauth: {} }), now)).toBeNull();
    expect(accessOnlyClaude("not json", now)).toBeNull();
  });
  test("Codex: access and id token, never the refresh token or an API key", () => {
    const file = JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: "sk-proj-x", tokens: { access_token: "at", id_token: "it", refresh_token: "rt", account_id: "a" }, last_refresh: "t" });
    expect(JSON.parse(accessOnlyCodex(file) as string)).toEqual({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: "at", id_token: "it", refresh_token: "", account_id: "a" }, last_refresh: "t" });
    expect(accessOnlyCodex(JSON.stringify({ OPENAI_API_KEY: "sk-proj-x" }))).toBeNull();
  });

  test("Codex: the copy has an EMPTY refresh_token field (codex-cli 0.156.1 rejects a file without it), never the real one", () => {
    const file = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "at", id_token: "it", refresh_token: "rt-secret", account_id: "a" } });
    const copy = accessOnlyCodex(file) as string;
    expect(copy).not.toContain("rt-secret");
    const parsed = JSON.parse(copy) as { tokens: Record<string, unknown> };
    expect(Object.keys(parsed.tokens)).toContain("refresh_token");
    expect(parsed.tokens.refresh_token).toBe("");
  });
});

describe("liveness, identity, ledgers (Codex r8 MEDIUM 1, Opus r8 LOW)", () => {
  test("an operation whose process can't be inspected stays held (busy), never taken over", () => {
    expect(processAlive({ pid: 999_999_9, start: "whenever" })).toBe(true); // ps can't tell about this pid
    const db = join(tmp(), "ledger.sqlite");
    const ledger = new Ledger(db, false, () => true);
    cleanups.push(() => ledger.close());
    ledger.reserve(3, 501, { pid: 999_999_9, start: "whenever" });
    ledger.advance(3, { pid: 999_999_9, start: "whenever" }, "reserved", "making");
    expect(ledger.takeForDestroy(3, 501, { pid: process.pid, start: "me" })).toMatchObject({ ok: false, busy: true, state: "making" });
  });

  test("a round-6 ledger (no owner or operation columns) is migrated; its rows are taken by the first person's helper", () => {
    const db = join(tmp(), "ledger.sqlite");
    const old = new Database(db, { create: true });
    old.exec("CREATE TABLE ids (n INTEGER PRIMARY KEY, state TEXT NOT NULL, at INTEGER NOT NULL)");
    old.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
    old.exec("INSERT INTO ids VALUES (4, 'created', 1), (5, 'destroyed', 1)");
    old.exec("INSERT INTO meta VALUES ('high', 5)");
    old.close();
    const ledger = new Ledger(db);
    cleanups.push(() => ledger.close());
    expect(ledger.pending(777)).toEqual([4]);
    expect(ledger.takeForDestroy(4, 777, { pid: process.pid, start: "me" })).toMatchObject({ ok: true, state: "created" });
    expect(ledger.takeForDestroy(4, 888, { pid: process.pid, start: "me" })).toMatchObject({ ok: false, busy: false }); // now 777's
    expect(ledger.reserve(5, 777, { pid: process.pid, start: "me" })).toMatchObject({ ok: false });
  });
});

describe("sweep roots and one person per machine", () => {
  test("Codex r8 MEDIUM 3: a sweep root that can't be walked is not verified", () => {
    const t = tmp();
    writeFileSync(join(t, "not-a-dir"), "x");
    const r = sweepVerified([{ path: join(t, "not-a-dir") }], fakeOwned("seat", process.getuid?.() ?? -1));
    expect(r.verified).toBe(false);
    expect(r.problems.join(" ")).toMatch(/ENOTDIR/);
  });

  test("a second person's setup is refused while this machine's seat users are someone else's", () => {
    const read = (owner: string | null) => (p: string) => (p === SEAT_OWNER_FILE ? owner : null);
    expect(seatOwnerProblem("arvid", read(null))).toBeNull();
    expect(seatOwnerProblem("arvid", read("arvid\n"))).toBeNull();
    expect(seatOwnerProblem("kira", read("arvid\n"))).toMatch(/set up for arvid: one person per machine/);
  });
});
