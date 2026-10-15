import { expect, test } from "bun:test";
import { seatRequestText, seatOf, SeatRunV2 } from "../../src/protocol/seats.ts";
import { controlCapabilityReady, controlRequestText, controlReceiptView, foldControlReceipt, parseControlPost, sameControlPrincipal, SeatControlIntent, SEATS_TURN_CONTROL_CAP, type SeatControlReceipt } from "../../src/protocol/seat-turn-control.ts";
const node = "a".repeat(16), host = "b".repeat(16), generation = "c".repeat(32);
const intent = {
  op: "control", v: 1, launch: `${node}:1`, principal: { kind: "agent", node, handle: "alex", agent: "builder" }, target: host,
  daemon_instance: generation, boot_generation: generation, seat_generation: generation, adapter: "codex-app-server",
  thread_id: "thread-1", control_id: generation, action: "follow_up", expected_turn_id: "turn-1", text: "continue",
} as const;
test("signed full identity, principal, target and revision bindings reject tampering and unknown keys", () => {
  expect(SeatControlIntent.safeParse(intent).success).toBe(true);
  const invalid = [
    { launch: "short" }, { principal: { ...intent.principal, agent: "other", extra: 1 } }, { target: "short" },
    { daemon_instance: "short" }, { boot_generation: "short" }, { seat_generation: "short" },
    { adapter: "other" }, { thread_id: "" }, { control_id: "short" }, { action: "other" },
    { expected_turn_id: undefined, expected_revision: undefined }, { expected_revision: 1 }, { extra: 1 },
    { text: "x".repeat(8193) },
  ];
  for (const patch of invalid) expect(SeatControlIntent.safeParse({ ...intent, ...patch }).success).toBe(false);
  expect(SeatControlIntent.safeParse({ ...intent, text: "é".repeat(4096) }).success).toBe(true);
  expect(SeatControlIntent.safeParse({ ...intent, text: "é".repeat(4097) }).success).toBe(false);
  expect(sameControlPrincipal(intent.principal, { ...intent.principal, agent: "other" })).toBe(false);
  expect(sameControlPrincipal(intent.principal, intent.principal)).toBe(true);
});
test("canonical post and plain-text envelope reject extra fields and text mismatch", () => {
  const post = { seat: intent, thread: intent.launch, text: controlRequestText(intent) };
  expect(parseControlPost(post)).toEqual(intent);
  expect(seatRequestText(post)).toBe(true);
  expect(seatOf(post)).toEqual(intent);
  for (const bad of [{ ...post, text: "another" }, { ...post, extra: 1 }, { ...post, thread: "bad" }]) {
    expect(parseControlPost(bad)).toBeNull(); expect(seatRequestText(bad)).toBe(false);
  }
  expect(SeatControlIntent.safeParse({ ...intent, action: "interrupt", text: "injected" }).success).toBe(false);
});
test("fresh authenticated capability must cover host and every current reader, even offline", () => {
  const evidence = [node, host].map((n) => ({ node: n, caps: [SEATS_TURN_CONTROL_CAP], observed_mono_ms: 100, authenticated: true }));
  const snapshot = { issued_mono_ms: 100, readers: [node, host], evidence, history_compatible: true };
  expect(controlCapabilityReady(snapshot, [node, host], host, 30_100)).toBe(true);
  expect(controlCapabilityReady(snapshot, [node, host], host, 30_101)).toBe(false);
  expect(controlCapabilityReady({ ...snapshot, issued_mono_ms: 0 }, [node, host], host, 30_100)).toBe(false);
  expect(controlCapabilityReady(snapshot, [node, host, "d".repeat(16)], host, 101)).toBe(false);
  expect(controlCapabilityReady({ ...snapshot, evidence: evidence.slice(0, 1) }, [node, host], host, 101)).toBe(false);
  expect(controlCapabilityReady({ ...snapshot, evidence: [{ ...evidence[0]!, authenticated: false }, evidence[1]!] }, [node, host], host, 101)).toBe(false);
  expect(controlCapabilityReady({ ...snapshot, history_compatible: false }, [node, host], host, 101)).toBe(false);
});
test("ordinary launch bytes and history parser remain stable; receipt view omits private payload", () => {
  const ordinary = { op: "run", v: 2, runtime: "codex", brief: "a".repeat(64), timeout_s: 600, max_concurrent: 1 };
  expect(JSON.stringify(SeatRunV2.parse(ordinary))).toBe(JSON.stringify(ordinary));
  expect(seatOf({ seat: { ...ordinary, history_extra: true } })).toBeNull();
  const receipt: SeatControlReceipt = { op: "control_result", v: 1, launch: intent.launch, control_id: generation, boot_generation: generation, seat_generation: generation, revision: 1, outcome: "requested" };
  expect(controlReceiptView(receipt)).toEqual({ control_id: generation, revision: 1, outcome: "requested" });
  expect(foldControlReceipt(receipt, { ...receipt, revision: 2, outcome: "runtime_accepted" })?.outcome).toBe("runtime_accepted");
  expect(foldControlReceipt({ ...receipt, outcome: "interrupted_observed", revision: 3 }, { ...receipt, revision: 4, outcome: "runtime_accepted" })?.outcome).toBe("interrupted_observed");
});
