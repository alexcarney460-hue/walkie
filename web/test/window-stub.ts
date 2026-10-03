// lib/route.ts reads window.location and subscribes to "hashchange" once, when it is first imported, on whatever
// window exists then. Every web test that renders a routed view installs this ONE stand-in (a process-wide singleton),
// so `go()` reaches the router's listener whichever test file imported route.ts first.
// Assigning location.hash does not notify by itself: a few tests leave a mounted view that writes the hash back, and
// following that write would undo go(). A test that renders a view which calls navigate() opts in with
// hashAssignNotifies(true) and turns it off in afterAll.
const media = { matches: false, addEventListener: () => {}, removeEventListener: () => {} };
const hashListeners: Array<() => void> = [];
let hashValue = "#/mission";
let notifying = false;
let assignNotifies = false;

function notifyHash(): void {
  if (notifying) return;
  notifying = true;
  try {
    for (const fn of [...hashListeners]) fn();
  } finally {
    notifying = false;
  }
}

export const testWindow = {
  location: {
    get hash() { return hashValue; },
    set hash(v: string) {
      const next = String(v);
      if (next === hashValue) return;
      hashValue = next;
      if (assignNotifies) notifyHash();
    },
  },
  removeEventListener: () => {}, matchMedia: () => media,
  addEventListener: (type: string, fn: () => void) => { if (type === "hashchange") hashListeners.push(fn); },
};

/** Installs the stand-in as `window` (again, if a test removed it) and returns it. */
export function installWindow(): typeof testWindow {
  (globalThis as { window?: unknown }).window = testWindow;
  return testWindow;
}

/**
 * When on, assigning location.hash tells the router, which is what navigate() does in a browser.
 * Turn it off in afterAll. Default off, so go() stays the only notifier for the rest of the suite.
 */
export function hashAssignNotifies(on: boolean): void {
  assignNotifies = on;
}

/** Moves to `hash` and tells the router, as a browser's hashchange would. */
export function go(hash: string): void {
  const loc = installWindow().location;
  const same = loc.hash === hash;
  if (!same) loc.hash = hash;
  if (same || !assignNotifies) notifyHash();
}
