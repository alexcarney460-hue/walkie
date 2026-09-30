import { z } from "zod";
import { Schedule, ScheduleTask } from "./talkie-schedule.ts";

const actor = { handle: z.string().min(1).max(80), machine: z.string().min(1).max(256),
  audit_id: z.string().uuid(), agent: z.string().min(1).max(80).optional() };
const add = z.object({ op: z.literal("add"), input: z.object({ name: z.string().trim().min(1).max(80),
  cron: z.string().min(1).max(100), task: ScheduleTask }).strict(), ...actor }).strict();
const edit = z.object({ op: z.literal("edit"), id: z.string().uuid(), input: add.shape.input.partial()
  .extend({ enabled: z.boolean().optional() }), ...actor }).strict();
const remove = z.object({ op: z.literal("remove"), id: z.string().uuid(), ...actor }).strict();
const reset = z.object({ op: z.literal("reset"), id: z.string().uuid(), ...actor }).strict();
export const ScheduleManagement = z.discriminatedUnion("op", [add, edit, remove, reset]);
export type ScheduleManagement = z.infer<typeof ScheduleManagement>;
export const ScheduleManagementResult = z.object({ schedule: Schedule.nullable().optional(),
  removed: z.boolean().optional() }).strict();
export type ScheduleManagementResult = z.infer<typeof ScheduleManagementResult>;

export const ScheduleProgress = z.object({ epoch: z.number().int().nonnegative().safe(),
  run_id: z.string().uuid().nullable(),
  change: z.discriminatedUnion("op", [
    z.object({ op: z.literal("put"), schedule: Schedule, completion_run: z.string().uuid().optional() }).strict(),
    z.object({ op: z.literal("note"), id: z.string().uuid(), run_id: z.string().uuid().nullable(),
      text: z.string().max(2_000) }).strict(),
  ]) }).strict();
export type ScheduleProgress = z.infer<typeof ScheduleProgress>;
export const ScheduleDefaultRequest = z.object({ epoch: z.number().int().nonnegative().safe() }).strict();
