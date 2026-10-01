// Rental compute building blocks: money, the public catalogue, the private config, request validation, the
// cloud-init user-data, FakeCloud and the DigitalOcean driver (asserting the exact requests it would send; no network).
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quotes, TIERS } from "../api/_lib/compute/catalog.ts";
import { userData } from "../api/_lib/compute/cloud-init.ts";
import { DigitalOceanDriver, doTags, fromDoTags, type Fetch } from "../api/_lib/compute/digitalocean.ts";
import { CapacityError, DriverError, rentalTags } from "../api/_lib/compute/driver.ts";
import { FakeCloud } from "../api/_lib/compute/fake-cloud.ts";
import { hoursLeft, priceOfMinutes, startedMinutes } from "../api/_lib/compute/money.ts";
import { ConfigError, parsePrivateConfig } from "../api/_lib/compute/private-config.ts";
import { tokenHash, tokenMatches, newToken } from "../api/_lib/compute/tokens.ts";
import { checkHeartbeat, checkRent, checkStop } from "../api/_lib/compute/validate.ts";
import { codes, configJson, joinCode, T0 } from "./compute-helpers.ts";

describe("money", () => {
  test("started minutes and prices", () => {
    expect(startedMinutes(T0, T0)).toBe(1);
    expect(startedMinutes(T0, T0 + 1)).toBe(1);
    expect(startedMinutes(T0, T0 + 60_000)).toBe(1);
    expect(startedMinutes(T0, T0 + 60_001)).toBe(2);
    expect(priceOfMinutes(750_000, 1)).toBe(12_500);
    expect(priceOfMinutes(1_520_000, 1)).toBe(25_334); // rounded up
    expect(priceOfMinutes(1_520_000, 60)).toBe(1_520_000); // exact per hour
    expect(hoursLeft(1_500_000, 750_000)).toBe(2);
    expect(hoursLeft(5, 0)).toBeNull();
  });
});

describe("catalogue", () => {
  test("five tiers with the decided prices; GPUs bill a 5-minute minimum; egress terms", () => {
    const q = quotes();
    expect(q.tiers.map((t) => [t.id, t.price_per_hour_micros, t.min_minutes])).toEqual([
      ["agent", 750_000, 1], ["agent-xl", 1_500_000, 1], ["gpu-20", 1_520_000, 5], ["gpu-48", 3_140_000, 5], ["gpu-80", 8_820_000, 5],
    ]);
    expect(q.tiers.every((t) => t.price_per_month_micros === t.price_per_hour_micros * 730)).toBe(true);
    expect(q).toMatchObject({ currency: "usd", credit_blocks: [50, 200, 1000], min_hours_covered: 1, egress_included_gib: 1024, egress_price_per_gib_micros: 20_000 });
    expect(TIERS.find((t) => t.id === "gpu-20")!.gpu).toBe("NVIDIA RTX 4000 Ada 20 GB");
  });
});

describe("private config", () => {
  test("parses the full config", () => {
    const c = parsePrivateConfig(configJson());
    expect(c.tiers["gpu-48"]).toMatchObject({ provider: "fake", instance_type: "gpu-l40sx1-48gb", region: "tor1", quota_group: "gpu" });
    expect(c.quotas).toEqual({ cpu: 100, gpu: 16 });
  });

  test("refuses missing, malformed and loss-making configs without echoing values", () => {
    expect(() => parsePrivateConfig(undefined)).toThrow(ConfigError);
    expect(() => parsePrivateConfig("{")).toThrow("not JSON");
    const full = JSON.parse(configJson());
    const broken = (f: (c: typeof full) => void) => { const c = structuredClone(full); f(c); return JSON.stringify(c); };
    expect(() => parsePrivateConfig(broken((c) => { delete c.tiers["gpu-80"]; }))).toThrow("tier gpu-80 missing");
    expect(() => parsePrivateConfig(broken((c) => { c.tiers.agent.cost_per_hour_micros = 375_001; }))).toThrow("price below 2x cost");
    expect(() => parsePrivateConfig(broken((c) => { c.tiers.agent.quota_group = "nope"; }))).toThrow("unknown quota_group");
    expect(() => parsePrivateConfig(broken((c) => { c.tiers.agent.region = "NYC 3; rm"; }))).toThrow("bad region");
    try {
      parsePrivateConfig(broken((c) => { c.tiers.agent.cost_per_hour_micros = 999_999; }));
    } catch (e) {
      expect((e as Error).message).not.toContain("999");
    }
  });
});

