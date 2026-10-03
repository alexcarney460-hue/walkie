// WALK-65 / WALK-66: one pure reading of free seats and what limits a machine. The poll still recommends on its own
// rules; this score is what the dashboard shows and what the owner-only schedule summary describes. It must not flap
// when a reading only chatters around a threshold. The fallback picture key still bands free seats. A posted
// marker that lists each machine stays quiet unless free seats move by two or more, or the limit or online state changes.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { freshRoomOf, READING_MAX_AGE_MS } from "../../src/accounts/select.ts";
import { CPU_BUSY_MAX_PCT, FREE_MEM_MIN_BYTES } from "../../src/daemon/orchestrator/poll-plan.ts";
import { SUMMARY_COOLDOWN_MS } from "../../src/daemon/orchestrator/capacity-summary.ts";
import { CAPACITY_ASK_COOLDOWN_MS } from "../../src/daemon/orchestrator/capacity-asks.ts";
import type { AccountView } from "../../src/protocol/accounts.ts";
import { PERSONAL_RESERVE_PCT } from "../../src/protocol/pool-rules.ts";
import { SEAT_RUNTIMES_V1 } from "../../src/protocol/seats.ts";
import {
  FLEET_ACCOUNT_RELEASE_ROOM, FLEET_CPU_BUSY_MAX_PCT, FLEET_CPU_RELEASE_PCT, FLEET_FREE_MEM_MIN_BYTES,
  FLEET_MEM_RELEASE_BYTES, FLEET_READING_MAX_AGE_MS, FLEET_SCORE_BAND, FLEET_SEAT_RUNTIMES, FLEET_SUMMARY_COOLDOWN_MS,
  bestAccountRoom, factorLabel, fleetCapacity, fleetPictureKey, fleetSummaryDecision, fleetSummaryText,
  type FleetCapacityInput, type FleetSummaryRow, type LimitingFactor,
} from "../../src/protocol/fleet-capacity.ts";

const GIB = 1024 ** 3;
const NODE = "aaaaaaaaaaaaaaaa";
const fp = (ch: string) => ch.repeat(64);

/** A machine the poll would give seats to: 3 of 4 free, memory and CPU quiet, an account with room. */
const open = (over: Partial<FleetCapacityInput> = {}): FleetCapacityInput => ({
  online: true,
  seats: { allows: true, max: 4, active: 1 },
  mem: { pressure: "normal", free: 8 * GIB },
  cpuBusyPct: 10,
  loadUnknown: false,
  accountRoomPct: 80,
  ...over,
});

test("the score uses the poll's own thresholds, and the summary waits an hour, not the two-hour ask cooldown", () => {
  expect(FLEET_CPU_BUSY_MAX_PCT).toBe(CPU_BUSY_MAX_PCT);
  expect(FLEET_CPU_BUSY_MAX_PCT).toBe(85);
  expect(FLEET_CPU_RELEASE_PCT).toBe(75);
  expect(FLEET_FREE_MEM_MIN_BYTES).toBe(FREE_MEM_MIN_BYTES);
  expect(FLEET_FREE_MEM_MIN_BYTES).toBe(2 * GIB);
  expect(FLEET_MEM_RELEASE_BYTES).toBe(FLEET_FREE_MEM_MIN_BYTES + 512 * 1024 ** 2);
  expect(FLEET_ACCOUNT_RELEASE_ROOM).toBe(PERSONAL_RESERVE_PCT + 10);
  expect(FLEET_SCORE_BAND).toBe(50);
  expect(FLEET_SUMMARY_COOLDOWN_MS).toBe(SUMMARY_COOLDOWN_MS);
  expect(FLEET_SUMMARY_COOLDOWN_MS).toBe(60 * 60_000);
  expect(CAPACITY_ASK_COOLDOWN_MS).toBeGreaterThan(FLEET_SUMMARY_COOLDOWN_MS);
  expect([...FLEET_SEAT_RUNTIMES]).toEqual([...SEAT_RUNTIMES_V1]);
  expect(FLEET_READING_MAX_AGE_MS).toBe(READING_MAX_AGE_MS);
});

