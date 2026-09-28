// Seats round 10 (Codex r10 MEDIUM 3), unit level: a store that accepted seats-channel asks, answers or non-canonical
// requests under the round-9 rules re-judges them once after the upgrade (VALIDITY_VERSION).
import { afterEach, expect, test } from "bun:test";
import { runText, SEATS_AGENT, seatAgentName, seatsChannel } from "../../src/protocol/seats.ts";
import { memberByHandle, requestAllowed, seatsChannelRule, type MemberRec } from "../../src/daemon/roster.ts";
import { feed, makeCore, reopen, settle, statusOf } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

test("events the new seats-channel rules forbid, accepted by an older release, are rejected after the upgrade", async () => {
  const alex = tnode("alex");
  const arvid = tnode("arvid");
  const { team: id, create } = createTeam(alex);
  let core = makeCore(arvid, id, cleanups);
  const name = seatsChannel(arvid.keys.nodeId);
  feed(core, [create, memberEv(id, alex, arvid, "member"), nodeEv(id, alex, arvid), ev(id, alex, "channel.upsert", { name, members: ["arvid", "alex"], seats: true })]);
  const ask = ev(id, alex, "ask", { to: "@arvid", text: "our private chat", expires_at: Date.now() + 60_000 }, { channel: name });
  const run = { op: "run", v: 1, runtime: "codex", prompt: "go", timeout_s: 600, max_concurrent: 1 };
  const loose = ev(id, alex, "msg.post", { text: "free text riding on a request", seat: run } as never, { channel: name });
  feed(core, [ask, loose]);
  // As a round-9 replica stored them: accepted, under the previous validity version.
  for (const e of [ask, loose]) core.store.setStatus(e.id, "ok", null);
  core.store.setMeta("validity_version", "7");
  expect(statusOf(core, ask.id)).toBe("ok");
  core = reopen(core, arvid);
  await settle(core);
  expect(statusOf(core, ask.id)).toBe("rejected");
  expect(statusOf(core, loose.id)).toBe("rejected");
  expect(core.store.getMeta("validity_version")).toBe("10"); // 10: seats + projects rules, seats mark (pre.4)
});

test("Opus r11 INFO: the seats-channel content rule covers the names the reservation rule reserves, known nodes only", () => {
  const alex = tnode("alex");
  const arvid = tnode("arvid");
  const { team: id, create } = createTeam(alex);
  const core = makeCore(arvid, id, cleanups);
  const stranger = "0123456789abcdef"; // no node of this team
  const name = seatsChannel(stranger);
  feed(core, [create, memberEv(id, alex, arvid, "member"), nodeEv(id, alex, arvid), ev(id, alex, "channel.upsert", { name, members: ["arvid", "alex"] })]);
  const upsert = ev(id, alex, "channel.upsert", { name: seatsChannel(arvid.keys.nodeId), members: ["arvid", "alex"], seats: true });
  const plain = ev(id, alex, "msg.post", { text: "an ordinary channel with a seats-like name" }, { channel: name });
  const reserved = ev(id, alex, "msg.post", { text: "not in a real seats channel" }, { channel: seatsChannel(arvid.keys.nodeId) });
  feed(core, [upsert, plain, reserved]);
  expect(statusOf(core, plain.id)).toBe("ok");
  expect(core.store.getRow(reserved.id)?.reason).toBe("seats_channel_protocol_only");
});

