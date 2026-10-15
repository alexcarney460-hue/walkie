// WALK-124: delayed channel membership writes must not restore a removed person's access. Fictional identities only.
import { afterEach, expect, test } from "bun:test";
import { canonicalJson } from "../../src/protocol/canonical.ts";
import type { RosterRequest } from "../../src/protocol/schemas.ts";
import { applyRequest, signRequest } from "../../src/daemon/requests.ts";
import { HttpError } from "../../src/daemon/http.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function world() {
  const alex = tnode("alex"), noor = tnode("noor");
  const core = makeCore(alex, "0000000000000000", cleanups);
  core.store.deleteMeta("team");
  core.createTeam("fictional", "alex", { login: alex.login });
  core.emit("team.member", { login: noor.login, handle: noor.handle, role: "member" });
  core.emit("channel.upsert", { name: "private-room", members: ["alex", "noor"] });
  const role = (role: "removed" | "member") => core.emit("team.member", { login: noor.login, handle: noor.handle, role });
  const request = (body: Record<string, unknown> = {}) => signRequest(core, "channel.upsert", {
    name: "private-room", members: ["alex", "noor"], ...body,
  });
  const signedBody = (req: RosterRequest, body: Record<string, unknown>): RosterRequest => {
    const { sig: _sig, ...unsigned } = { ...req, body };
    return { ...unsigned, sig: core.keys.sign(canonicalJson({ team: core.teamId, ...unsigned })) };
  };
  const legacy = () => {
    const req = request();
    const { seen_pos: _seen, ...body } = req.body;
    return signedBody(req, body);
  };
  return { core, noor, role, request, signedBody, legacy };
}

test("a channel request carries its signed roster position, never an event field", () => {
  const { core, request } = world();
  const req = request();
  expect(req.body.seen_pos).toBe(core.roster.pos);
  const event = applyRequest(core, req);
  expect(event?.body).not.toHaveProperty("seen_pos");
  expect(core.roster.channels.get("private-room")?.members).toEqual(["alex", "noor"]);
});

test("a queued channel request cannot reinsert a removed handle, including after a later reinvite", () => {
  const { core, role, request } = world();
  const req = request();
  role("removed");
  expect(core.roster.channels.get("private-room")?.members).toEqual(["alex"]);
  expect(() => applyRequest(core, req)).toThrow(/stale_request/);
  role("member");
  expect(core.roster.channels.get("private-room")?.members).toEqual(["alex"]);
});

test("remove and reinvite before the stale request arrives still refuses that request", () => {
  const { core, role, request } = world();
  const req = request();
  role("removed");
  role("member");
  expect(() => applyRequest(core, req)).toThrow(/stale_request/);
  expect(core.roster.channels.get("private-room")?.members).toEqual(["alex"]);
});

test("a new request made after reinvitation may deliberately add the current member", () => {
  const { core, role, request } = world();
  role("removed");
  role("member");
  expect(() => applyRequest(core, request())).not.toThrow();
  expect(core.roster.channels.get("private-room")?.members).toEqual(["alex", "noor"]);
});

test("even a fresh request cannot name someone who is still removed or was never a member", () => {
  const { core, role, request } = world();
  role("removed");
  expect(() => applyRequest(core, request())).toThrow(/stale_request/);
  expect(() => applyRequest(core, request({ members: ["alex", "unknown"] }))).toThrow(/unknown_member/);
  expect(core.roster.channels.get("private-room")?.members).toEqual(["alex"]);
});

test("the equal removal position is stale; observing past it and the reinvite is fresh", () => {
  const { core, noor, role, request, signedBody } = world();
  role("removed");
  const at = core.roster.members.get(noor.login)!.removed_pos!;
  role("member");
  const req = request();
  expect(() => applyRequest(core, signedBody(req, { ...req.body, seen_pos: at }))).toThrow(/stale_request/);
  expect(() => applyRequest(core, req)).not.toThrow();
});

