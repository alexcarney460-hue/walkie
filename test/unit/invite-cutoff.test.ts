// DIRECT-FIX-2 (Opus r2 MEDIUM 3 + 4, Codex r2 HIGH 2): a code minted before a member's removal stays void
// for good: through a re-invite (the cut-off survives re-admission and applies whatever the member's role is now),
// and whatever the issuer's clock said (the code carries the issuer's signed roster chain position).
import { afterEach, describe, expect, test } from "bun:test";
import { buildChain } from "../../src/daemon/chain.ts";
import { checkInvite, createInvite, decodeInvite, inviteMintPos } from "../../src/daemon/invite.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import type { Event } from "../../src/protocol/schemas.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, memberEv, nodeEv, now, tnode, type TNode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const directBody = (who: TNode) => ({
  node_id: who.keys.nodeId, login: who.login, hostname: who.hostname, pubkey: who.keys.pubkey, ip: "",
  endpoint: Buffer.from(who.keys.pubkey, "base64").toString("hex"), transports: ["direct"],
});

/** alex's daemon (the roster authority of a Direct team) with sam, an owner, on one machine. */
function world() {
  const alex = tnode("alex", "direct:alex");
  const sam = tnode("sam", "direct:sam");
  const core = makeCore(alex, "0000000000000000", cleanups);
  core.store.deleteMeta("team");
  core.createTeam("acme", "alex", { login: alex.login });
  core.emit("team.node", directBody(alex));
  core.emit("team.member", { login: sam.login, handle: "sam", role: "owner" });
  core.emit("team.node", directBody(sam));
  const team = core.teamId as string;
  const mint = (role: "owner" | "member" | "observer", at = now(), pos = inviteMintPos(core.roster)) =>
    createInvite(alex.keys, { team, authority: alex.keys.pubkey, handle: "sam", role, now: at, pos });
  return { alex, sam, team, core, api: new PeerApi(core), mint };
}

async function join(w: ReturnType<typeof world>, who: TNode, invite: string): Promise<{ status: number; code?: string }> {
  const req = new Request("http://walkie.direct/peer/v1/join", {
    method: "POST", body: JSON.stringify({ pubkey: who.keys.pubkey, hostname: who.hostname, ip: "", invite }),
  });
  const res = await w.api.handle(req, { kind: "direct", pubkey: who.keys.pubkey });
  const body = res.status === 200 ? {} : (await res.json()) as { error?: { code?: string } };
  return { status: res.status, ...("error" in body ? { code: body.error?.code } : {}) };
}

describe("a removal's invite cut-off survives re-admission (Codex r2 HIGH 2 / Opus r2 MEDIUM 4)", () => {
  test("remove -> fresh re-invite as observer -> an old owner code is still refused, on a new key and on the old machine", async () => {
    const w = world();
    const oldOwner = w.mint("owner");
    const oldMember = w.mint("member");
    w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "removed" });
    const fresh = w.mint("observer");
    const sam2 = tnode("sam", "direct:sam", "sams-new-laptop");
    expect(await join(w, sam2, fresh.code)).toEqual({ status: 200 });
    expect(w.core.roster.members.get("direct:sam")?.role).toBe("observer");
    const sam3 = tnode("sam", "direct:sam", "attackers-box");
    const stolen = await join(w, sam3, oldOwner.code);
    const oldMachine = await join(w, w.sam, oldMember.code);
    console.log(`[evidence] after re-invite: old owner code on a new key -> ${stolen.status} ${stolen.code}; old machine -> ${oldMachine.status} ${oldMachine.code}`);
    expect(stolen).toEqual({ status: 403, code: "invite_predates_removal" });
    expect(oldMachine).toEqual({ status: 403, code: "invite_predates_removal" });
    expect(w.core.roster.nodes.get(sam3.keys.nodeId)).toBeUndefined();
    expect(w.core.roster.nodes.get(w.sam.keys.nodeId)?.revoked).toBe(true);
    expect(w.core.roster.members.get("direct:sam")?.role).toBe("observer");
  });

  test("the member record keeps its removal cut-off when re-admitted", async () => {
    const w = world();
    w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "removed" });
    const removed = w.core.roster.members.get("direct:sam");
    w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "member" });
    const back = w.core.roster.members.get("direct:sam");
    expect(back?.role).toBe("member");
    expect(back?.removed_pos).toBe(removed?.removed_pos as number);
  });

  test("a code minted after the re-admission (adding a machine) still works", async () => {
    const w = world();
    w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "removed" });
    expect((await join(w, tnode("sam", "direct:sam", "a"), w.mint("member").code)).status).toBe(200);
    expect((await join(w, tnode("sam", "direct:sam", "b"), w.mint("member").code)).status).toBe(200);
  });
});

describe("the cut-off doesn't depend on clocks (Opus r2 MEDIUM 3)", () => {
  test("issuer clock 10 min ahead: an owner code minted before the removal can't bring the owner back", async () => {
    const w = world();
    const skewed = w.mint("owner", now() + 10 * 60_000); // its minting time claims to be after the removal
    w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "removed" });
    const res = await join(w, tnode("sam", "direct:sam", "sams-other-mac"), skewed.code);
    console.log(`[evidence] skewed (+10 min) pre-removal owner code -> ${res.status} ${res.code}; sam is ${w.core.roster.members.get("direct:sam")?.role}`);
    expect(res).toEqual({ status: 403, code: "invite_predates_removal" });
    expect(w.core.roster.members.get("direct:sam")?.role).toBe("removed");
  });

  test("issuer clock behind the authority's: a code minted after the removal still passes", async () => {
    const w = world();
    w.core.emit("team.member", { login: w.sam.login, handle: "sam", role: "removed" });
    const behind = w.mint("member", now() - 10 * 60_000);
    expect((await join(w, tnode("sam", "direct:sam", "c"), behind.code)).status).toBe(200);
  });

  test("the chain position is signed: raising it breaks the signature", () => {
    const alex = tnode("alex");
    const { team, create } = createTeam(alex);
    const sam = tnode("sam");
    const log: Event[] = [create, memberEv(team, alex, sam, "owner"), nodeEv(team, alex, sam)];
    const roster = buildChain(log, team).roster;
    const inv = createInvite(alex.keys, { team, authority: alex.keys.pubkey, handle: "sam", role: "owner", now: now(), pos: inviteMintPos(roster) });
    const d = decodeInvite(inv.code);
    if ("error" in d) throw new Error(d.error);
    expect(d.pos).toBe(3);
    const bytes = Buffer.from(inv.code.slice(3), "base64url");
    bytes.writeUInt32BE(1_000, 1 + 8 + 32 + 8 + 16 + 4);
    expect(checkInvite("wk1" + bytes.toString("base64url"), roster, team, now())).toEqual({ ok: false, reason: "invite_bad_signature" });
  });

  test("replicas fold the same cut-off: the position is the removal's chain index everywhere", () => {
    const alex = tnode("alex");
    const { team, create } = createTeam(alex);
    const sam = tnode("sam");
    const log: Event[] = [create, memberEv(team, alex, sam, "owner"), nodeEv(team, alex, sam), memberEv(team, alex, sam, "removed")];
    const a = buildChain(log, team).roster;
    const b = buildChain([...log].reverse(), team).roster;
    expect(a.voids?.get("sam")).toEqual({ pos: 3 });
    expect(b.voids?.get("sam")).toEqual({ pos: 3 });
    expect(a.pos).toBe(4);
  });
});
