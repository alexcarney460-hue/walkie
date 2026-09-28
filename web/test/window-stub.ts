// lib/route.ts reads window.location and subscribes to "hashchange" once, when it is first imported, on whatever
// window exists then. Every web test that renders a routed view installs this ONE stand-in (a process-wide singleton),
// so `go()` reaches the router's listener whichever test file imported route.ts first.
const media = { matches: false, addEventListener: () => {}, removeEventListener: () => {} };
const hashListeners: Array<() => void> = [];

export const testWindow = {
  location: { hash: "#/mission" }, removeEventListener: () => {}, matchMedia: () => media,
  addEventListener: (type: string, fn: () => void) => { if (type === "hashchange") hashListeners.push(fn); },
};

/** Installs the stand-in as `window` (again, if a test removed it) and returns it. */
export function installWindow(): typeof testWindow {
  (globalThis as { window?: unknown }).window = testWindow;
  return testWindow;
}

/** Moves to `hash` and tells the router, as a browser's hashchange would. */
export function go(hash: string): void {
  installWindow().location.hash = hash;
  for (const fn of hashListeners) fn();
}
