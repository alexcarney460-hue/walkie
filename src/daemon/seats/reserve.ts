import { freshRoomOf } from "../../accounts/select.ts";
import type { AccountUsage } from "../../protocol/accounts.ts";
import { PERSONAL_RESERVE_PCT } from "../../protocol/pool-rules.ts";

/** Staleness requests a refresh; only a fresh reading can stop an existing borrowed seat. */
export function superviseReserve(o: {
  read: () => AccountUsage | null; refresh: () => Promise<AccountUsage | null>;
  stop: () => Promise<void>; error: (err: unknown) => void; everyMs?: number;
}): () => void {
  let ended = false, pending = false;
  const cancel = () => { ended = true; clearInterval(timer); };
  const check = async () => {
    if (ended || pending) return;
    pending = true;
    try {
      let room = freshRoomOf(o.read(), null, Date.now());
      if (room === null) room = freshRoomOf(await o.refresh(), null, Date.now());
      if (ended || room === null || room > PERSONAL_RESERVE_PCT) return;
      cancel();
      await o.stop();
    } catch (err) { o.error(err); }
    finally { pending = false; }
  };
  const timer = setInterval(() => { void check(); }, o.everyMs ?? 60_000);
  timer.unref?.();
  return cancel;
}
