// pre.9 hotfix: a running WalkieTalkie re-announces its status, so an idle card never ages past STALE_STATUS_MS (the
// WalkieTalkie page showed "WalkieTalkie is starting" for a running, idle WalkieTalkie once its card went stale).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const FAKE_DIR = join(import.meta.dir, "..", "fixtures", "fake-claude");

describe("WalkieTalkie status heartbeat", () => {
  let c: Cluster;
  let solo: TestNode;
  beforeAll(async () => {
    const root = mkdtempSync(join(tmpdir(), "orch-hb-"));
    const state = join(root, "fake-state");
    mkdirSync(state, { recursive: true });
    c = new Cluster();
    solo = await c.add({
      name: "solo", login: "solo@example.com", hostname: "solo-mbp",
      orchestrator: {
        restartBaseMs: 50, restartMaxMs: 200, statusThrottleMs: 20, heartbeatMs: 300, auto: true, autoCheckMs: 100,
        logins: async () => ({ found: ["claude"], claude: "cli" }),
        env: { ...process.env, PATH: `${FAKE_DIR}:${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOG: join(root, "launches.jsonl") },
      },
    });
    await solo.client().init("acme", "solo");
  }, 60_000);
  afterAll(async () => { await c.close(); });

  const card = async () => (await solo.client().agents({ scope: "all" })).agents.find((a) => a.agent === "orchestrator" && a.node === solo.daemon!.nodeId);

  test("an idle running WalkieTalkie keeps refreshing its card; it stops once WalkieTalkie stops", async () => {
    await waitFor(async () => (await solo.client("").orchestrator()).local.running === true, { what: "running" });
    await waitFor(async () => (await card())?.status.state === "idle", { what: "idle card" });
    const first = (await card())!.updated_at;
    await waitFor(async () => ((await card())?.updated_at ?? 0) > first, { what: "heartbeat re-announce", timeoutMs: 5_000 });
    expect((await card())!.effective_state).toBe("idle");
  }, 30_000);
});