test("legacy channel grants are refused after any removal with an upgrade explanation", () => {
  const { core, role, legacy } = world();
  const req = legacy();
  role("removed");
  role("member");
  expect(() => applyRequest(core, req)).toThrow(/Update Sqwakie/);
  expect(core.roster.channels.get("private-room")?.members).toEqual(["alex"]);
});

test("legacy grants to uninterrupted members and membership-free topic changes still work", () => {
  const { core, role, request, legacy } = world();
  expect(() => applyRequest(core, legacy())).not.toThrow();
  const req = request({ members: undefined, topic: "Updated topic" });
  role("removed");
  expect(() => applyRequest(core, req)).not.toThrow();
  expect(core.roster.channels.get("private-room")?.members).toEqual(["alex"]);
  expect(core.roster.channels.get("private-room")?.topic).toBe("Updated topic");
});

test("changing or stripping the signed position without resigning is refused", () => {
  const { core, request } = world();
  const req = request();
  const { seen_pos: _seen, ...body } = req.body;
  expect(() => applyRequest(core, { ...req, body })).toThrow(/bad request signature/);
  expect(() => applyRequest(core, { ...req, body: { ...req.body, seen_pos: 100000 } })).toThrow(/bad request signature/);
});

test("malformed positions on membership changes are refused", () => {
  const { core, request, signedBody } = world();
  for (const seen_pos of [-1, 0.5, "3", null, Number.MAX_SAFE_INTEGER + 1]) {
    const req = request();
    expect(() => applyRequest(core, signedBody(req, { ...req.body, seen_pos }))).toThrow(/bad_precondition/);
  }
});

test("malformed positions are refused for a removal and a topic-only update too", () => {
  const { core, noor, request, signedBody } = world();
  const topic = request({ members: undefined, topic: "Updated topic" });
  let refusal: unknown;
  try { applyRequest(core, signedBody(topic, { ...topic.body, seen_pos: -1 })); } catch (err) { refusal = err; }
  expect(refusal).toBeInstanceOf(HttpError);
  expect((refusal as HttpError).status).toBe(400);
  expect((refusal as HttpError).code).toBe("invalid");
  expect((refusal as HttpError).message).toBe("request refused: bad_precondition");
  const removal = signRequest(core, "team.member", { login: noor.login, handle: noor.handle, role: "removed" });
  expect(() => applyRequest(core, signedBody(removal, { ...removal.body, seen_pos: -1 }))).toThrow(/bad_precondition/);
});

test("an already applied request is idempotent after removal and cannot restore the old membership", () => {
  const { core, role, request } = world();
  const req = request();
  const applied = applyRequest(core, req);
  role("removed");
  const length = core.chainLength;
  expect(applyRequest(core, req)?.id).toBe(applied?.id);
  expect(core.chainLength).toBe(length);
  expect(core.roster.channels.get("private-room")?.members).toEqual(["alex"]);
});

test("an authority transfer preserves the removal precondition for a delayed channel request", () => {
  const { core, role, request } = world();
  const kira = tnode("kira");
  core.emit("team.member", { login: kira.login, handle: kira.handle, role: "owner" });
  core.emit("team.node", { node_id: kira.keys.nodeId, login: kira.login, hostname: kira.hostname,
    pubkey: kira.keys.pubkey, ip: "127.0.0.1", port: 7458 });
  const req = request();
  role("removed");
  role("member");
  core.emit("team.authority", { node_id: kira.keys.nodeId });
  const heir = makeCore(kira, core.teamId!, cleanups);
  feed(heir, core.rosterEntries());
  expect(heir.isAuthority()).toBe(true);
  expect(() => applyRequest(heir, req)).toThrow(/stale_request/);
  expect(heir.roster.channels.get("private-room")?.members).toEqual(["alex"]);
});

test("a future signed position is refused for a channel grant", () => {
  const { core, request, signedBody } = world();
  const req = request();
  expect(() => applyRequest(core, signedBody(req, { ...req.body, seen_pos: core.roster.pos! + 1 }))).toThrow(/bad_precondition/);
});

