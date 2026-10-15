import { z } from "zod";

export const BrowserActionSchema = z.object({ op: z.enum(["open", "read", "screenshot", "click", "type", "select", "submit", "confirm_plan"]),
  url: z.string().max(4_000).optional(), ref: z.string().uuid().optional(), text: z.string().max(10_000).optional(),
  value: z.string().max(1_000).optional() }).strict();
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
