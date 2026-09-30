// Local backup serialization for database claims if a transaction connection drops during Stripe I/O.
// The Stripe key covers separate serverless instances; this queue covers callbacks in one instance.
const pending = new Map<string, Promise<void>>();

export async function lockSubscriptionClaim(id: string): Promise<() => void> {
  const prior = pending.get(id);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  pending.set(id, current);
  if (prior) await prior;
  return () => {
    if (pending.get(id) === current) pending.delete(id);
    release();
  };
}