test("a free machine scores its open seats; a full one, a silent one and a switched-off one are limited by seats", () => {
  expect(fleetCapacity(open())).toEqual({ free_slots: 3, limiting_factor: "seats", score: 75 });
  expect(fleetCapacity(open({ seats: { allows: true, max: 2, active: 0 } }))).toEqual({ free_slots: 2, limiting_factor: "seats", score: 100 });
  // Any free seat is at least 1, even when the share rounds to nothing.
  expect(fleetCapacity(open({ seats: { allows: true, max: 1000, active: 999 } })).score).toBe(1);
  expect(fleetCapacity(open({ seats: { allows: true, max: 4, active: 4 } }))).toEqual({ free_slots: 0, limiting_factor: "seats", score: 0 });
  expect(fleetCapacity(open({ seats: { allows: true, max: 4, active: 9 } }))).toEqual({ free_slots: 0, limiting_factor: "seats", score: 0 });
  expect(fleetCapacity(open({ seats: null }))).toEqual({ free_slots: 0, limiting_factor: "seats", score: 0 });
  expect(fleetCapacity(open({ seats: { allows: false, max: 4, active: 0 } }))).toEqual({ free_slots: 0, limiting_factor: "seats", score: 0 });
  expect(fleetCapacity(open({ seats: { allows: true, max: null, active: 0 } }))).toEqual({ free_slots: 0, limiting_factor: "seats", score: 0 });
  expect(fleetCapacity(open({ seats: { allows: true, max: 1.5, active: 0 } }))).toEqual({ free_slots: 0, limiting_factor: "seats", score: 0 });
  expect(fleetCapacity(open({ seats: { allows: true, max: -1, active: 0 } }))).toEqual({ free_slots: 0, limiting_factor: "seats", score: 0 });
  // A nonsense active count is no seats in use, not a reason to hide the cap.
  expect(fleetCapacity(open({ seats: { allows: true, max: 4, active: Number.NaN } })).free_slots).toBe(4);
});

