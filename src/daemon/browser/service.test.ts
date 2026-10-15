import { expect, test } from "bun:test";
import { BrowserManager } from "./service.ts";
import { BrowserQuota } from "./policy.ts";
import type { BrowserRuntime } from "./runtime.ts";

function fake(options: { downloadOnClick?: boolean; clickError?: boolean; afterFill?: () => void; onClick?: () => Promise<void>; control?: { visible: boolean; role: string; name: string; type: string; download?: boolean; href?: string; scriptHandler?: boolean; id?: string; fieldName?: string; label?: string; form?: string } } = {}) {
  let clicks = 0;
  let fills = 0;
  let selects = 0;
  let contexts = 0;
  let closed = 0;
  let downloadHandler: ((event: { cancel(): Promise<void> }) => void) | undefined;
  let routeHandler: ((route: any) => Promise<void>) | undefined;
  let socketHandler: ((socket: { close(): void }) => void) | undefined;
  let initScript: (() => void) | undefined;
  let formBinding: (() => boolean) | undefined;
  const control = () => ({ visible: true, role: "button", name: "Pay now", type: "button", ...options.control });
  const element = { evaluate: async () => ({ connected: true, ...control() }), click: async () => { clicks++; await options.onClick?.(); if (options.downloadOnClick) downloadHandler?.({ cancel: async () => {} });
    if (options.clickError) throw new Error("page disappeared after click"); }, fill: async () => { fills++; options.afterFill?.(); },
    selectOption: async () => { selects++; }, dispose: async () => {} };
  const page = () => {
    let url = "about:blank";
    return { url: () => url, goto: async (to: string) => { url = to; }, screenshot: async () => new Uint8Array([137, 80, 78, 71]),
      on: (_event: string, handler: typeof downloadHandler) => { downloadHandler = handler; }, close: async () => {}, locator: (selector: string) => ({
        count: async () => selector === "body" ? 1 : 1,
        nth: () => ({ evaluate: async () => ({ ...control() }), elementHandle: async () => element }),
        ariaSnapshot: async () => "- button Pay now", innerText: async () => "Pay now",
      }) };
  };
  const runtime = { chromium: { launch: async () => ({ newContext: async () => {
    contexts++;
    return { newPage: async () => page(), addInitScript: async (script: () => void) => { initScript = script; },
      exposeBinding: async (_name: string, callback: () => boolean) => { formBinding = callback; },
      route: async (_pattern: string, handler: typeof routeHandler) => { routeHandler = handler; },
      routeWebSocket: async (_pattern: string, handler: typeof socketHandler) => { socketHandler = handler; },
      close: async () => { closed++; } };
  }, close: async () => {} }) } } as unknown as BrowserRuntime;
  return { runtime, request: async (url: string, method = "GET", resourceType = "document") => {
    let result = "none";
    await routeHandler?.({ request: () => ({ url: () => url, method: () => method, resourceType: () => resourceType, headers: () => ({}), postDataBuffer: () => null }),
      fulfill: async () => { result = "fulfilled"; }, abort: async () => { result = "aborted"; },
      continue: async () => { result = "continued"; } });
    return result;
  }, socket: () => { let closed = false; socketHandler?.({ close: () => { closed = true; } }); return closed; },
    installScript: () => initScript?.(), canSubmitForm: () => formBinding?.() ?? false,
    get clicks() { return clicks; }, get fills() { return fills; }, get selects() { return selects; }, get contexts() { return contexts; }, get closed() { return closed; } };
}

test("page requests use pinned fulfillment and block local URLs before any fetch", async () => {
  const f = fake();
  let fetched = 0;
  const fetcher = (async () => { fetched++; return { status: 200, headers: {}, body: Buffer.from("ok") }; }) as never;
  const manager = new BrowserManager("/unused", async () => f.runtime, Date.now, new BrowserQuota(), fetcher);
  await manager.open("a", "https://example.org", { enabled: true, denylist: [] });
  expect(await f.request("https://example.org/image.png")).toBe("fulfilled");
  expect(await f.request("http://127.0.0.1:7457/v1/admin")).toBe("aborted");
  expect(fetched).toBe(1);
  await manager.close();
});

