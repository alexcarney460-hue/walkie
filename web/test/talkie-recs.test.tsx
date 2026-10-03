import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { api, ApiError } from "../src/api/client.ts";
import { RecommendationItems, RecommendationsPanel } from "../src/views/orchestrator/Recommendations.tsx";
import { MockRecommendations, recommendationFixtures } from "../mock/recommendations.ts";
import type { Recommendation } from "../src/api/types.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const render = (recs: Recommendation[], rows = {}) => renderToStaticMarkup(
  <RecommendationItems recs={recs} rows={rows} onAnswer={() => { throw new Error("Action during render"); }} onRefresh={() => {}} />,
);

describe("recommendation panel", () => {
  test("loading and empty states never perform actions", () => {
    expect(renderToStaticMarkup(<RecommendationsPanel />)).toContain("Loading recommendations");
    expect(render([])).toContain("No recommendations right now");
  });
  test("groups plain-language suggestions and keeps evidence closed", () => {
    const html = render(recommendationFixtures());
    for (const label of ["Work to start", "Cards to move", "Reviews waiting", "Stalled", "Machines to set up"]) expect(html).toContain(label);
    expect(html.match(/<details>/g)?.length).toBe(5);
    expect(html).not.toContain("<details open");
    expect(html).toContain("Fictional fixture");
  });
  test("uses each capability independently and shows the server reason", () => {
    const rec = recommendationFixtures()[0]!;
    const html = render([{ ...rec, can_approve: false, can_dismiss: true, why_not: "Approval is unavailable here" }]);
    expect(html).toMatch(/disabled="">Approve/);
    expect(html).not.toMatch(/disabled="">Dismiss/);
    expect(html).toContain("Approval is unavailable here");
    expect(render([{ ...rec, can_approve: true, can_dismiss: false }])).toMatch(/disabled="">Dismiss/);
  });
  test("an ask shows word for word what approving sends as you, and what WalkieTalkie wrote quoted as not sent", () => {
    const [, , review, stalled] = recommendationFixtures();
    const html = render([review!, stalled!]);
    expect(html.match(/Approving does this in your name/g)?.length).toBe(2);
    expect(html).toContain("Please take the review of card DEMO-3.");
    expect(html).toContain("WalkieTalkie wrote this (it is not sent)");
    expect(html).toContain("the import task");
    expect(render([{ ...stalled!, outgoing: null }])).toContain("Its card is gone, so approving it will be refused.");
    // Once answered there is nothing left to send.
    expect(render([{ ...review!, status: "approved", can_approve: false, can_dismiss: false }])).not.toContain("Approving does this in your name");
    expect(render([recommendationFixtures()[0]!])).not.toContain("Approving does this in your name");
  });
  test("open recommendations past the server's cap are counted, not dropped silently", () => {
    const html = renderToStaticMarkup(<RecommendationItems recs={recommendationFixtures()} more={3} onAnswer={() => {}} onRefresh={() => {}} />);
    expect(html).toContain("3 more open recommendations are not shown");
    expect(render(recommendationFixtures())).not.toContain("more open recommendation");
  });
  test("busy and failed rows disable both actions; failure offers a read-only retry", () => {
    const rec = recommendationFixtures()[0]!;
    const busy = render([rec], { [rec.id]: { pending: "approve" } });
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain("Approving…");
    expect(busy.match(/disabled=""/g)?.length).toBe(2);
    const failed = render([rec], { [rec.id]: { error: "This recommendation has expired" } });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Refresh before trying again");
    expect(failed.match(/disabled=""/g)?.length).toBe(2);
  });
  test("resolved and expired records have no approve or dismiss buttons", () => {
    for (const status of ["approved", "dismissed", "expired", "superseded"] as const) {
      const html = render([{ ...recommendationFixtures()[0]!, status }]);
      expect(html).not.toContain("<button");
      expect(html).toContain('role="status"');
    }
  });
  test("a failed row cannot offer refresh while another row is still pending", () => {
    const recs = recommendationFixtures();
    const html = render(recs, { [recs[0]!.id]: { error: "The card changed" }, [recs[1]!.id]: { pending: "dismiss" } });
    expect(html).toMatch(/disabled="">Refresh before trying again/);
    // The third, unrelated row can still be answered.
    expect(html.match(/disabled="">Approve/g)?.length).toBe(2);
    expect(html.match(/disabled="">Dismiss/g)?.length).toBe(2);
  });
});

