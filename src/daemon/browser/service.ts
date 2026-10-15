import { randomUUID } from "node:crypto";
import { defang } from "../../protocol/safety.ts";
import { browserUrl, BrowserQuota, secretField, sensitiveValue, type Control } from "./policy.ts";
import { fetchBrowserRequest } from "./network.ts";
import { browserAuditLine } from "./audit.ts";
import { resolveBrowserModule, type Browser, type BrowserContext, type BrowserElement, type BrowserPage, type BrowserRuntime } from "./runtime.ts";

export interface BrowserSettings { enabled: boolean; denylist: readonly string[] }
export interface BrowserResult {
  text: string;
  screenshot?: string;
  needs_confirmation?: boolean;
  confirmation_id?: string;
  summary?: string;
  role?: string;
  name?: string;
  url?: string;
}
interface Ref { element: BrowserElement; control: Control; url: string }
interface PlanStep { ref: string; kind: "click" | "type" | "select" | "submit"; value?: string; manual: boolean; control: Control }
interface Pending { id: string; steps: readonly PlanStep[]; summary: string; screenshot: string; url: string; created: number; askId?: string }
interface Session { context: BrowserContext; page: BrowserPage; refs: Map<string, Ref>; pending?: Pending; touched: number; denylist: readonly string[]; downloaded: boolean; typedValues: Set<string>; blockedRequests: number; activePlanOrigin?: string }

const IDLE_MS = 15 * 60_000;
const MAX_CONTEXTS = 4;
const REF_SELECTORS = "a,button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=radio],[role=combobox]";
type Loader = (home: string) => Promise<BrowserRuntime | null>;

/** Runs inside the page; never reads an input's value. */
function controlOf(el: Element) {
  const node = el as HTMLElement;
  const style = getComputedStyle(node);
  const box = node.getBoundingClientRect();
  const type = el.tagName.toLowerCase() === "button" || el.tagName.toLowerCase() === "input"
    ? ((el as HTMLInputElement).type ?? "").toLowerCase() : (el.getAttribute("type") ?? "").toLowerCase();
  const labels = "labels" in el ? [...((el as HTMLInputElement).labels ?? [])].map((label) => label.textContent ?? "").join(" ") : "";
  const name = (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.getAttribute("placeholder")
    ?? (labels || node.innerText || el.getAttribute("name") || el.getAttribute("autocomplete") || el.id || "")).trim().slice(0, 160);
  const form = "form" in el ? (el as HTMLInputElement).form : node.closest("form");
  const formKey = form ? [form.id, form.getAttribute("name") ?? "", form.getAttribute("action") ?? "",
    form.getAttribute("method") ?? "", String([...document.forms].indexOf(form))].join("|") : "";
  return { connected: el.isConnected, visible: box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none",
    role: el.getAttribute("role") ?? el.tagName.toLowerCase(), name, type, download: el.hasAttribute("download"),
    autocomplete: el.getAttribute("autocomplete") ?? "", id: el.id, fieldName: el.getAttribute("name") ?? "", label: labels.trim().slice(0, 160),
    placeholder: el.getAttribute("placeholder") ?? "", ariaLabel: el.getAttribute("aria-label") ?? "",
    href: el.tagName.toLowerCase() === "a" ? (el as HTMLAnchorElement).href : "",
    scriptHandler: el.hasAttribute("onclick") || node.onclick !== null, form: formKey };
}

/** One daemon owns all ephemeral contexts, so the four-context cap applies across its MCP processes. */
export class BrowserManager {
  private browser?: Promise<Browser>;
  private readonly sessions = new Map<string, Promise<Session>>();
  private readonly idleTimer: ReturnType<typeof setInterval>;
  constructor(private readonly home: string, private readonly load: Loader = resolveBrowserModule,
    private readonly now: () => number = Date.now, private readonly quota: BrowserQuota = new BrowserQuota(),
    private readonly fetchRequest: typeof fetchBrowserRequest = fetchBrowserRequest) {
    this.idleTimer = setInterval(() => { void this.sweep().catch(() => undefined); }, 60_000);
    this.idleTimer.unref?.();
  }

