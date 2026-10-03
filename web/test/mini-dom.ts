// A very small DOM, just enough for react-dom/client to mount, update and unmount the dashboard's components in bun
// tests. Bun has no DOM and the project takes no DOM library; the other web tests render to a string with
// renderToStaticMarkup, which cannot exercise an error boundary (React's server renderer never calls one), so the
// boundary tests need the real client renderer.
//
// What it is not: a browser. It keeps nodes, attributes and text, tells React the events it listens for, and lets a test
// click an element or fill a text input through React's own root listener. No layout, CSS, form submission or focus.
// Elements a test renders must stay within plain markup (div, span, button, input, a, ul/li, svg, details, pre ...).
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { installWindow } from "./window-stub.ts";

type Listener = (event: unknown) => void;
interface Registered { fn: Listener; capture: boolean }

class MiniNode {
  nodeType = 0;
  nodeName = "";
  parentNode: MiniNode | null = null;
  childNodes: MiniNode[] = [];
  ownerDocument: MiniDocument | null = null;
  private readonly listeners = new Map<string, Registered[]>();

  get firstChild(): MiniNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): MiniNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): MiniNode | null {
    const p = this.parentNode;
    return p ? p.childNodes[p.childNodes.indexOf(this) + 1] ?? null : null;
  }
  get previousSibling(): MiniNode | null {
    const p = this.parentNode;
    const i = p ? p.childNodes.indexOf(this) : -1;
    return p && i > 0 ? p.childNodes[i - 1] ?? null : null;
  }

  appendChild<T extends MiniNode>(child: T): T { return this.insertBefore(child, null); }
  insertBefore<T extends MiniNode>(child: T, ref: MiniNode | null): T {
    child.parentNode?.removeChild(child);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    if (at < 0) throw new Error("mini-dom: insertBefore with a reference that is not a child");
    this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild<T extends MiniNode>(child: T): T {
    const at = this.childNodes.indexOf(child);
    if (at < 0) throw new Error("mini-dom: removeChild of a node that is not a child");
    this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  contains(other: MiniNode | null): boolean {
    for (let n: MiniNode | null = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(value: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (value) this.appendChild(new MiniText(value, this.ownerDocument));
  }

  addEventListener(type: string, fn: Listener, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === "boolean" ? options : options?.capture === true;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), { fn, capture }]);
  }
  removeEventListener(type: string, fn: Listener, options?: boolean | { capture?: boolean }): void {
    const capture = typeof options === "boolean" ? options : options?.capture === true;
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l.fn !== fn || l.capture !== capture));
  }
  /** The listeners registered for `type`: capture listeners first, as a dispatch would call them. */
  listenersFor(type: string): Listener[] {
    const all = this.listeners.get(type) ?? [];
    return [...all.filter((l) => l.capture), ...all.filter((l) => !l.capture)].map((l) => l.fn);
  }
}

export class MiniText extends MiniNode {
  nodeValue: string;
  constructor(text: string, doc: MiniDocument | null) {
    super();
    this.nodeType = 3;
    this.nodeName = "#text";
    this.nodeValue = text;
    this.ownerDocument = doc;
  }
  get textContent(): string { return this.nodeValue; }
  set textContent(value: string) { this.nodeValue = value; }
  get data(): string { return this.nodeValue; }
}

class MiniComment extends MiniNode {
  constructor(readonly data: string, doc: MiniDocument | null) {
    super();
    this.nodeType = 8;
    this.nodeName = "#comment";
    this.ownerDocument = doc;
  }
  get textContent(): string { return ""; }
}

const HTML_NS = "http://www.w3.org/1999/xhtml";

export class MiniElement extends MiniNode {
  private inputValue = "";
  readonly tagName: string;
  readonly namespaceURI: string;
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> & { setProperty(name: string, value: string): void; removeProperty(name: string): void } = {
    setProperty(name: string, value: string) { this[name] = value; },
    removeProperty(name: string) { delete this[name]; },
  };

  constructor(tag: string, namespace: string, doc: MiniDocument | null) {
    super();
    this.nodeType = 1;
    this.namespaceURI = namespace;
    this.tagName = namespace === HTML_NS ? tag.toUpperCase() : tag;
    this.nodeName = this.tagName;
    this.ownerDocument = doc;
  }

