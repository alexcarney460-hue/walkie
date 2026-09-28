import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { api, ApiError, friendlyError } from "../api/client.ts";
import type { AgentView, Event, MeView, OrchMessage } from "../api/types.ts";
import { SESSION_KEY } from "../lib/session.ts";
import { load, save } from "../lib/storage.ts";
import { LiveStream } from "./live-stream.ts";
import { initialState, reducer, type Action, type State } from "./reducer.ts";
import { projectsStore } from "./projects.ts";

interface Actions {
  retryBoot: () => void;
  reconnectNow: () => void;
  markRead: (channel: string) => void;
  applyEvents: (events: Event[]) => void;
  /** Messages of this machine's orchestrator conversation (its own store, ORCH-FIX-11). */
  applyOrch: (messages: OrchMessage[]) => void;
  refreshTeam: () => void;
  refreshAsks: () => void;
  /** The Archive view loaded archived agents (the agent drawer can open them). */
  archiveLoaded: (agents: AgentView[], append?: boolean) => void;
}

const StateCtx = createContext<State>(initialState);
const ActionsCtx = createContext<Actions | null>(null);

const NO_TEAM_POLL_MS = 3_000;
const ROSTER_KINDS = new Set(["team.create", "team.member", "team.node", "channel.upsert", "team.license"]);