test("offline, memory, CPU and an unknown load outrank seat headroom, which stays visible", () => {
  expect(fleetCapacity(open({ online: false }))).toEqual({ free_slots: 0, limiting_factor: "offline", score: 0 });
  expect(fleetCapacity(open({ online: false, mem: { pressure: "critical", free: 0 } })).limiting_factor).toBe("offline");
  const tight = fleetCapacity(open({ mem: { pressure: "normal", free: FLEET_FREE_MEM_MIN_BYTES - 1 } }));
  expect(tight).toEqual({ free_slots: 3, limiting_factor: "memory", score: 0 });
  expect(fleetCapacity(open({ mem: { pressure: "warn", free: 8 * GIB } })).limiting_factor).toBe("memory");
  expect(fleetCapacity(open({ mem: { pressure: "critical", free: 8 * GIB } })).limiting_factor).toBe("memory");
  // Exactly 2 GB free is not a hold, matching the poll. Missing memory is not a hold either.
  expect(fleetCapacity(open({ mem: { pressure: "normal", free: FLEET_FREE_MEM_MIN_BYTES } })).limiting_factor).toBe("seats");
  expect(fleetCapacity(open({ mem: { pressure: null, free: null } })).limiting_factor).toBe("seats");
  expect(fleetCapacity(open({ mem: null })).limiting_factor).toBe("seats");
  expect(fleetCapacity(open({ cpuBusyPct: 90 }))).toEqual({ free_slots: 3, limiting_factor: "cpu", score: 0 });
  expect(fleetCapacity(open({ cpuBusyPct: FLEET_CPU_BUSY_MAX_PCT })).limiting_factor).toBe("seats");
  expect(fleetCapacity(open({ cpuBusyPct: null })).limiting_factor).toBe("seats");
  expect(fleetCapacity(open({ cpuBusyPct: Number.NaN })).limiting_factor).toBe("seats");
  expect(fleetCapacity(open({ cpuBusyPct: Number.POSITIVE_INFINITY })).limiting_factor).toBe("seats");
  // Memory outranks a busy processor; a busy processor outranks an unknown load; an unknown load outranks full seats.
  expect(fleetCapacity(open({ mem: { pressure: "warn", free: 8 * GIB }, cpuBusyPct: 99, loadUnknown: true })).limiting_factor).toBe("memory");
  expect(fleetCapacity(open({ cpuBusyPct: 90, loadUnknown: true })).limiting_factor).toBe("cpu");
  expect(fleetCapacity(open({ loadUnknown: true, seats: { allows: true, max: 4, active: 4 } }))).toEqual({ free_slots: 0, limiting_factor: "load_unknown", score: 0 });
  expect(fleetCapacity(open({ loadUnknown: true }))).toEqual({ free_slots: 3, limiting_factor: "load_unknown", score: 0 });
  // No account room keeps the idle seats and scores nothing. Room of exactly the reserve is not enough.
  expect(fleetCapacity(open({ accountRoomPct: PERSONAL_RESERVE_PCT }))).toEqual({ free_slots: 3, limiting_factor: "accounts", score: 0 });
  expect(fleetCapacity(open({ accountRoomPct: null })).limiting_factor).toBe("accounts");
  expect(fleetCapacity(open({ accountRoomPct: Number.NaN })).limiting_factor).toBe("accounts");
  expect(fleetCapacity(open({ accountRoomPct: PERSONAL_RESERVE_PCT + 1 })).limiting_factor).toBe("seats");
  // A full seat list is the limit even when accounts are also empty.
  expect(fleetCapacity(open({ seats: { allows: true, max: 4, active: 4 }, accountRoomPct: 0 })).limiting_factor).toBe("seats");
  // Unknown caps stay at zero free when something else is the limit.
  expect(fleetCapacity(open({ seats: null, mem: { pressure: "warn", free: 8 * GIB } }))).toEqual({ free_slots: 0, limiting_factor: "memory", score: 0 });
});

test("hysteresis holds the previous limit only while the reading is still in that limit's release band", () => {
  const held = (factor: LimitingFactor, over: Partial<FleetCapacityInput> = {}) => fleetCapacity(open(over), factor);
  expect(held("cpu", { cpuBusyPct: 80 })).toEqual({ free_slots: 3, limiting_factor: "cpu", score: 0 });
  expect(held("cpu", { cpuBusyPct: FLEET_CPU_BUSY_MAX_PCT }).limiting_factor).toBe("cpu");
  expect(held("cpu", { cpuBusyPct: FLEET_CPU_RELEASE_PCT }).limiting_factor).toBe("seats");
  expect(held("cpu", { cpuBusyPct: null }).limiting_factor).toBe("seats");
  expect(held("cpu", { cpuBusyPct: 90 }).limiting_factor).toBe("cpu");
  expect(held("memory", { mem: { pressure: "normal", free: FLEET_FREE_MEM_MIN_BYTES } }).limiting_factor).toBe("memory");
  expect(held("memory", { mem: { pressure: "normal", free: FLEET_MEM_RELEASE_BYTES - 1 } }).limiting_factor).toBe("memory");
  expect(held("memory", { mem: { pressure: "normal", free: FLEET_MEM_RELEASE_BYTES } }).limiting_factor).toBe("seats");
  expect(held("memory", { mem: { pressure: null, free: null } }).limiting_factor).toBe("seats");
  expect(held("memory", { mem: null }).limiting_factor).toBe("seats");
  // A new harder limit wins at once. CPU over 85 is not "still memory".
  expect(held("memory", { cpuBusyPct: 90, mem: { pressure: "normal", free: FLEET_FREE_MEM_MIN_BYTES } }).limiting_factor).toBe("cpu");
  expect(held("cpu", { mem: { pressure: "critical", free: 8 * GIB }, cpuBusyPct: 10 }).limiting_factor).toBe("memory");
  expect(held("accounts", { accountRoomPct: 15 })).toEqual({ free_slots: 3, limiting_factor: "accounts", score: 0 });
  expect(held("accounts", { accountRoomPct: FLEET_ACCOUNT_RELEASE_ROOM }).limiting_factor).toBe("accounts");
  expect(held("accounts", { accountRoomPct: FLEET_ACCOUNT_RELEASE_ROOM + 1 }).limiting_factor).toBe("seats");
  expect(held("accounts", { accountRoomPct: null }).limiting_factor).toBe("accounts");
  // Offline and an unknown load have no band: they enter and leave immediately.
  expect(held("offline").limiting_factor).toBe("seats");
  expect(held("load_unknown").limiting_factor).toBe("seats");
  expect(fleetCapacity(open({ online: false }), "seats").limiting_factor).toBe("offline");
  expect(fleetCapacity(open({ loadUnknown: true }), "seats").limiting_factor).toBe("load_unknown");
  // An unknown previous factor is ignored.
  expect(fleetCapacity(open(), "seats").score).toBe(75);
});