test("passive page requests refuse writes and report blocked attempts; confirmed steps allow only their origin", async () => {
  const f = fake();
  const sent: string[] = [];
  const fetcher = (async (url: string, method: string) => {
    sent.push(`${method} ${url}`);
    return { status: 200, headers: {}, body: Buffer.from("ok") };
  }) as never;
  const manager = new BrowserManager("/unused", async () => f.runtime, Date.now, new BrowserQuota(), fetcher);
  const settings = { enabled: true, denylist: [] };
  try {
    await manager.open("a", "https://example.org", settings);
    expect(await f.request("https://example.org/accept", "POST")).toBe("aborted");
    expect(await f.request("https://example.org/beacon", "POST", "ping")).toBe("aborted");
    expect(await f.request("https://example.org/events", "GET", "eventsource")).toBe("aborted");
    expect(f.socket()).toBe(true);
    expect(await f.request("https://example.org/image", "HEAD")).toBe("fulfilled");
    expect((await manager.read("a", settings)).text).toContain("4 request(s): the page tried to send data; blocked");
    expect(sent).toEqual(["HEAD https://example.org/image"]);
    const ref = (await manager.read("a", settings)).text.match(/[0-9a-f-]{36} button/)![0].split(" ")[0]!;
    await manager.action("a", "click", ref, undefined, settings);
    const plan = await manager.confirmPlan("a", settings);
    await manager.confirm("a", plan.confirmation_id!, settings);
  } finally { await manager.close(); }
});

test("a confirmed step permits same-origin writes only during its execution", async () => {
  const options: { onClick?: () => Promise<void> } = {};
  const f = fake(options);
  const sent: string[] = [];
  options.onClick = async () => {
    expect(await f.request("https://example.org/accept", "POST")).toBe("fulfilled");
    expect(await f.request("https://other.example/receive", "POST")).toBe("aborted");
  };
  const fetcher = (async (url: string, method: string) => {
    sent.push(`${method} ${url}`);
    return { status: 200, headers: {}, body: Buffer.from("ok") };
  }) as never;
  const manager = new BrowserManager("/unused", async () => f.runtime, Date.now, new BrowserQuota(), fetcher);
  const settings = { enabled: true, denylist: [] };
  try {
    await manager.open("a", "https://example.org", settings);
    const ref = (await manager.read("a", settings)).text.match(/[0-9a-f-]{36} button/)![0].split(" ")[0]!;
    await manager.action("a", "click", ref, undefined, settings);
    const plan = await manager.confirmPlan("a", settings);
    expect((await manager.confirm("a", plan.confirmation_id!, settings)).text).toContain("the page tried to send data; blocked");
    expect(await f.request("https://example.org/late", "POST")).toBe("aborted");
    expect(sent).toEqual(["POST https://example.org/accept"]);
  } finally { await manager.close(); }
});

test("form submit guard counts a passive submission and permits one during a confirmed step", async () => {
  const options: { onClick?: () => Promise<void> } = {};
  const f = fake(options);
  const manager = new BrowserManager("/unused", async () => f.runtime);
  const settings = { enabled: true, denylist: [] };
  const previous = [globalThis.HTMLFormElement, globalThis.window, globalThis.document];
  let submissions = 0;
  class Form { submit() { submissions++; } requestSubmit() { submissions++; } }
  try {
    await manager.open("a", "https://example.org", settings);
    Object.assign(globalThis, { HTMLFormElement: Form, window: { __walkieCanSubmitForm: async () => f.canSubmitForm() },
      document: { addEventListener: () => {} } });
    f.installScript();
    const form = new Form();
    form.submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(submissions).toBe(0);
    expect((await manager.read("a", settings)).text).toContain("1 request(s): the page tried to send data; blocked");
    options.onClick = async () => { form.submit(); await new Promise((resolve) => setTimeout(resolve, 0)); };
    const ref = (await manager.read("a", settings)).text.match(/[0-9a-f-]{36} button/)![0].split(" ")[0]!;
    await manager.action("a", "click", ref, undefined, settings);
    const plan = await manager.confirmPlan("a", settings);
    await manager.confirm("a", plan.confirmation_id!, settings);
    expect(submissions).toBe(1);
  } finally {
    Object.assign(globalThis, { HTMLFormElement: previous[0], window: previous[1], document: previous[2] });
    await manager.close();
  }
});

test("a pass_phrase field is manual-only throughout its plan", async () => {
  const f = fake({ control: { visible: true, role: "input", name: "Account", type: "text", fieldName: "pass_phrase" } });
  const manager = new BrowserManager("/unused", async () => f.runtime);
  const settings = { enabled: true, denylist: [] };
  try {
    await manager.open("a", "https://example.org", settings);
    const ref = (await manager.read("a", settings)).text.match(/[0-9a-f-]{36} input/)![0].split(" ")[0]!;
    await manager.action("a", "type", ref, "Demonstration phrase", settings);
    const plan = await manager.confirmPlan("a", settings);
    expect(plan.summary).toContain("[masked]");
    expect(plan.summary).not.toContain("Demonstration phrase");
    await expect(manager.confirm("a", plan.confirmation_id!, settings)).rejects.toThrow("sensitive field");
    expect(f.fills).toBe(0);
  } finally { await manager.close(); }
});

