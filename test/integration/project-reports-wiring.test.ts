// PROJECT-REPORTS-1 through a real daemon (the in-process Cluster): the CLI switches a project over the daemon's local API
// and `projects show` reads it back, the dashboard's route answers (a fresh project has no report yet), an agent is refused
// the switch, and the host's own Schedules instance (the one main.ts builds) seeds the new duty into a team that already
// has its older ones (unit tests show a Schedules built without the host's option does not).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { WalkieClient, WalkieError } from "../../src/client/index.ts";
import { dashboardRoute } from "../../src/daemon/local-api.ts";
import { hostFor } from "../../src/daemon/orchestrator/host.ts";
import type { ProjectView } from "../../src/protocol/projects/schema.ts";
import type { StatusReportPayload } from "../../src/protocol/projects/status-report-setting.ts";
import { Cluster, type TestNode } from "../helpers/cluster.ts";
import { runAsPerson } from "../helpers/person-cli.ts";

const CLI = join(import.meta.dir, "../../src/cli/main.ts");
async function walkie(node: TestNode, args: string[]) {
  return runAsPerson([process.execPath, CLI, ...args], { PATH: process.env.PATH ?? "", NO_COLOR: "1", WALKIE_HOME: node.home, WALKIE_SOCKET: node.socket });
}

let c: Cluster;
let alex: TestNode;
let web: ProjectView;

const url = (n: TestNode, path: string) => `http://127.0.0.1:${n.d.localPort as number}${path}`;
/** A dashboard SESSION, obtained the way the dashboard gets one (a nonce, then /auth): what its requests carry, not the durable token. */
async function session(n: TestNode): Promise<Record<string, string>> {
  const { nonce } = await n.client().authNonce();
  const res = await fetch(url(n, `/auth?nonce=${nonce}`), { redirect: "manual" });
  const value = /#s=([0-9a-f]{64})$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";
  if (!value) throw new Error("no dashboard session");
  return { "X-Walkie-Session": value, Origin: `http://127.0.0.1:${n.d.localPort as number}`, Accept: "application/json" };
}

beforeAll(async () => {
  c = new Cluster();
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  await alex.client().init("aka", "alex");
  web = (await alex.client().createProject({ name: "Website relaunch" })).project;
}, 60_000);

afterAll(async () => { await c.close(); });

test("the CLI switches a project's hourly status report on and off, and show reads it back", async () => {
  expect((await alex.client().project(web.channel)).project.status_report).toBe("off");
  const on = await walkie(alex, ["projects", "report", web.prefix, "on"]);
  expect([on.code, on.out]).toEqual([0, expect.stringContaining("hourly status report on")]);
  expect((await alex.client().project(web.channel)).project.status_report).toBe("hourly");
  const shown = await walkie(alex, ["projects", "show", web.prefix]);
  expect(shown.out).toContain("status report: hourly");
  const json = await walkie(alex, ["projects", "report", web.prefix, "--json"]);
  expect(JSON.parse(json.out)).toEqual({ project: web.prefix, status_report: "hourly" });
  const off = await walkie(alex, ["projects", "report", web.prefix, "off"]);
  expect(off.out).toContain("hourly status report off");
  expect((await alex.client().project(web.channel)).project.status_report).toBe("off");
}, 60_000);

test("an agent is refused the switch with a plain reason; nothing changes", async () => {
  const agent = new WalkieClient({ socket: alex.socket, agent: "cc-reports", timeoutMs: 15_000 });
  const err = await agent.request("POST", `/v1/projects/${web.channel}`, { status_report: "hourly" }).then(() => null, (e: WalkieError) => e);
  expect(err?.status).toBe(403);
  expect(err?.message).toContain("people only");
  expect((await alex.client().project(web.channel)).project.status_report).toBe("off");
});

test("the dashboard's route answers over the daemon's own API: the setting, and no report yet", async () => {
  await alex.client().request("POST", `/v1/projects/${web.channel}`, { status_report: "hourly" });
  const got = await alex.client().request<StatusReportPayload>("GET", `/v1/projects/${web.channel}/status-report`);
  expect(got).toEqual({ mode: "hourly", report: null });
  const missing = await alex.client().request("GET", "/v1/projects/p-ffffffff/status-report").then(() => null, (e: WalkieError) => e);
  expect(missing?.status).toBe(404);
});

test("the dashboard's session allow-list takes the status report read, and nothing looser", () => {
  expect(dashboardRoute("GET", "/v1/projects/p-12345678/status-report")).toBe(true);
  expect(dashboardRoute("POST", "/v1/projects/p-12345678/status-report")).toBe(false); // it is a read
  expect(dashboardRoute("DELETE", "/v1/projects/p-12345678/status-report")).toBe(false);
  expect(dashboardRoute("GET", "/v1/projects/p-12345678/status-report/extra")).toBe(false);
  expect(dashboardRoute("GET", "/v1/projects/not-a-project/status-report")).toBe(false);
  expect(dashboardRoute("GET", "/v1/projects/p-12345678/export")).toBe(true); // the neighbour it was added beside is unchanged
});

test("a dashboard SESSION, as the browser sends it, sets the switch and reads the latest report (the panel's own request)", async () => {
  const { project } = await alex.client().createProject({ name: "Session page" });
  const h = await session(alex);
  const set = await fetch(url(alex, `/v1/projects/${project.channel}`), {
    method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ status_report: "hourly" }),
  });
  expect(set.status).toBe(200);
  expect(((await set.json()) as { project: ProjectView }).project.status_report).toBe("hourly");
  const read = await fetch(url(alex, `/v1/projects/${project.channel}/status-report`), { headers: h });
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({ mode: "hourly", report: null });
  // The same read without any credential is still refused: the allow-list widens what a session may call, not who may call.
  const anonymous = await fetch(url(alex, `/v1/projects/${project.channel}/status-report`), { headers: { Accept: "application/json" } });
  expect([401, 403]).toContain(anonymous.status);
}, 60_000);

test("the host seeds the status reports duty into a team that already has the older five", async () => {
  const host = hostFor(alex.d.core);
  expect(host).not.toBeNull();
  const schedules = host!.schedules;
  expect(await schedules.ensureChannel()).toBe(true);
  for (const [name, cron, template] of [
    ["Board refresh", "0 * * * *", "board-refresh"], ["Machine onboarding", "*/15 * * * *", "machine-onboarding"], ["Project sync", "0 * * * *", "project-sync"],
    ["Capacity check", "*/15 * * * *", "capacity-check"], ["Data room refresh", "0 9 * * *", "data-room-refresh"],
  ] as const) schedules.add({ name, cron, task: { template } }, "alex");
  expect(schedules.list().map((s) => s.name)).not.toContain("Project status reports");
  await schedules.defaultsForAuthority();
  const added = schedules.list().find((s) => s.name === "Project status reports");
  expect(added).toMatchObject({ cron: "7 * * * *", task: { template: "project-reports" }, enabled: true });
  // The later defaults come together: this one, the orchestration poll and the card curation.
  expect(schedules.list()).toHaveLength(8);
  // Once only.
  await schedules.defaultsForAuthority();
  expect(schedules.list()).toHaveLength(8);
});