test("the picture key bands free seats and score, and still counts a limit or an offline machine", () => {
  const row = (score: number, free = 3, factor: LimitingFactor = "seats") => ({ node: NODE, limiting_factor: factor, free_slots: free, score });
  const same = fleetPictureKey([row(0), row(FLEET_SCORE_BAND - 1)]);
  expect(fleetPictureKey([row(0)])).not.toBe(same); // two machines is a different fleet
  // 0, under 50, and 50–100. A three-seat machine scores 100 with 3 free and 67 with 2 free: one picture.
  expect(fleetPictureKey([row(1)])).toBe(fleetPictureKey([row(49)]));
  expect(fleetPictureKey([row(49)])).not.toBe(fleetPictureKey([row(50)]));
  expect(fleetPictureKey([row(50)])).toBe(fleetPictureKey([row(100)]));
  expect(fleetPictureKey([row(100, 3)])).toBe(fleetPictureKey([row(67, 2)]));
  expect(fleetPictureKey([row(67, 1)])).toBe(fleetPictureKey([row(100, 3)]));
  expect(fleetPictureKey([row(100, 4)])).not.toBe(fleetPictureKey([row(100, 3)]));
  expect(fleetPictureKey([row(0, 0)])).not.toBe(fleetPictureKey([row(50, 1)]));
  expect(fleetPictureKey([row(0, 3, "cpu")])).not.toBe(fleetPictureKey([row(0, 3, "memory")]));
  const offline = { node: "bbbbbbbbbbbbbbbb", limiting_factor: "offline" as const, free_slots: 0, score: 0 };
  expect(fleetPictureKey([row(75), offline])).toBe(fleetPictureKey([offline, row(75)]));
  expect(fleetPictureKey([row(75), offline])).not.toBe(fleetPictureKey([row(75)]));
  expect(fleetPictureKey([{ node: "", limiting_factor: "seats", free_slots: 1, score: 50 }])).toBe(fleetPictureKey([]));
  expect(fleetPictureKey([{ node: "x".repeat(65), limiting_factor: "seats", free_slots: 1, score: 50 }])).toBe(fleetPictureKey([]));
  // The text keeps the exact numbers the bands hide.
  const exact = (free: number, score: number) => fleetSummaryText([{ node: NODE, hostname: "mac-a", free_slots: free, limiting_factor: "seats", score }]);
  expect(exact(3, 100)).toContain("mac-a: 3 free, limited by seats, score 100");
  expect(exact(2, 67)).toContain("mac-a: 2 free, limited by seats, score 67");
});

