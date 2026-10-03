import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { api } from "../src/api/client.ts";
import type { OrchestratorView } from "../src/api/types.ts";
import { StartOrchestrator } from "../src/views/orchestrator/Lifecycle.tsx";
import { installDom, type DomEnv, type Mounted } from "./mini-dom.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
// Only the local lifecycle fields are consumed by this component.
const view = (running = false, lead?: string, last_error?: string) =>
  ({ local: { running, lead, last_error } }) as OrchestratorView;
let dom: DomEnv;
let mounted: Mounted;
let status: ReturnType<typeof spyOn<typeof api, "orchestrator">>;
let start: ReturnType<typeof spyOn<typeof api, "orchestratorStart">>;
let oldConfirm: typeof window.confirm;

beforeEach(async () => {
  dom = await installDom();
  oldConfirm = window.confirm;
  window.confirm = () => true;
  status = spyOn(api, "orchestrator").mockResolvedValue(view());
  start = spyOn(api, "orchestratorStart").mockResolvedValue(view(true));
  mounted = await dom.mount(<StartOrchestrator />);
});
afterEach(async () => {
  await dom.restore();
  status.mockRestore();
  start.mockRestore();
  if (oldConfirm === undefined) delete (window as Partial<Window>).confirm;
  else window.confirm = oldConfirm;
});
const button = () => mounted.one("button.btn-primary")!;
function pending(value: boolean) {
  expect(button().hasAttribute("disabled")).toBe(value);
  expect(button().getAttribute("aria-busy")).toBe(String(value));
  expect(button().textContent).toBe(value ? "Starting…" : "Start WalkieTalkie");
  expect(mounted.one("fieldset")!.hasAttribute("disabled")).toBe(value);
  expect(mounted.one("select")!.hasAttribute("disabled")).toBe(value);
}

// Dispatch twice within ONE act, before React commits disabled=true. This exercises
// the mounted handler through React's listeners, including the synchronous guard.
async function doubleClick() {
  const event = { type: "click", target: button(), bubbles: true, button: 0,
    preventDefault() {}, stopPropagation() {} };
  await act(async () => {
    for (let i = 0; i < 2; i++)
      for (const listener of mounted.container.listenersFor("click")) listener(event);
  });
}

test("two clicks before status settles claim one lookup and one start", async () => {
  const lookup = deferred<OrchestratorView>();
  const launch = deferred<OrchestratorView>();
  status.mockReturnValue(lookup.promise);
  start.mockReturnValue(launch.promise);
  await doubleClick();
  expect(status).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledTimes(0);
  pending(true);
  await act(async () => lookup.resolve(view()));
  expect(start).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledWith("platform", "default");
  await mounted.click(button());
  expect(status).toHaveBeenCalledTimes(1);
  pending(true);
  await act(async () => launch.resolve(view(true)));
  pending(true);
});

test("declining the other leader returns idle and allows a deliberate retry", async () => {
  status.mockResolvedValue(view(false, "fixture-leader"));
  let confirmations = 0;
  window.confirm = () => { confirmations++; return false; };
  await doubleClick();
  expect(confirmations).toBe(1);
  expect(start).toHaveBeenCalledTimes(0);
  pending(false);
  window.confirm = () => true;
  await mounted.click(button());
  expect(status).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenCalledTimes(1);
  pending(true);
});

for (const failure of ["refused", "rejected"] as const) {
  test(`${failure} start shows the error and permits retry`, async () => {
    if (failure === "refused") start.mockResolvedValueOnce(view(false, undefined, "fixture refusal"));
    else start.mockRejectedValueOnce(new Error("fixture refusal"));
    await mounted.click(button());
    pending(false);
    const message = failure === "refused" ? "fixture refusal" : "Something went wrong. Try again.";
    expect(mounted.text()).toContain(message);
    const lookup = deferred<OrchestratorView>();
    status.mockReturnValueOnce(lookup.promise);
    await mounted.click(button());
    pending(true);
    expect(mounted.text()).not.toContain(message);
    await act(async () => lookup.resolve(view()));
    expect(start).toHaveBeenCalledTimes(2);
    pending(true);
  });
}

test("failed status lookup preserves the existing fallback to one start", async () => {
  status.mockRejectedValue(new Error("fixture status unavailable"));
  await doubleClick();
  expect(status).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledTimes(1);
  pending(true);
});

test("successful start remains pending until the existing stream wait expires", async () => {
  const nativeTimeout = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) => {
    if (ms === 20_000) { expire = fn; return nativeTimeout(() => {}, ms); }
    return nativeTimeout(fn, ms, ...args);
  }) as typeof setTimeout);
  try {
    await mounted.click(button());
    pending(true);
    expect(expire).toBeDefined();
    await act(async () => expire!());
    pending(false);
    await mounted.click(button());
    expect(status).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
  } finally { timer.mockRestore(); }
});
