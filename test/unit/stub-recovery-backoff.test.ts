import { afterEach, expect, test } from "bun:test";
import { makeCore, feed, reopen } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, tnode } from "../helpers/events.ts";
import { seatsChannel, type SeatRunV2 } from "../../src/protocol/seats.ts";
import { stubOf } from "../../src/protocol/header.ts";
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()?.(); });

test("still-invalid capped seat recovery preserves backoff and is attempted once per validity version", () => {
  const a = tnode("launcher"), b = tnode("replica");
  const { team, create } = createTeam(a);
  let core = makeCore(b, team, cleanup);
  const channel = seatsChannel(b.keys.nodeId);
  feed(core, [create, memberEv(team, a, b, "member"), nodeEv(team, a, b),
    ev(team, a, "channel.upsert", { name: channel, members: ["launcher", "replica"], seats: true })]);
  const run: SeatRunV2 = { op: "run", v: 2, runtime: "codex", brief: "b".repeat(64), timeout_s: 600, max_concurrent: 3 };
  const bad = ev(team, a, "msg.post", { text: "noncanonical text", seat: run } as never, { channel });
  core.ingest(bad, "remote");
  core.store.replaceWithStub(stubOf(bad), "junk", "hidden_cap");
  const peer = a.keys.nodeId;
  expect(core.fillableStubIds(10, peer)).toContain(bad.id);
  core.store.markStubsTried([bad.id], peer, Date.now());
  expect(core.ingest(bad, "remote").status).toBe("rejected");
  // Model the cap reducing the rejected body again, without thousands of unrelated rows.
  core.store.replaceWithStub(stubOf(bad), "junk", "hidden_cap");
  expect(core.fillableStubIds(10, peer)).not.toContain(bad.id);
  expect(core.fillableStubIds(10, "c".repeat(16))).not.toContain(bad.id);
  core = reopen(core, b);
  expect(core.fillableStubIds(10, "c".repeat(16))).not.toContain(bad.id);
  expect(core.store.db.query("SELECT attempts FROM stub_fill WHERE id = ?").get(bad.id)).toEqual({ attempts: 1 });
  core.store.setMeta(`stub_recovery:${bad.id}`, "previous-validity");
  expect(core.fillableStubIds(10, "c".repeat(16))).toContain(bad.id);
});
