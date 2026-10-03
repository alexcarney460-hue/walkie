// walkie doctor on a mixed team: a machine that shares no transport with part of the team says how many machines and
// which, that their agents show only while another machine that reaches them is in sync (or are hidden when none is),
// and the fix. Always a warning: it reports other machines' reachability, not this machine's health, and the macOS
// company-machine join treats any failing doctor as a failed join (test/integration/mixed-doctor.test.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { daemonChecks, unreachedCheck } from "../../src/cli/commands/doctor.ts";
import type { NodeView, TransportKind } from "../../src/protocol/schemas.ts";
import { fakeDaemon, type FakeDaemon } from "../helpers/fake-daemon.ts";

const TAILSCALE: TransportKind[] = ["tailscale"];
const DIRECT: TransportKind[] = ["direct"];
const DUAL: TransportKind[] = ["tailscale", "direct"];

const node = (hostname: string, over: Partial<NodeView> = {}): NodeView => ({
  node_id: hostname.padEnd(16, "0"), handle: "maren", hostname, ip: "100.64.0.9", online: true, last_seen: 1, rtt_ms: 3, self: false,
  sync: { behind: 0, last_sync: 1 }, ...over,
});
const me = node("maren-mbp", { self: true });
/** A Direct-only machine this one can't reach; `vouched`: a machine that reaches it says it is online. */
const directOnly = (hostname: string, vouched: boolean) => node(hostname, {
  ip: "", transports: DIRECT, via: "relay", online: vouched, unreached: { vouched },
});
/** The reverse: a Tailscale-only machine a Direct-only one can't reach. */
const tailscaleOnly = (hostname: string, vouched: boolean) => node(hostname, {
  transports: TAILSCALE, via: "relay", online: vouched, unreached: { vouched },
});
const reached = (hostname: string, via: "tailscale" | "direct") => node(hostname, { via });

const WARN_TAILSCALE = "2 machines use only Walkie Direct (atlas, hestia) and this machine can't reach them: their agents show here only while another machine that reaches them is in sync. Fix: walkie direct enable";
const HIDDEN_TAILSCALE = "2 machines use only Walkie Direct (atlas, hestia) and this machine can't reach them: no machine that reaches them is in sync now, so their agents are hidden here (or those machines are off). Fix: walkie direct enable";

describe("a Tailscale-only machine", () => {
  test("some of the Direct-only machines are shown through another machine: a warning with the fix", () => {
    const check = unreachedCheck(TAILSCALE, [me, reached("alex-mac", "tailscale"), directOnly("atlas", true), directOnly("hestia", false)]);
    expect(check).toEqual({ level: "warn", name: "mixed transports", detail: WARN_TAILSCALE });
  });

  test("every Direct-only machine is unvouched, their agents hidden: still a warning, worded as hidden, with the same fix", () => {
    const check = unreachedCheck(TAILSCALE, [me, directOnly("atlas", false), directOnly("hestia", false)]);
    expect(check).toEqual({ level: "warn", name: "mixed transports", detail: HIDDEN_TAILSCALE });
  });

  test("the \"off\" remark belongs to the hidden wording only: machines shown through another machine are online", () => {
    expect(unreachedCheck(TAILSCALE, [me, directOnly("atlas", true), directOnly("hestia", false)])?.detail).not.toContain("off");
    expect(unreachedCheck(TAILSCALE, [me, directOnly("atlas", true), directOnly("hestia", true)])?.detail).not.toContain("off");
    expect(unreachedCheck(TAILSCALE, [me, directOnly("atlas", false), directOnly("hestia", false)])?.detail).toContain("(or those machines are off)");
  });

  test("one machine: singular wording, same level and fix", () => {
    expect(unreachedCheck(TAILSCALE, [me, directOnly("atlas", true)])).toEqual({
      level: "warn", name: "mixed transports",
      detail: "1 machine uses only Walkie Direct (atlas) and this machine can't reach it: its agents show here only while another machine that reaches it is in sync. Fix: walkie direct enable",
    });
    expect(unreachedCheck(TAILSCALE, [me, directOnly("atlas", false)])).toEqual({
      level: "warn", name: "mixed transports",
      detail: "1 machine uses only Walkie Direct (atlas) and this machine can't reach it: no machine that reaches it is in sync now, so its agents are hidden here (or that machine is off). Fix: walkie direct enable",
    });
  });

  test("a dual machine whose Direct was just turned on (its record not yet listing it) still gets the command to run again", () => {
    expect(unreachedCheck(DUAL, [me, directOnly("atlas", false)])?.detail).toEndWith("Fix: walkie direct enable");
  });
});

