// Bug fix: `walkie admin --machine X seats allow --dir '~/walkie-seats'` used to store the literal string
// "/~/walkie-seats" and answer "internal error" although the change had already applied. Covers: a leading "~"
// resolves against the TARGET's own daemon user (never the caller's, never the spawned admin run's own cwd, which
// isn't meaningful); a relative --dir is refused remotely with a clear message rather than silently mis-resolved; a
// --dir that can't be made refuses cleanly with nothing changed (never a bare "internal error" after a partial
// apply); and a later remote `seats allow` that only touches one field keeps launchers/runtimes/dir/same_user as
// they were, rather than resetting them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WalkieError } from "../../src/client/index.ts";
import { seatsFor } from "../../src/daemon/seats/host.ts";
import { Cluster, waitFor, type TestNode } from "../helpers/cluster.ts";

let c: Cluster;
let alex: TestNode;
let kira: TestNode;
let kiraHome: string;

beforeAll(async () => {
  c = new Cluster();
  kiraHome = join(c.root, "kira-seats-home");
  mkdirSync(kiraHome, { recursive: true });
  alex = await c.add({ name: "alex", login: "alex@example.com", hostname: "alex-mbp" });
  kira = await c.add({ name: "kira", login: "kira@example.com", hostname: "kiras-mac", seats: { env: { HOME: kiraHome } } });
  await alex.client().init("aka", "alex");
  await alex.client().invite("kira@example.com", "kira", "member");
  expect((await kira.client().join(alex.peerAddr)).admitted).toBe(true);
  await waitFor(() => alex.d.core.roster.nodes.size === 2 && kira.d.core.roster.nodes.size === 2, { what: "roster sync" });
});
afterAll(async () => { await c.close(); });

const run = (argv: string[]) => alex.client().adminRun({ machines: "kiras-mac", argv });
const refused = async (p: Promise<unknown>): Promise<WalkieError> => {
  try { await p; } catch (e) { return e as WalkieError; }
  throw new Error("expected a refusal");
};
const settings = () => seatsFor(kira.d.core)?.settings;

describe("remote admin: seats allow --dir", () => {
  test("a leading ~ resolves against the target's own daemon user, and is stored literally (never a caller-side resolve)", async () => {
    const r = await run(["seats", "allow", "--dir", "~/remote-seats", "--same-user", "--launchers", "@alex", "--runtimes", "codex"]);
    expect(r.results[0]?.error).toBeUndefined();
    expect(r.results[0]?.exit).toBe(0);
    expect(settings()?.dir).toBe("~/remote-seats"); // never "/~/remote-seats"
    expect(existsSync(join(kiraHome, "remote-seats"))).toBe(true); // made against the TARGET's home
  });

  test("a relative --dir is refused remotely with a clear message (the spawned admin run's own cwd isn't meaningful)", async () => {
    const before = settings();
    const err = await refused(run(["seats", "allow", "--dir", "some/relative/dir"]));
    expect(err.code).toBe("not_allowed_remotely");
    expect(err.message).toContain("absolute path or start with ~/");
    expect(settings()).toEqual(before); // refused before it ever ran: nothing changed
  });

  test("a later remote allow that only changes --max keeps launchers, runtimes and dir (never silently resets them)", async () => {
    expect(settings()).toMatchObject({ launchers: ["@alex"], runtimes: ["codex"], dir: "~/remote-seats" });
    const r = await run(["seats", "allow", "--max", "5"]); // no --same-user, --launchers, --runtimes or --dir at all
    expect(r.results[0]?.error).toBeUndefined();
    expect(r.results[0]?.exit).toBe(0);
    expect(settings()).toMatchObject({ max: 5, launchers: ["@alex"], runtimes: ["codex"], dir: "~/remote-seats", same_user: true });
  });

  test("a --dir that can't be made refuses cleanly with nothing changed (never a bare \"internal error\" after a partial apply)", async () => {
    const before = settings();
    const blocker = join(kiraHome, "blocked-file");
    writeFileSync(blocker, "x");
    try {
      const r = await run(["seats", "allow", "--dir", "~/blocked-file"]);
      expect(r.results[0]?.error).toBeUndefined(); // the run itself wasn't refused; the command it ran failed
      expect(r.results[0]?.exit).not.toBe(0);
      expect(r.results[0]?.stderr).toContain("seats directory couldn't be made");
      expect(r.results[0]?.stderr?.trim()).not.toBe("internal error");
      expect(settings()).toEqual(before); // config.json still says the previous (working) directory: no partial apply
    } finally {
      rmSync(blocker, { force: true });
    }
  });
});
