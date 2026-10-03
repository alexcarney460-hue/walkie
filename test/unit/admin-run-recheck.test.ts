// WALK-74 (ASYNC-PERMS-1) for remote admin: a remote command runs for up to 30 minutes, and its caller was judged again
// only every 30 s. Each admin step the command takes (an agent-marked request carrying the run's token) now asks first:
// a caller removed, demoted, whose machine was revoked, or whose remote admin was switched off since the run began is
// refused, audited as refused. The control: a caller still allowed passes.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { admit } from "../../src/daemon/admin/gate.ts";
import { beginRun } from "../../src/daemon/admin/runs.ts";
import { makeCore } from "../helpers/core.ts";
import { createTeam, tnode } from "../helpers/events.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()?.(); });

function remoteStep() {
  const a = tnode("alex"), { team } = createTeam(a);
  const core = makeCore(a, team, cleanup);
  let allowed = true;
  const run = beginRun(core, { actor: "@kira/kiras-mbp/cc-1", notify: "alex", callerNode: "k".repeat(16), callerHandle: "kira", authorized: () => allowed });
  cleanup.push(run.end);
  const ctx = { core, agent: "remote-admin", underAgent: false,
    req: new Request("http://walkie/v1/seats/config", { method: "POST", headers: { "x-walkie-admin-token": run.token } }) };
  return { core, ctx, revoke: () => { allowed = false; } };
}

test("control: a remote caller still allowed passes the admin step", () => {
  const { ctx } = remoteStep();
  expect(() => admit(ctx as never, "enabled seats")).not.toThrow();
});

test("a remote caller no longer allowed mid-run: the next admin step is refused and audited as refused", () => {
  const { core, ctx, revoke } = remoteStep();
  revoke();
  expect(() => admit(ctx as never, "enabled seats")).toThrow("the remote caller @kira/kiras-mbp/cc-1 may no longer administer alex-mbp");
  const audit = readFileSync(join(core.paths.home, "admin-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(audit.at(-1)).toMatchObject({ actor: "@kira/kiras-mbp/cc-1", action: "enabled seats", via: "remote", refused: "not_your_machine" });
});