test("Kimi r11 LOW 9 (golden): legitimate seats-channel history, emitted and received, survives the v8 re-judge", async () => {
  const alex = tnode("alex");
  const arvid = tnode("arvid");
  const { team: id, create } = createTeam(alex);
  let core = makeCore(arvid, id, cleanups); // the host
  const name = seatsChannel(arvid.keys.nodeId);
  feed(core, [create, memberEv(id, alex, arvid, "member"), nodeEv(id, alex, arvid), ev(id, alex, "channel.upsert", { name, members: ["arvid", "alex"], seats: true })]);
  // The launcher's requests, exactly as POST /v1/seats/run and /v1/seats/stop write them.
  const run = { op: "run", v: 1, runtime: "codex", prompt: "fix the tests\nplease", timeout_s: 600, max_concurrent: 9 } as const;
  const req = ev(id, alex, "msg.post", { text: runText(run, arvid.hostname), seat: run } as never, { channel: name });
  const stop = ev(id, alex, "msg.post", { text: `Stop seat ${req.id}`, thread: req.id, seat: { op: "stop", v: 1, seat: req.id } } as never, { channel: name });
  feed(core, [req, stop]);
  // The host daemon's own posts and a share, emitted as its `seats` agent and as a seat's.
  const state = core.emit("msg.post", { text: "Seat running", thread: req.id, seat: { op: "state", v: 1, seat: req.id, state: "running" } } as never, { channel: name, agent: SEATS_AGENT });
  const output = core.emit("msg.post", { text: "codex: done", thread: req.id, seat: { op: "output", v: 1, seat: req.id, n: 1, final: true } } as never, { channel: name, agent: seatAgentName(req.id) });
  const share = core.emit("artifact.share", { hash: "b".repeat(64), name: "seat.bundle", size: 10, mime: "application/x-git-bundle", thread: req.id }, { channel: name, agent: SEATS_AGENT });
  const all = [req, stop, state, output, share];
  for (const e of all) expect(statusOf(core, e.id)).toBe("ok");
  // Upgraded from a store judged under the previous rules: everything is re-judged once, and stays.
  core.store.setMeta("validity_version", "7");
  core = reopen(core, arvid);
  await settle(core);
  expect(core.store.getMeta("validity_version")).toBe("10"); // 10: seats + projects rules, seats mark (pre.4)
  for (const e of all) expect(statusOf(core, e.id)).toBe("ok");
});

test("pre.4 merge: a store at validity 8 (a seats-only or projects-only build) is re-judged once more, to the current version", async () => {
  const alex = tnode("alex");
  const arvid = tnode("arvid");
  const { team: id, create } = createTeam(alex);
  let core = makeCore(arvid, id, cleanups);
  const name = seatsChannel(arvid.keys.nodeId);
  feed(core, [create, memberEv(id, alex, arvid, "member"), nodeEv(id, alex, arvid), ev(id, alex, "channel.upsert", { name, members: ["arvid", "alex"], seats: true })]);
  const ask = ev(id, alex, "ask", { to: "@arvid", text: "our private chat", expires_at: Date.now() + 60_000 }, { channel: name });
  feed(core, [ask]);
  // A projects-only build (its 8) never judged the seats-channel rules: it accepted the ask.
  core.store.setStatus(ask.id, "ok", null);
  core.store.setMeta("validity_version", "8");
  core = reopen(core, arvid);
  await settle(core);
  expect(statusOf(core, ask.id)).toBe("rejected");
  expect(core.store.getMeta("validity_version")).toBe("10");
});

test("PRE4 RC (Codex 5): a pre.3 ordinary channel named seats-<node> keeps its history; the rule starts where the host marks it", async () => {
  const alex = tnode("alex");
  const arvid = tnode("arvid");
  const { team: id, create } = createTeam(alex);
  let core = makeCore(arvid, id, cleanups);
  const name = seatsChannel(arvid.keys.nodeId);
  // pre.3: an ordinary restricted channel that happens to have a seats name (no `seats` marker), and its history.
  feed(core, [create, memberEv(id, alex, arvid, "member"), nodeEv(id, alex, arvid), ev(id, alex, "channel.upsert", { name, members: ["arvid", "alex"] })]);
  const oldAsk = ev(id, alex, "ask", { to: "@arvid", text: "lunch?", expires_at: Date.now() + 60_000 }, { channel: name });
  const oldPost = ev(id, alex, "msg.post", { text: "an ordinary message" }, { channel: name });
  feed(core, [oldAsk, oldPost]);
  // Upgraded to validity 9 and never marked: nothing is re-judged away.
  core.store.setMeta("validity_version", "7");
  core = reopen(core, arvid);
  await settle(core);
  expect(core.store.getMeta("validity_version")).toBe("10");
  expect([statusOf(core, oldAsk.id), statusOf(core, oldPost.id)]).toEqual(["ok", "ok"]);
  // The seats host marks it (its upsert carries `seats: true`; the authority's watermark anchors what came before).
  const mark = ev(id, alex, "channel.upsert", { name, members: ["arvid", "alex"], seats: true, wm: { [alex.keys.nodeId]: alex.seq } });
  const newAsk = ev(id, alex, "ask", { to: "@arvid", text: "after marking", expires_at: Date.now() + 60_000 }, { channel: name });
  const newPost = ev(id, alex, "msg.post", { text: "a loose post after marking" }, { channel: name });
  feed(core, [mark, newAsk, newPost]);
  expect(core.roster.channels.get(name)?.seats).toBe(true);
  expect([statusOf(core, newAsk.id), statusOf(core, newPost.id)]).toEqual(["rejected", "rejected"]);
  // Re-judged again (every replica computes the same boundary from the chain): the history before the mark stays.
  core.store.setMeta("validity_version", "8");
  core = reopen(core, arvid);
  await settle(core);
  expect([statusOf(core, oldAsk.id), statusOf(core, oldPost.id)]).toEqual(["ok", "ok"]);
  expect([statusOf(core, newAsk.id), statusOf(core, newPost.id)]).toEqual(["rejected", "rejected"]);
});

