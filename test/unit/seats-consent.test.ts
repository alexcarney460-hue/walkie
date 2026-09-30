import { expect, test } from "bun:test";
import { enableConsentLine, launcherSummary } from "../../src/cli/commands/seats-enable.ts";
import { launcherPolicyLabel } from "../../src/protocol/seats.ts";

test("seat consent names the owners, listed launchers and their agents", () => {
  expect(enableConsentLine()).toContain("owners and every agent they run");
  expect(enableConsentLine()).toContain("listed person launchers and every agent they run");
  expect(enableConsentLine()).toContain("Exact agent entries");
});

test("empty and all-invalid launcher policies display nobody", () => {
  expect(launcherPolicyLabel({ launchers: [], launchers_default: true })).toBe("the team's owners and their agents");
  expect(launcherPolicyLabel({})).toBe("the team's owners and their agents");
  expect(launcherPolicyLabel({ launchers: [], launchers_default: false, launcher_policy_empty: true })).toBe("nobody");
  expect(launcherPolicyLabel({ launchers: ["invalid"], launchers_default: false, launcher_policy_empty: true })).toBe("nobody");
});

test("seat enable summary describes each entry's actual coverage", () => {
  expect(launcherSummary(["@alex", "@alex/mac", "@alex/mac/planner"])).toBe(
    "@alex and every agent they run, @alex/mac and every agent they run on that machine, @alex/mac/planner only",
  );
});
