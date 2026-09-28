import { expect, test } from "bun:test";
import { tailscaleEnv } from "../../src/daemon/identity.ts";

// Under launchd the macOS app-bundle CLI sees no TERM/TERM_PROGRAM/SHLVL, tries to launch the GUI and reports no
// IPv4 (found on the first real install, v0.1.0). TAILSCALE_BE_CLI=1 forces CLI mode.
test("the Tailscale CLI is always spawned in CLI mode, keeping the rest of the environment", () => {
  const env = tailscaleEnv({ HOME: "/Users/x", PATH: "/usr/bin" });
  expect(env.TAILSCALE_BE_CLI).toBe("1");
  expect(env.HOME).toBe("/Users/x");
  expect(tailscaleEnv({}).TAILSCALE_BE_CLI).toBe("1");
});