test("PRE4 RC (Codex 5): the seats marker is refused on a channel that is not a machine's seats channel", () => {
  const alex = tnode("alex");
  const arvid = tnode("arvid");
  const { team: id, create } = createTeam(alex);
  const core = makeCore(arvid, id, cleanups);
  feed(core, [create, memberEv(id, alex, arvid, "member"), nodeEv(id, alex, arvid)]);
  const owner = memberByHandle(core.roster, "alex") as MemberRec;
  expect(requestAllowed("channel.upsert", { name: "general2", seats: true }, core.roster, owner).status).toBe("reject");
  expect(requestAllowed("channel.upsert", { name: seatsChannel(arvid.keys.nodeId), members: ["arvid"], seats: true }, core.roster, owner).status).toBe("reject"); // not alex's machine
  const arvidRec = memberByHandle(core.roster, "arvid") as MemberRec;
  expect(requestAllowed("channel.upsert", { name: seatsChannel(arvid.keys.nodeId), members: ["arvid"], seats: true }, core.roster, arvidRec).status).toBe("ok");
});

test("PRE4 delta: a store left at 9 (name-keyed seats rule) re-judges an unmarked seats-name channel's rejected post to ok", async () => {
  const alex = tnode("alex");
  const arvid = tnode("arvid");
  const { team: id, create } = createTeam(alex);
  let core = makeCore(arvid, id, cleanups);
  const name = seatsChannel(arvid.keys.nodeId);
  feed(core, [create, memberEv(id, alex, arvid, "member"), nodeEv(id, alex, arvid), ev(id, alex, "channel.upsert", { name, members: ["arvid", "alex"] })]);
  const post = ev(id, alex, "msg.post", { text: "an ordinary chat" }, { channel: name });
  feed(core, [post]);
  // As the 9 build (7c522b8's name-only rule) judged it.
  core.store.setStatus(post.id, "rejected", "seats_channel_protocol_only");
  core.store.setMeta("validity_version", "9");
  expect(statusOf(core, post.id)).toBe("rejected");
  core = reopen(core, arvid);
  await settle(core);
  expect(core.store.getMeta("validity_version")).toBe("10");
  expect(statusOf(core, post.id)).toBe("ok");
});

test("PRE4 delta (Opus 5): narrowing someone's seats channel is the authority's own sweep only; duplicate members are refused", () => {
  const alex = tnode("alex");
  const arvid = tnode("arvid");
  const eve = tnode("eve");
  const { team: id, create } = createTeam(alex);
  const core = makeCore(arvid, id, cleanups);
  const name = seatsChannel(arvid.keys.nodeId);
  feed(core, [create, memberEv(id, alex, arvid, "member"), nodeEv(id, alex, arvid), memberEv(id, alex, eve, "member"),
    ev(id, alex, "channel.upsert", { name, members: ["arvid", "eve"], seats: true }), memberEv(id, alex, eve, "removed")]);
  const owner = memberByHandle(core.roster, "alex") as MemberRec;
  const arvidRec = memberByHandle(core.roster, "arvid") as MemberRec;
  // A request (even the owner's) to drop the removed eve from arvid's seats channel: not the authority's sweep.
  expect(requestAllowed("channel.upsert", { name, members: ["arvid"] }, core.roster, owner)).toMatchObject({ status: "reject", reason: "reserved_name" });
  expect(seatsChannelRule({ name, members: ["arvid"] }, core.roster, "alex", { authoritySweep: true })?.status).toBe("ok");
  expect(seatsChannelRule({ name, members: ["arvid", "alex"] }, core.roster, "alex", { authoritySweep: true })?.status).toBe("reject"); // never adds
  expect(requestAllowed("channel.upsert", { name, members: ["arvid", "arvid"], seats: true }, core.roster, arvidRec)).toMatchObject({ status: "reject", reason: "duplicate_member" });
});
