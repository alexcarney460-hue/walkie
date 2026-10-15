import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelGate } from "./policy.ts";
import { WebChannelAdapter } from "./web-adapter.ts";
import { whatsappWeb } from "./whatsapp-web.ts";
import { smsGvoice } from "./sms-gvoice.ts";
import { dispatch } from "../local-routes.ts";
import "./routes.ts";

const owner = "+15551230001";
const other = "+15551230002";

test("a number has one hourly quota across apps and the machine has one cap", () => {
  const gate = new ChannelGate(() => 1_000);
  for (let i = 0; i < 5; i++) expect(gate.receive("whatsapp-web", owner, owner, true)).toBe("accepted");
  for (let i = 0; i < 5; i++) expect(gate.receive("sms-gvoice", owner, owner, true)).toBe("accepted");
  expect(gate.receive("sms-gvoice", owner, owner, true)).toBe("limited");
  expect(gate.receive("whatsapp-web", other, owner, true)).toBe("unknown");
  const machine = new ChannelGate(() => 1_000);
  for (let n = 1; n <= 6; n++) {
    const number = `+1555123000${n}`;
    for (let i = 0; i < 10; i++) expect(machine.receive("whatsapp-web", number, number, true)).toBe("accepted");
  }
  expect(machine.receive("sms-gvoice", "+15551230007", "+15551230007", true)).toBe("limited");
});

test("previous per-app quota files consolidate without reopening the hourly number limit", () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-quota-r2-"));
  const file = join(home, "quota.json");
  writeFileSync(file, JSON.stringify({ ignored: 0, numbers: {
    [`whatsapp-web:${owner}`]: Array(5).fill(1_000), [`sms-gvoice:${owner}`]: Array(5).fill(1_000),
  }, channels: { "whatsapp-web": Array(5).fill(1_000), "sms-gvoice": Array(5).fill(1_000) } }));
  expect(new ChannelGate(() => 1_000, file, () => true).receive("sms-gvoice", owner, owner, true)).toBe("limited");
});

test("app IDs alone prove an incoming one-to-one sender", () => {
  expect(whatsappWeb.incomingId(`false_15551230001@c.us_ABC`, "15551230001@c.us"))
    .toEqual({ sender: owner, conversation: "15551230001@c.us" });
  for (const id of ["true_15551230001@c.us_ABC", "false_15551230001@g.us_ABC", "false_15551230001@lid_ABC", "", "false_15551230002@c.us_ABC"])
    expect(whatsappWeb.incomingId(id, "15551230001@c.us")).toBeNull();
  const thread = `t.${owner}`;
  expect(smsGvoice.conversationId(`https://voice.google.com/u/0/messages/${encodeURIComponent(thread)}`)).toBe(thread);
  expect(smsGvoice.incomingId(`incoming_${thread}_ABC`, thread)).toEqual({ sender: owner, conversation: thread });
  for (const id of [`incoming_t.${other}_ABC`, `outgoing_${thread}_ABC`, "", "incoming_t.+15551230001,+15551230002_ABC"])
    expect(smsGvoice.incomingId(id, thread)).toBeNull();
  expect(smsGvoice.conversationId("https://voice.google.com/u/0/messages/t.%2B15551230001,+15551230002")).toBeNull();
});

test("Google Voice adapter binds rows and final send to the thread URL", async () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-gvoice-r2-"));
  const thread = `t.${owner}`;
  let url = `https://voice.google.com/u/0/messages/${encodeURIComponent(thread)}`;
  let changeOnFill = false;
  let sends = 0;
  const page = {
    url: () => url, async goto() {},
    locator(selector: string) {
      return {
        async count() { return [smsGvoice.linked, smsGvoice.unread, smsGvoice.composer, smsGvoice.chatFor(thread)].includes(selector as never) ? 1 : 0; },
        nth() { return this; },
        async elementHandle() { return { async click() {} }; },
        async evaluateAll() { return [{ id: `incoming_${thread}_ABC`, text: "hello" }, { id: `incoming_t.${other}_WRONG`, text: "group member" }]; },
        async fill() { if (changeOnFill) url = `https://voice.google.com/u/0/messages/t.${other}`; },
        async press() { sends++; },
      };
    },
  };
  const adapter = new WebChannelAdapter(home, smsGvoice,
    { async load() { return null; }, async save() {} } as never,
    async () => ({ chromium: { async launch() { return { async newContext() { return { async newPage() { return page; }, async storageState() { return {}; } }; }, async close() {} }; } } }) as never);
  const rows = await adapter.poll();
  expect(rows.map((row) => row.from)).toEqual([owner, ""]);
  expect(rows[0]?.conversation).toBe(thread);
  await adapter.send(owner, "reply", thread);
  expect(sends).toBe(1);
  changeOnFill = true;
  await expect(adapter.send(owner, "do not send", thread)).rejects.toThrow("conversation changed");
  expect(sends).toBe(1);
  await adapter.close();
});

test("config setup requires separate registration and exact warning digest", async () => {
  const home = mkdtempSync(join(tmpdir(), "walkie-channels-r2-"));
  const notices: string[] = [];
  const core = { paths: { home, config: join(home, "config.json") }, hostname: "test", myHandle: () => "alex",
    teamId: "team", me: () => ({ handle: "alex" }), roster: { channels: new Map([["general", {}]]) },
    emit(_kind: string, body: { text: string }) { notices.push(body.text); return {}; }, log: { info() {}, warn() {} } };
  const call = (method: string, path: string, body?: object, extra?: object) => {
    const url = new URL(`http://walkie${path}`);
    const req = new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
    return dispatch({ req, url, core, via: "cli", noTimeout() {}, ...extra } as never);
  };
  const warning = await (await call("GET", "/v1/channels/config")).json() as { warning: string; warning_sha256: string };
  expect(warning.warning).toContain("may block the number");
  expect(warning.warning_sha256).toMatch(/^[a-f0-9]{64}$/);
  await expect(call("POST", "/v1/channels/config", { owner_number: owner, enabled: true, acknowledge_risk: warning.warning_sha256 })).rejects.toThrow();
  await call("POST", "/v1/channels/config", { owner_number: owner });
  await expect(call("POST", "/v1/channels/config", { enabled: true, acknowledge_risk: "bad" })).rejects.toThrow();
  await call("POST", "/v1/channels/config", { enabled: true, acknowledge_risk: warning.warning_sha256 });
  expect((readFileSync(join(home, "admin-audit.jsonl"), "utf8").match(/changed messaging channel settings/g) ?? []).length).toBe(2);
  expect(notices).toHaveLength(2);
  expect(notices.every((notice) => notice.includes("@alex"))).toBe(true);
  for (const extra of [{ agent: "other" }, { underAgent: true }, { req: new Request("http://walkie/v1/channels/config", { method: "POST", headers: { "x-walkie-talkie-shell": "1" }, body: JSON.stringify({ enabled: false }) }) }]) {
    await expect(call("POST", "/v1/channels/config", { enabled: false }, extra)).rejects.toThrow();
  }
  await expect(call("POST", "/v1/channels/link", { channel: "whatsapp-web" }, { req: new Request("http://walkie/v1/channels/link", { method: "POST", headers: { "x-walkie-admin-token": "remote" }, body: JSON.stringify({ channel: "whatsapp-web" }) }) })).rejects.toThrow();
});