test("writes queue as one plan; plain links navigate without click", async () => {
  const settings = { enabled: true, denylist: [] };
  for (const kind of ["click", "select", "submit"] as const) {
    const f = fake({ control: { visible: true, role: kind === "select" ? "select" : "button", name: "Details", type: kind === "select" ? "select-one" : "button" } });
    const manager = new BrowserManager("/unused", async () => f.runtime);
    await manager.open("a", "https://example.org", settings);
    const read = await manager.read("a", settings);
    const ref = read.text.match(/[0-9a-f-]{36} (?:button|select)/)![0].split(" ")[0]!;
    const pending = await manager.action("a", kind, ref, kind === "select" ? "choice" : undefined, settings);
    expect(pending.needs_confirmation).toBeUndefined();
    expect(f.clicks + f.selects).toBe(0);
    const plan = await manager.confirmPlan("a", settings);
    expect(plan.needs_confirmation).toBe(true);
    await manager.confirm("a", plan.confirmation_id!, settings);
    expect(f.clicks + f.selects).toBe(1);
    await manager.close();
  }
  const f = fake({ control: { visible: true, role: "a", name: "Details", type: "", href: "https://example.org/details", scriptHandler: true } });
  const manager = new BrowserManager("/unused", async () => f.runtime);
  await manager.open("a", "https://example.org", settings);
  const read = await manager.read("a", settings);
  const ref = read.text.match(/[0-9a-f-]{36} a/)![0].split(" ")[0]!;
  expect((await manager.action("a", "click", ref, undefined, settings)).needs_confirmation).toBeUndefined();
  expect(f.clicks).toBe(0);
  await manager.close();

  const plain = fake({ control: { visible: true, role: "a", name: "Details", type: "", href: "https://example.org/details", scriptHandler: false } });
  const second = new BrowserManager("/unused", async () => plain.runtime);
  await second.open("a", "https://example.org", settings);
  const fresh = await second.read("a", settings);
  const link = fresh.text.match(/[0-9a-f-]{36} a/)![0].split(" ")[0]!;
  expect((await second.action("a", "click", link, undefined, settings)).needs_confirmation).toBeUndefined();
  expect(plain.clicks).toBe(0);
  await second.close();
});

test("typing is queued until one confirmed plan executes its steps in order", async () => {
  const f = fake({ control: { visible: true, role: "input", name: "Quantity", type: "text" } });
  const manager = new BrowserManager("/unused", async () => f.runtime);
  const settings = { enabled: true, denylist: [] };
  try {
    await manager.open("a", "https://example.org", settings);
    const read = await manager.read("a", settings);
    const ref = read.text.match(/[0-9a-f-]{36} input/)![0].split(" ")[0]!;
    await manager.action("a", "type", ref, "2", settings);
    await manager.action("a", "submit", ref, undefined, settings);
    expect(f.fills + f.clicks).toBe(0);
    const plan = await manager.confirmPlan("a", settings);
    expect(plan.summary).toContain("1. Type");
    expect(plan.summary).toContain("2. Submit");
    await manager.confirm("a", plan.confirmation_id!, settings);
    expect(f.fills).toBe(1);
    expect(f.clicks).toBe(1);
  } finally { await manager.close(); }
});

test("plan stops before the next write if its element changes form", async () => {
  const control = { visible: true, role: "input", name: "Quantity", type: "text", form: "order|post" };
  const f = fake({ control, afterFill: () => { control.form = "payment|post"; } });
  const manager = new BrowserManager("/unused", async () => f.runtime);
  const settings = { enabled: true, denylist: [] };
  try {
    await manager.open("a", "https://example.org", settings);
    const ref = (await manager.read("a", settings)).text.match(/[0-9a-f-]{36} input/)![0].split(" ")[0]!;
    await manager.action("a", "type", ref, "2", settings);
    await manager.action("a", "submit", ref, undefined, settings);
    const plan = await manager.confirmPlan("a", settings);
    await expect(manager.confirm("a", plan.confirmation_id!, settings)).rejects.toThrow("stale");
    expect(f.fills).toBe(1);
    expect(f.clicks).toBe(0);
  } finally { await manager.close(); }
});

