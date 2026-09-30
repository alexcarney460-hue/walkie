import type { Tx } from './store.js';
import type { StoredChain, TeamProof } from './team-proof.js';

/** A resolved fork cannot be replayed with a new event digest from the same ancestor. */
export async function refusedFork(t: Tx, team: string, kept: StoredChain,
  candidate: StoredChain, roster: TeamProof): Promise<string | null> {
  const rejected = await t.control(`enrollment-fork-rejected:${team}`) as
    { digest: string; predecessor_key: string }[] | undefined;
  if (!rejected?.length) return null;
  const exact = rejected.find(item => candidate.chain?.includes(item.digest));
  if (exact) return exact.digest;
  const first = candidate.chain?.findIndex((digest, i) => kept.chain?.[i] !== digest) ?? -1;
  if (first < 0) return null;
  const genesis = roster.genesis as { body?: { node_pubkey?: unknown } } | null;
  const transfers = roster.authority_chain as { key?: unknown }[] | undefined;
  const signer = first <= 1 ? genesis?.body?.node_pubkey : transfers?.[first - 2]?.key;
  if (typeof signer !== 'string') return null;
  if (first === 0 && candidate.chain?.[0] !== kept.chain?.[0]) return rejected[0]!.digest;
  // The first divergent transfer is signed by a key on the kept chain's shared prefix.
  // A recorded resolution makes that ancestor unable to freeze the team with a fresh branch.
  return rejected.find(item => item.predecessor_key === signer)?.digest ??
    (first <= kept.depth && candidate.chain?.slice(0, first).every((digest, i) => kept.chain?.[i] === digest)
      ? rejected[0]!.digest : null);
}
