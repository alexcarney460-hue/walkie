// Mixed teams × status history (v0.2.0-pre.2 merge of WALKIE-MISSION-1 with Walkie Direct): a Direct-only member that
// joins later pulls through the dual authority over Walkie Direct; the same rule as on the tailnet applies there.
// A superseded titled status (another machine's, and the authority's own) arrives as a stub; the latest is in full.
//   alex   authority, Tailscale + Walkie Direct (dual)
//   bob    Tailscale only, shares prompt titles
//   arvid  Walkie Direct only, joins with an invite code after the statuses were superseded
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SyncOptions } from "../../src/daemon/sync.ts";
import { Cluster, waitFor } from "../helpers/cluster.ts";

const SLOW: SyncOptions = { intervalMs: 20_000, livenessMs: 60_000, pushTimeoutMs: 1_000 };
const c = new Cluster();
afterAll(async () => { await c.close(); });

function setShare(home: string, share: Record<string, boolean>): void {
  const cfg = join(home, "config.json");
  writeFileSync(cfg, JSON.stringify({ ...(JSON.parse(readFileSync(cfg, "utf8")) as object), ...share }));
}

describe("status history to a Direct-only member of a mixed team", () => {
  test("superseded titled statuses reach the new Direct-only member as stubs; the latest ones in full", async () => {
    const alex = await c.add({ name: "m-alex", login: "malex@example.com", hostname: "malex-mbp", dual: true, sync: SLOW });
    const bob = await c.add({ name: "m-bob", login: "mbob@example.com", hostname: "mbob-mbp", sync: SLOW });
    await alex.client().init("mixhist", "malex");
    await alex.client().invite("mbob@example.com", "mbob", "member");
    expect((await bob.client().join(alex.peerAddr)).admitted).toBe(true);
    await alex.client().request("POST", "/v1/direct/enable", {});

    setShare(bob.home, { share_prompts: true });
    setShare(alex.home, { share_prompts: true });
    const title = (t: string) => ({ state: "working", runtime: "claude-code", title: t, activity: "Thinking" });
    const b1 = await bob.client("cc-bx").status({ agent: "cc-bx", ...title("Quokka acquisition memo") }, { title: "prompt", activity: "phrase" });
    const a1 = await alex.client("cc-ax").status({ agent: "cc-ax", ...title("Wombat pricing sheet") }, { title: "prompt", activity: "phrase" });
    await Bun.sleep(2_100); // past the 2 s duplicate window
    const b2 = await bob.client("cc-bx").status({ agent: "cc-bx", ...title("Next: release notes") }, { title: "prompt", activity: "phrase" });
    const a2 = await alex.client("cc-ax").status({ agent: "cc-ax", ...title("Next: changelog") }, { title: "prompt", activity: "phrase" });
    expect(b1.event && b2.event && a1.event && a2.event).toBeTruthy();
    // The authority holds bob's superseded status in full (it was a member when it was signed).
    await waitFor(() => alex.d.core.store.agent(bob.d.nodeId, "cc-bx")?.event_id === b2.event?.id, { what: "alex has bob's latest", timeoutMs: 20_000 });
    expect(alex.d.core.store.getRow(b1.event?.id as string)?.json).toContain("Quokka");

    const arvid = await c.add({ name: "m-arvid", login: "-", hostname: "marvid-mbp", direct: true, sync: SLOW });
    const inv = await alex.client().inviteCode("marvid", "member");
    expect((await arvid.client().join(inv.code)).admitted).toBe(true);
    expect((await arvid.client().me()).transport?.mode).toBe("direct");

    const row = (id: string | undefined) => arvid.d.core.store.getRow(id as string);
    for (const ev of [b1, b2, a1, a2]) await waitFor(() => row(ev.event?.id), { what: `arvid has ${ev.event?.id}`, timeoutMs: 20_000 });
    expect(row(b1.event?.id)?.redacted).toBe(1); // another machine's superseded status, served over Direct: stub
    expect(row(a1.event?.id)?.redacted).toBe(1); // the authority's own superseded status: stub
    expect(row(b2.event?.id)?.redacted).toBe(0); // latest: in full
    expect(row(a2.event?.id)?.redacted).toBe(0);
    const all = arvid.d.core.store.queryEvents({ kinds: ["agent.status"], limit: 1_000 }).map((r) => r.json).join("\n");
    expect(all).not.toContain("Quokka");
    expect(all).not.toContain("Wombat");
    expect(arvid.d.core.store.agent(bob.d.nodeId, "cc-bx")?.body).toContain("Next: release notes");

    // Live: bob's next status is relayed to arvid by the authority (bob and arvid share no transport), in full.
    await Bun.sleep(2_100);
    const b3 = await bob.client("cc-bx").status({ agent: "cc-bx", ...title("Next: tag the build") }, { title: "prompt", activity: "phrase" });
    await waitFor(() => row(b3.event?.id), { what: "b3 relayed to arvid", timeoutMs: 5_000 });
    expect(row(b3.event?.id)?.redacted).toBe(0);
  }, 90_000);
});
