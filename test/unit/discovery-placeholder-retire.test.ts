// A process-only placeholder card (`claude-pid<N>`) whose process later gets its real name is a duplicate of the named card:
// it must leave the live roster at once, not sit beside the named card for ten minutes (WALK-83, from Codex see-load r6).
import { afterEach, describe, expect, test } from "bun:test";
import type { SyncManager } from "../../src/daemon/sync.ts";
import { agentsView } from "../../src/daemon/views.ts";
import { OFFLINE_GRACE_MS } from "../../src/protocol/agent-roster.ts";
import { AGENT, status, world } from "../helpers/discovery-world.ts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0)) clean(); });
const onlineSync = { isOnline: () => true } as unknown as SyncManager;
const PLACEHOLDER = "claude-pid100";

describe("placeholder cards", () => {
  test("a placeholder renamed by a later scan is archived at once; the named card stays live", async () => {
    const w = world(cleanups);
    const named = new Map(w.fx.env);
    w.fx.env.set(101, {}); // the session id is not readable yet (a lookup that timed out): the process is known by its pid
    const d = w.disc();
    try {
      await d.tick();
      expect(status(w.core, PLACEHOLDER)).toMatchObject({ state: "working" });
      expect(status(w.core, AGENT)).toBeNull();

      w.clock.t += 15_000;
      w.fx.env.set(101, named.get(101)!); // the next scan reads it
      await d.tick();
      expect(status(w.core, AGENT)).toMatchObject({ state: "working" });
      const retired = status(w.core, PLACEHOLDER);
      expect(retired).toMatchObject({ state: "offline" });
      expect(retired?.observed_at).toBe(w.clock.t - OFFLINE_GRACE_MS);

      const roster = agentsView(w.core, onlineSync, w.clock.t);
      expect(roster.find((a) => a.agent === PLACEHOLDER)).toMatchObject({ effective_state: "offline", archived: true });
      expect(roster.find((a) => a.agent === AGENT)).toMatchObject({ effective_state: "working", archived: false });
    } finally { d.stop(); }
  });

  test("a placeholder whose process simply ended is an ordinary exit: offline, in the live roster for the grace period", async () => {
    const w = world(cleanups);
    w.fx.env.set(101, {});
    const d = w.disc();
    try {
      await d.tick();
      expect(status(w.core, PLACEHOLDER)).toMatchObject({ state: "working" });
      w.fx.procs = w.fx.procs.filter((p) => p.pid < 100);
      w.clock.t += 15_000;
      await d.tick();
      const ended = status(w.core, PLACEHOLDER);
      expect(ended).toMatchObject({ state: "offline" });
      expect(ended?.observed_at).toBeUndefined();
      expect(agentsView(w.core, onlineSync, w.clock.t).find((a) => a.agent === PLACEHOLDER)).toMatchObject({ effective_state: "offline", archived: false });
    } finally { d.stop(); }
  });

  test("the retirement is submitted with its observation time", async () => {
    const w = world(cleanups);
    w.fx.env.set(101, {});
    const d = w.disc();
    try {
      await d.tick();
      const submitted: Array<number | undefined> = [];
      const submit = w.core.statuses.submit.bind(w.core.statuses);
      w.core.statuses.submit = (agent, body, provenance, observedAt) => {
        if (agent === PLACEHOLDER) submitted.push(observedAt);
        return submit(agent, body, provenance, observedAt);
      };
      w.clock.t += 15_000;
      w.fx.env.set(101, { CLAUDE_CODE_SESSION_ID: "5eed0001-1111-4222-8333-944455556666" });
      await d.tick();
      expect(submitted).toEqual([w.clock.t - OFFLINE_GRACE_MS]);
    } finally { d.stop(); }
  });
});
