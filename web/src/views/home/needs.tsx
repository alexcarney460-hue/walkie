import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../../api/client.ts";
import type { AccountView, AgentView, AskView, CardView, PendingJoin, ProjectView, Recommendation } from "../../api/types.ts";
import { canAnswer, needsAttention } from "../../lib/format.ts";
import { onSimplePage, partition } from "../../lib/simple-board.ts";
import { useNow } from "../../lib/time.ts";
import { useRoute } from "../../lib/route.ts";
import { projectsStore, useProjects } from "../../state/projects.ts";
import { useStore } from "../../state/store.tsx";
import { shownByDefault } from "../../../../src/protocol/agent-roster.ts";
import { displayState } from "../../../../src/protocol/accounts-format.ts";

export interface LoginNeed { account: AccountView; hostname: string }
export interface HomeNeeds {
  asks: AskView[];
  agents: AgentView[];
  cards: CardView[];
  projectCards: CardView[];
  projectCardsComplete?: boolean;
  projectCardsStatus?: "loading" | "ready" | "unavailable";
  recommendations: Recommendation[];
  pending: PendingJoin[];
  pendingStatus?: "loading" | "ready" | "error";
  retryPending?: () => void;
  logins: LoginNeed[];
  count: number;
  cardsError?: boolean;
  cardsLoading?: boolean;
  retryCards?: () => void;
}

const EMPTY: HomeNeeds = { asks: [], agents: [], cards: [], projectCards: [], projectCardsComplete: false, projectCardsStatus: "loading",
  recommendations: [], pending: [], pendingStatus: "loading", retryPending: () => undefined, logins: [], count: 0 };
const EMPTY_RECS: Recommendation[] = [];
export const HomeNeedsContext = createContext<HomeNeeds>(EMPTY);

type Source = Pick<ReturnType<typeof useStore>, "asks" | "agents" | "accounts" | "me">;

export function assembleHomeNeeds(source: Source, projects: readonly ProjectView[], cards: readonly CardView[],
  projectCards: readonly CardView[], recs: readonly Recommendation[], pending: readonly PendingJoin[], now: number): HomeNeeds {
  const { asks, agents, accounts, me } = source;
  const handle = me?.handle ?? null;
  const owner = me?.role === "owner";
  const mine = me?.role === "observer" ? [] : asks.filter((ask) => canAnswer(ask, handle, agents, now))
    .sort((a, b) => b.ask.ts - a.ask.ts);
  const asking = new Set(mine.map((ask) => `${ask.ask.author.handle}/${ask.ask.author.node}/${ask.ask.author.agent ?? ""}`));
  const stuck = agents.filter((agent) => shownByDefault(agent) && needsAttention(agent.effective_state)
    && !asking.has(`${agent.handle}/${agent.node}/${agent.agent}`))
    .sort((a, b) => b.updated_at - a.updated_at);
  const logins = accounts.filter((account) => Array.isArray(account.owners) && Array.isArray(account.machines))
    .flatMap((account) => account.machines
    .filter((machine) => machine && machine.handle === handle && displayState(machine.usage, now) === "relogin")
    .map((machine) => ({ account, hostname: machine.hostname })));
  const visiblePending = owner ? [...pending].sort((a, b) => b.requested_at - a.requested_at) : [];
  const visibleCards = cards.filter((card) => onSimplePage(card, projects));
  const visibleProjectCards = projectCards.filter((card) => onSimplePage(card, projects));
  return { asks: mine, agents: stuck, cards: [...visibleCards].sort((a, b) => b.updated_at - a.updated_at),
    projectCards: visibleProjectCards, recommendations: [...recs], pending: visiblePending, logins,
    count: mine.length + stuck.length + visibleCards.length + recs.length + visiblePending.length + logins.length };
}

