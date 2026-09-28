// DIRECT-FIX-3 (Codex r3 MEDIUM 3): the signed chain position is the ONLY removal invalidation of a Walkie
// Direct invite. The old timestamp cut-off (and the mint-time floor that served it) blocked recovery after a removal
// the authority stamped with a clock that ran ahead: every fresh code then failed as `invite_expired` (floored mint
// time) or `invite_predates_removal` (unfloored). Ordinary 7-day expiry stays.
import { afterEach, describe, expect, test } from "bun:test";
import { createInvite, inviteMintPos } from "../../src/daemon/invite.ts";
import { dispatch, type RouteCtx } from "../../src/daemon/local-routes.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import { makeCore } from "../helpers/core.ts";
import { now, tnode, type TNode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const HOUR = 60 * 60 * 1000;
const directBody = (who: TNode) => ({
  node_id: who.keys.nodeId, login: who.login, hostname: who.hostname, pubkey: who.keys.pubkey, ip: "",
  endpoint: Buffer.from(who.keys.pubkey, "base64").toString("hex"), transports: ["direct"],
});

/** alex's daemon (a Direct team's roster authority) on a settable clock, with sam, a member, on one machine. */
function world() {
  let t = now();
  const alex = tnode("alex", "direct:alex");
  const sam = tnode("sam", "direct:sam");
  const core = makeCore(alex, "0000000000000000", cleanups, { clock: () => t });
  core.store.deleteMeta("team");
  core.createTeam("acme", "alex", { login: alex.login });
  core.emit("team.node", directBody(alex));
  core.emit("team.member", { login: sam.login, handle: "sam", role: "member" });
  core.emit("team.node", directBody(sam));
  return { alex, sam, core, api: new PeerApi(core), setClock: (v: number) => { t = v; }, clock: () => t };
}

/** `walkie invite --handle sam` on alex's daemon (the local route the CLI calls). */
async function inviteCode(w: ReturnType<typeof world>, role = "member"): Promise<string> {
  const req = new Request("http://127.0.0.1/v1/team/invite-code", { method: "POST", body: JSON.stringify({ handle: "sam", role }) });
  const transport = { direct: () => ({}), relayHint: async () => null };
  const ctx = { core: w.core, req, url: new URL(req.url), noTimeout: () => undefined, transport } as unknown as RouteCtx;
  const res = await dispatch(ctx);
  return ((await res.json()) as { code: string }).code;
}

async function join(w: ReturnType<typeof world>, who: TNode, invite: string): Promise<{ status: number; code?: string }> {
  const req = new Request("http://walkie.direct/peer/v1/join", {
    method: "POST", body: JSON.stringify({ pubkey: who.keys.pubkey, hostname: who.hostname, ip: "", invite }),
  });
  const res = await w.api.handle(req, { kind: "direct", pubkey: who.keys.pubkey });
  const body = res.status === 200 ? {} : (await res.json()) as { error?: { code?: string } };
  return { status: res.status, ...("error" in body ? { code: body.error?.code } : {}) };
}

describe("recovery after a removal stamped by a clock that ran ahead (Codex r3 MEDIUM 3)", () => {
  test("authority 2 h ahead removes sam, then corrects its clock: a fresh `walkie invite` code admits sam", async () => {
    const w = world();
    const real = w.clock();
    w.setClock(real + 2 * HOUR);
    w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "removed" });
    w.setClock(real); // clock corrected
    const code = await inviteCode(w);
    const res = await join(w, tnode("sam", "direct:sam", "sams-new-mac"), code);
    console.log(`[evidence] removal stamped +2 h, clock corrected, fresh route-minted code -> ${res.status} ${res.code ?? ""}; sam is ${w.core.roster.members.get("direct:sam")?.role}`);
    expect(res).toEqual({ status: 200 });
    expect(w.core.roster.members.get("direct:sam")?.role).toBe("member");
  });

  test("a code minted after the removal at the corrected clock passes; one minted before it is refused whatever its clock", async () => {
    const w = world();
    const real = w.clock();
    const before = createInvite(w.alex.keys, {
      team: w.core.teamId as string, authority: w.alex.keys.pubkey, handle: "sam", role: "owner", now: real + 50 * 60_000, pos: inviteMintPos(w.core.roster),
    });
    w.setClock(real + 2 * HOUR);
    w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "removed" });
    w.setClock(real);
    const after = createInvite(w.alex.keys, {
      team: w.core.teamId as string, authority: w.alex.keys.pubkey, handle: "sam", role: "member", now: real, pos: inviteMintPos(w.core.roster),
    });
    const old = await join(w, tnode("sam", "direct:sam", "a"), before.code);
    const fresh = await join(w, tnode("sam", "direct:sam", "b"), after.code);
    console.log(`[evidence] pre-removal code (its clock 50 min ahead) -> ${old.status} ${old.code}; post-removal code at the corrected clock -> ${fresh.status}`);
    expect(old).toEqual({ status: 403, code: "invite_predates_removal" });
    expect(fresh).toEqual({ status: 200 });
  });

  test("ordinary expiry is kept: 7 days after minting, and a code claiming to expire further out is refused", async () => {
    const w = world();
    const code = await inviteCode(w);
    w.setClock(w.clock() + 7 * 24 * HOUR + 1_000);
    expect(await join(w, tnode("sam", "direct:sam", "late"), code)).toEqual({ status: 403, code: "invite_expired" });
    const w2 = world();
    const ahead = createInvite(w2.alex.keys, {
      team: w2.core.teamId as string, authority: w2.alex.keys.pubkey, handle: "sam", role: "member", now: w2.clock() + 2 * HOUR, pos: inviteMintPos(w2.core.roster),
    });
    expect(await join(w2, tnode("sam", "direct:sam", "far"), ahead.code)).toEqual({ status: 403, code: "invite_expired" });
  });
});
