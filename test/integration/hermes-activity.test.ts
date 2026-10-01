// Hermes privacy by default over real daemons: a hook's status reaches a teammate with its state only, unless the machine's config.json
// lists the profile in `hermes_activity_profiles`. The daemon's discovery, wired the way main.ts wires it, follows the same list, and a
// change of the file applies without a restart.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXITED_ACTIVITY } from "../../src/daemon/discovery.ts";
import type { ProcessProvider, ProcRow } from "../../src/daemon/procs.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const UID = 4242;
const hex = (name: string) => createHash("sha256").update(name).digest("hex");

class Procs implements ProcessProvider {
  constructor(public procs: ProcRow[]) {}
  async list(): Promise<ProcRow[]> { return this.procs; }
  async envVars(pids: readonly number[]) { return new Map(pids.map((p) => [p, {}])); }
  async cwd(): Promise<string | undefined> { return undefined; }
  async openFiles(): Promise<string[]> { return []; }
  async claudeSession() { return undefined; }
}

const c = new Cluster();
afterAll(async () => { await c.close(); });

const INIT: ProcRow = { pid: 1, ppid: 0, uid: 0, startedAt: 1, command: "/sbin/init" };
const hermes = (pid: number, profile: string): ProcRow => ({ pid, ppid: 1, uid: UID, startedAt: Date.now() - 60_000, command: `hermes --profile ${profile} chat` });

/** Replaces the node's config.json by a new file, so its daemon sees the change. */
function setConfig(node: TestNode, patch: Record<string, unknown>): void {
  const file = join(node.home, "config.json");
  writeFileSync(`${file}.tmp`, JSON.stringify({ ...(JSON.parse(readFileSync(file, "utf8")) as object), ...patch }, null, 2));
  renameSync(`${file}.tmp`, file);
}

test("a listed profile shows its activity to a teammate and no other does; discovery follows the list, and a change applies at once", async () => {
  const procs = new Procs([INIT]);
  const alex = await c.add({ name: "hermes-alex", login: "hermes-alex@example.com", discovery: { provider: procs, uid: UID, intervalMs: 50 } });
  const kira = await c.add({ name: "hermes-kira", login: "hermes-kira@example.com" });
  setConfig(alex, { share_activity: true, hermes_activity_profiles: ["research"] });
  await alex.client().init("acme", "alex");
  await alex.client().invite("hermes-kira@example.com", "kira", "member");
  expect((await kira.client().join(alex.peerAddr)).admitted).toBe(true);

  const seen = async (agent: string) => (await kira.client().agents()).agents.find((a) => a.agent === agent);
  let sequence = 0;
  const hook = (profile: string, session: string) => alex.client(`hermes-${profile}`).hermesStatus({ profile, session: hex(session), at: Date.now(),
    sequence: ++sequence, state: "idle", fallback: "idle", activity: "Finished turn", source: "phrase" });
  const activityEvents = (agent: string) => alex.d.core.store.db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM events WHERE kind = 'agent.status' AND author_agent = ? AND json_extract(body, '$.activity') IS NOT NULL").get(agent)!.n;

  // The same hook, the same line, two profiles: the listed one shows it, the other shows its state only.
  await hook("research", "r");
  await hook("example-billing", "b");
  const research = await waitFor(async () => { const a = await seen("hermes-research"); return a?.status.activity ? a : undefined; }, { what: "the listed profile's line on kira" });
  expect(research.status).toMatchObject({ state: "idle", runtime: "other", runtime_name: "hermes", activity: "Finished turn" });
  const billing = await waitFor(() => seen("hermes-example-billing"), { what: "the unlisted profile on kira" });
  expect(billing.status).toMatchObject({ state: "idle", runtime_name: "hermes" });
  expect(billing.status).not.toHaveProperty("activity");

  // Their processes run and then exit: discovery posts the listed profile's exit with its line, the other profile's with state only.
  procs.procs = [INIT, hermes(700, "research"), hermes(701, "example-billing")];
  await Bun.sleep(150); // a few scans with both processes running
  procs.procs = [INIT];
  await waitFor(async () => (await seen("hermes-research"))?.status.state === "offline", { what: "the listed profile offline on kira" });
  await waitFor(async () => (await seen("hermes-example-billing"))?.status.state === "offline", { what: "the unlisted profile offline on kira" });
  expect((await seen("hermes-research"))?.status.activity).toBe(EXITED_ACTIVITY);
  expect((await seen("hermes-example-billing"))?.status).not.toHaveProperty("activity");
  expect(activityEvents("hermes-example-billing")).toBe(0); // no status of it ever carried a line

  // The person takes the profile off the list: no restart, and its card loses the line within a scan.
  setConfig(alex, { hermes_activity_profiles: [] });
  await waitFor(async () => { const a = await seen("hermes-research"); return a && a.status.activity === undefined ? a : undefined; }, { what: "the line gone from the unlisted card on kira" });
  expect((await seen("hermes-research"))?.status).toMatchObject({ state: "offline", runtime_name: "hermes" });
  // and a damaged file is read as no list at all
  setConfig(alex, { hermes_activity_profiles: ["research", "Not A Profile"] });
  await hook("research", "r2");
  await Bun.sleep(150);
  expect((await seen("hermes-research"))?.status).not.toHaveProperty("activity");
}, 60_000);
