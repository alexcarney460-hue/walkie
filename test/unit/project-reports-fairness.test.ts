// A failed report consumes a turn, so it must not monopolize or lose its place in the next turns.
import { afterEach, expect, test } from "bun:test";
import { reportsWorld } from "../helpers/project-reports.ts";
import { prepareProjectReports } from "../../src/daemon/projects/status-report.ts";
import { updateCard } from "../../src/daemon/projects/service.ts";
import { readReportFailures } from "../../src/daemon/orchestrator/report-times.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); });
const body = "The project made ordinary progress. The current work remains on track.";
const names = (evidence: string) => [...evidence.matchAll(/=== PROJECT (p-[0-9a-f]{8}) ===/g)].map((m) => m[1]!);
const reply = (channels: string[]) => channels.map((channel) => `<status-report project="${channel}">${body}</status-report>`).join("\n");

for (const failedPrivate of [true, false]) {
  test(`a failed ${failedPrivate ? "private" : "public"} report is retried while the other privacy class keeps changing`, async () => {
    const t = reportsWorld(cleanups);
    const recovering = await t.project("Recovering work", "REC", { private: failedPrivate });
    const healthy = await t.project("Healthy work", "HLT", { private: !failedPrivate });
    t.card(recovering, "Recovering task");
    const healthyCard = t.card(healthy, "Healthy task");
    t.tick(3_600_000);
    const first = await prepareProjectReports(t.deps, () => true);
    if ("skip" in first) throw new Error(first.skip);
    expect(names(first.evidence)).toEqual([recovering.channel]);
    first.finish?.({ text: "No report available for this single turn.", ok: true }, t.wall());
    const seen: string[][] = [];
    for (let hour = 1; hour <= 2; hour++) {
      t.tick(3_600_000);
      updateCard(t.w, healthyCard.id, { title: `Healthy task update ${hour}` });
      t.tick();
      const prepared = await prepareProjectReports(t.deps, () => true);
      if ("skip" in prepared) throw new Error(prepared.skip);
      const selected = names(prepared.evidence);
      expect(selected).toHaveLength(1); // privacy classes still never share a prompt
      seen.push(selected);
      prepared.finish?.({ text: reply(selected), ok: true }, t.wall());
    }
    expect(seen.some((selected) => selected.includes(recovering.channel))).toBe(true);
    expect(seen.some((selected) => selected.includes(healthy.channel))).toBe(true);
    expect(readReportFailures(t.core).has(recovering.channel)).toBe(false);
  });
}

test("a once-failed project is retried beside ten healthy projects changing every hour", async () => {
  const t = reportsWorld(cleanups);
  const recovering = await t.project("Recovering work", "REC");
  t.card(recovering, "Recovering task");
  const healthyCards = [];
  for (let i = 0; i < 10; i++) {
    const project = await t.project(`Healthy work ${i}`, `H${i}`);
    healthyCards.push(t.card(project, `Healthy task ${i}`));
  }
  t.tick(3_600_000);
  const first = await prepareProjectReports(t.deps, () => true);
  if ("skip" in first) throw new Error(first.skip);
  const initial = names(first.evidence);
  expect(initial).toContain(recovering.channel);
  first.finish?.({ text: reply(initial.filter((c) => c !== recovering.channel)), ok: true }, t.wall());
  let retried = false;
  for (let hour = 1; hour <= 2; hour++) {
    t.tick(3_600_000);
    for (const card of healthyCards) updateCard(t.w, card.id, { title: `Healthy update ${hour} for ${card.id}` });
    t.tick();
    const prepared = await prepareProjectReports(t.deps, () => true);
    if ("skip" in prepared) throw new Error(prepared.skip);
    const selected = names(prepared.evidence);
    expect(selected.length).toBeLessThanOrEqual(10);
    retried ||= selected.includes(recovering.channel);
    prepared.finish?.({ text: reply(selected), ok: true }, t.wall());
  }
  expect(retried).toBe(true);
  expect(readReportFailures(t.core).has(recovering.channel)).toBe(false);
});