test("expired confirmation discards its plan without acting", async () => {
  let now = 1_000;
  const f = fake();
  const manager = new BrowserManager("/unused", async () => f.runtime, () => now);
  const settings = { enabled: true, denylist: [] };
  try {
    await manager.open("a", "https://example.org", settings);
    const ref = (await manager.read("a", settings)).text.match(/[0-9a-f-]{36} button/)![0].split(" ")[0]!;
    await manager.action("a", "click", ref, undefined, settings);
    const plan = await manager.confirmPlan("a", settings);
    now += 10 * 60_000 + 1;
    await expect(manager.confirm("a", plan.confirmation_id!, settings)).rejects.toThrow("discarded");
    expect(f.clicks).toBe(0);
    await expect(manager.confirmPlan("a", settings)).rejects.toThrow("empty");
  } finally { await manager.close(); }
});

test("Luhn-valid card numbers and security-code contexts become manual steps", async () => {
  const settings = { enabled: true, denylist: [] };
  for (const [name, value] of [["Reference", "4111111111111111"], ["Security code", "123"]]) {
    const f = fake({ control: { visible: true, role: "input", name: name!, type: "text" } });
    const manager = new BrowserManager("/unused", async () => f.runtime);
    await manager.open("a", "https://example.org", settings);
    const read = await manager.read("a", settings);
    const ref = read.text.match(/[0-9a-f-]{36} input/)![0].split(" ")[0]!;
    await manager.action("a", "type", ref, value, settings);
    const plan = await manager.confirmPlan("a", settings);
    expect(plan.summary).toContain("person must enter this sensitive value themselves");
    expect(plan.summary).not.toContain(value);
    await expect(manager.confirm("a", plan.confirmation_id!, settings)).rejects.toThrow("sensitive field");
    expect(f.fills).toBe(0);
    await manager.close();
  }
});

test("typed text reflected into a later URL is hidden from the confirmation summary and audit", async () => {
  const f = fake({ control: { visible: true, role: "input", name: "Search", type: "text" } });
  const manager = new BrowserManager("/unused", async () => f.runtime);
  const settings = { enabled: true, denylist: [] };
  await manager.open("a", "https://example.org", settings);
  const first = await manager.read("a", settings);
  const input = first.text.match(/[0-9a-f-]{36} input/)![0].split(" ")[0]!;
  await manager.action("a", "type", input, "private phrase", settings);
  await manager.open("a", "https://example.org/search/private%20phrase", settings);
  const next = await manager.read("a", settings);
  const ref = next.text.match(/[0-9a-f-]{36} input/)![0].split(" ")[0]!;
  await manager.action("a", "click", ref, undefined, settings);
  const pending = await manager.confirmPlan("a", settings);
  expect(pending.summary).not.toContain("private");
  expect(await manager.auditTypedValues("a")).toContain("private phrase");
  await manager.close();
});

test("off is the default gate and missing installation is explicit", async () => {
  const manager = new BrowserManager("/unused", async () => null);
  await expect(manager.open("a", "https://example.org", { enabled: false, denylist: [] })).rejects.toThrow("off");
  await expect(manager.open("a", "https://example.org", { enabled: true, denylist: [] })).rejects.toThrow("not installed");
  await expect(manager.read("a", { enabled: true, denylist: [] })).rejects.toThrow("not installed");
  await manager.close();
});

test("downloads and file inputs are refused", async () => {
  const settings = { enabled: true, denylist: [] };
  const file = fake({ control: { visible: true, role: "input", name: "Upload", type: "file" } });
  const manager = new BrowserManager("/unused", async () => file.runtime);
  await manager.open("file", "https://example.org", settings);
  const read = await manager.read("file", settings);
  const ref = read.text.match(/[0-9a-f-]{36} input/)![0].split(" ")[0]!;
  await expect(manager.action("file", "click", ref, undefined, settings)).rejects.toThrow("refused");
  await manager.close();

  const download = fake({ downloadOnClick: true });
  const second = new BrowserManager("/unused", async () => download.runtime);
  await second.open("a", "https://example.org", settings);
  const page = await second.read("a", settings);
  const pay = page.text.match(/[0-9a-f-]{36} button/)![0].split(" ")[0]!;
  const pending = await second.action("a", "click", pay, undefined, settings);
  const plan = await second.confirmPlan("a", settings);
  await expect(second.confirm("a", plan.confirmation_id!, settings)).rejects.toThrow("downloads are refused");
  await second.close();
});

