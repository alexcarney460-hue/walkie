// E21b (WALK-200): the Billing panel promises no unlimited machines. Paid plans and the trial set no machine limit of
// their own, but the node limits still cap machines per login (16, or 256 through a fleet link).
import { expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { BillingPanel } from "../src/views/Billing.tsx";
import { planView, seedPlan } from "../mock/plan.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.UTC(2026, 8, 25, 12);

function rowText(mode: Parameters<typeof seedPlan>[0], machines: number): string {
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<BillingPanel plan={planView(seedPlan(mode, NOW), { people: 2, machines }, NOW)} owner={false} />); });
  const dt = tree.root.findAll((n) => n.type === "dt" && n.children.join("") === "Machines")[0];
  const text = dt?.parent ? dt.parent.findByType("dd").findByType("span").children.join("") : "";
  tree.unmount();
  return text;
}

test("paid plans and the trial show machines with no plan limit, never unlimited", () => {
  for (const mode of ["team", "business", "trial"] as const) {
    expect(rowText(mode, 9)).toBe("9 machines · no plan limit");
  }
  expect(rowText("free", 3)).toBe("3/4 machines");
});
