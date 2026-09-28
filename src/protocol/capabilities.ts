import { z } from "zod";
import { MachineSys } from "./machine-stats.ts";

/** Protocol features are independent of optional hardware telemetry. */
export const PeerCapabilities = z.object({
  version: MachineSys.shape.version,
  caps: z.array(z.string().regex(/^[a-z0-9_]{1,32}$/)).max(16),
});
export type PeerCapabilities = z.infer<typeof PeerCapabilities>;
