// LOCAL-MODELS-HF-1 integration finding: the dashboard reads the model list with `GET /v1/pool/models` and asks again with
// `POST /v1/pool/models/refresh` (web/src/api/pool.ts), but a dashboard SESSION may only call the routes in
// DASHBOARD_ROUTES (local-api.ts), so the daemon answered both with 403 "not available to a dashboard session" and the
// dashboard stayed on the built-in list. Nothing else may widen with them.
import { expect, test } from "bun:test";
import { dashboardRoute } from "../../src/daemon/local-api.ts";

test("a dashboard session can read the model list and ask for a refresh", () => {
  expect(dashboardRoute("GET", "/v1/pool/models")).toBe(true);
  expect(dashboardRoute("POST", "/v1/pool/models/refresh")).toBe(true);
});

test("and nothing next to those routes opens with them", () => {
  expect(dashboardRoute("POST", "/v1/pool/models")).toBe(false);
  expect(dashboardRoute("GET", "/v1/pool/models/refresh")).toBe(false);
  expect(dashboardRoute("DELETE", "/v1/pool/models")).toBe(false);
  expect(dashboardRoute("GET", "/v1/pool/models/other")).toBe(false);
  expect(dashboardRoute("POST", "/v1/pool/models/refresh/x")).toBe(false);
  expect(dashboardRoute("GET", "/v1/pool/modelsx")).toBe(false);
  // The split-run and serve routes keep the person-only list they already had.
  expect(dashboardRoute("POST", "/v1/pool/run")).toBe(true);
  expect(dashboardRoute("POST", "/v1/pool/prepare")).toBe(false);
});
