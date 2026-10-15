import { resolveBrowserModule, type Browser, type BrowserContext, type BrowserPage } from "../browser/runtime.ts";
import { ProfileStore } from "./profile.ts";
import type { ChannelAdapter, ChannelId, ChannelState, IncomingMessage } from "./types.ts";
import { whatsappWeb } from "./whatsapp-web.ts";
import { smsGvoice } from "./sms-gvoice.ts";
import { createHash } from "node:crypto";

type Selectors = typeof whatsappWeb | typeof smsGvoice;
type Stored = { browser: unknown; seen: string[] };
type ProfileContext = BrowserContext & { storageState(options?: { indexedDB: boolean }): Promise<unknown> };
type MessageElement = { getAttribute(name: string): string | null; textContent: string | null };
type Reader = { evaluateAll<T>(fn: (els: MessageElement[]) => T): Promise<T> };
type Composer = { fill(text: string): Promise<void>; press(key: string): Promise<void> };
const PHONE = /^\+[1-9]\d{6,14}$/;

export class WebChannelAdapter implements ChannelAdapter {
  readonly id: ChannelId;
  private browser: Browser | null = null;
  private context: ProfileContext | null = null;
  private page: BrowserPage | null = null;
  private seen = new Set<string>();

  constructor(private readonly home: string, private readonly selectors: Selectors,
    private readonly profiles = new ProfileStore(home),
    private readonly load = resolveBrowserModule) { this.id = selectors.id; }

  private async start(visible: boolean): Promise<BrowserPage> {
    if (this.page) return this.page;
    const runtime = await this.load(this.home);
    if (!runtime) throw new Error("browser not installed on this machine; run walkie browser install");
    const state = await this.profiles.load(this.id, "primary") as Stored | null;
    const browser = await runtime.chromium.launch({ headless: !visible });
    try {
      const context = await browser.newContext({ ...(state?.browser ? { storageState: state.browser } : {}), acceptDownloads: false }) as ProfileContext;
      const page = await context.newPage();
      await page.goto(this.selectors.url, { waitUntil: "domcontentloaded" });
      this.browser = browser;
      this.context = context;
      this.page = page;
      this.seen = new Set(state?.seen ?? []);
      return page;
    } catch (error) { await browser.close(); throw error; }
  }

  private check(page: BrowserPage): void {
    if (new URL(page.url()).hostname !== this.selectors.host) throw new Error("channel browser left its authorized app");
  }

  private async conversation(page: BrowserPage): Promise<string | null> {
    this.check(page);
    if (this.selectors.id === "sms-gvoice") return smsGvoice.conversationId(page.url());
    const active = page.locator(whatsappWeb.active);
    if (await active.count() !== 1) return null;
    const id = await active.evaluate((el) => el.getAttribute("data-id") ?? "");
    return whatsappWeb.conversationId(id);
  }

  private async save(): Promise<void> {
    if (!this.context) return;
    const browser = await this.context.storageState({ indexedDB: true });
    await this.profiles.save(this.id, "primary", { browser, seen: [...this.seen].slice(-2_000) });
  }

  async openForLink(): Promise<void> {
    await this.close();
    await this.start(true);
    // The person uses the visible Chromium window. No agent enters QR codes or credentials.
  }

  async status(): Promise<ChannelState> {
    const page = await this.start(false);
    this.check(page);
    if (await page.locator(this.selectors.blocked).count()) return "blocked";
    if (await page.locator(this.selectors.linked).count()) { await this.save(); return "linked"; }
    return "logged_out";
  }

  async poll(): Promise<readonly IncomingMessage[]> {
    const page = await this.start(false);
    if (await this.status() !== "linked") return [];
    const out: IncomingMessage[] = [];
    const unread = page.locator(this.selectors.unread);
    const batchSeen = new Set<string>();
    for (let i = 0; i < 20 && await unread.count(); i++) {
      await unread.nth(0).elementHandle().then((el) => el?.click());
      this.check(page);
      const conversation = await this.conversation(page);
      const rows = page.locator(this.selectors.incoming) as unknown as Reader;
      const messages = await rows.evaluateAll((els) => els.map((el) => ({
        id: el.getAttribute("data-id") ?? el.getAttribute("data-message-id") ?? "",
        text: el.textContent?.trim() ?? "",
      })));
      for (const message of messages) {
        if (!message.text) continue;
        const identity = conversation ? this.selectors.incomingId(message.id, conversation) : null;
        const fingerprint = message.id || createHash("sha256").update(message.text).digest("hex");
        const id = `${conversation ?? "unidentified"}:${fingerprint}`;
        if (this.seen.has(id) || batchSeen.has(id)) continue;
        batchSeen.add(id);
        out.push({ id, from: identity?.sender ?? "", conversation: identity?.conversation ?? "", text: message.text.slice(0, 8_000) });
      }
    }
    await this.save();
    return out;
  }

  async acknowledge(id: string): Promise<void> {
    this.seen.add(id);
    await this.save();
  }

  async send(to: string, text: string, conversation: string): Promise<void> {
    if (!PHONE.test(to) || !text.trim() || text.length > 8_000) throw new Error("invalid channel reply");
    const expected = this.selectors.id === "whatsapp-web" ? `${to.slice(1)}@c.us` : `t.${to}`;
    if (conversation !== expected) throw new Error("channel recipient identity mismatch");
    const page = await this.start(false);
    if (await this.status() !== "linked") throw new Error("channel is logged out or blocked");
    this.check(page);
    const chat = page.locator(this.selectors.chatFor(conversation));
    if (await chat.count() !== 1) throw new Error("channel recipient missing or ambiguous");
    await chat.elementHandle().then((el) => el?.click());
    if (await this.conversation(page) !== conversation) throw new Error("channel conversation changed; reply refused");
    const composer = page.locator(this.selectors.composer) as unknown as Composer;
    if (await page.locator(this.selectors.composer).count() !== 1) throw new Error("channel composer missing or ambiguous");
    await composer.fill(text);
    if (await this.conversation(page) !== conversation) throw new Error("channel conversation changed; reply refused");
    await composer.press("Enter");
    await this.save();
  }

  async close(): Promise<void> {
    try { await this.save(); } finally {
      await this.browser?.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}

export const adaptersFor = (home: string): readonly ChannelAdapter[] => [
  new WebChannelAdapter(home, whatsappWeb), new WebChannelAdapter(home, smsGvoice),
];
