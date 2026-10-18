import { Suspense, useCallback, useState } from "react";
import { AgentDrawer } from "./components/AgentDrawer.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { ShortcutsDialog } from "./components/ShortcutsDialog.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { MobileBar, Sidebar, TabBar, Logo } from "./components/Shell.tsx";
import { PageHeader } from "./components/Shell.tsx";
import { SkeletonRows } from "./components/primitives.tsx";
import { useGlobalHotkeys } from "./lib/hotkeys.ts";
import { pageKey, useRoute, type Route, type View } from "./lib/route.ts";
import { retryableLazy } from "./lib/retryable-lazy.tsx";
import { useStore } from "./state/store.tsx";
import { BootError, FirstRun, SignedOut } from "./views/FirstRun.tsx";
import { Board } from "./views/board/Board.tsx";
import { Orchestrator } from "./views/orchestrator/Orchestrator.tsx";
import { Projects } from "./views/projects/Projects.tsx";
import { HomeNeedsProvider } from "./views/home/needs.tsx";
// Home is the live agent view, so it ships in the first chunk, not a lazy one.
import { MissionControl } from "./views/mission/MissionControl.tsx";
const Artifacts = retryableLazy(() => import("./views/Artifacts.tsx").then((module) => ({ default: module.Artifacts })));
const Asks = retryableLazy(() => import("./views/Asks.tsx").then((module) => ({ default: module.Asks })));
const Integrations = retryableLazy(() => import("./views/Integrations.tsx").then((module) => ({ default: module.Integrations })));
const Accounts = retryableLazy(() => import("./views/Accounts.tsx").then((module) => ({ default: module.Accounts })));
const MachineDetail = retryableLazy(() => import("./views/machine/MachineDetail.tsx").then((module) => ({ default: module.MachineDetail })));
const Team = retryableLazy(() => import("./views/Team.tsx").then((module) => ({ default: module.Team })));
const SimpleBoard = retryableLazy(() => import("./views/simple/SimpleBoard.tsx").then((module) => ({ default: module.SimpleBoard })));
const Seats = retryableLazy(() => import("./views/seats/Seats.tsx").then((module) => ({ default: module.Seats })));
const Updates = retryableLazy(() => import("./views/updates/Updates.tsx").then((module) => ({ default: module.Updates })));
const Settings = retryableLazy(() => import("./views/settings/Settings.tsx").then((module) => ({ default: module.Settings })));

function Loading() {
  return (
    <main className="boot" aria-busy="true">
      <Logo size={28} />
      <span className="boot-label">Connecting to the daemon…</span>
    </main>
  );
}

/** What a view's boundary calls it (the same words as the navigation). */
const VIEW_NAME: Record<View, string> = {
  home: "Home", settings: "Settings", agents: "Agents and machines", mission: "Agents and machines", updates: "Updates", orchestrator: "Talkie", projects: "Projects", simple: "Simple", board: "Channels", asks: "Asks", artifacts: "Artifacts",
  team: "Team", integrations: "Integrations", accounts: "Accounts", seats: "Seats", machine: "Machine",
};

/** The route's view. */
export function RouteLoading({ name }: { name: string }) {
  return <div className="page route-loading" aria-label={`Loading ${name}`}><PageHeader title={name} /><SkeletonRows rows={3} /></div>;
}

export function ViewOutlet({ route }: { route: Route }) {
  return <Suspense fallback={<RouteLoading name={VIEW_NAME[route.view]} />}>{routeView(route)}</Suspense>;
}

function routeView(route: Route) {
  switch (route.view) {
    case "home": return <MissionControl home />;
    case "settings": return <Settings />;
    case "agents": return <MissionControl home />;
    case "mission": return <MissionControl home />;
    case "updates": return <Updates />;
    case "orchestrator": return <Orchestrator />;
    case "projects": return <Projects />;
    case "simple": return <SimpleBoard />;
    case "board": return <Board />;
    case "asks": return <Asks />;
    case "artifacts": return <Artifacts />;
    case "team": return <Team />;
    case "integrations": return <Integrations />;
    case "accounts": return <Accounts />;
    case "seats": return <Seats />;
    case "machine": return <MachineDetail key={route.node} />;
  }
}

function Dashboard() {
  const route = useRoute();
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const openPalette = useCallback(() => setPalette(true), []);
  const openShortcuts = useCallback(() => setShortcuts(true), []);
  const closeShortcuts = useCallback(() => setShortcuts(false), []);
  useGlobalHotkeys(openPalette, openShortcuts);
  const { agents, archivedAgents, me } = useStore();
  const drawerAgent = route.agent ? agents.find((a) => a.id === route.agent) ?? archivedAgents.find((a) => a.id === route.agent) : undefined;

  return (
    <HomeNeedsProvider key={`${me?.handle ?? ""}|${me?.role ?? ""}`}><div className={`app view-${route.view}`}>
      <Sidebar onSearch={openPalette} />
      <MobileBar onSearch={openPalette} />
      <main className="main" id="main">
        {/* A view that throws gives way alone: the shell stays, and any other page works. */}
        <ErrorBoundary scope="view" name={VIEW_NAME[route.view]} resetKeys={[pageKey(route)]}><ViewOutlet route={route} /></ErrorBoundary>
      </main>
      <TabBar />
      {route.agent && <ErrorBoundary scope="item" name={`agent ${route.agent}`} resetKeys={[route.agent, drawerAgent]}><AgentDrawer key={route.agent} id={route.agent} /></ErrorBoundary>}
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      {shortcuts && <ShortcutsDialog onClose={closeShortcuts} />}
    </div></HomeNeedsProvider>
  );
}

export function App() {
  const { phase, me, error, signedOut } = useStore();
  if (phase === "loading") return <Loading />;
  if (phase === "error") return signedOut ? <SignedOut /> : <BootError message={error ?? "Can't reach the daemon."} />;
  if (phase === "no-team" && me) return <FirstRun me={me} />;
  return <Dashboard />;
}
