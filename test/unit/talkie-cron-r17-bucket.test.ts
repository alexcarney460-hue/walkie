import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import { Leadership } from "../../src/daemon/orchestrator/leadership.ts";
import { Schedules } from "../../src/daemon/orchestrator/schedules.ts";
import { signSchedulePeer } from "../../src/daemon/orchestrator/schedule-forward.ts";
import { registerHost, type OrchestratorHost } from "../../src/daemon/orchestrator/host.ts";
import { SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { feed, makeCore } from "../helpers/core.ts";
import { createTeam, now, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); setSystemTime(); });

test("keyless signed-route junk cannot spend buckets before a real lead claim", async () => {
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
  const lead = new Leadership({ core: A, preferred: () => k.keys.nodeId, lost: () => {}, now: () => wall.value });
  const schedules = new Schedules(A, { valid: () => true, claim: async () => false,
    turn: () => "", reply: () => null, interrupt: () => {} });
  registerHost(A, { schedules, grantLeadership: (node: string) => lead.grant(node),
    holdsScheduleLease: (node: string, epoch: number) => lead.holds(node, epoch),
    claimSchedule: (node: string, claim: never) => lead.claimFromPeer(node, claim) } as unknown as OrchestratorHost);
  const grant = lead.grant(k.keys.nodeId);
  const schedule = schedules.add({ name: "Job", cron: "*/5 * * * *", task: { prompt: "check" } }, "alex");
  const K = makeCore(k, team, cleanups, { clock: () => wall.value });
  feed(K, A.store.queryEvents({ limit: 100 }).map((row) => JSON.parse(row.json)).sort((x, y) => x.seq - y.seq));
  wall.value = schedule.next_run! + 1_000;
  setSystemTime(new Date(wall.value));
  const api = new PeerApi(A) as unknown as { serveAdmitted: (
    req: Request, url: URL, node: string, member: { handle: string; role: string }) => Promise<Response> };
  const post = async (route: string, body: unknown) => {
    const url = new URL(`http://peer/peer/v1/orchestrator/${route}`);
    try {
      const response = await api.serveAdmitted(new Request(url, { method: "POST", body: JSON.stringify(body) }),
        url, k.keys.nodeId, { handle: "mira", role: "owner" });
      return response.status;
    } catch (err) { return (err as { status?: number }).status; }
  };
  const take = spyOn(A.limiter, "take");
  for (const route of ["schedule-claim", "schedule-manage", "schedule-progress", "schedule-defaults"])
    for (let i = 0; i < 70; i++) expect(await post(route, { garbage: i })).toBe(400);
  expect(take.mock.calls).toHaveLength(0);
  expect(await post("schedule-claim", signSchedulePeer(K, "schedule-claim", {
    schedule: schedule.id, slot: schedule.next_run, run: randomUUID(), epoch: grant.epoch }))).toBe(200);
  take.mockRestore();
});