async function loadSnapshot(me: MeView, dispatch: (a: Action) => void): Promise<void> {
  void projectsStore.refresh(); // agent cards show their project; an older daemon without /v1/projects just has none
  const [team, agents, peers, events, asks, accounts] = await Promise.all([
    api.team(), api.agents(), api.peers(), api.events({ limit: 500 }), api.asks(),
    // An older daemon has no /v1/accounts: the dashboard works without it.
    api.accounts().catch(() => ({ accounts: [] })),
  ]);
  const teamId = me.team?.id ?? "none";
  const baselineKey = `walkie.readBaseline.${teamId}`;
  let readBaseline = load<number>(baselineKey, 0);
  if (!readBaseline) {
    readBaseline = Date.now();
    save(baselineKey, readBaseline);
  }
  dispatch({
    // An older daemon sends no archive counts (it sends every agent): treat that as an empty archive.
    type: "boot/ready", me, team, agents: agents.agents, archive: agents.archive ?? [], archiveRev: agents.archive_rev ?? null, nodes: peers.nodes, accounts: accounts.accounts, events: events.events,
    asks: asks.asks, readMarks: load<Record<string, number>>(`walkie.read.${teamId}`, {}), readBaseline,
  });
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [bootNonce, bumpBoot] = useReducer((n: number) => n + 1, 0);
  const [streamNonce, bumpStream] = useReducer((n: number) => n + 1, 0);
  const stateRef = useRef(state);
  stateRef.current = state;

  // ---- boot: /v1/me decides between first-run and the dashboard ----------------
  useEffect(() => {
    let cancelled = false;
    let poll: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      dispatch({ type: "boot/start" });
      try {
        const me = await api.me();
        if (cancelled) return;
        if (!me.team) {
          dispatch({ type: "boot/no-team", me });
          poll = setTimeout(run, NO_TEAM_POLL_MS);
          return;
        }
        await loadSnapshot(me, dispatch);
      } catch (err) {
        if (!cancelled) dispatch({ type: "boot/error", error: friendlyError(err), signedOut: err instanceof ApiError && err.status === 401 });
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (poll) clearTimeout(poll);
    };
  }, [bootNonce]);

  // ---- live stream (state/live-stream.ts: deltas, stall watchdog, backoff) -------------
  const ready = state.phase === "ready";
  useEffect(() => {
    if (!ready) return;
    // After a reconnect, refetch what the stream doesn't resend. Not the roster or nodes: the new stream's first
    // frames carry them, and a slower GET landing after a newer stream frame would put an older roster back.
    const resync = async () => {
      const newest = stateRef.current.events[0]?.ts ?? 0;
      const [team, events, asks] = await Promise.all([
        api.team(), api.events({ since_ts: Math.max(0, newest - 5_000), limit: 500 }), api.asks(),
      ]);
      dispatch({ type: "team", team });
      dispatch({ type: "asks", asks: asks.asks });
      dispatch({ type: "events", events: events.events });
      void api.accounts().then((r) => dispatch({ type: "accounts", accounts: r.accounts })).catch(() => {});
      void resyncOrch();
      projectsStore.resync();
    };

    // This machine's orchestrator conversation (ORCH-FIX-13, Codex r13 MEDIUM 5): what was stored, or changed state,
    // while the stream was down. Only a queued message changes after it is stored, so everything from the older of
    // the newest message held and the oldest one still queued is enough.
    const resyncOrch = async () => {
      const orch = stateRef.current.orch;
      if (!orch.length) return; // the tab loads its history when it opens
      const queued = orch.filter((m) => m.state === "queued").map((m) => m.ts);
      const since = Math.max(0, Math.min((orch[orch.length - 1] as OrchMessage).ts, ...queued) - 1_000);
      try {
        const { messages } = await api.orchestratorMessages(2_000, since);
        dispatch({ type: "orch/live-reset" });
        dispatch({ type: "orch/messages", messages });
      } catch { /* not a person's dashboard, or no orchestrator here: nothing to resync */ }
    };
    const live = new LiveStream({
      stream: api.stream,
      dispatch,
      resync,
      checkSession: api.me,
      onSignedOut: (err) => dispatch({ type: "boot/error", error: friendlyError(err), signedOut: true }),
      onEvent: (e) => {
        if (ROSTER_KINDS.has(e.kind)) void api.team().then((team) => dispatch({ type: "team", team })).catch(() => {});
      },
      onNoTeam: bumpBoot,
      onBoard: (d) => projectsStore.delta(d),
    });
    live.start();
    const onOnline = () => live.wake();
    // A hidden page's timers are throttled: check the stream as soon as it is visible again.
    const onVisible = () => { if (document.visibilityState === "visible") live.check(); };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      live.stop();
    };
  }, [ready, streamNonce]);

  // ---- a new sign-in (another tab, or `walkie dashboard` again) revives a signed-out page --
  const signedOut = state.phase === "error";
  useEffect(() => {
    if (!signedOut) return;
    const onStorage = (e: StorageEvent) => { if (e.key === SESSION_KEY && e.newValue) bumpBoot(); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [signedOut]);

  // ---- persist read markers ------------------------------------------------------
  const teamId = state.me?.team?.id;
  useEffect(() => {
    if (teamId && state.phase === "ready") save(`walkie.read.${teamId}`, state.readMarks);
  }, [teamId, state.readMarks, state.phase]);

  const markRead = useCallback((channel: string) => dispatch({ type: "read", channel, ts: Date.now() }), []);
  const applyEvents = useCallback((events: Event[]) => dispatch({ type: "events", events }), []);
  const applyOrch = useCallback((messages: OrchMessage[]) => dispatch({ type: "orch/messages", messages }), []);
  const refreshTeam = useCallback(() => {
    void api.team().then((team) => dispatch({ type: "team", team })).catch(() => {});
  }, []);
  const archiveLoaded = useCallback((agents: AgentView[], append?: boolean) => dispatch({ type: "archive/loaded", agents, ...(append ? { append } : {}) }), []);
  const refreshAsks = useCallback(() => {
    void api.asks().then((r) => dispatch({ type: "asks", asks: r.asks })).catch(() => {});
  }, []);

  const actions = useMemo<Actions>(() => ({
    retryBoot: bumpBoot,
    reconnectNow: bumpStream,
    markRead, applyEvents, applyOrch, refreshTeam, refreshAsks, archiveLoaded,
  }), [markRead, applyEvents, applyOrch, refreshTeam, refreshAsks, archiveLoaded]);

  return (
    <ActionsCtx.Provider value={actions}>
      <StateCtx.Provider value={state}>{children}</StateCtx.Provider>
    </ActionsCtx.Provider>
  );
}

const NO_ACTIONS: Actions = {
  retryBoot: () => {}, reconnectNow: () => {}, markRead: () => {}, applyEvents: () => {}, applyOrch: () => {}, refreshTeam: () => {},
  refreshAsks: () => {}, archiveLoaded: () => {},
};

/** A fixed state with no-op actions: for rendering views in tests. */
export function StaticStore({ state, children }: { state: State; children: ReactNode }) {
  return (
    <ActionsCtx.Provider value={NO_ACTIONS}>
      <StateCtx.Provider value={state}>{children}</StateCtx.Provider>
    </ActionsCtx.Provider>
  );
}

export function useStore(): State {
  return useContext(StateCtx);
}

export function useActions(): Actions {
  const a = useContext(ActionsCtx);
  if (!a) throw new Error("useActions outside StoreProvider");
  return a;
}