test("four isolated contexts, stale refs, confirmation, and idle teardown", async () => {
  let now = 1000;
  const f = fake();
  const manager = new BrowserManager("/unused", async () => f.runtime, () => now);
  const settings = { enabled: true, denylist: [] };
  for (const key of ["a", "b", "c", "d"]) await manager.open(key, "https://example.org", settings);
  expect(f.contexts).toBe(4);
  await expect(manager.open("e", "https://example.org", settings)).rejects.toThrow("at most 4");
  const first = await manager.read("a", settings);
  const old = first.text.match(/[0-9a-f-]{36} button/)?.[0].split(" ")[0];
  const fresh = await manager.read("a", settings);
  const ref = fresh.text.match(/[0-9a-f-]{36} button/)?.[0].split(" ")[0];
  expect(ref).toBeTruthy();
  await expect(manager.action("a", "click", old!, undefined, settings)).rejects.toThrow("ref expired");
  const pending = await manager.action("a", "click", ref!, undefined, settings);
  expect(pending.needs_confirmation).toBeUndefined();
  expect(f.clicks).toBe(0);
  const plan = await manager.confirmPlan("a", settings);
  await manager.confirm("a", plan.confirmation_id!, settings);
  expect(f.clicks).toBe(1);
  await expect(manager.action("a", "click", ref!, undefined, settings)).rejects.toThrow("ref expired");
  now += 15 * 60_000 + 1;
  await manager.sweep();
  expect(f.closed).toBe(4);
  await manager.close();
});

test("an uncertain confirmed click retires its ref so it cannot be repeated", async () => {
  const f = fake({ clickError: true });
  const manager = new BrowserManager("/unused", async () => f.runtime);
  const settings = { enabled: true, denylist: [] };
  await manager.open("a", "https://example.org", settings);
  const read = await manager.read("a", settings);
  const ref = read.text.match(/[0-9a-f-]{36} button/)![0].split(" ")[0]!;
  await manager.action("a", "click", ref, undefined, settings);
  const plan = await manager.confirmPlan("a", settings);
  await expect(manager.confirm("a", plan.confirmation_id!, settings)).rejects.toThrow("outcome uncertain");
  await expect(manager.action("a", "click", ref, undefined, settings)).rejects.toThrow("ref expired");
  expect(f.clicks).toBe(1);
  await manager.close();
});

test("a control changed after its snapshot is stale, not clicked under its old label", async () => {
  const control = { visible: true, role: "button", name: "Details", type: "button" };
  const f = fake({ control });
  const manager = new BrowserManager("/unused", async () => f.runtime);
  const settings = { enabled: true, denylist: [] };
  await manager.open("a", "https://example.org", settings);
  const read = await manager.read("a", settings);
  const ref = read.text.match(/[0-9a-f-]{36} button/)![0].split(" ")[0]!;
  control.name = "Pay now";
  await expect(manager.action("a", "click", ref, undefined, settings)).rejects.toThrow("stale");
  expect(f.clicks).toBe(0);
  await manager.close();
});

test("a person changing browser settings cannot reset a conversation's hourly quota", async () => {
  const quota = new BrowserQuota();
  const f = fake();
  const settings = { enabled: true, denylist: [] };
  const first = new BrowserManager("/unused", async () => f.runtime, () => 1_000, quota);
  await first.open("a", "https://example.org", settings);
  for (let n = 1; n < 60; n++) await first.read("a", settings);
  await first.close();
  const second = new BrowserManager("/unused", async () => f.runtime, () => 1_000, quota);
  await expect(second.open("a", "https://example.org", settings)).rejects.toThrow("rate limit");
  await second.close();
});

test("sensitive typing retains only the target's URL, role and name for audit", async () => {
  const f = fake({ control: { visible: true, role: "input", name: "Password", type: "password" } });
  const manager = new BrowserManager("/unused", async () => f.runtime);
  const settings = { enabled: true, denylist: [] };
  await manager.open("a", "https://example.org/form?token=hidden", settings);
  const read = await manager.read("a", settings);
  const ref = read.text.match(/[0-9a-f-]{36} input/)![0].split(" ")[0]!;
  expect(await manager.auditInfo("a", ref)).toEqual({ url: "https://example.org/form?token=hidden", role: "input", name: "Password" });
  await manager.action("a", "type", ref, "never-log-this", settings);
  const plan = await manager.confirmPlan("a", settings);
  expect(plan.summary).not.toContain("never-log-this");
  await manager.close();
});
