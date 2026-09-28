// WALKIE-MISSION-1 fix round 3 (Opus r3 #1): a machine that joins later is not served a node's old statuses in full.
// Only an agent's latest status goes out in full, and only if the current sharing policy would sign it today; the
// rest are header-signed stubs. (Machines that were members when a status was signed already have it: documented.)
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cluster, waitFor } from "../helpers/cluster.ts";

const c = new Cluster();
afterAll(async () => { await c.close(); });

function setShare(home: string, share: Record<string, boolean>): void {
  const cfg = join(home, "config.json");
  writeFileSync(cfg, JSON.stringify({ ...(JSON.parse(readFileSync(cfg, "utf8")) as object), ...share }));
}

describe("status history served to a machine that joins later", () => {
  test("superseded statuses and one signed while sharing was on are stubs; the latest compliant one is full", async () => {
    const alex = await c.add({ name: "h-alex", login: "halex@example.com", hostname: "halex-mbp" });
    const kira = await c.add({ name: "h-kira", login: "hkira@example.com", hostname: "hkira-mbp" });
    await alex.client().init("hist", "halex");
    await alex.client().invite("hkira@example.com", "hkira", "member");
    expect((await kira.client().join(alex.peerAddr)).admitted).toBe(true);

    setShare(kira.home, { share_prompts: true });
    const a1 = await kira.client("cc-zz").status({ agent: "cc-zz", state: "working", runtime: "claude-code", title: "Zanzibar layoffs list", activity: "Thinking" }, { title: "prompt", activity: "phrase" });
    await Bun.sleep(2_100); // past the 2 s duplicate window
    const a2 = await kira.client("cc-zz").status({ agent: "cc-zz", state: "working", runtime: "claude-code", title: "Zanzibar layoffs list, part 2", activity: "Running a command" }, { title: "prompt", activity: "phrase" });
    const b1 = await kira.client("cc-bb").status({ agent: "cc-bb", state: "idle", runtime: "claude-code", activity: "Finished turn" }, { activity: "phrase" });
    setShare(kira.home, { share_prompts: false }); // sharing turned off (the upkeep re-signs, every minute); then someone new joins
    expect(a1.event && a2.event && b1.event).toBeTruthy();
    expect(kira.d.core.reprojectOwnStatuses()).toBe(1); // cc-zz's title is no longer allowed: re-signed without it
    await waitFor(() => { const r = kira.d.core.store.agent(kira.d.nodeId, "cc-zz"); return r && r.event_id !== a2.event?.id ? r : null; }, { what: "re-signed" });
    await waitFor(() => { const r = alex.d.core.store.agent(kira.d.nodeId, "cc-zz"); return r && r.event_id !== a2.event?.id ? r : null; }, { what: "alex has the re-signed status", timeoutMs: 20_000 });

    const arvid = await c.add({ name: "h-arvid", login: "harvid@example.com", hostname: "harvid-mbp" });
    await alex.client().invite("harvid@example.com", "harvid", "member");
    expect((await arvid.client().join(alex.peerAddr)).admitted).toBe(true);
    await waitFor(() => arvid.d.core.store.getRow(b1.event?.id as string), { what: "kira's statuses reach arvid", timeoutMs: 20_000 });
    await waitFor(() => arvid.d.core.store.getRow(a2.event?.id as string), { what: "the latest cc-zz status", timeoutMs: 20_000 });

    const row = (id: string | undefined) => arvid.d.core.store.getRow(id as string);
    expect(row(a1.event?.id)?.redacted).toBe(1); // superseded
    expect(row(a2.event?.id)?.redacted).toBe(1); // signed while sharing was on: superseded by its re-signed copy
    expect(row(b1.event?.id)?.redacted).toBe(0); // latest and compliant: in full
    await waitFor(() => arvid.d.core.store.agent(kira.d.nodeId, "cc-zz"), { what: "cc-zz on arvid", timeoutMs: 20_000 });
    const all = arvid.d.core.store.queryEvents({ kinds: ["agent.status"], limit: 1_000 }).map((r) => r.json).join("\n");
    expect(all).not.toContain("Zanzibar");
    expect(arvid.d.core.store.agent(kira.d.nodeId, "cc-zz")?.body).toContain("Running a command"); // the current status, in full
    // A member that was there when they were signed has them (history is not recalled: documented).
    expect(alex.d.core.store.getRow(a1.event?.id as string)?.json).toContain("Zanzibar");
  }, 60_000);
});
