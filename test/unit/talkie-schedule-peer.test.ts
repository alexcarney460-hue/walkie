import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Schedules, readSchedules } from "../../src/daemon/orchestrator/schedules.ts";
import { PeerApi } from "../../src/daemon/peer-api.ts";
import { MAX_SCHEDULES, SCHEDULE_CHANNEL } from "../../src/protocol/talkie-schedule.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, tnode } from "../helpers/events.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const idle = { valid: () => true, claim: async () => false, turn: () => "", reply: () => null, interrupt: () => {} };
function authority() {
  const a = tnode("alex");
  const { team, create } = createTeam(a);
  const core = makeCore(a, team, cleanups);
  core.ingest(create, "local");
  core.emit("channel.upsert", { name: "general" });
  core.emit("channel.upsert", { name: SCHEDULE_CHANNEL, members: ["alex"] });
  return { core, schedules: new Schedules(core, idle) };
}

test("authority enforces the cap before writing and keeps the audit post with a successful change", () => {
  const { core, schedules } = authority();
  const request = (n: number) => ({ op: "add" as const, handle: "alex", machine: core.hostname,
    audit_id: randomUUID(), input: { name: `Job ${n}`, cron: "*/5 * * * *", task: { prompt: "check" } } });
  for (let n = 0; n < MAX_SCHEDULES; n++) expect(schedules.manage(request(n)).schedule?.name).toBe(`Job ${n}`);
  const before = core.store.channelEventCount("general");
  expect(() => schedules.manage(request(MAX_SCHEDULES))).toThrow(`at most ${MAX_SCHEDULES}`);
  expect(core.store.channelEventCount("general")).toBe(before);
  expect(readSchedules(core)).toHaveLength(MAX_SCHEDULES);
});

test("an edit of a removed schedule returns 404 and cannot reuse its id", () => {
  const { schedules } = authority();
  const actor = { handle: "alex", machine: "laptop", audit_id: randomUUID() };
  const added = schedules.manage({ op: "add", ...actor,
    input: { name: "Job", cron: "*/5 * * * *", task: { prompt: "check" } } }).schedule!;
  expect(schedules.manage({ op: "remove", id: added.id, ...actor }).removed).toBe(true);
  expect(() => schedules.manage({ op: "edit", id: added.id, input: { enabled: true }, ...actor }))
    .toThrow("no such schedule");
});

test("a managed reset writes one audit post in the durable decision", () => {
  const { core, schedules } = authority();
  const actor = { handle: "alex", machine: core.hostname, audit_id: randomUUID() };
  const added = schedules.manage({ op: "add", ...actor,
    input: { name: "Job", cron: "*/5 * * * *", task: { prompt: "check" } } }).schedule!;
  const before = core.store.channelEventCount("general");
  expect(schedules.manage({ op: "reset", id: added.id, ...actor }).schedule?.id).toBe(added.id);
  expect(core.store.channelEventCount("general")).toBe(before + 1);
});

test("a member's forwarded management request is refused before its body is read", async () => {
  const { core } = authority();
  const api = new PeerApi(core) as unknown as { serveAdmitted: (
    req: Request, url: URL, node: string, member: { handle: string; role: string }) => Promise<Response> };
  const url = new URL("http://peer/peer/v1/orchestrator/schedule-manage");
  const req = new Request(url, { method: "POST", body: "not-json" });
  await expect(api.serveAdmitted(req, url, "member-node", { handle: "mira", role: "member" }))
    .rejects.toMatchObject({ status: 403, code: "forbidden" });
});