describe("validation", () => {
  const base = () => ({ idempotency_key: "k".repeat(20), machines: [{ tier: "agent", count: 2 }, { tier: "gpu-20", count: 1 }], codes: codes(3), walkie_version: "v0.2.0-pre.7" });
  test("rent bodies", () => {
    expect(checkRent(base())).toMatchObject({ ok: true });
    expect(checkRent({ ...base(), codes: codes(2) })).toEqual({ ok: false, error: "codes_mismatch" });
    expect(checkRent({ ...base(), machines: [{ tier: "gpu-24", count: 1 }], codes: codes(1) })).toEqual({ ok: false, error: "invalid_tier" });
    expect(checkRent({ ...base(), machines: [{ tier: "agent", count: 1 }, { tier: "agent", count: 1 }], codes: codes(2) })).toEqual({ ok: false, error: "invalid_tier" });
    expect(checkRent({ ...base(), machines: [{ tier: "agent", count: 51 }], codes: codes(51) })).toEqual({ ok: false, error: "invalid_count" });
    expect(checkRent({ ...base(), machines: [{ tier: "agent", count: 30 }, { tier: "gpu-20", count: 30 }], codes: codes(60) })).toEqual({ ok: false, error: "too_many_machines" });
    const c = joinCode();
    expect(checkRent({ ...base(), machines: [{ tier: "agent", count: 2 }], codes: [c, c] })).toEqual({ ok: false, error: "duplicate_code" });
    expect(checkRent({ ...base(), codes: ["wk1'; rm -rf /", ...codes(2)] })).toEqual({ ok: false, error: "invalid_code" });
    expect(checkRent({ ...base(), walkie_version: "latest" })).toEqual({ ok: false, error: "invalid_walkie_version" });
    expect(checkRent({ ...base(), cost: 1 })).toEqual({ ok: false, error: "unknown_field" });
  });
  test("stop and heartbeat bodies", () => {
    expect(checkStop({ all: true })).toEqual({ ok: true, value: { all: true } });
    expect(checkStop({ all: false })).toEqual({ ok: false, error: "unknown_field" });
    expect(checkHeartbeat({ rental_id: "r_0123456789abcdef", token: newToken(), busy_seats: 1, pool_jobs: 0, cpu_pct: 101, egress_bytes: 0 })).toEqual({ ok: false, error: "invalid_load" });
  });
});

describe("tokens", () => {
  test("hash + constant-time match", () => {
    const t = newToken();
    expect(tokenMatches(t, tokenHash(t))).toBe(true);
    expect(tokenMatches(newToken(), tokenHash(t))).toBe(false);
    expect(tokenMatches(t, null)).toBe(false);
  });
});

describe("cloud-init user-data", () => {
  const params = () => ({
    rentalId: "r_0123456789abcdef", joinCode: joinCode(), heartbeatToken: newToken(), walkieVersion: "v0.2.0-pre.7",
    siteOrigin: "https://getwalkie.vercel.app", hostname: "rent-agent-7f3a", egressRateMbit: 1000,
  });

  test("valid bash; pins the signed release; joins with the code; team agents on as seat users; no same-user; no logins", () => {
    const p = params();
    const u = userData(p);
    const dir = mkdtempSync(join(tmpdir(), "rent-ud-"));
    writeFileSync(join(dir, "ud.sh"), u);
    expect(spawnSync("bash", ["-n", join(dir, "ud.sh")]).status).toBe(0);
    const hb = /<<'HB'\n([\s\S]*?)\nHB\n/.exec(u)?.[1] ?? "";
    writeFileSync(join(dir, "hb.sh"), hb);
    expect(hb).toContain("/api/compute/heartbeat");
    expect(spawnSync("bash", ["-n", join(dir, "hb.sh")]).status).toBe(0);
    expect(u).toContain(`curl -fsSL https://getwalkie.vercel.app/install.sh | WALKIE_VERSION=v0.2.0-pre.7 sh -s -- --invite ${p.joinCode} --allow-team-agents --seat-users`);
    expect(u).not.toContain("same-user");
    expect(u).toContain("-d 169.254.0.0/16 -m owner ! --uid-owner 0 -j REJECT");
    expect(u).toContain("tbf rate 1000mbit");
    expect(u).toContain("rm -f /etc/sudoers.d/90-walkie-bootstrap");
    expect(u).not.toMatch(/ssh-(rsa|ed25519)|authorized_keys|CLAUDE|ANTHROPIC|OPENAI/);
  });

  test("refuses any value that could break out of its quotes", () => {
    expect(() => userData({ ...params(), joinCode: "wk1abc'$(id)" })).toThrow("bad join code");
    expect(() => userData({ ...params(), walkieVersion: "v1.0.0;id" })).toThrow("bad walkie version");
    expect(() => userData({ ...params(), hostname: "rent-a'b" })).toThrow("bad hostname");
    expect(() => userData({ ...params(), siteOrigin: "http://evil.test" })).toThrow("bad site origin");
  });
});

