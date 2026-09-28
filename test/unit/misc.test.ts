import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, UsageError } from "../../src/cli/args.ts";
import { addressedTo } from "../../src/daemon/asks.ts";
import { loadConfig } from "../../src/daemon/config.ts";
import { parseWhois, shortNodeName } from "../../src/daemon/identity.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { parsePeerTarget } from "../../src/daemon/peer-client.ts";
import { RateLimiter } from "../../src/daemon/ratelimit.ts";
import { planService } from "../../src/daemon/service.ts";
import { askState, effectiveState, STALE_STATUS_MS } from "../../src/daemon/views.ts";
import type { Event } from "../../src/protocol/schemas.ts";

describe("RateLimiter", () => {
  test("token bucket limits then refills", () => {
    const rl = new RateLimiter();
    const spec = { capacity: 3, perSecond: 1 };
    const t = 1_000_000;
    expect([rl.take("a", spec, t), rl.take("a", spec, t), rl.take("a", spec, t), rl.take("a", spec, t)]).toEqual([true, true, true, false]);
    expect(rl.take("b", spec, t)).toBe(true); // independent keys
    expect(rl.take("a", spec, t + 999)).toBe(false);
    expect(rl.take("a", spec, t + 2_100)).toBe(true);
  });
});

describe("addressing", () => {
  const me = { handle: "kira", hostname: "kiras-mbp" };
  test("handle / machine / agent levels", () => {
    expect(addressedTo("@kira", me)).toBe(true);
    expect(addressedTo("@kira/kiras-mbp", me)).toBe(true);
    expect(addressedTo("@kira/other", me)).toBe(false);
    expect(addressedTo("@alex", me)).toBe(false);
    expect(addressedTo("@kira/kiras-mbp/ux", { ...me, agent: "ux" })).toBe(true);
    expect(addressedTo("@kira/kiras-mbp/ux", { ...me, agent: "db" })).toBe(false);
    expect(addressedTo("@kira/kiras-mbp/ux", me)).toBe(true); // a human sees all of their asks
  });
});

describe("agent + ask state", () => {
  const now = 10_000_000;
  test("effective_state", () => {
    expect(effectiveState("working", now - 1000, true, now)).toBe("working");
    expect(effectiveState("working", now - 1000, false, now)).toBe("offline");
    expect(effectiveState("working", now - STALE_STATUS_MS - 1, true, now)).toBe("offline");
    expect(effectiveState("idle", now - STALE_STATUS_MS * 10, true, now)).toBe("idle");
  });
  test("ask state", () => {
    const ask = { body: { expires_at: now + 1000 } } as unknown as Event;
    const yes = { body: { text: "y" } } as unknown as Event;
    const no = { body: { text: "n", declined: true } } as unknown as Event;
    expect(askState(ask, [], now)).toBe("open");
    expect(askState(ask, [], now + 2000)).toBe("expired");
    expect(askState(ask, [no], now)).toBe("declined");
    // D6: the first valid answer decides, a decline included (was: any non-declined answer won).
    expect(askState(ask, [no, yes], now)).toBe("declined");
    expect(askState(ask, [yes, no], now)).toBe("answered");
  });
});

describe("parsing", () => {
  test("peer targets", () => {
    expect(parsePeerTarget("100.1.2.3", 7458)).toEqual({ ip: "100.1.2.3", port: 7458 });
    expect(parsePeerTarget("alex-mac:9000", 7458)).toEqual({ ip: "alex-mac", port: 9000 });
    expect(parsePeerTarget("[fd7a::1]:7", 7458)).toEqual({ ip: "fd7a::1", port: 7 });
    expect(() => parsePeerTarget("http://x", 7458)).toThrow();
    expect(() => parsePeerTarget("x:99999", 7458)).toThrow();
  });
  test("whois json", () => {
    const j = JSON.stringify({ Node: { Name: "Sams-MacBook-Air.tail1.ts.net." }, UserProfile: { LoginName: "a@b.c" } });
    expect(parseWhois(j)).toEqual({ login: "a@b.c", nodeName: "sams-macbook-air" });
    expect(parseWhois(JSON.stringify({ Node: { Name: "x" }, UserProfile: { LoginName: "tagged-devices" } }))).toBeNull();
    expect(parseWhois("nope")).toBeNull();
    expect(shortNodeName("Alex’s MacBook")).toBe("alex-s-macbook");
  });
  test("argv", () => {
    const a = parseArgs(["#b", "hello", "--thread", "x:1", "--raw", "--limit=5", "-o", "f", "--", "--literal"], new Set(["raw"]));
    expect(a.pos).toEqual(["#b", "hello", "--literal"]);
    expect(a.flags.get("thread")).toBe("x:1");
    expect(a.flags.get("raw")).toBe(true);
    expect(a.flags.get("limit")).toBe("5");
    expect(a.flags.get("output")).toBe("f");
    expect(() => parseArgs(["--thread"], new Set())).toThrow(UsageError);
  });
});

describe("config / logger / service", () => {
  test("config defaults, file values and env overrides", () => {
    const dir = mkdtempSync("/tmp/walkie-cfg-");
    try {
      const path = join(dir, "config.json");
      expect(loadConfig(path, false).peer_port).toBe(7458);
      expect(existsSync(path)).toBe(true);
      writeFileSync(path, JSON.stringify({ peer_port: 9000, auto_admit: false }));
      expect(loadConfig(path, false)).toMatchObject({ peer_port: 9000, auto_admit: false, local_port: 7457 });
      process.env.WALKIE_PEER_PORT = "9100";
      process.env.WALKIE_PEER_HOST = "127.0.0.1";
      expect(loadConfig(path)).toMatchObject({ peer_port: 9100, peer_host: "127.0.0.1" });
      process.env.WALKIE_PEER_PORT = "nope";
      expect(() => loadConfig(path)).toThrow(/WALKIE_PEER_PORT/);
      writeFileSync(path, "{bad");
      expect(() => loadConfig(path, false)).toThrow(/not valid JSON/);
    } finally {
      delete process.env.WALKIE_PEER_PORT;
      delete process.env.WALKIE_PEER_HOST;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("logger writes JSON lines and rotates", () => {
    const dir = mkdtempSync("/tmp/walkie-log-");
    try {
      const file = join(dir, "daemon.log");
      const log = createLogger({ file, maxBytes: 200, keep: 2 });
      for (let i = 0; i < 20; i++) log.info("line", { i });
      expect(existsSync(`${file}.1`)).toBe(true);
      expect(existsSync(`${file}.2`)).toBe(true);
      expect(existsSync(`${file}.3`)).toBe(false);
      const last = readFileSync(file, "utf8").trim().split("\n").pop() ?? "{}";
      expect(JSON.parse(last)).toMatchObject({ level: "info", msg: "line", i: 19 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("service plan (dry run) is well-formed for this platform", () => {
    const plan = planService("/tmp/walkie-home");
    if (process.platform === "darwin") {
      expect(plan.path).toMatch(/Library\/LaunchAgents\/dev\.walkie\.daemon\.plist$/);
      expect(plan.content).toContain("<key>KeepAlive</key><true/>");
      expect(plan.content).toContain("<string>daemon</string>");
      expect(plan.content).toContain("<string>/tmp/walkie-home</string>");
      expect(plan.load[0]?.[0]).toBe("launchctl");
    } else {
      expect(plan.content).toContain("Restart=always");
    }
  });
});
