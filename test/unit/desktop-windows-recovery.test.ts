import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const ROOT = join(import.meta.dir, "..", "..");
const page = readFileSync(join(ROOT, "desktop/ui/windows.js"), "utf8");

// Exercise the recovery page with a stub bridge. These checks do not execute the
// Windows-only native callback or prove that a real window is restored.
describe("Windows desktop Open Dashboard recovery", () => {
  test("local recovery page shows an unavailable daemon and Check again can reopen it", async () => {
    let connected = false;
    const harness = localPage(async (command) => command === "status"
      ? { connected, distros: [], version: "test", error: "The Sqwakie daemon is not running in WSL." }
      : undefined);
    await harness.ready();
    expect(harness.elements.state.textContent).toBe("The Sqwakie daemon is not running in WSL.");
    expect(harness.elements.open.disabled).toBe(true);
    expect(harness.elements.retry.disabled).toBe(false);
    connected = true;
    await harness.listeners["retry:click"]!();
    expect(harness.calls).toEqual(["status", "status", "show_dashboard"]);
  });

  test("local recovery page displays opening failures and leaves a manual retry", async () => {
    const harness = localPage(async (command) => {
      if (command === "status") return { connected: true, distros: [], version: "test" };
      throw "Could not open the dashboard window.";
    });
    await harness.ready();
    expect(harness.elements.state.textContent).toBe("Could not open the dashboard window.");
    expect(harness.elements.retry.disabled).toBe(false);
    await harness.listeners["open:click"]!();
    expect(harness.elements.state.textContent).toBe("Could not open the dashboard window.");
    expect(harness.elements.open.disabled).toBe(false);
  });
});

function localPage(invoke: (command: string) => Promise<unknown>) {
  const listeners: Record<string, () => Promise<void>> = {};
  const calls: string[] = [];
  const element = (id: string) => ({
    textContent: "", disabled: false, value: "",
    replaceChildren() {},
    addEventListener(event: string, listener: () => Promise<void>) { listeners[`${id}:${event}`] = listener; },
  });
  const elements = { distro: element("distro"), state: element("state"), open: element("open"), retry: element("retry") };
  runInNewContext(page, {
    window: { __TAURI__: { core: { invoke: async (command: string) => { calls.push(command); return invoke(command); } } } },
    document: { getElementById: (id: keyof typeof elements) => elements[id] },
    Option: function () {}, URLSearchParams, location: { search: "" },
  });
  return { elements, listeners, calls, ready: () => new Promise<void>((resolve) => setImmediate(resolve)) };
}