test("the summary names roster hostnames only, and does not advertise seats a limit has already blocked", () => {
  const rows: FleetSummaryRow[] = [
    { node: NODE, hostname: "mac-a", free_slots: 3, limiting_factor: "memory", score: 0 },
    { node: "bbbbbbbbbbbbbbbb", hostname: "olive-box", free_slots: 1, limiting_factor: "seats", score: 25 },
  ];
  const text = fleetSummaryText(rows);
  expect(text.startsWith("WalkieTalkie fleet capacity: 1 free seat on 1 of 2 machines.")).toBe(true);
  expect(text).toContain("olive-box: 1 free, limited by seats, score 25");
  expect(text).toContain("mac-a: 3 free, limited by memory, score 0");
  expect(text.indexOf("mac-a")).toBeLessThan(text.indexOf("olive-box"));
  expect(text).not.toContain("127.0.0.1");
  expect(text).not.toContain("@");
  expect(text).not.toContain("%");
  expect(text).not.toContain("maren:claude");
  const messy = fleetSummaryText([{ node: NODE, hostname: "mac-a\n127.0.0.1 @olive", free_slots: 1, limiting_factor: "cpu", score: 0 }]);
  expect(messy).not.toContain("\n127.0.0.1");
  expect(messy).not.toContain("@");
  expect(messy).toContain("limited by CPU");
  expect(fleetSummaryText([{ node: NODE, hostname: "127.0.0.1", free_slots: 0, limiting_factor: "offline", score: 0 }])).toContain("machine: 0 free, limited by offline");
  expect(fleetSummaryText([{ node: NODE, hostname: "@@@", free_slots: 2, limiting_factor: "seats", score: 100 }])).toContain("machine: 2 free, limited by seats, score 100");
  const many = Array.from({ length: 41 }, (_, i) => ({ node: `n${i}`, hostname: `m-${String(i).padStart(2, "0")}`, free_slots: 1, limiting_factor: "seats" as const, score: 50 }));
  const long = fleetSummaryText(many);
  expect(long).toContain("41 free seats on 41 of 41 machines.");
  expect(long).toContain("and 1 more machine");
  expect(long.split("\n")).toHaveLength(42); // headline + 40 machines + the more line
  expect(factorLabel("load_unknown")).toBe("load unknown");
  expect(fleetSummaryText([])).toBe("WalkieTalkie fleet capacity: 0 free seats on 0 of 0 machines.");
});

test("owners are told they can derive every host's free seats the lead can see", () => {
  const protocol = readFileSync(new URL("../../docs/PROTOCOL.md", import.meta.url), "utf8");
  const security = readFileSync(new URL("../../docs/SECURITY.md", import.meta.url), "utf8");
  for (const text of [protocol, security]) {
    expect(text).toContain("owners can read, and derive");
    expect(text).not.toContain("stay in `seats-");
  }
  expect(protocol).toContain("seats hidden");
  expect(protocol).toContain("moved by two or more");
});

test("a hidden host is seats hidden for every limit, with no count and no score", () => {
  const hidden = (factor: LimitingFactor, free = 4, score = 80) => {
    const text = fleetSummaryText([{ node: NODE, hostname: "mac-a", free_slots: free, limiting_factor: factor, score, seats_hidden: true }]);
    return text.split("\n").find((line) => line.startsWith("mac-a:"));
  };
  // Seats stays the short line. Any other limit names the factor. Neither line carries the count or the score.
  expect(hidden("seats")).toBe("mac-a: seats hidden");
  for (const factor of ["cpu", "memory", "load_unknown", "accounts", "offline"] as const) {
    const line = hidden(factor);
    expect(line, factor).toBe(`mac-a: seats hidden, limited by ${factorLabel(factor)}`);
    expect(line, factor).not.toContain("4");
    expect(line, factor).not.toContain("80");
    expect(line, factor).not.toContain("score");
    expect(line, factor).not.toContain("free");
  }
});