describe("a Direct-only machine", () => {
  test("Tailscale-only machines it can't reach: Tailscale is optional here, the other machines run the command", () => {
    const fix = "Tailscale is optional on this machine; the other machines should run walkie direct enable";
    expect(unreachedCheck(DIRECT, [me, reached("alex-mac", "direct"), tailscaleOnly("atlas", true), tailscaleOnly("hestia", false)])).toEqual({
      level: "warn", name: "mixed transports",
      detail: `2 machines use only Tailscale (atlas, hestia) and this machine can't reach them: their agents show here only while another machine that reaches them is in sync. Fix: ${fix}`,
    });
    expect(unreachedCheck(DIRECT, [me, tailscaleOnly("atlas", false), tailscaleOnly("hestia", false)])).toEqual({
      level: "warn", name: "mixed transports",
      detail: `2 machines use only Tailscale (atlas, hestia) and this machine can't reach them: no machine that reaches them is in sync now, so their agents are hidden here (or those machines are off). Fix: ${fix}`,
    });
  });
});

describe("never a failing check", () => {
  test("whichever transports this machine serves and however many machines are hidden or shown, the level is a warning", () => {
    for (const serving of [TAILSCALE, DIRECT, DUAL]) {
      const peer = (host: string, vouched: boolean) => (serving.includes("tailscale") ? directOnly(host, vouched) : tailscaleOnly(host, vouched));
      for (const vouched of [[false], [true], [false, false], [true, false], [true, true], [false, false, false]]) {
        const nodes = [me, ...vouched.map((v, i) => peer(`m${i}`, v))];
        expect([serving, vouched, unreachedCheck(serving, nodes)?.level]).toEqual([serving, vouched, "warn"]);
      }
    }
  });
});

describe("nothing to say", () => {
  test("a machine that reaches every machine, one with no other machines, and a daemon from before the view", () => {
    expect(unreachedCheck(DUAL, [me, reached("alex-mac", "tailscale"), reached("carol-mbp", "direct")])).toBeNull();
    expect(unreachedCheck(TAILSCALE, [me])).toBeNull();
    // An older daemon marks the machine `via: "relay"` but sends no `unreached`: no claim is made about it.
    expect(unreachedCheck(TAILSCALE, [me, node("atlas", { via: "relay", transports: DIRECT, online: false })])).toBeNull();
    // Only a peer counts: this machine's own entry never does.
    expect(unreachedCheck(TAILSCALE, [{ ...me, unreached: { vouched: false } }])).toBeNull();
  });
});

describe("the names", () => {
  test("at most eight are listed, then the number left", () => {
    const many = Array.from({ length: 11 }, (_, i) => directOnly(`m${String(i).padStart(2, "0")}`, false));
    const detail = unreachedCheck(TAILSCALE, [me, ...many])?.detail;
    expect(detail).toStartWith("11 machines use only Walkie Direct (m00, m01, m02, m03, m04, m05, m06, m07 and 3 more) and");
  });

  test("terminal control characters in a machine name are dropped", () => {
    const detail = unreachedCheck(TAILSCALE, [me, directOnly("at\u001b[31mlas\u0007", false)])?.detail;
    expect(detail).toContain("(at[31mlas)");
    expect(detail).not.toContain("\u001b");
    expect(detail).not.toContain("\u0007");
  });
});