describe("browser recommendation client with synthetic routes", () => {
  test("refresh is GET only; a deliberate action posts once using the encoded full id", async () => {
    const mock = new MockRecommendations();
    const calls: { path: string; method: string }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      calls.push({ path, method: init?.method ?? "GET" });
      return (await mock.handle(new Request(`http://fixture.test${path}`, init), true, 1))!;
    }) as unknown as typeof fetch;
    const first = await api.recommendations();
    await api.recommendations();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    const result = await api.answerRecommendation(first.recs[0]!.id, "approve");
    expect(result.rec.status).toBe("approved");
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ path: "/v1/talkie/recs/0000000000000001%3A1/approve", method: "POST" }]);
    // Open ones are listed first, so the answered one is found by its id.
    expect((await api.recommendations()).recs.find((r) => r.id === first.recs[0]!.id)!.can_approve).toBe(false);
    await expect(api.answerRecommendation(first.recs[0]!.id, "dismiss")).rejects.toBeInstanceOf(ApiError);
  });
  test("approving one that does something in the person's name echoes the text shown; the mock refuses it otherwise", async () => {
    const mock = new MockRecommendations();
    const bodies: unknown[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
      return (await mock.handle(new Request(`http://fixture.test${String(input)}`, init), true, 1))!;
    }) as unknown as typeof fetch;
    const review = (await api.recommendations()).recs.find((r) => r.group === "reviews")!;
    await expect(api.answerRecommendation(review.id, "approve")).rejects.toMatchObject({ code: "rec_changed" });
    await expect(api.answerRecommendation(review.id, "approve", "something else")).rejects.toMatchObject({ code: "rec_changed" });
    expect((await api.answerRecommendation(review.id, "approve", review.outgoing as string)).rec.status).toBe("approved");
    expect(bodies.slice(1)).toEqual([{}, { seen: "something else" }, { seen: review.outgoing }]);
  });
  test("denied and conflict responses are surfaced once without automatic replay", async () => {
    for (const [status, code, message] of [[403, "forbidden", "Permission denied"], [409, "rec_not_pending", "This recommendation has expired"], [409, "conflict", "The card changed"]] as const) {
      let calls = 0;
      globalThis.fetch = (async () => { calls++; return Response.json({ error: { code, message } }, { status }); }) as unknown as typeof fetch;
      try { await api.answerRecommendation("0000000000000001:1", "approve"); throw new Error("Expected rejection"); }
      catch (err) { expect(err).toBeInstanceOf(ApiError); expect((err as ApiError).message).toBe(message); }
      expect(calls).toBe(1);
    }
  });
  test("mock denies unprivileged and agent writes", async () => {
    const mock = new MockRecommendations();
    const request = () => new Request("http://fixture.test/v1/talkie/recs/00000001/approve", { method: "POST" });
    expect((await mock.handle(request(), false))?.status).toBe(403);
    const agent = request(); agent.headers.set("x-walkie-agent", "fixture");
    expect((await mock.handle(agent, true))?.status).toBe(403);
    const list = await mock.handle(new Request("http://fixture.test/v1/talkie/recs"), false);
    const payload = await list!.json();
    expect(payload.recs.every((r: Recommendation) => !r.can_approve && !r.can_dismiss && r.why_not)).toBe(true);
  });
});


