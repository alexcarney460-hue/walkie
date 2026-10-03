// The model list the local-model suggestions rank from (LOCAL-MODELS-HF-1). The daemon reads Hugging Face when a person
// opens a dashboard page that shows the suggestions (Mission Control, the Team page or a machine page: the first one to mount
// starts this store) and the list is missing or over a day old (never on a timer); until it has, and when it cannot,
// this is the list built into Walkie, with the reason. One shared store, so the Mission Control card, the Team page and a
// machine page share one request. The browser never talks to Hugging Face: only the daemon does.
import { useEffect, useSyncExternalStore } from "react";
import { CATALOG, type Catalog } from "../../../src/pool/catalog.ts";
import type { ModelsView } from "../../../src/pool/hf/view.ts";
import { friendlyError } from "../api/client.ts";
import { poolApi, type PoolModelsView } from "../api/pool.ts";

export interface ModelsState {
  view: ModelsView;
  /** Hugging Face is being read now. */
  refreshing: boolean;
  error: string | null;
  /** Ask Hugging Face again (the daemon refuses within a minute of the last time). */
  again: () => void;
}

export type ModelsInput = ModelsView & { refreshing?: boolean };

const BUILT_IN: ModelsView = { catalog: CATALOG, source: "built-in", state: "built-in", checkedAt: null, note: null };
let state: Omit<ModelsState, "again"> = { view: BUILT_IN, refreshing: false, error: null };
const listeners = new Set<() => void>();
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function set(patch: Partial<typeof state>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

const POLL_MS = 2_500;
/** A read of Hugging Face takes about half a minute; give up on waiting after three. */
const POLL_LIMIT = 72;

function viewOf(w: PoolModelsView, catalog: Catalog): ModelsView {
  return { catalog, source: w.source, state: w.state, checkedAt: w.checked_at, note: w.note };
}

async function load(polls = 0): Promise<void> {
  try {
    const w = await poolApi.models(polls > 0);
    set({ view: viewOf(w, w.catalog ?? state.view.catalog), refreshing: w.refreshing, error: null });
    if (w.refreshing && polls < POLL_LIMIT) {
      timer = setTimeout(() => { void load(polls + 1); }, POLL_MS);
    } else if (polls > 0 && !w.catalog) {
      // The refresh is over: fetch the new list once.
      await load(0);
    }
  } catch (err) {
    set({ error: friendlyError(err), refreshing: false });
  }
}

export function ensureModels(): void {
  if (started) return;
  started = true;
  void load(0);
}

/** Tests: forget everything (the singleton outlives a test). */
export function resetModelsForTest(): void {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
  state = { view: BUILT_IN, refreshing: false, error: null };
}

function again(): void {
  if (timer) clearTimeout(timer);
  void poolApi.refreshModels().then((w) => {
    set({ refreshing: w.refreshing });
    if (w.refreshing) timer = setTimeout(() => { void load(1); }, POLL_MS);
  }).catch((err: unknown) => set({ error: friendlyError(err) }));
}

const subscribe = (l: () => void): (() => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = (): typeof state => state;

/** The shared model list; `override` (tests, previews) replaces the store. */
export function useModels(override?: ModelsInput): ModelsState {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => { if (!override) ensureModels(); }, [override]);
  if (override) return { view: override, refreshing: override.refreshing ?? false, error: null, again: () => undefined };
  return { ...s, again };
}
