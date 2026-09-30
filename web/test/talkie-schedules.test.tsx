import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ScheduleItems, ScheduleLocalStatus, SchedulesPanel } from "../src/views/orchestrator/Schedules.tsx";
import type { Schedule } from "../src/api/types.ts";

const schedule: Schedule = { id: "11111111-1111-4111-8111-111111111111", name: "Board refresh", cron: "0 * * * *",
  task: { template: "board-refresh" }, enabled: true, created_by: "alex", last_run: null,
  next_run: Date.UTC(2026, 8, 28, 12), last_result: "Two cards moved", failures: 0, run_id: null };

describe("WalkieTalkie schedule list", () => {
  test("shows status, result, and controls", () => {
    const html = renderToStaticMarkup(<ScheduleItems schedules={[schedule]} onToggle={() => {}} onRun={() => {}} />);
    expect(html).toContain("Board refresh");
    expect(html).toContain("Two cards moved");
    expect(html).toContain("Pause");
    expect(html).toContain("Run now");
  });
  test("shows an empty state and the resume control", () => {
    expect(renderToStaticMarkup(<ScheduleItems schedules={[]} onToggle={() => {}} onRun={() => {}} />)).toContain("No schedules yet");
    expect(renderToStaticMarkup(<ScheduleItems schedules={[{ ...schedule, enabled: false }]} onToggle={() => {}} onRun={() => {}} />)).toContain("Resume");
  });
  test("shows the lead's local authority status even without schedules", () => {
    expect(renderToStaticMarkup(<ScheduleLocalStatus status="schedule authority unreachable" />))
      .toContain("schedule authority unreachable");
  });
  test("shows every default by plain name and offers its template", () => {
    const names = ["Board refresh", "Machine onboarding", "Project sync", "Capacity check", "Data room refresh"];
    const html = renderToStaticMarkup(<ScheduleItems schedules={names.map((name, i) => ({ ...schedule, id: String(i), name }))}
      onToggle={() => {}} onRun={() => {}} />);
    const panel = renderToStaticMarkup(<SchedulesPanel />);
    for (const name of names) {
      expect(html).toContain(name);
      expect(panel).toContain(`>${name}</option>`);
    }
  });
});
