import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

export interface BrowserRuntime {
  chromium: { launch(options: Record<string, unknown>): Promise<Browser> };
}
export interface Browser {
  newContext(options: Record<string, unknown>): Promise<BrowserContext>;
  close(): Promise<void>;
}
export interface BrowserContext {
  newPage(): Promise<BrowserPage>;
  addInitScript(script: () => void): Promise<void>;
  exposeBinding(name: string, callback: () => boolean): Promise<void>;
  route(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<void>;
  routeWebSocket(pattern: string, handler: (socket: { close(): void }) => void): Promise<void>;
  close(): Promise<void>;
}
export interface BrowserRoute {
  request(): { url(): string; method(): string; resourceType(): string; headers(): Record<string, string>; postDataBuffer(): Buffer | null };
  fulfill(response: { status: number; headers: Record<string, string>; body: Buffer }): Promise<void>;
  continue(): Promise<void>;
  abort(): Promise<void>;
}
export interface BrowserPage {
  url(): string;
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  locator(selector: string): BrowserLocator;
  screenshot(options?: Record<string, unknown>): Promise<Uint8Array>;
  on(event: string, handler: (event: { cancel(): Promise<void> }) => void): void;
  close(): Promise<void>;
}
export interface BrowserLocator {
  count(): Promise<number>;
  nth(index: number): BrowserLocator;
  ariaSnapshot(options?: Record<string, unknown>): Promise<string>;
  innerText(options?: Record<string, unknown>): Promise<string>;
  evaluate<T>(fn: (el: Element) => T): Promise<T>;
  elementHandle(): Promise<BrowserElement | null>;
}
export interface BrowserElement {
  evaluate<T>(fn: (el: Element) => T): Promise<T>;
  click(): Promise<void>;
  fill(text: string): Promise<void>;
  selectOption(value: string): Promise<unknown>;
  dispose(): Promise<void>;
}

/** Import only a person-installed Playwright package beneath this machine's Sqwakie home. */
export async function resolveBrowserModule(home: string): Promise<BrowserRuntime | null> {
  const base = join(home, "browser");
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(base, "chromium");
  const moduleDir = join(base, "node_modules", "playwright");
  const entry = join(moduleDir, "index.mjs");
  const fallback = join(moduleDir, "index.js");
  const path = existsSync(entry) ? entry : fallback;
  if (!existsSync(path)) return null;
  const root = realpathSync(base);
  const actual = realpathSync(path);
  if (!actual.startsWith(root + sep)) return null;
  try {
    const loaded = await import(pathToFileURL(actual).href) as BrowserRuntime & { default?: BrowserRuntime };
    const runtime = loaded.chromium ? loaded : loaded.default;
    return typeof runtime?.chromium?.launch === "function" ? runtime : null;
  } catch { return null; }
}
