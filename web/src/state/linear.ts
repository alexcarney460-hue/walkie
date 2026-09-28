// Linear enrichment for task chips: keys requested in the same tick are batched into one
// GET /v1/linear/issues call; results are kept for 5 minutes. Local-only data from this daemon.
import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api/client.ts";
import type { LinearIssueInfo } from "../api/types.ts";
import { ISSUE_KEY_RE } from "../lib/sources.ts";

const TTL_MS = 5 * 60_000;
const MAX_BATCH = 50;

interface Entry { info: LinearIssueInfo | null; at: number }

const cache = new Map<string, Entry>();
const queued = new Set<string>();
const inflight = new Set<string>();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let disabledUntil = 0;

function notify(): void { subs.forEach((s) => s()); }

async function flush(): Promise<void> {
  timer = null;
  const keys = [...queued].slice(0, MAX_BATCH);
  keys.forEach((k) => { queued.delete(k); inflight.add(k); });
  if (queued.size) schedule();
  try {
    const res = await api.linearIssues(keys);
    if (!res.enabled) disabledUntil = Date.now() + TTL_MS; // Linear off on this machine: don't keep asking
    const now = Date.now();
    for (const k of keys) if (k in res.issues) cache.set(k, { info: res.issues[k] ?? null, at: now });
  } catch {
    /* enrichment is best effort: chips keep showing the bare key */
  } finally {
    keys.forEach((k) => inflight.delete(k));
    notify();
  }
}

function schedule(): void {
  if (!timer) timer = setTimeout(() => void flush(), 40);
}

function request(key: string): void {
  if (Date.now() < disabledUntil || inflight.has(key) || queued.has(key)) return;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return;
  queued.add(key);
  schedule();
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/** Issue info for an agent's task key, or null (unknown key, Linear not enabled, not loaded yet). */
export function useLinearIssue(key: string | undefined): LinearIssueInfo | null {
  const norm = key?.trim().toUpperCase();
  const valid = !!norm && ISSUE_KEY_RE.test(norm);
  const info = useSyncExternalStore(subscribe, () => (valid ? cache.get(norm as string)?.info ?? null : null));
  useEffect(() => { if (valid) request(norm as string); }, [valid, norm]);
  return info;
}
