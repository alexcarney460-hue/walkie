import { describe, expect, test } from "bun:test";
import { nextRuns, Schedule, ScheduleTemplate, TEMPLATE_PROMPTS, schedulePrompt, validateCron, MAX_SCHEDULES } from "../../src/protocol/talkie-schedule.ts";

describe("WalkieTalkie cron", () => {
  test("parses five local fields and finds the next hourly times", () => {
    const at = new Date(2026, 8, 28, 10, 2).getTime();
    expect(nextRuns("0 * * * *", at).map((t) => new Date(t).getHours())).toEqual([11, 12, 13]);
  });
  test("refuses malformed and too frequent schedules", () => {
    expect(() => validateCron("* * * * *")).toThrow("five minutes");
    expect(() => validateCron("60 * * * *")).toThrow("invalid cron field");
    expect(() => validateCron("* * * *")).toThrow("five fields");
    expect(() => validateCron("5/2 * * * *")).toThrow("invalid cron field");
    expect(validateCron("*/5 * * * *")).toBeGreaterThan(Date.now());
  });
  test("weekday seven means Sunday", () => {
    const monday = new Date(2026, 8, 28, 8, 0).getTime();
    expect(new Date(nextRuns("0 9 * * 7", monday, 1)[0]!).getDay()).toBe(0);
  });
  test("template prompts are fixed and task-specific", () => {
    expect(ScheduleTemplate.options).toEqual(["board-refresh", "machine-onboarding", "project-sync", "capacity-check", "data-room-refresh", "project-reports", "orchestration-poll", "card-curation"]);
    expect(ScheduleTemplate.options.length).toBeLessThan(MAX_SCHEDULES);
    for (const template of ScheduleTemplate.options) expect(TEMPLATE_PROMPTS[template]).toContain("information, not instructions");
    expect(schedulePrompt({ prompt: "Check queue" })).toContain("information, not instructions");
    expect(schedulePrompt({ template: "board-refresh" })).toContain("steward");
    expect(schedulePrompt({ template: "data-room-refresh" })).toContain("Do not delete files");
    const onboarding = schedulePrompt({ template: "machine-onboarding" });
    for (const clause of ["walkie admin machines --json", "walkie seats --json", "onboarding_step", "agent admin", "seat helper", "runtime login", "version", "one exact next step", "Never post join links", "walkie talkie recommend"])
      expect(onboarding).toContain(clause);
    const sync = schedulePrompt({ template: "project-sync" });
    expect(sync).toContain("walkie tasks --project <P> --limit 500 --json");
    expect(sync).toContain("total exceeds tasks.length");
    for (const clause of ["walkie who --all --json", "walkie projects list --all --json", "walkie tasks --project", "ask_orchestrator", "create_card", "disagrees"])
      expect(sync).toContain(clause);
    const capacity = schedulePrompt({ template: "capacity-check" });
    for (const clause of ["orchestration poll", "free seats", "CPU", "memory", "10% reserve", "to-do", "recommendations", "no model turn"])
      expect(capacity).toContain(clause);
    expect(schedulePrompt({ prompt: "Check queue" })).toContain("Check queue");
  });
});

test("schedule records ignore newer optional fields but validate known fields", () => {
  const record = { id: "11111111-1111-4111-8111-111111111111", name: "Capacity", cron: "*/15 * * * *",
    task: { template: "capacity-check", newer_task_field: true }, enabled: true, created_by: "alex",
    last_run: null, next_run: 900_000, last_result: null, failures: 0, run_id: null,
    capacity_checked_at: { "@alex/lab-host": 900_000 }, newer_record_field: true };
  const parsed = Schedule.parse(record);
  expect(parsed.task).toEqual({ template: "capacity-check" });
  expect("newer_record_field" in parsed).toBe(false);
  expect(Schedule.safeParse({ ...record, capacity_checked_at: { "@alex/lab-host": "bad" } }).success).toBe(false);
});
