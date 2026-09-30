import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { Schedules } from "../../src/daemon/orchestrator/schedules.ts";
import { PeerCallError, type PeerClient } from "../../src/daemon/peer-client.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });
const skew = () => new PeerCallError(403, "clock_skew", "schedule request clock offset -180000 ms exceeds 120000 ms");

function peers() {
  const a = tnode("alex"), k = tnode("mira");
  const { team, create } = createTeam(a);
  const wall = { value: now() };
  setSystemTime(new Date(wall.value));
  const A = makeCore(a, team, cleanups, { clock: () => wall.value });
  A.ingest(create, "local");
  A.emit("team.member", { login: k.login, handle: k.handle, role: "owner" });
  A.emit("team.node", { node_id: k.keys.nodeId, login: k.login, hostname: k.hostname,
    pubkey: k.keys.pubkey, ip: "127.0.0.1" });
  A.emit("channel.upsert", { name: "general" });
  A.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex", "mira"] });
  const K = makeCore(k, team, cleanups, { clock: () => wall.value });
  feed(K, A.store.queryEvents({ limit: 100 }).map((row) => JSON.parse(row.json)).sort((x, y) => x.seq - y.seq));
  return { A, K, wall };
}

test("claim preserves the authority clock_skew refusal and offset", async () => {
  const { A, K } = peers();
  const authority = new Leadership({ core: A, preferred: () => K.nodeId, lost: () => {} });
  const client = { addrOf: () => ({ ip: "127.0.0.1", port: 9000 }),
    leadLease: async () => authority.grant(K.nodeId), scheduleClaim: async () => { throw skew(); } } as unknown as PeerClient;
  const lead = new Leadership({ core: K, client, preferred: () => K.nodeId, lost: () => {} });
  expect(await lead.acquire()).toBe(true);
  try {
    await expect(lead.claimSchedule(randomUUID(), Date.now(), randomUUID())).rejects.toMatchObject({
      code: "clock_skew", message: expect.stringContaining("-180000 ms"),
    });
  } finally { lead.stop(); }
});

test("claim preserves authoritative refusal codes instead of reporting transport failure", async () => {
  const { A, K } = peers();
  const authority = new Leadership({ core: A, preferred: () => K.nodeId, lost: () => {} });
  let code = "stale_run";
  const client = { addrOf: () => ({ ip: "127.0.0.1", port: 9000 }),
    leadLease: async () => authority.grant(K.nodeId),
    scheduleClaim: async () => { throw new PeerCallError(code === "rate_limited" ? 429 : 409, code, code); } } as unknown as PeerClient;
  const lead = new Leadership({ core: K, client, preferred: () => K.nodeId, lost: () => {} });
  expect(await lead.acquire()).toBe(true);
  try {
    for (code of ["stale_run", "forbidden", "rate_limited", "just_ran"]) {
      await expect(lead.claimSchedule(randomUUID(), Date.now(), randomUUID())).rejects.toMatchObject({ code });
    }
  } finally { lead.stop(); }
});

test("lease clock skew is warned and shown to the owner even without a valid lease", async () => {
  const { K } = peers();
  const warn = spyOn(K.log, "warn");
  const client = { addrOf: () => ({ ip: "127.0.0.1", port: 9000 }),
    leadLease: async () => { throw skew(); } } as unknown as PeerClient;
  const lead = new Leadership({ core: K, client, preferred: () => K.nodeId, lost: () => {} });
  expect(await lead.acquire()).toBe(false);
  const schedules = new Schedules(K, { valid: () => lead.valid, leaseFailure: () => lead.leaseFailure,
    claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} });
  expect(schedules.status()).toBe("this machine's clock is 3 min off the schedule authority; fix the clock");
  expect(warn.mock.calls.some(([name]) => name === "orchestrator_lease_unavailable")).toBe(true);
  lead.stop();
  expect(lead.leaseFailure).toBeNull();
  warn.mockRestore();
});

test("a stopped lease does not retain a late peer failure", async () => {
  const { K } = peers();
  let reject!: (error: unknown) => void;
  const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
  const client = { addrOf: () => ({ ip: "127.0.0.1", port: 9000 }),
    leadLease: () => pending } as unknown as PeerClient;
  const lead = new Leadership({ core: K, client, preferred: () => K.nodeId, lost: () => {} });
  const request = lead.acquire();
  lead.stop();
  reject(skew());
  await request;
  expect(lead.leaseFailure).toBeNull();
});

test("defaults clock skew appears in local owner status", async () => {
  const { K } = peers();
  const client = { addrOf: () => ({ ip: "127.0.0.1", port: 9000 }),
    scheduleDefaults: async () => { throw skew(); } } as unknown as PeerClient;
  const schedules = new Schedules(K, { valid: () => true, epoch: () => 1,
    claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} }, client);
  await schedules.tick();
  expect(schedules.status()).toBe("this machine's clock is 3 min off the schedule authority; fix the clock");
});
