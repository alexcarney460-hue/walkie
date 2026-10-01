import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalLagBanner } from "../src/views/mission/LocalLagBanner.tsx";

test("Mission Control names recent local lag without changing machine state", () => {
  const lag = { max_ms: 20_000, at: 10_000 };
  const recent = renderToStaticMarkup(<LocalLagBanner lag={lag} now={20_000} />);
  expect(recent).toContain("Walkie on this machine is lagging (stalled 20 s); machine states may be stale");
  expect(recent).toContain('role="status"');
  expect(renderToStaticMarkup(<LocalLagBanner lag={{ max_ms: 2_000, at: 10_000 }} now={20_000} />)).toBe("");
  expect(renderToStaticMarkup(<LocalLagBanner lag={lag} now={70_000} />)).toBe("");
});