test("the docs name a hidden host's limit, every skip, and a marker ten minutes ahead of the earlier clock", () => {
  const protocol = readFileSync(new URL("../../docs/PROTOCOL.md", import.meta.url), "utf8");
  const security = readFileSync(new URL("../../docs/SECURITY.md", import.meta.url), "utf8");
  const changelog = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
  const unreleased = changelog.slice(0, changelog.indexOf("## v0.2.0-pre.12"));
  for (const text of [protocol, security, unreleased]) {
    expect(text).toContain("seats hidden, limited by");
    expect(text).toContain("more than ten minutes");
    expect(text).toContain("earlier of this clock");
    expect(text).toContain("is-offline");
  }
  expect(protocol).toContain("newest eight");
  expect(protocol).toContain("`--text-3`");
  expect(security).toContain("set of machines");
  expect(security).toContain("whether seats are hidden");
  expect(security).toContain("online state");
  expect(security).toContain("must not post one");
  expect(security).toContain("no schedule channel");
  expect(security).toContain("empty after redaction");
  expect(security).toContain("when the clock is bad");
  expect(unreleased).toContain("newest eight");
  expect(unreleased).toContain("must not post one");
  expect(unreleased).toContain('limited by" CPU, memory, load unknown, accounts or offline');
});

test("the summary decision ignores the ask cooldown: post on a real change, skip chatter, an empty first look and a clock that went backwards", () => {
  const first = fp("a");
  const changed = fp("b");
  expect(fleetSummaryDecision(first, null, 1_000, 2)).toBe("post");
  expect(fleetSummaryDecision(first, null, 1_000, 0)).toBe("empty");
  expect(fleetSummaryDecision(first, { fingerprint: first, at: 0 }, FLEET_SUMMARY_COOLDOWN_MS + 5, 2)).toBe("unchanged");
  expect(fleetSummaryDecision(changed, { fingerprint: first, at: 1_000 }, 1_000 + FLEET_SUMMARY_COOLDOWN_MS - 1, 2)).toBe("cooldown");
  // An hour has passed and the ask cooldown (two hours) has not: a changed picture is still due.
  expect(fleetSummaryDecision(changed, { fingerprint: first, at: 0 }, FLEET_SUMMARY_COOLDOWN_MS, 2)).toBe("post");
  expect(FLEET_SUMMARY_COOLDOWN_MS).toBeLessThan(CAPACITY_ASK_COOLDOWN_MS);
  expect(fleetSummaryDecision(changed, { fingerprint: first, at: 5_000 }, 4_999, 2)).toBe("cooldown");
  expect(fleetSummaryDecision(changed, { fingerprint: first, at: 5_000 }, Number.NaN, 2)).toBe("cooldown");
  expect(fleetSummaryDecision(changed, null, -1, 2)).toBe("cooldown");
  // The fleet going away is a change, once the hour has passed. The first look at nothing is not.
  expect(fleetSummaryDecision(changed, { fingerprint: first, at: 0 }, FLEET_SUMMARY_COOLDOWN_MS, 0)).toBe("post");
});

test("account room is the roomiest fresh Claude or Codex reading on that machine, and matches the selector", () => {
  const now = 1_700_000_000_000;
  const account = (provider: string, used: number, online = true, at = now - 60_000): AccountView => ({
    key: `maren:${provider}`, id: provider, provider: provider as AccountView["provider"], label: "Claude account", plan: null,
    owners: ["maren"], claimed_by: [],
    machines: [{ node_id: NODE, hostname: "mac-a", handle: "maren", online, self: false, agents: [], usage: null }],
    usage: { at, state: "ok", reason: null, source: "api", until: null, windows: [{ kind: "session", used_pct: used, resets_at: now + 3_600_000, window_s: null, scope: null }] },
    usage_host: "mac-a", last_seen: now,
  });
  const claude = account("claude", 20);
  expect(bestAccountRoom([claude], NODE, now)).toBe(freshRoomOf(claude.usage, null, now));
  expect(bestAccountRoom([claude], NODE, now)).toBe(80);
  expect(bestAccountRoom([account("claude", 20), account("codex", 40)], NODE, now)).toBe(80);
  expect(bestAccountRoom([account("kimi", 10)], NODE, now)).toBeNull();
  expect(bestAccountRoom([account("claude", 20, false)], NODE, now)).toBeNull();
  expect(bestAccountRoom([account("claude", 20, true, now - READING_MAX_AGE_MS - 1)], NODE, now)).toBeNull();
  expect(bestAccountRoom([account("claude", 20)], "bbbbbbbbbbbbbbbb", now)).toBeNull();
});
