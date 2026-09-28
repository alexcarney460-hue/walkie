// PRE5-INT (a) through the daemon: GET /v1/seats `local.helper_version` shows a stale root-owned runner/helper (fake
// paths and a fake `version` run: the real copies need root), and the fix once they are reinstalled.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { DEFAULT_ADMIN } from "../../src/daemon/seats/seat-user.ts";
import { VERSION } from "../../src/daemon/version.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

const RUNNER = "/fake/libexec/walkie/walkie-seat-runner";
const ADMIN = "/fake/libexec/walkie/walkie-seat-admin";
const installed: Record<string, string> = { [RUNNER]: "0.1.0", [ADMIN]: "0.1.0" };
let mtime = 1;
let c: Cluster;
let arvid: TestNode;

beforeAll(async () => {
  c = new Cluster();
  arvid = await c.add({
    name: "arvid", login: "arvid@example.com", hostname: "arvid-mac",
    seats: {
      helperVersion: {
        release: true, pathProblem: () => null, runAsync: async (p: string) => (installed[p] ? `walkie ${installed[p]}\n` : null),
        stat: () => ({ ino: 1, size: 1, mtimeMs: mtime, ctimeMs: mtime }),
      },
    },
  });
}, 60_000);

afterAll(async () => { await c.close(); });

describe("seats view: helper_version", () => {
  test("absent until seat users are configured; stale after an update; current once reinstalled", async () => {
    // (A machine with seat users really set up has the default helper installed: then it is shown already.)
    if (!existsSync(DEFAULT_ADMIN)) expect((await arvid.client("").seats()).local.helper_version).toBeUndefined();
    await arvid.client("").seatsConfig({ allow: false, ephemeral: true, runner: RUNNER, admin: ADMIN });
    // Checked in the background: the view shows it once that check ends.
    const stale = await waitFor(async () => (await arvid.client("").seats()).local.helper_version ?? null, { what: "helper_version" });
    expect(stale?.state).toBe("stale");
    expect(stale?.want).toBe(VERSION);
    expect(stale?.copies.map((x) => [x.path, x.version])).toEqual([[RUNNER, "0.1.0"], [ADMIN, "0.1.0"]]);
    expect(stale?.problem).toStartWith("the seat helper is from an older Walkie");

    installed[RUNNER] = VERSION;
    installed[ADMIN] = VERSION;
    mtime = 2; // walkie seats setup-user --apply
    const cur = await waitFor(async () => { const v = (await arvid.client("").seats()).local.helper_version; return v?.state === "current" ? v : null; }, { what: "current after the reinstall" });
    expect(cur?.state).toBe("current");
    expect(cur?.problem).toBeUndefined();
  });
});