describe("FakeCloud", () => {
  test("idempotent on the key; capacity per type; list and terminate", async () => {
    const f = new FakeCloud({ slots: { small: 1 } });
    const req = { idempotency_key: "r_1:1", instance_type: "small", region: null, image: null, user_data: "x", name: "rent-a", tags: rentalTags("r_1", "t", "a") };
    const a = await f.provision(req);
    expect(await f.provision(req)).toEqual(a);
    await expect(f.provision({ ...req, idempotency_key: "r_2:1" })).rejects.toBeInstanceOf(CapacityError);
    expect((await f.list()).map((i) => i.instance_id)).toEqual([a.instance_id]);
    await f.terminate(a.instance_id);
    await f.terminate(a.instance_id);
    expect(await f.list()).toEqual([]);
  });
});

describe("DigitalOcean driver (requests asserted, nothing sent)", () => {
  const TOKEN = "dop_v1_" + "0".repeat(64);
  type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

  function fakeFetch(answers: (c: Call) => { status: number; body?: unknown }): { fetch: Fetch; calls: Call[] } {
    const calls: Call[] = [];
    const f: Fetch = async (url, init) => {
      const c: Call = { url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(init.body as string) : undefined };
      calls.push(c);
      expect(init.redirect).toBe("error");
      const a = answers(c);
      return new Response(a.status === 204 ? null : JSON.stringify(a.body ?? {}), { status: a.status });
    };
    return { fetch: f, calls };
  }

  const req = {
    idempotency_key: "r_0123456789abcdef:1", instance_type: "gpu-l40sx1-48gb", region: "tor1", image: "ubuntu-24-04-x64",
    user_data: "#!/bin/bash\necho hi\n", name: "rent-gpu-48-7f3a", tags: rentalTags("r_0123456789abcdef", "0123456789abcdef", "ca_0123456789abcdef"),
  };

  test("provision looks up the launch tag, then creates one droplet with user_data, tags, no SSH keys, no agent", async () => {
    const { fetch, calls } = fakeFetch((c) => c.method === "GET" ? { status: 200, body: { droplets: [], links: {} } } : { status: 202, body: { droplet: { id: 4242 } } });
    const d = new DigitalOceanDriver(TOKEN, fetch);
    expect(await d.provision(req)).toEqual({ instance_id: "4242" });
    expect(calls[0]).toMatchObject({ method: "GET", url: "https://api.digitalocean.com/v2/droplets?tag_name=walkie-launch%3Ar_0123456789abcdef%3A1&per_page=200&page=1" });
    expect(calls[1]!.method).toBe("POST");
    expect(calls[1]!.url).toBe("https://api.digitalocean.com/v2/droplets");
    expect(calls[1]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[1]!.body).toEqual({
      name: "rent-gpu-48-7f3a", region: "tor1", size: "gpu-l40sx1-48gb", image: "ubuntu-24-04-x64", user_data: "#!/bin/bash\necho hi\n",
      tags: ["walkie-managed", "walkie-rental:r_0123456789abcdef", "walkie-team:0123456789abcdef", "walkie-account:ca_0123456789abcdef", "walkie-launch:r_0123456789abcdef:1"],
      ssh_keys: [], backups: false, ipv6: true, monitoring: false, with_droplet_agent: false,
    });
  });

  test("a retried launch finds the droplet by its launch tag instead of making a second one", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { droplets: [{ id: 99, status: "new", tags: [] }], links: {} } }));
    expect(await new DigitalOceanDriver(TOKEN, fetch).provision(req)).toEqual({ instance_id: "99" });
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  test("limits and sold-out sizes are capacity (queue); other errors are driver errors, 429/5xx retryable", async () => {
    const answer = (status: number, message: string) => fakeFetch((c) => c.method === "GET" ? { status: 200, body: { droplets: [] } } : { status, body: { id: "x", message } }).fetch;
    await expect(new DigitalOceanDriver(TOKEN, answer(422, "You have reached the droplet limit")).provision(req)).rejects.toBeInstanceOf(CapacityError);
    await expect(new DigitalOceanDriver(TOKEN, answer(422, "Size is not available in this region.")).provision(req)).rejects.toBeInstanceOf(CapacityError);
    const e = await new DigitalOceanDriver(TOKEN, answer(429, "slow down")).provision(req).catch((x) => x);
    expect(e).toBeInstanceOf(DriverError);
    expect(e.retryable).toBe(true);
    const bad = await new DigitalOceanDriver(TOKEN, answer(401, "unauthorized")).provision(req).catch((x) => x);
    expect(bad).toMatchObject({ retryable: false });
    expect(String(bad.message)).not.toContain(TOKEN);
  });

  test("terminate is DELETE and treats 404 as done; list pages through the managed tag and maps tags back", async () => {
    const { fetch, calls } = fakeFetch((c) => {
      if (c.method === "DELETE") return { status: c.url.endsWith("/1") ? 204 : 404 };
      if (c.url.endsWith("/droplets/1")) return { status: 404 };
      const page = new URL(c.url).searchParams.get("page");
      return page === "1"
        ? { status: 200, body: { droplets: [{ id: 1, status: "active", tags: ["walkie-managed", "walkie-rental:r_0123456789abcdef"] }], links: { pages: { next: "p2" } } } }
        : { status: 200, body: { droplets: [{ id: 2, status: "archive", tags: [] }], links: {} } };
    });
    const d = new DigitalOceanDriver(TOKEN, fetch);
    await d.terminate("1");
    await d.terminate("2");
    expect(calls.filter(c => c.method === "DELETE").slice(0, 2).map((c) => [c.method, c.url])).toEqual([["DELETE", "https://api.digitalocean.com/v2/droplets/1"], ["DELETE", "https://api.digitalocean.com/v2/droplets/2"]]);
    expect(await d.list()).toEqual([{ instance_id: "1", state: "running", tags: { "walkie:managed": "1", "walkie:rental": "r_0123456789abcdef" } }]);
    await expect(d.terminate("1; rm")).rejects.toBeInstanceOf(DriverError);
  });

  test("tag mapping round-trips", () => {
    const tags = rentalTags("r_0123456789abcdef", "0123456789abcdef", "ca_0123456789abcdef");
    expect(fromDoTags(doTags(tags))).toEqual(tags);
  });

  test('renewal attaches a new paid deadline before removing the old one', async () => {
    const old = 'wk-paid-until-1790000900';
    const next = 'wk-paid-until-1790000960';
    const { fetch, calls } = fakeFetch(c => c.method === 'GET'
      ? { status: 200, body: { droplet: { id: 42, tags: ['walkie-managed', old] } } }
      : { status: c.url.endsWith('/tags') ? 201 : 204 });
    await new DigitalOceanDriver(TOKEN, fetch).setPaidUntil('42', 1_790_000_960_000);
    expect(calls.map(c => [c.method, c.url])).toEqual([
      ['GET', 'https://api.digitalocean.com/v2/droplets/42'],
      ['POST', 'https://api.digitalocean.com/v2/tags'],
      ['POST', `https://api.digitalocean.com/v2/tags/${next}/resources`],
      ['DELETE', `https://api.digitalocean.com/v2/tags/${old}/resources`],
    ]);
    expect(calls[2]!.body).toEqual({ resources: [{ resource_id: '42', resource_type: 'droplet' }] });
  });

  test("no region or image in the private config → refused before any request", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200 }));
    await expect(new DigitalOceanDriver(TOKEN, fetch).provision({ ...req, region: null })).rejects.toBeInstanceOf(DriverError);
    expect(calls).toHaveLength(0);
  });
});
