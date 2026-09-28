// FO-2 r1 MEDIUM 10: the seats content rule now takes a `v: 2` run request exactly as the daemon writes it. A store
// judged by an older build (validity 10) rejected such a request; VALIDITY_VERSION 11 re-judges it once after the
// upgrade, so it is accepted, while a v2 request with text of its own stays rejected.
import { afterEach, expect, test } from "bun:test";
import { runTextV2, seatsChannel, type SeatRunV2 } from "../../src/protocol/seats.ts";
import { feed, makeCore, reopen, settle, statusOf } from "../helpers/core.ts";
import { createTeam, ev, memberEv, nodeEv, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

test("a v2 request an older build rejected is accepted after the upgrade; a non-canonical one stays rejected", async () => {
  const alex = tnode("alex");
  const arvid = tnode("arvid");
  const { team: id, create } = createTeam(alex);
  let core = makeCore(arvid, id, cleanups);
  const name = seatsChannel(arvid.keys.nodeId);
  feed(core, [create, memberEv(id, alex, arvid, "member"), nodeEv(id, alex, arvid), ev(id, alex, "channel.upsert", { name, members: ["arvid", "alex"], seats: true, requested_by: "arvid" })]);
  const run: SeatRunV2 = { op: "run", v: 2, runtime: "codex", brief: "b".repeat(64), timeout_s: 600, max_concurrent: 3 };
  const req = ev(id, alex, "msg.post", { text: runTextV2(run, arvid.hostname), seat: run } as never, { channel: name });
  const loose = ev(id, alex, "msg.post", { text: "free text riding on a v2 request", seat: run } as never, { channel: name });
  feed(core, [req, loose]);
  expect(statusOf(core, req.id)).toBe("ok"); // this build
  expect(statusOf(core, loose.id)).toBe("rejected");
  // As a pre.5 replica stored them: both rejected, under validity 10.
  core.store.setStatus(req.id, "rejected", "seats_channel_protocol_only");
  core.store.setMeta("validity_version", "10");
  core = reopen(core, arvid);
  await settle(core);
  expect(core.store.getMeta("validity_version")).toBe("11");
  expect(statusOf(core, req.id)).toBe("ok");
  expect(statusOf(core, loose.id)).toBe("rejected");
});

test("pre-v2 rejection beyond the hidden cap is repairable after upgrade, only with a valid signature", async () => {
  const launcher = tnode("launcher");
  const replica = tnode("replica");
  const { team, create } = createTeam(launcher);
  let core = makeCore(replica, team, cleanups);
  const channel = seatsChannel(replica.keys.nodeId);
  feed(core, [create, memberEv(team, launcher, replica, "member"), nodeEv(team, launcher, replica),
    ev(team, launcher, "channel.upsert", { name: channel, members: ["launcher", "replica"], seats: true, requested_by: "replica" })]);
  // Emulate the old strict decoder's verdict, retaining the real signature, cap and storage paths.
  const judge = core as unknown as { verdict: (e: unknown) => { status: string; reason?: string } };
  judge.verdict = () => ({ status: "reject", reason: "seats_channel_protocol_only" });
  const run: SeatRunV2 = { op: "run", v: 2, runtime: "codex", brief: "b".repeat(64), timeout_s: 600, max_concurrent: 3 };
  let last!: ReturnType<typeof ev>;
  for (let i = 0; i < 1001; i++) {
    last = ev(team, launcher, "msg.post", { text: runTextV2(run, replica.hostname), seat: run } as never, { channel });
    core.ingest(last, "remote");
  }
  expect(core.store.getRow(last.id)).toMatchObject({ redacted: 1, status: "junk", reason: "hidden_cap" });
  core.store.setMeta("validity_version", "10");
  core = reopen(core, replica);
  await settle(core);
  expect(core.fillableStubIds(100, launcher.keys.nodeId)).toContain(last.id);
  expect(core.ingest({ ...last, sig: "0".repeat(128) }, "remote").status).toBe("rejected");
  expect(statusOf(core, last.id)).toBe("junk");
  expect(core.ingest(last, "remote").status).toBe("accepted");
  expect(statusOf(core, last.id)).toBe("ok");
});