  private async runtime(): Promise<Browser> {
    if (!this.browser) {
      this.browser = (async () => {
        const module = await this.load(this.home);
        if (!module) throw new Error("browser not installed on this machine; a person runs walkie browser install");
        try { return await module.chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND"] }); }
        catch (err) {
          if (/executable does not exist|browser.*not found|install.*browser/i.test(String(err)))
            throw new Error("browser not installed on this machine; a person runs walkie browser install");
          throw err;
        }
      })().catch((err) => { this.browser = undefined; throw err; });
    }
    return this.browser;
  }

  private async create(key: string): Promise<Session> {
    const browser = await this.runtime();
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      const session: Session = { context, page, refs: new Map(), touched: this.now(),
        denylist: [], downloaded: false, typedValues: new Set(), blockedRequests: 0 };
      await context.exposeBinding("__walkieCanSubmitForm", () => {
        const allowed = !!session.activePlanOrigin && new URL(session.page.url()).origin === session.activePlanOrigin;
        if (!allowed) session.blockedRequests++;
        return allowed;
      });
      await context.addInitScript(() => {
        const form = HTMLFormElement.prototype;
        const submit = form.submit;
        const requestSubmit = form.requestSubmit;
        const canSubmit = () => (window as unknown as { __walkieCanSubmitForm: () => Promise<boolean> }).__walkieCanSubmitForm();
        let approved = false;
        form.submit = function () { void canSubmit().then((allowed) => { if (allowed) submit.call(this); }); };
        form.requestSubmit = function (button?: HTMLElement) {
          void canSubmit().then((allowed) => {
            if (allowed) {
              approved = true;
              try { requestSubmit.call(this, button); } finally { approved = false; }
            }
          });
        };
        document.addEventListener("submit", (event) => {
          if (approved) { approved = false; return; }
          event.preventDefault();
          void canSubmit().then((allowed) => {
            if (allowed && event.target instanceof HTMLFormElement) {
              approved = true;
              try { requestSubmit.call(event.target, (event as SubmitEvent).submitter as HTMLElement | undefined); }
              finally { approved = false; }
            }
          });
        }, true);
      });
      page.on("download", (download) => { session.downloaded = true; void download.cancel().catch(() => undefined); });
      await context.route("**/*", async (route) => {
        try {
          const request = route.request();
          const url = browserUrl(request.url(), session.denylist);
          const method = request.method().toUpperCase();
          const headers = request.headers();
          const stream = request.resourceType?.() === "eventsource" || /text\/event-stream/i.test(headers.accept ?? "");
          if ((method !== "GET" && method !== "HEAD" || stream)
            && session.activePlanOrigin !== new URL(url).origin) throw new Error("page write blocked");
          const response = await this.fetchRequest(request.url(), request.method(), request.headers(),
            request.postDataBuffer(), session.denylist);
          await route.fulfill(response);
        }
        catch { session.blockedRequests++; await route.abort(); }
      });
      await context.routeWebSocket("**/*", (socket) => { session.blockedRequests++; socket.close(); });
      return session;
    } catch (err) { await context.close(); throw err; }
  }

  private async session(key: string, create: boolean): Promise<Session> {
    await this.sweep();
    let promise = this.sessions.get(key);
    if (!promise && !create) {
      await this.runtime();
      throw new Error("browser conversation has no open page; call browser_open first");
    }
    if (!promise) {
      if (this.sessions.size >= MAX_CONTEXTS) throw new Error("browser limit: at most 4 conversations on this machine");
      promise = this.create(key).catch((err) => { this.sessions.delete(key); throw err; });
      this.sessions.set(key, promise);
    }
    const session = await promise;
    session.touched = this.now();
    return session;
  }

  async sweep(): Promise<void> {
    for (const [key, promise] of this.sessions) {
      const session = await promise.catch(() => null);
      if (!session || this.now() - session.touched < IDLE_MS) continue;
      this.sessions.delete(key);
      await this.clearRefs(session);
      await session.context.close();
    }
    if (this.sessions.size === 0 && this.browser) {
      const browser = await this.browser.catch(() => null);
      this.browser = undefined;
      await browser?.close();
    }
  }

  async close(): Promise<void> {
    clearInterval(this.idleTimer);
    for (const [key, promise] of this.sessions) {
      this.sessions.delete(key);
      const session = await promise.catch(() => null);
      if (session) await session.context.close();
    }
    const browser = await this.browser?.catch(() => null);
    this.browser = undefined;
    await browser?.close();
  }

  private async clearRefs(session: Session): Promise<void> {
    await this.retireRefs(session)();
  }

