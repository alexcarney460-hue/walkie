// E21b (WALK-200): a board limit shows no Upgrade or Add seats link (extra boards aren't on sale and an upgrade adds no
// board), even when an older daemon still sends the add-on checkout link; other limits keep their link.
import { expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PlanLimitDetails } from "../src/api/types.ts";
import { PlanLimitNotice } from "../src/components/PlanLimitNotice.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(details: PlanLimitDetails): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => { tree = create(<PlanLimitNotice details={details} />); });
  return tree;
}

const text = (tree: ReactTestRenderer) => tree.root.findByType("p").children.join("");

test("a board limit has no link and no billing-portal line", () => {
  for (const subscribed of [false, true]) {
    for (const upgrade_url of ["", "https://sqwakie.si/api/checkout?addon=board&quantity=1"]) {
      const tree = render({ resource: "boards", limit: 3, used: 3, plan: "team", subscribed, upgrade_url });
      expect(tree.root.findAllByType("a")).toHaveLength(0);
      expect(text(tree)).toBe("Each project includes 3 boards (this one has 3). Extra boards aren't on sale.");
      tree.unmount();
    }
  }
});

test("a people limit keeps its Upgrade link", () => {
  const tree = render({ resource: "people", limit: 2, used: 2, plan: "free", upgrade_url: "https://sqwakie.si/api/checkout?plan=team&interval=month&seats=3" });
  const links = tree.root.findAllByType("a");
  expect(links).toHaveLength(1);
  expect(links[0]!.props.href).toBe("https://sqwakie.si/api/checkout?plan=team&interval=month&seats=3");
  tree.unmount();
});
