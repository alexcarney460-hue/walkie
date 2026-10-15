import { randomUUID } from "node:crypto";
import type { Core } from "../daemon/core.ts";

/** Delivery of the account poller's suggestion to this machine's person. */
export function postAccountImportNotice(core: {
  myHandle: Core["myHandle"];
  store: Pick<Core["store"], "putOrchMessage">;
  hub: Pick<Core["hub"], "publishLocal">;
}, text: string): void {
  if (!core.myHandle()) throw new Error("no local person can receive the account import notice");
  const id = `om_${randomUUID()}`;
  const message = { id, thread: id, role: "orchestrator" as const, via: "private" as const, text, ts: Date.now() };
  core.store.putOrchMessage(message);
  core.hub.publishLocal({ type: "orchestrator_message", message });
}