  private retireRefs(session: Session): () => Promise<void> {
    const old = [...session.refs.values()];
    session.refs = new Map();
    session.pending = undefined;
    return async () => { await Promise.all(old.map((r) => r.element.dispose().catch(() => undefined))); };
  }

  private guard(key: string, settings: BrowserSettings): void {
    if (!settings.enabled) throw new Error("browser is off on this machine; a person runs walkie browser on");
    this.quota.take(key, this.now());
  }

  private reportBlocked(session: Session, result: BrowserResult): BrowserResult {
    const count = session.blockedRequests;
    session.blockedRequests = 0;
    return count ? { ...result, text: `${result.text}\n${count} request(s): the page tried to send data; blocked` } : result;
  }

  /** Audit metadata from the latest snapshot, including when an action is refused. No field value is read. */
  async auditInfo(key: string, ref?: string): Promise<Pick<BrowserResult, "url" | "role" | "name"> | undefined> {
    const session = await this.sessions.get(key)?.catch(() => null);
    if (!session) return undefined;
    const control = ref ? session.refs.get(ref)?.control : undefined;
    return { url: session.page.url(), role: control?.role ?? "document", name: control?.name ?? "page" };
  }

  async auditTypedValues(key: string): Promise<string[]> {
    const session = await this.sessions.get(key)?.catch(() => null);
    return session ? [...session.typedValues] : [];
  }