  get localName(): string { return this.tagName.toLowerCase(); }
  get type(): string { return this.getAttribute("type") ?? ""; }
  set type(value: string) { this.setAttribute("type", value); }
  get value(): string { return this.inputValue; }
  set value(value: string) { this.inputValue = String(value); }
  get className(): string { return this.attributes.get("class") ?? ""; }
  /** A select's options (React sets `selected` on them when the select has a value). */
  get options(): MiniElement[] { return this.all("option"); }
  setAttribute(name: string, value: unknown): void { this.attributes.set(name, String(value)); }
  setAttributeNS(_ns: string | null, name: string, value: unknown): void { this.setAttribute(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  removeAttributeNS(_ns: string | null, name: string): void { this.removeAttribute(name); }

  /** The elements below this one that match a simple selector (see `matches`), in document order. */
  all(selector: string): MiniElement[] {
    const out: MiniElement[] = [];
    const walk = (n: MiniNode) => {
      for (const c of n.childNodes) {
        if (c instanceof MiniElement) {
          if (matches(c, selector)) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  one(selector: string): MiniElement | null { return this.all(selector)[0] ?? null; }

  /** Serialised markup (attributes in the order they were set), for assertions and failure messages. */
  get outerHTML(): string {
    const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`).join("");
    return `<${this.localName}${attrs}>${this.innerHTML}</${this.localName}>`;
  }
  get innerHTML(): string {
    return this.childNodes.map((c) => (c instanceof MiniElement ? c.outerHTML : c instanceof MiniText ? escapeText(c.nodeValue) : "")).join("");
  }
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** Supports `tag`, `.class`, `[attr]`, `[attr="value"]` and combinations such as `button.btn[aria-label="Close"]`. */
function matches(el: MiniElement, selector: string): boolean {
  const re = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:\.[\w-]+|\[[\w:-]+(?:="[^"]*")?\])*)$/;
  const m = re.exec(selector.trim());
  if (!m) throw new Error(`mini-dom: unsupported selector ${selector}`);
  const [, tag, rest = ""] = m;
  if (tag && el.localName !== tag.toLowerCase()) return false;
  const classes = el.className.split(/\s+/);
  for (const part of rest.match(/\.[\w-]+|\[[\w:-]+(?:="[^"]*")?\]/g) ?? []) {
    if (part.startsWith(".")) {
      if (!classes.includes(part.slice(1))) return false;
      continue;
    }
    const a = /^\[([\w:-]+)(?:="([^"]*)")?\]$/.exec(part);
    if (!a) return false;
    const [, name = "", value] = a;
    const have = el.getAttribute(name);
    if (have === null || (value !== undefined && have !== value)) return false;
  }
  return true;
}

class MiniDocument extends MiniNode {
  readonly oninput = null;
  readonly documentElement: MiniElement;
  readonly body: MiniElement;
  readonly head: MiniElement;
  readonly activeElement: MiniElement | null = null;
  defaultView: unknown = null;

  constructor() {
    super();
    this.nodeType = 9;
    this.nodeName = "#document";
    this.documentElement = new MiniElement("html", HTML_NS, this);
    this.head = new MiniElement("head", HTML_NS, this);
    this.body = new MiniElement("body", HTML_NS, this);
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }
  createElement(tag: string): MiniElement { return new MiniElement(tag, HTML_NS, this); }
  createElementNS(namespace: string, tag: string): MiniElement { return new MiniElement(tag, namespace, this); }
  createTextNode(text: string): MiniText { return new MiniText(text, this); }
  createComment(text: string): MiniComment { return new MiniComment(text, this); }
}

export interface Mounted {
  readonly container: MiniElement;
  render(element: ReactNode): Promise<void>;
  unmount(): Promise<void>;
  /** Visible text of the whole tree. */
  text(): string;
  html(): string;
  all(selector: string): MiniElement[];
  one(selector: string): MiniElement | null;
  /** A click on `el`, delivered through React's own root listener (so `onClick` runs). */
  click(el: MiniElement): Promise<void>;
  /** Change a text input through the native input listener and React's value tracker. */
  fill(el: MiniElement, value: string): Promise<void>;
}

export interface DomEnv {
  mount(element: ReactNode): Promise<Mounted>;
  /** Errors an error boundary caught, and errors no boundary caught (the page would be white), and recoverable ones. */
  readonly caught: unknown[];
  readonly uncaught: unknown[];
  readonly recoverable: unknown[];
  /** Unmounts every root still mounted and puts back the globals the test replaced. */
  restore(): Promise<void>;
}

const GLOBALS = ["document", "navigator", "HTMLElement", "HTMLIFrameElement", "Element", "Node", "IS_REACT_ACT_ENVIRONMENT"] as const;

/**
 * Installs the mini DOM on the shared test `window` (window-stub.ts) and loads react-dom/client afterwards (it decides at
 * import whether a DOM exists). Call `restore()` in afterAll: other test files must find no browser globals.
 */
export async function installDom(): Promise<DomEnv> {
  const win = installWindow() as unknown as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  const had = new Map<string, { win: boolean; winValue: unknown; global: boolean; globalValue: unknown }>();
  for (const k of GLOBALS) had.set(k, { win: k in win, winValue: win[k], global: k in g, globalValue: g[k] });

  const doc = new MiniDocument();
  doc.defaultView = win;
  class Stub {}
  const dom: Record<string, unknown> = {
    document: doc, navigator: { userAgent: "mini-dom" }, HTMLElement: MiniElement, HTMLIFrameElement: Stub, Element: MiniElement, Node: MiniNode,
  };
  for (const [k, v] of Object.entries(dom)) { win[k] = v; g[k] = v; }
  win.event = undefined;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const { createRoot } = await import("react-dom/client");
  const caught: unknown[] = [];
  const uncaught: unknown[] = [];
  const recoverable: unknown[] = [];
  const roots: Array<{ root: Root; container: MiniElement; mounted: boolean }> = [];

  async function mount(element: ReactNode): Promise<Mounted> {
    const container = doc.createElement("div");
    doc.body.appendChild(container);
    const root = createRoot(container as unknown as Element, {
      onCaughtError: (error) => { caught.push(error); },
      onUncaughtError: (error) => { uncaught.push(error); },
      onRecoverableError: (error) => { recoverable.push(error); },
    });
    const entry = { root, container, mounted: true };
    roots.push(entry);
    const mounted: Mounted = {
      container,
      render: async (el) => { await act(async () => { root.render(el); }); },
      unmount: async () => {
        if (!entry.mounted) return;
        entry.mounted = false;
        await act(async () => { root.unmount(); });
      },
      text: () => container.textContent,
      html: () => container.innerHTML,
      all: (s) => container.all(s),
      one: (s) => container.one(s),
      click: async (el) => {
        const event = {
          type: "click", target: el, srcElement: el, currentTarget: container, bubbles: true, cancelable: true, composed: true,
          defaultPrevented: false, eventPhase: 3, isTrusted: true, timeStamp: Date.now(), button: 0, buttons: 0, detail: 1,
          preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {},
        };
        await act(async () => { for (const fn of container.listenersFor("click")) fn(event); });
      },
      fill: async (el, value) => {
        // The prototype setter represents a native edit, bypassing React's instance value tracker.
        Object.getOwnPropertyDescriptor(MiniElement.prototype, "value")?.set?.call(el, value);
        const event = { type: "input", target: el, bubbles: true, cancelable: false, timeStamp: Date.now() };
        await act(async () => { for (const fn of container.listenersFor("input")) fn(event); });
      },
    };
    await mounted.render(element);
    return mounted;
  }

  return {
    mount, caught, uncaught, recoverable,
    async restore() {
      for (const r of roots) if (r.mounted) { r.mounted = false; await act(async () => { r.root.unmount(); }); }
      for (const k of GLOBALS) {
        const was = had.get(k);
        if (!was) continue;
        if (was.win) win[k] = was.winValue; else delete win[k];
        if (was.global) g[k] = was.globalValue; else delete g[k];
      }
      delete win.event;
    },
  };
}