describe("walkie doctor against a daemon", () => {
  let daemon: FakeDaemon | null = null;
  const savedSocket = process.env.WALKIE_SOCKET;
  afterEach(() => {
    daemon?.stop();
    daemon = null;
    if (savedSocket === undefined) delete process.env.WALKIE_SOCKET; else process.env.WALKIE_SOCKET = savedSocket;
  });

  /** The daemon-side checks of `walkie doctor` against a stand-in daemon reporting `nodes` and serving `transports`. */
  async function checks(transports: TransportKind[], nodes: NodeView[], mode: TransportKind = transports.includes("tailscale") ? "tailscale" : "direct") {
    daemon?.stop();
    const direct = transports.includes("direct") ? { direct: { endpoint: "a".repeat(64), relay: "https://relay.example./" } } : {};
    daemon = fakeDaemon({
      "GET /v1/healthz": { ok: true, version: "0.2.0" },
      "GET /v1/me": {
        version: "0.2.0", protocol: 1, team: { id: "t", name: "harbor" }, node: { id: "n", hostname: "maren-mbp", ip: "100.64.0.9", port: 7458 },
        handle: "maren", role: "owner", tailscale: { ok: mode === "tailscale" }, transport: { mode, transports }, plan: null,
      },
      "GET /v1/diag": { version: "0.2.0", peer_listen: "100.64.0.9:7458", peer_api: { state: "up", listen: "100.64.0.9:7458" }, pending: 0, conflicts: [], now: 1, ...direct },
      "GET /v1/peers": { nodes },
    });
    process.env.WALKIE_SOCKET = daemon.socket;
    const out: Parameters<typeof daemonChecks>[0] = [];
    await daemonChecks(out);
    return out;
  }

  test("a Tailscale-only machine: the check is in the report, a warning even when every Direct-only machine is hidden", async () => {
    const out = await checks(TAILSCALE, [me, reached("alex-mac", "tailscale"), directOnly("atlas", false), directOnly("hestia", false)]);
    expect(out.filter((c) => c.name === "mixed transports")).toEqual([{ level: "warn", name: "mixed transports", detail: HIDDEN_TAILSCALE }]);
    // The per-machine lines are still there.
    expect(out.find((c) => c.name === "peer atlas")?.detail).toContain("no transport in common");
    // Nothing in this machine's report fails because other machines can't be reached (doctor's exit status follows failures).
    expect(out.filter((c) => c.level === "fail")).toEqual([]);
  });

  test("one Direct-only machine shown through another: a warning", async () => {
    const out = await checks(TAILSCALE, [me, directOnly("atlas", true), directOnly("hestia", false)]);
    expect(out.find((c) => c.name === "mixed transports")).toEqual({ level: "warn", name: "mixed transports", detail: WARN_TAILSCALE });
  });

  test("a Direct-only machine gets the Direct-only advice, and its report has no failure while every Tailscale-only machine is hidden", async () => {
    const out = await checks(DIRECT, [me, tailscaleOnly("atlas", false)]);
    expect(out.find((c) => c.name === "mixed transports")).toMatchObject({ level: "warn" });
    expect(out.find((c) => c.name === "mixed transports")?.detail).toContain("Tailscale is optional on this machine; the other machines should run walkie direct enable");
    expect(out.filter((c) => c.level === "fail")).toEqual([]);
  });

  test("a dual machine, and an older daemon that sends no `unreached`, add no such check", async () => {
    expect((await checks(DUAL, [me, reached("alex-mac", "tailscale"), reached("carol-mbp", "direct")])).some((c) => c.name === "mixed transports")).toBe(false);
    expect((await checks(TAILSCALE, [me, node("atlas", { via: "relay", transports: DIRECT, online: false })])).some((c) => c.name === "mixed transports")).toBe(false);
  });
});
