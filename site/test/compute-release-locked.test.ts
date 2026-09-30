import { expect, test } from "bun:test";
import { GET as quotes } from "../api/compute/quotes.ts";
import { POST as account } from "../api/compute/account.ts";
import { GET as state } from "../api/compute/state.ts";
import { POST as credit } from "../api/compute/credit.ts";
import { POST as rent } from "../api/compute/rent.ts";
import { POST as start } from "../api/compute/start.ts";
import { POST as stop } from "../api/compute/stop.ts";
import { GET as tick } from "../api/compute/tick.ts";
import { POST as heartbeat } from "../api/compute/heartbeat.ts";
import { POST as handover } from "../api/compute/handover.ts";
import { POST as lease } from "../api/compute/lease.ts";
import { POST as webhook } from "../api/compute/webhook.ts";
import { POST as watchdog } from "../api/compute/watchdog-heartbeat.ts";
import { computeConfigurationError, computeReleaseGate, COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION } from "../api/_lib/compute/release-gate.ts";

test("every published compute endpoint is locked in this release", async () => {
  expect(COMPUTE_LIVE_AVAILABLE_IN_THIS_VERSION).toBe(false);
  for (const [name, handler] of Object.entries({ quotes, account, state, credit, rent, start, stop, tick,
    heartbeat, handover, lease, webhook, watchdog })) {
    const response = await handler(new Request(`http://127.0.0.1/api/compute/${name}`));
    expect(response.status).toBe(503);
    expect((await response.json() as { error: string }).error).toBe("compute_unavailable_in_this_version");
  }
});

test("a live flag produces a configuration refusal while license bind keeps its unflagged path", async () => {
  const flagged = computeReleaseGate({ COMPUTE_ENABLED: "1" });
  expect(flagged?.status).toBe(503);
  expect(await flagged?.json()).toEqual({ error: "compute_unavailable_in_this_version",
    message: "COMPUTE_ENABLED=1 is refused in this version; remove it from the deployment configuration" });
  expect(computeConfigurationError({ COMPUTE_PRIVATE_CONFIG: "fixture" })).toBeNull();
});