// Opt in after building web/dist. The caller supplies an installed Playwright module,
// a loopback mock URL and an external evidence directory; no downloads or real daemon.
const browserEnabled = process.env.WALKIE_RECS_BROWSER === "1";
describe.skipIf(!browserEnabled)("mounted recommendation interactions", () => {
  // Playwright is provisioned by the fixture runner, not a dashboard dependency.
  let browser: any;
  const base = process.env.WALKIE_RECS_BROWSER_URL ?? "";
  const evidence = process.env.WALKIE_RECS_EVIDENCE ?? "";
  beforeAll(async () => {
    const modulePath = process.env.WALKIE_PLAYWRIGHT_MODULE;
    if (!modulePath || !evidence || new URL(base).hostname !== "127.0.0.1") throw new Error("Supply isolated loopback browser fixture inputs");
    const { chromium } = await import(modulePath);
    browser = await chromium.launch({ headless: true, timeout: 15_000 });
  });
  afterAll(async () => { await browser?.close(); });

  for (const width of [1440, 390]) for (const theme of ["dark", "light"] as const) {
    test(`${width}px ${theme}: loading, retry, capabilities, actions and conflicts`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme });
      const page = await context.newPage();
      page.setDefaultTimeout(5_000);
      const pageErrors: string[] = [];
      page.on("pageerror", (error: Error) => pageErrors.push(error.message));
      const writes: string[] = [];
      page.on("request", (request: any) => { if (request.method() === "POST") writes.push(new URL(request.url()).pathname); });
      let recs = recommendationFixtures();
      let listError = false;
      let failure: { code: string; message: string; status: number } | null = null;
      let wrongAnswer = false;
      let releaseList = () => {};
      let releaseAction = () => {};
      let listGate: Promise<void> | null = new Promise((resolve) => { releaseList = resolve; });
      let actionGate: Promise<void> | null = null;
      const calls: { method: string; path: string }[] = [];
      const posts = () => calls.filter((c) => c.method === "POST");
      const gets = () => calls.filter((c) => c.method === "GET");
      await context.route("**/*", (route: any) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
      await page.route("**/v1/orchestrator**", async (route: any) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/v1/orchestrator") return route.fulfill({ json: { local: { running: true, state: "idle", restarts: 0, access: "platform" } } });
        if (url.pathname === "/v1/orchestrator/messages") return route.fulfill({ json: { messages: [] } });
        if (url.pathname === "/v1/orchestrator/schedules") return route.fulfill({ json: { schedules: [], status: null } });
        if (url.pathname === "/v1/orchestrator/say") {
          const { text } = route.request().postDataJSON();
          return route.fulfill({ json: { message: { id: "om_fixture", thread: "om_fixture", role: "person", state: "sent", text, ts: Date.now() } } });
        }
        return route.abort();
      });
      await page.route("**/v1/talkie/recs**", async (route: any) => {
        const request = route.request();
        const url = new URL(request.url());
        calls.push({ method: request.method(), path: url.pathname });
        if (request.method() === "GET") {
          if (listGate) await listGate;
          await route.fulfill({ status: listError ? 503 : 200, json: listError ? { error: { code: "fixture", message: "Fixture list unavailable" } } : { recs, now: 1 } });
          return;
        }
        if (actionGate) await actionGate;
        if (failure) { await route.fulfill({ status: failure.status, json: { error: failure } }); return; }
        const parts = url.pathname.split("/");
        const id = decodeURIComponent(parts[4]!);
        const status = parts[5] === "approve" ? "approved" : "dismissed";
        const rec = recs.find((r) => r.id === id)!;
        const resolved = { ...rec, status, can_approve: false, can_dismiss: false } as Recommendation;
        if (!wrongAnswer) recs = recs.map((r) => r.id === id ? resolved : r);
        await route.fulfill({ json: { rec: wrongAnswer ? { ...resolved, id: "different-record" } : resolved } });
      });
      const panel = page.locator(".orch-recommendations");
      const row = (index: number) => panel.locator(".orch-rec").nth(index);
      const action = (index: number, name: string) => row(index).getByRole("button", { name, exact: true });
      const refresh = panel.getByRole("button", { name: "Refresh", exact: true });
      try {
        await page.goto(`${base}/#/orchestrator`);
        await panel.getByText("Loading recommendations…").waitFor();
        expect(posts()).toHaveLength(0);
        expect(await refresh.isDisabled()).toBe(true);
        listError = true; releaseList(); listGate = null;
        await panel.getByText("Fixture list unavailable").waitFor();
        listError = false; recs = [];
        await panel.getByRole("button", { name: "Retry recommendations" }).click();
        await panel.getByText("No recommendations right now.").waitFor();
        expect(posts()).toHaveLength(0);
        recs = recommendationFixtures().map((rec, i) => i === 0 ? { ...rec, can_approve: false, why_not: "Approval unavailable for this record" }
          : i === 1 ? { ...rec, can_dismiss: false } : rec);
        await refresh.click();
        await panel.getByRole("heading", { name: "Work to start" }).waitFor();
        expect(await panel.locator("details[open]").count()).toBe(0);
        expect(await panel.locator(".orch-rec-group").count()).toBe(5);
        expect(await action(0, "Approve").isDisabled()).toBe(true);
        expect(await action(0, "Dismiss").isEnabled()).toBe(true);
        expect(await action(1, "Approve").isEnabled()).toBe(true);
        expect(await action(1, "Dismiss").isDisabled()).toBe(true);
        await panel.getByText("Approval unavailable for this record").waitFor();
        // The asks show what approving sends in the person's name; what WalkieTalkie wrote is quoted as not sent.
        await row(2).getByText("Approving does this in your name").waitFor();
        await row(3).getByText("WalkieTalkie wrote this (it is not sent)").waitFor();
        await row(0).locator("summary").click();
        expect(await row(0).locator("details").getAttribute("open")).not.toBeNull();
        await row(0).locator("summary").click();
        expect(posts()).toHaveLength(0);
        expect(writes).toEqual([]);

        recs = recommendationFixtures(); await refresh.click();
        await action(0, "Approve").waitFor();
        // A conflict blocks only its row; another row can still submit one action.
        failure = { status: 409, code: "conflict", message: "The card changed" };
        await action(0, "Approve").click();
        await row(0).getByRole("alert").waitFor();
        expect(await action(0, "Approve").isDisabled()).toBe(true);
        const retry = row(0).getByRole("button", { name: "Refresh before trying again" });
        failure = null;
        actionGate = new Promise((resolve) => { releaseAction = resolve; });
        // Two clicks in one JS turn exercise the synchronous lock before a re-render.
        await action(1, "Dismiss").evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
        await row(1).getByText("Dismissing…").waitFor();
        expect(await row(1).getAttribute("aria-busy")).toBe("true");
        expect(posts()).toHaveLength(2);
        expect(await action(1, "Approve").isDisabled()).toBe(true);
        expect(await action(2, "Approve").isEnabled()).toBe(true);
        expect(await refresh.isDisabled()).toBe(true);
        expect(await retry.isDisabled()).toBe(true);
        releaseAction(); actionGate = null;
        await row(1).getByText("Dismissed", { exact: true }).waitFor();
        expect(await row(1).getByRole("button").count()).toBe(0);
        const readsBeforeRetry = gets().length;
        await retry.click();
        await action(0, "Approve").waitFor();
        expect(gets().length).toBe(readsBeforeRetry + 1);
        expect(posts()).toHaveLength(2);
        await action(0, "Approve").click();
        await row(0).getByText("Approved", { exact: true }).waitFor();
        await refresh.click();
        await row(0).getByText("Approved", { exact: true }).waitFor();
        expect(posts()).toHaveLength(3);

        for (const denied of [
          { status: 403, code: "forbidden", message: "Permission changed" },
          { status: 409, code: "rec_not_pending", message: "This recommendation has expired" },
        ]) {
          failure = denied;
          const before = posts().length;
          await action(2, "Approve").click();
          await row(2).getByText(`${denied.message} Refresh to check its current status.`).waitFor();
          expect(posts()).toHaveLength(before + 1);
          expect(await action(2, "Approve").isDisabled()).toBe(true);
          await row(2).getByRole("button", { name: "Refresh before trying again" }).click();
          await action(2, "Approve").waitFor();
          expect(posts()).toHaveLength(before + 1);
        }
        failure = null; wrongAnswer = true;
        await action(2, "Approve").click();
        await row(2).getByText("The action could not be confirmed. Refresh to check its current status.").waitFor();
        expect(await row(2).getByText("Approved", { exact: true }).count()).toBe(0);
        wrongAnswer = false;
        recs = recs.map((rec, i) => i === 2 ? { ...rec, status: "expired", can_approve: false, can_dismiss: false } : rec);
        await row(2).getByRole("button", { name: "Refresh before trying again" }).click();
        await row(2).getByText("Expired", { exact: true }).waitFor();
        expect(await row(2).getByRole("button").count()).toBe(0);
        expect(posts()).toHaveLength(6);
        expect(pageErrors).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(await panel.evaluate((element: HTMLElement) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await panel.getByRole("heading", { name: "Recommendations", exact: true }).scrollIntoViewIfNeeded();
        const shot = await page.screenshot({ path: `${evidence}/recommendations-${width}-${theme}.png` });
        // The final group's controls must remain reachable above mobile navigation.
        await action(4, "Dismiss").click();
        await row(4).getByText("Dismissed", { exact: true }).waitFor();
        const bottomShot = await page.screenshot({ path: `${evidence}/recommendations-bottom-${width}-${theme}.png` });
        expect(posts()).toHaveLength(7);
        // Reading suggestions has not taken over the conversation's composer.
        await page.getByRole("textbox", { name: "Message WalkieTalkie" }).fill("Synthetic conversation still works");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page.getByRole("log", { name: "Conversation" }).getByText("Synthetic conversation still works").waitFor();
        expect(writes).toHaveLength(8);
        expect(writes[7]).toBe("/v1/orchestrator/say");
        const receipt = { width, theme, calls, writes, pageErrors, screenshotSha256: createHash("sha256").update(shot).digest("hex"),
          bottomScreenshotSha256: createHash("sha256").update(bottomShot).digest("hex") };
        await Bun.write(`${evidence}/recommendations-${width}-${theme}.json`, JSON.stringify(receipt, null, 2));
      } finally { releaseList(); releaseAction(); await context.close(); }
    }, 30_000);
  }
});
