import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserUrl, browserRequestUrl, sensitiveValue, secretField, BrowserQuota, seatMayBrowse } from "./policy.ts";

test("browser policy denies unsafe schemes, private hosts, and owner-extended domains", () => {
  expect(() => browserUrl("file:///etc/passwd", [])).toThrow();
  expect(() => browserUrl("http://127.0.0.1", [])).toThrow();
  expect(() => browserUrl("https://mail.google.com", [])).toThrow();
  expect(() => browserUrl("https://a.example.org", ["example.org"])).toThrow();
  expect(browserUrl("https://example.org/path", [])).toBe("https://example.org/path");
  for (const host of ["8.8.8.8", "0x08080808", "134744072", "[2001:4860:4860::8888]", "[::1]", "2130706433", "localhost", "api.localhost"]) {
    expect(() => browserUrl(`https://${host}/`, [])).toThrow();
  }
});

test("every intercepted request rejects local DNS answers and literal IPs", async () => {
  for (const address of ["127.0.0.1", "10.0.0.2", "172.20.1.1", "192.168.1.2", "169.254.169.254", "100.64.1.2", "192.0.0.1", "198.18.0.1"]) {
    const privateDns = (async () => [{ address, family: 4 }]) as never;
    await expect(browserRequestUrl("https://public.example/image.png", [], privateDns)).rejects.toThrow("private address");
  }
  const privateDns = (async () => [{ address: "192.168.1.2", family: 4 }]) as never;
  await expect(browserRequestUrl("https://8.8.8.8/", [], privateDns)).rejects.toThrow();
  const publicDns = (async () => [{ address: "93.184.215.14", family: 4 }]) as never;
  expect(await browserRequestUrl("https://public.example/image.png", [], publicDns)).toBe("https://public.example/image.png");
  const ipv6Only = (async () => [{ address: "0:0:0:0:0:0:0:1", family: 6 }]) as never;
  await expect(browserRequestUrl("https://public.example/image.png", [], ipv6Only)).rejects.toThrow("private address");
});

test("field shape table refuses secrets while allowing ordinary fields", () => {
  const blocked = [
    { name: "cc_number", type: "tel" }, { name: "cc_csc", type: "tel" },
    { name: "cc-cvv", type: "text" }, { name: "creditCardNumber", type: "text" },
    { name: "debit_card", type: "text" }, { name: "payment-pan", type: "text" },
    { name: "expiry_month", type: "text" }, { name: "card exp", type: "text" },
    { name: "account", id: "cardNumber", type: "text" },
    { name: "account", label: "Security code", type: "tel" },
    { name: "account", autocomplete: "cc-number", type: "tel" },
    { name: "account", autocomplete: "cc-csc", type: "tel" },
    { name: "account", autocomplete: "cc-exp", type: "tel" },
    { name: "account", autocomplete: "current-password", type: "text" },
    { name: "account", autocomplete: "new-password", type: "text" },
    { name: "account", autocomplete: "one-time-code", type: "text" },
    { name: "passcode", type: "text" }, { name: "pin", type: "number" },
    { name: "otp", type: "tel" }, { name: "bank routing", type: "text" },
    { name: "Reference", id: "ccNumber", type: "text" },
    { name: "Reference", id: "pinCode", type: "text" },
    { name: "Reference", fieldName: "oneTimeCode", type: "text" },
    { name: "passphrase", type: "text" }, { id: "api_key", name: "Reference", type: "text" },
    { fieldName: "privateKey", name: "Reference", type: "text" },
    { label: "Recovery phrase", name: "Reference", type: "text" },
    { name: "Security answer", type: "text" }, { name: "seed", type: "text" },
    { name: "token", type: "text" }, { name: "secret", type: "text" },
    { name: "Reference", placeholder: "API key", type: "text" },
    { name: "Reference", ariaLabel: "Security answer", type: "text" },
  ];
  const allowed = [
    { name: "City", type: "text" }, { name: "ZIP code", type: "text" },
    { name: "Search", type: "search" }, { name: "Contact email", type: "email" },
    { name: "Phone", type: "tel" }, { name: "Quantity", type: "number" },
    { name: "Favorite color", type: "text" }, { name: "Display name", type: "text" },
    { name: "Comment", type: "textarea" }, { name: "Address", type: "text" },
    { name: "Start date", type: "date" }, { name: "Product size", type: "select" },
  ];
  for (const field of blocked) if (!secretField(field)) throw new Error(`secret field admitted: ${JSON.stringify(field)}`);
  for (const field of allowed) expect(secretField(field)).toBe(false);
  expect(sensitiveValue("4111 1111 1111 1111", { name: "Reference" })).toBe(true);
  expect(sensitiveValue("4111 1111 1111 1112", { name: "Reference" })).toBe(false);
  expect(sensitiveValue("123", { name: "Security code" })).toBe(true);
  expect(sensitiveValue("123", { name: "Quantity" })).toBe(false);
});

test("password and card fields are refused", () => {
  expect(secretField({ type: "password", name: "Account" })).toBe(true);
  expect(secretField({ type: "text", name: "card number" })).toBe(true);
  expect(secretField({ type: "tel", name: "cc-number" })).toBe(true);
  expect(secretField({ type: "tel", name: "Number", autocomplete: "cc-number" })).toBe(true);
  expect(secretField({ type: "text", name: "City" })).toBe(false);
});

test("every sensitive pattern is recognized across separators, case, camel case and trailing digits", () => {
  const patterns = ["password", "passcode", "passphrase", "secret", "token", "api key", "private key",
    "recovery", "seed", "security answer", "one time code", "security code", "cvv", "cvc", "csc",
    "card", "credit", "debit", "iban", "routing", "account number", "expiry", "expir", "cc", "pan", "pin", "otp"];
  for (const pattern of patterns) {
    const words = pattern.split(" ");
    const variants = [pattern.replaceAll(" ", "_"), pattern.replaceAll(" ", "-"),
      pattern.replaceAll(" ", "."), words.map((word, n) => n ? word[0]!.toUpperCase() + word.slice(1) : word).join(""),
      `${pattern.replaceAll(" ", "").toUpperCase()}1`];
    for (const value of variants) {
      for (const field of ["name", "id", "fieldName", "label", "placeholder", "ariaLabel"] as const)
        expect(secretField({ type: "text", name: "Reference", [field]: value })).toBe(true);
    }
  }
});

test("a conversation gets no more than 60 actions in a rolling hour", () => {
  const quota = new BrowserQuota();
  for (let n = 0; n < 60; n++) quota.take("thread", 1000);
  expect(() => quota.take("thread", 1000)).toThrow();
  quota.take("thread", 3_601_001);
});

test("hourly quota survives a new daemon instance", () => {
  const dir = mkdtempSync(join(tmpdir(), "walkie-browser-quota-"));
  try {
    const file = join(dir, "quota.json");
    const first = new BrowserQuota(file);
    for (let n = 0; n < 60; n++) first.take("thread", 1000);
    const second = new BrowserQuota(file);
    expect(() => second.take("thread", 1000)).toThrow("rate limit");
    second.take("thread", 3_601_001);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only an exact seat grant works while this machine's browser is on", () => {
  expect(seatMayBrowse(false, ["seat-abc"], "seat-abc")).toBe(false);
  expect(seatMayBrowse(true, ["seat-abc"], "seat-def")).toBe(false);
  expect(seatMayBrowse(true, ["seat-abc"], "seat-abc")).toBe(true);
  expect(seatMayBrowse(true, ["seats"], "seats")).toBe(false);
});
