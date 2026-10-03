// WALK-77 Phase 0: a decision-needed card is evidence and uncertainty, not the agent's preference.
import { expect, test } from "bun:test";
import { playbook } from "../../src/daemon/orchestrator/playbook.ts";

const LINE = "- When a card is labelled decision-needed, present the evidence and what is still uncertain. Do not state a preference. A person decides.";

test("the playbook tells WalkieTalkie not to prefer an outcome on a decision-needed card", () => {
  for (const access of ["platform", "full"] as const) {
    const p = playbook({ owner: "alex", hostname: "alex-mac", access });
    const lines = p.split("\n");
    expect(lines.filter((l) => l.includes("decision-needed"))).toEqual([LINE]);
    expect(p).toContain("## Decisions a person has to make");
    expect(lines.length).toBeLessThanOrEqual(60);
  }
});