/** The same six lists feed both Home and its navigation badge on every route. */
export function HomeNeedsProvider({ children }: { children: ReactNode }) {
  const route = useRoute();
  const { asks, agents, accounts, me } = useStore();
  const projects = useProjects();
  const now = useNow();
  const [cards, setCards] = useState<CardView[]>([]);
  const [projectCards, setProjectCards] = useState<CardView[]>([]);
  const [recState, setRecState] = useState<{ access: number; items: Recommendation[] }>({ access: -1, items: [] });
  const [pending, setPending] = useState<PendingJoin[]>([]);
  const [pendingStatus, setPendingStatus] = useState<HomeNeeds["pendingStatus"]>("loading");
  const [pendingNonce, setPendingNonce] = useState(0);
  const lastPendingRequest = useRef(0);
  const pendingRequestId = useRef(0);
  const previousPendingNonce = useRef(0);
  const [projectCardsComplete, setProjectCardsComplete] = useState(false);
  const [projectCardsStatus, setProjectCardsStatus] = useState<HomeNeeds["projectCardsStatus"]>("loading");
  const cardsSource = useRef<string | null>(null);
  const [cardsError, setCardsError] = useState(false);
  const [cardsLoading, setCardsLoading] = useState(true);
  const [cardsNonce, setCardsNonce] = useState(0);
  const home = route.view === "home";
  const handle = me?.handle ?? null;
  const owner = me?.role === "owner";
  const access = projectsStore.accessGeneration();
  const recs = recState.access === access ? recState.items : EMPTY_RECS;

  useEffect(() => {
    let cancelled = false;
    const generation = projectsStore.accessGeneration();
    const source = `${handle ?? ""}|${access}`;
    if (cardsSource.current !== source) {
      cardsSource.current = source;
      setCards([]);
      setProjectCards([]);
      setProjectCardsComplete(false);
      setProjectCardsStatus("loading");
    }
    setCardsError(false);
    setCardsLoading(true);
    void Promise.all([
      projectsStore.refresh(),
      api.tasks({ state: "open", limit: 500 }),
      api.tasks({ state: "open", assignee: "me", limit: 500 }),
      api.tasks({ state: "open", role: "review", limit: 500 }),
    ]).then(([, team, mine, review]) => {
      if (cancelled || generation !== projectsStore.accessGeneration()) return;
      const state = projectsStore.get();
      if (state.error) { setCardsError(true); setCardsLoading(false); setProjectCardsComplete(false); setProjectCardsStatus("unavailable"); return; }
      const model = partition(team.tasks, state.projects, handle, { mine: mine.tasks, review: review.tasks });
      setCards(model.decisions);
      setProjectCards(team.tasks.filter((card) => !model.hiddenIds.has(card.id) && onSimplePage(card, state.projects)));
      const complete = team.tasks.length < 500;
      setProjectCardsComplete(complete);
      setProjectCardsStatus(complete ? "ready" : "unavailable");
      setCardsLoading(false);
    }).catch(() => { if (!cancelled) { setCardsError(true); setCardsLoading(false); setProjectCardsComplete(false); setProjectCardsStatus("unavailable"); } });
    return () => { cancelled = true; };
  }, [home, handle, access, cardsNonce]);

  useEffect(() => {
    if (!owner) {
      pendingRequestId.current += 1;
      setPending([]);
      return;
    }
    const load = (force = false) => {
      const at = Date.now();
      if (!force && at - lastPendingRequest.current < 10_000) return;
      lastPendingRequest.current = at;
      const requestId = ++pendingRequestId.current;
      void api.pending().then((result) => {
        if (requestId !== pendingRequestId.current) return;
        setPending(result.requests); setPendingStatus("ready");
      }).catch(() => { if (requestId === pendingRequestId.current) setPendingStatus("error"); });
    };
    const explicitRetry = pendingNonce !== previousPendingNonce.current;
    previousPendingNonce.current = pendingNonce;
    if (home || route.view === "team" || route.view === "settings" || explicitRetry) load(explicitRetry);
    const onFocus = () => load();
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [owner, home, route.view, access, pendingNonce]);

  useEffect(() => {
    let cancelled = false;
    const load = () => { void api.recommendations()
      .then((result) => { if (!cancelled) setRecState({ access, items: result.recs.filter((rec) => rec.status === "pending") }); })
      .catch(() => { if (!cancelled) setRecState({ access, items: [] }); }); };
    load();
    const timer = home ? setInterval(load, 60_000) : null;
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [home, access]);

  const needs = useMemo(() => {
    try {
      return { ...assembleHomeNeeds({ asks, agents, accounts, me }, projects.projects,
        cards, projectCards, recs, pending, now), projectCardsComplete, projectCardsStatus, pendingStatus,
        retryPending: () => setPendingNonce((n) => n + 1), cardsError, cardsLoading, retryCards: () => setCardsNonce((n) => n + 1) };
    } catch {
      return { ...EMPTY, projectCardsStatus, pendingStatus, retryPending: () => setPendingNonce((n) => n + 1),
        cardsError, cardsLoading, retryCards: () => setCardsNonce((n) => n + 1) };
    }
  }, [asks, agents, accounts, me, now, cards, projectCards, projectCardsComplete, projectCardsStatus, projects.projects, recs, pending, pendingStatus, cardsError, cardsLoading]);
  return <HomeNeedsContext.Provider value={needs}>{children}</HomeNeedsContext.Provider>;
}

export function useHomeNeeds(): HomeNeeds { return useContext(HomeNeedsContext); }
