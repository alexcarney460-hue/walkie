// The desktop app shows Walkie's own dashboard (http://127.0.0.1:<port>) in its webview. Tauri's freezePrototype
// freezes Object.prototype in every page it shows, and the dashboard's bundled zod then throws on startup ("Cannot
// assign to read only property 'toString'"), leaving a blank window (seen on a Windows machine, 2026-10-01). That origin gets no
// Tauri IPC (every command refuses callers that are not the app's own setup page), so the freeze protects nothing there.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

describe("desktop app webview", () => {
  test("freezePrototype stays off: a frozen Object.prototype blanks the dashboard (zod assigns toString on plain objects)", () => {
    const conf = JSON.parse(readFileSync(join(ROOT, "desktop/src-tauri/tauri.conf.json"), "utf8"));
    expect(conf.app.security.freezePrototype).toBe(false);
    const win = JSON.parse(readFileSync(join(ROOT, "desktop/src-tauri/tauri.windows.conf.json"), "utf8"));
    expect(win.app?.security?.freezePrototype).not.toBe(true);
  });

});