test("a stale public request cannot open a channel restricted since signing", () => {
  const { core, request } = world();
  const req = request({ public: true, members: undefined });
  core.emit("channel.upsert", { name: "private-room", members: ["alex"] });
  expect(() => applyRequest(core, req)).toThrow(/stale_request/);
  expect(core.roster.channels.get("private-room")?.members).toEqual(["alex"]);
});

test("a positionless public request cannot open a restricted channel", () => {
  const { core, request, signedBody } = world();
  const req = request({ public: true, members: undefined });
  const { seen_pos: _seen, ...body } = req.body;
  expect(() => applyRequest(core, signedBody(req, body))).toThrow(/stale_request/);
});

test("an explicit list signed before a channel removal cannot restore it", () => {
  const { core, request } = world();
  const req = request();
  core.emit("channel.upsert", { name: "private-room", members: ["alex"] });
  expect(() => applyRequest(core, req)).toThrow(/stale_request/);
  expect(core.roster.channels.get("private-room")?.members).toEqual(["alex"]);
});

test("an explicit list signed before a channel reorder cannot restore the old order", () => {
  const { core, request } = world();
  const req = request();
  core.emit("channel.upsert", { name: "private-room", members: ["noor", "alex"] });
  expect(core.roster.channels.get("private-room")?.members).toEqual(["noor", "alex"]);
  expect(() => applyRequest(core, req)).toThrow(/stale_request/);
  expect(core.roster.channels.get("private-room")?.members).toEqual(["noor", "alex"]);
});

test("a positionless list cannot restore members after the channel changed", () => {
  const { core, request, signedBody } = world();
  const req = request();
  const { seen_pos: _seen, ...body } = req.body;
  core.emit("channel.upsert", { name: "private-room", members: ["alex"] });
  expect(() => applyRequest(core, signedBody(req, body))).toThrow(/stale_request/);
});

test("a positionless list signed before channel creation cannot expand its first restricted list", () => {
  const { core, request, signedBody } = world();
  const req = request({ name: "later-room" });
  const { seen_pos: _seen, ...body } = req.body;
  const oldRequest = signedBody(req, body);
  core.emit("channel.upsert", { name: "later-room", members: ["alex"] });
  expect(core.roster.channels.get("later-room")?.membership_pos).toBeDefined();
  expect(() => applyRequest(core, oldRequest)).toThrow(/stale_request/);
  expect(core.roster.channels.get("later-room")?.members).toEqual(["alex"]);
});

test("a positionless list signed before channel creation cannot narrow its first restricted list", () => {
  const { core, request, signedBody } = world();
  const req = request({ name: "later-room", members: ["alex"] });
  const { seen_pos: _seen, ...body } = req.body;
  const oldRequest = signedBody(req, body);
  core.emit("channel.upsert", { name: "later-room", members: ["alex", "noor"] });
  expect(core.roster.channels.get("later-room")?.membership_pos).toBeDefined();
  expect(() => applyRequest(core, oldRequest)).toThrow(/stale_request/);
  expect(core.roster.channels.get("later-room")?.members).toEqual(["alex", "noor"]);
});

test("a positionless list cannot replace the first restricted list with duplicates", () => {
  const { core, request, signedBody } = world();
  const req = request({ name: "later-room", members: ["alex", "noor", "noor"] });
  const { seen_pos: _seen, ...body } = req.body;
  const oldRequest = signedBody(req, body);
  core.emit("channel.upsert", { name: "later-room", members: ["alex", "noor"] });
  expect(() => applyRequest(core, oldRequest)).toThrow(/stale_request/);
  expect(core.roster.channels.get("later-room")?.members).toEqual(["alex", "noor"]);
});

test("a positionless list cannot reorder the first restricted list", () => {
  const { core, request, signedBody } = world();
  const req = request({ name: "later-room", members: ["noor", "alex"] });
  const { seen_pos: _seen, ...body } = req.body;
  const oldRequest = signedBody(req, body);
  core.emit("channel.upsert", { name: "later-room", members: ["alex", "noor"] });
  expect(() => applyRequest(core, oldRequest)).toThrow(/stale_request/);
  expect(core.roster.channels.get("later-room")?.members).toEqual(["alex", "noor"]);
});
