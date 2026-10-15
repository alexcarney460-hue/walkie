import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore } from "./profile.ts";
import { ChannelGate } from "./policy.ts";
import { WebChannelAdapter } from "./web-adapter.ts";
import { whatsappWeb } from "./whatsapp-web.ts";

const keys = new Map<string, Buffer>();
const keyStore = { kind: "keychain" as const,
  async get(id: string) { return keys.get(id) ?? null; },
  async put(id: string, key: Buffer) { if (keys.has(id)) return "exists" as const; keys.set(id, key); return "created" as const; },
};

test("channel profile is sealed at rest and bound to one account", async () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-channel-"));
  const store = new ProfileStore(home, keyStore);
  await store.save("whatsapp-web", "primary", { cookies: [{ name: "session", value: "secret-cookie" }] });
  const raw = readFileSync(join(home, "channels", "whatsapp-web", "primary.profile"));
  expect(raw.toString()).not.toContain("secret-cookie");
  expect(await store.load("whatsapp-web", "primary")).toEqual({ cookies: [{ name: "session", value: "secret-cookie" }] });
  expect(await store.load("sms-gvoice", "primary")).toBeNull();
});

test("unknown numbers are ignored; owner number is bounded and reply requires an inbound", () => {
  let time = 1_000;
  const gate = new ChannelGate(() => time);
  expect(gate.receive("whatsapp-web", "+15551230001", "+15551230002", true)).toBe("unknown");
  expect(gate.ignored).toBe(1);
  expect(gate.receive("whatsapp-web", "+15551230001", "+15551230001", false)).toBe("off");
  expect(gate.canReply("whatsapp-web", "+15551230001")).toBe(false);
  expect(gate.receive("whatsapp-web", "+15551230001", "+15551230001", true)).toBe("accepted");
  expect(gate.canReply("whatsapp-web", "+15551230001")).toBe(true);
  expect(gate.claimReply("whatsapp-web", "+15551230001")).toBe(true);
  expect(gate.canReply("whatsapp-web", "+15551230001")).toBe(false);
  for (let i = 1; i < 10; i++) gate.receive("whatsapp-web", "+15551230001", "+15551230001", true);
  expect(gate.receive("whatsapp-web", "+15551230001", "+15551230001", true)).toBe("limited");
  time += 3_600_001;
  expect(gate.canReply("whatsapp-web", "+15551230001")).toBe(false);
});

test("rate limits survive a daemon restart", () => {
  const file = join(mkdtempSync(join(tmpdir(), "walkie-channel-quota-")), "quota.json");
  new ChannelGate(() => 2_000, file).initializeQuota();
  for (let i = 0; i < 10; i++) expect(new ChannelGate(() => 2_000, file, () => true).receive("sms-gvoice", "+15551230001", "+15551230001", true)).toBe("accepted");
  expect(new ChannelGate(() => 2_000, file, () => true).receive("sms-gvoice", "+15551230001", "+15551230001", true)).toBe("limited");
});

test("adapter uses one account profile and refuses sending to a changed chat", async () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-channel-ui-"));
  let conversation = "15551230001@c.us";
  let sent = "";
  let sends = 0;
  let switchAfterFill = false;
  const page = {
    url: () => whatsappWeb.url,
    async goto() {},
    locator(selector: string) {
      return {
        async count() { return selector === whatsappWeb.linked || selector === whatsappWeb.unread || selector === whatsappWeb.composer || selector === whatsappWeb.active || selector === whatsappWeb.chatFor("15551230001@c.us") ? 1 : 0; },
        nth() { return this; },
        async elementHandle() { return { async click() {} }; },
        async evaluate() { return conversation; },
        async evaluateAll() { return [{ id: "false_15551230001@c.us_message-1", text: "hello" }]; },
        async fill(value: string) { sent = value; if (switchAfterFill) conversation = "15551239999@c.us"; },
        async press() { sends++; },
      };
    },
  };
  const context = { async newPage() { return page; }, async storageState() { return { cookies: [{ name: "s", value: "private" }] }; }, async close() {} };
  const runtime = { chromium: { async launch() { return { async newContext() { return context; }, async close() {} }; } } };
  const adapter = new WebChannelAdapter(home, whatsappWeb, new ProfileStore(home, keyStore), async () => runtime as never);
  expect(await adapter.status()).toBe("linked");
  expect(await adapter.poll()).toEqual([{ id: "15551230001@c.us:false_15551230001@c.us_message-1", from: "+15551230001", conversation: "15551230001@c.us", text: "hello" }]);
  await adapter.acknowledge("15551230001@c.us:false_15551230001@c.us_message-1");
  expect(await adapter.poll()).toEqual([]);
  conversation = "12345@g.us";
  const ignored = await adapter.poll();
  expect(ignored).toHaveLength(1);
  expect(ignored[0]?.from).toBe("");
  const gate = new ChannelGate();
  expect(gate.receive("whatsapp-web", ignored[0]!.from, "+15551230001", true)).toBe("unknown");
  expect(gate.ignored).toBe(1);
  conversation = "15551230001@c.us";
  await adapter.send("+15551230001", "reply", "15551230001@c.us");
  expect(sent).toBe("reply");
  expect(sends).toBe(1);
  switchAfterFill = true;
  await expect(adapter.send("+15551230001", "wrong recipient", "15551230001@c.us")).rejects.toThrow("conversation changed");
  expect(sends).toBe(1);
  await adapter.close();
});
