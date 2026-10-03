// WALK-73 r5 review (SHOULD): a hand-signed open that omits the settings head carries no contact authority. In a project
// with settings, a non-owner's resolve of it is refused before anything is signed (it used to get a 200 that the fold
// then ignored); an owner still resolves it. Ported from the reviewer probe R5RV-NOHEAD-OPEN. Fictional names only.
import { afterEach, expect, test } from "bun:test";
import { createLogger } from "../../src/daemon/logger.ts";
import type { Core } from "../../src/daemon/core.ts";
import { ProjectsIndex } from "../../src/daemon/projects/index.ts";
import "../../src/daemon/projects/routes.ts";
import type { WriteCtx } from "../../src/daemon/projects/service.ts";
import { resolveDispute, showDispute } from "../../src/daemon/projects/dispute.ts";
import { opEventOf } from "../../src/daemon/projects/db.ts";
import { refOf } from "../../src/protocol/projects/fold.ts";
import { DEFAULT_COLUMNS } from "../../src/protocol/projects/schema.ts";
import type { BodyOf, Event } from "../../src/protocol/schemas.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, ev as signed, memberEv, nodeEv, tnode, type TNode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) (cleanups.pop() as () => void)(); });
const CH = "p-5e7a7e05";

type D = { core: Core; idx: ProjectsIndex; w: WriteCtx };
function daemonOf(self: TNode, team: string, clock: () => number): D {
  const core = makeCore(self, team, cleanups, { clock });
  const idx = new ProjectsIndex(core, createLogger({}));
  cleanups.push(() => idx.stop());
  core.onPostChange = (e, change) => idx.onPost(e, change);
  core.onRosterChange = () => idx.rosterChanged();
  return { core, idx, w: { core, idx, client: {} as WriteCtx["client"], catchUp: async () => {} } };
}
async function attempt(f: () => Promise<{ state: string; resolved_by?: { handle: string } }>): Promise<string> {
  try { const d = await f(); return `200 ${d.state}${d.resolved_by ? ` by ${d.resolved_by.handle}` : ""}`; } catch (e) { return `${(e as { status?: number }).status} ${(e as Error).message}`; }
}
const refEv = (e: Event) => refOf(opEventOf(JSON.stringify(e)));

test("an open that names no settings head, in a project with settings: the contact is refused before signing; an owner resolves it", async () => {
  let t = 1_900_000_000_000;
  const clock = () => t;
  const alex = tnode("alex"), olive = tnode("olive"), noor = tnode("noor"), bea = tnode("bea");
  const { team, create } = createTeam(alex);
  const admitted = ([[olive, "owner"], [noor, "member"], [bea, "member"]] as const).flatMap(([n, r]) => [memberEv(team, alex, n, r), nodeEv(team, alex, n)]);
  const channel = signed(team, alex, "channel.upsert", { name: CH, project: true });
  const root = signed(team, alex, "msg.post", { text: "Project", board: { v: 1, rev: 0, op: "project", name: "Website", prefix: "WEB", escalation_contact: "@noor" } } as BodyOf<"msg.post">, { channel: CH, ts: (t += 1000) });
  const board = signed(team, alex, "msg.post", { text: "Board", board: { v: 1, rev: 0, op: "board", name: "Main", columns: DEFAULT_COLUMNS } } as BodyOf<"msg.post">, { channel: CH, ts: (t += 1000) });
  const card = signed(team, alex, "msg.post", { text: "card", board: { v: 1, rev: 0, op: "card", board: board.id, title: "Card", column: "todo", n: 1 } } as BodyOf<"msg.post">, { channel: CH, ts: (t += 1000) });
  const open = signed(team, bea, "msg.post", { text: "Dispute on card: Q", thread: card.id,
    board: { v: 1, rev: 1, op: "dispute", state: "open", summary: "Q", resolvers: ["@noor"], routed: "contact", after: refEv(card) } } as BodyOf<"msg.post">, { channel: CH, ts: (t += 1000) });
  const N = daemonOf(noor, team, clock), O = daemonOf(olive, team, clock);
  for (const d of [N, O]) { feed(d.core, [create, ...admitted, channel, root, board, card, open]); d.idx.flushAll(); }
  const out: Record<string, unknown> = { displayed: N.idx.project(CH)?.escalation_contact, listed: showDispute(N.w, card.id)?.resolvers };
  const before = N.core.store.allocatedSelfSeq(N.core.nodeId);
  t += 1000; out.noor = await attempt(() => resolveDispute(N.w, card.id, "Noor decides."));
  out.noor_signed = N.core.store.allocatedSelfSeq(N.core.nodeId) - before;
  out.noor_ignored = N.idx.disputeOf(CH, card.id).ignored.map((x) => x.reason);
  t += 1000; out.olive = await attempt(() => resolveDispute(O.w, card.id, "Owner decides."));
  expect(out.listed).toEqual(["@alex", "@olive"]);
  expect(String(out.noor)).toBe("403 this dispute names no project settings, so only an owner can resolve it");
  expect(out.noor_signed).toBe(0); // nothing signed, so no ignored resolve either
  expect(out.olive).toBe("200 resolved by olive");
});