  async open(key: string, rawUrl: string, settings: BrowserSettings): Promise<BrowserResult> {
    this.guard(key, settings);
    const url = browserUrl(rawUrl, settings.denylist);
    const session = await this.session(key, true);
    session.denylist = settings.denylist;
    await this.clearRefs(session);
    session.downloaded = false;
    try { await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 }); }
    catch { throw new Error("browser_open failed or navigation was refused"); }
    if (session.downloaded) throw new Error("browser downloads are refused");
    const final = browserUrl(session.page.url(), settings.denylist);
    return this.reportBlocked(session, { text: `opened ${final}; call browser_read for element refs`, url: final, role: "navigation", name: "open" });
  }

  async read(key: string, settings: BrowserSettings): Promise<BrowserResult> {
    this.guard(key, settings);
    const session = await this.session(key, false);
    session.denylist = settings.denylist;
    const url = browserUrl(session.page.url(), settings.denylist);
    await this.clearRefs(session);
    const body = session.page.locator("body");
    const [accessibility, visible] = await Promise.all([
      body.ariaSnapshot({ timeout: 10_000 }), body.innerText({ timeout: 10_000 }),
    ]);
    const controls = session.page.locator(REF_SELECTORS);
    const lines: string[] = [];
    for (let n = 0, count = Math.min(await controls.count(), 150); n < count; n++) {
      const item = controls.nth(n);
      const meta = await item.evaluate(controlOf).catch(() => null);
      if (!meta?.visible) continue;
      const handle = await item.elementHandle();
      if (!handle) continue;
      const ref = randomUUID();
      session.refs.set(ref, { element: handle, control: meta, url });
      lines.push(`${ref} ${meta.role} ${meta.name}${secretField(meta) ? " [sensitive field: typing refused]" : ""}`);
    }
    return this.reportBlocked(session, { text: `Accessibility snapshot:\n${accessibility.slice(0, 20_000)}\nVisible text:\n${visible.slice(0, 20_000)}\nElement refs:\n${lines.join("\n")}`,
      url, role: "document", name: "read" });
  }

  async screenshot(key: string, settings: BrowserSettings): Promise<BrowserResult> {
    this.guard(key, settings);
    const session = await this.session(key, false);
    session.denylist = settings.denylist;
    const url = browserUrl(session.page.url(), settings.denylist);
    const bytes = await session.page.screenshot({ type: "png", animations: "disabled" });
    return this.reportBlocked(session, { text: `Screenshot of ${url}`, screenshot: Buffer.from(bytes).toString("base64"), url, role: "document", name: "screenshot" });
  }

  private async target(key: string, ref: string, settings: BrowserSettings): Promise<{ session: Session; target: Ref; url: string }> {
    this.guard(key, settings);
    const session = await this.session(key, false);
    session.denylist = settings.denylist;
    const target = session.refs.get(ref);
    if (!target) throw new Error("browser ref expired; call browser_read for a fresh snapshot");
    const url = browserUrl(session.page.url(), settings.denylist);
    const live = await target.element.evaluate(controlOf).catch(() => null);
    if (!live?.connected || !live.visible || target.url !== url || live.role !== target.control.role
      || live.name !== target.control.name || live.type !== target.control.type || live.download !== target.control.download
      || live.autocomplete !== target.control.autocomplete || live.id !== target.control.id
      || live.fieldName !== target.control.fieldName || live.label !== target.control.label
      || live.placeholder !== target.control.placeholder || live.ariaLabel !== target.control.ariaLabel
      || live.href !== target.control.href || live.scriptHandler !== target.control.scriptHandler || live.form !== target.control.form)
      throw new Error("browser ref is stale; call browser_read again");
    return { session, target, url };
  }

  async action(key: string, kind: "click" | "type" | "select" | "submit", ref: string, value: string | undefined,
    settings: BrowserSettings): Promise<BrowserResult> {
    const { session, target, url } = await this.target(key, ref, settings);
    if (kind === "click" && (target.control.type === "file" || target.control.download)) throw new Error("browser downloads and file inputs are refused");
    const plainLink = kind === "click" && target.control.role === "a" && !!target.control.href && !target.control.scriptHandler;
    if (!plainLink) {
      if (session.pending?.askId) throw new Error("browser plan is awaiting the person's answer");
      if (session.pending && session.pending.url !== url) throw new Error("browser page changed; start a new plan");
      const manual = (kind === "type" || kind === "select") && (secretField(target.control) || sensitiveValue(value ?? "", target.control));
      const step: PlanStep = { ref, kind, manual, control: target.control,
        ...(!manual && (kind === "type" || kind === "select") ? { value } : {}) };
      if (kind === "type" && value && !manual) session.typedValues.add(value);
      const prior = session.pending;
      if ((prior?.steps.length ?? 0) >= 20) throw new Error("browser plan is limited to 20 steps");
      session.pending = prior ? { ...prior, steps: [...prior.steps, step] }
        : { id: randomUUID(), steps: [step], summary: "", screenshot: "", url, created: this.now() };
      return this.reportBlocked(session, { text: `queued browser ${kind} as step ${session.pending.steps.length}; call browser_confirm_plan to show the person the full plan`,
        url, role: target.control.role, name: target.control.name });
    }
    if (session.pending) throw new Error("confirm or discard the queued browser plan before navigating");
    const dispose = this.retireRefs(session);
    try {
      session.downloaded = false;
      const destination = browserUrl(target.control.href ?? "", settings.denylist);
      try { await session.page.goto(destination, { waitUntil: "domcontentloaded", timeout: 20_000 }); }
      catch { throw new Error("browser_click navigation failed; outcome uncertain; read the page again"); }
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (session.downloaded) throw new Error("browser downloads are refused");
    } finally { await dispose(); }
    return this.reportBlocked(session, { text: `${kind} completed; call browser_read for fresh refs`, url, role: target.control.role, name: target.control.name });
  }

  async confirmPlan(key: string, settings: BrowserSettings): Promise<BrowserResult> {
    this.guard(key, settings);
    const session = await this.session(key, false);
    const p = session.pending;
    if (!p?.steps.length) throw new Error("browser plan is empty; queue a write action first");
    if (p.askId && this.now() - p.created > 10 * 60_000) {
      session.pending = undefined;
      throw new Error("browser confirmation expired; plan discarded");
    }
    if (session.page.url() !== p.url) { session.pending = undefined; throw new Error("browser page changed; read and plan again"); }
    if (p.askId) return this.pendingResult(p);
    const origin = browserAuditLine("plan", { text: "", url: p.url, role: "", name: "" }, undefined,
      [...session.typedValues]).replace(/^browser plan /, "").trim();
    const steps = p.steps.map((step, index) => {
      const label = browserAuditLine(step.kind, { text: "", url: p.url, role: step.control.role, name: step.control.name },
        undefined, [...session.typedValues]).replace(/^browser \w+ \S+ /, "");
      const verb = step.kind === "type" ? "Type" : step.kind === "select" ? "Select" : step.kind === "submit" ? "Submit" : "Click";
      const detail = step.manual ? " — [masked]; person must enter this sensitive value themselves; Talkie cannot enter it"
        : step.kind === "type" || step.kind === "select" ? ` — ${JSON.stringify(step.value ?? "")}` : "";
      return `${index + 1}. ${verb} ${label}${detail}`;
    });
    const rawSummary = `Browser plan on ${origin}:\n${steps.join("\n")}`;
    if (rawSummary.length > 2800) throw new Error("browser plan is too long for review; use shorter input or fewer steps");
    const summary = defang(rawSummary, 3000);
    const screenshot = Buffer.from(await session.page.screenshot({ type: "png" })).toString("base64");
    session.pending = { ...p, summary, screenshot, created: this.now() };
    return this.reportBlocked(session, this.pendingResult(session.pending));
  }

  private pendingResult(p: Pending): BrowserResult {
    return { text: `needs confirmation: ${p.summary}`, screenshot: p.screenshot, needs_confirmation: true,
      confirmation_id: p.id, summary: p.summary, url: p.url, role: "document", name: "plan" };
  }

  async bindAsk(key: string, id: string, askId: string): Promise<void> {
    const session = await this.session(key, false);
    if (!session.pending || session.pending.id !== id) throw new Error("browser confirmation expired");
    session.pending = { ...session.pending, askId };
  }

  async pending(key: string, id: string): Promise<Pending | null> {
    const session = await this.session(key, false);
    if (session.pending && this.now() - session.pending.created > 10 * 60_000) session.pending = undefined;
    return session.pending?.id === id ? session.pending : null;
  }

  async review(id: string): Promise<Pick<Pending, "summary" | "screenshot"> | null> {
    for (const promise of this.sessions.values()) {
      const session = await promise.catch(() => null);
      if (session?.pending?.id === id && this.now() - session.pending.created <= 10 * 60_000)
        return { summary: session.pending.summary, screenshot: session.pending.screenshot };
    }
    return null;
  }

  async cancelPending(key: string, id: string): Promise<void> {
    const session = await this.session(key, false);
    if (session.pending?.id === id) session.pending = undefined;
  }

  async confirm(key: string, id: string, settings: BrowserSettings): Promise<BrowserResult> {
    this.guard(key, settings);
    const session = await this.session(key, false);
    const p = session.pending;
    if (!p || p.id !== id || !p.screenshot) throw new Error("browser confirmation expired");
    if (this.now() - p.created > 10 * 60_000) { session.pending = undefined; throw new Error("browser confirmation expired; plan discarded"); }
    if (session.page.url() !== p.url) throw new Error("browser page changed; call browser_read again");
    if (p.steps.some((step) => step.manual)) {
      session.pending = undefined;
      throw new Error("browser plan needs the person to type a sensitive field themselves; automated execution is refused");
    }
    const refs = new Map(session.refs);
    const dispose = this.retireRefs(session); // one confirmation cannot execute twice, even if outcome is uncertain
    try {
      for (const step of p.steps) {
        if (new URL(session.page.url()).origin !== new URL(p.url).origin || session.page.url() !== p.url)
          throw new Error("browser page changed during plan; outcome uncertain; read the page again");
        const target = refs.get(step.ref);
        const live = await target?.element.evaluate(controlOf).catch(() => null);
        const c = step.control;
        if (!target || !live?.connected || !live.visible || live.role !== c.role || live.name !== c.name
          || live.type !== c.type || live.download !== c.download || live.autocomplete !== c.autocomplete
          || live.id !== c.id || live.fieldName !== c.fieldName || live.label !== c.label
          || live.placeholder !== c.placeholder || live.ariaLabel !== c.ariaLabel
          || live.href !== c.href || live.scriptHandler !== c.scriptHandler || live.form !== c.form)
          throw new Error("browser ref is stale; plan stopped; read the page again");
        session.downloaded = false;
        try {
          session.activePlanOrigin = new URL(p.url).origin;
          if (step.kind === "type") await target.element.fill(step.value ?? "");
          else if (step.kind === "select") await target.element.selectOption(step.value ?? "");
          else await target.element.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch { throw new Error(`browser_${step.kind} failed; outcome uncertain; read the page again`); }
        finally { session.activePlanOrigin = undefined; }
        if (session.downloaded) throw new Error("browser downloads are refused");
      }
    } finally { await dispose(); }
    return this.reportBlocked(session, { text: `browser plan completed after person confirmation; call browser_read for fresh refs`, url: p.url,
      role: "document", name: "plan" });
  }
}
