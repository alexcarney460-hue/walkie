import { useCallback, useState } from "react";
import { AgentDrawer } from "./components/AgentDrawer.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { MobileBar, Sidebar, TabBar, Logo } from "./components/Shell.tsx";
import { useGlobalHotkeys } from "./lib/hotkeys.ts";
import { pageKey, useRoute, type Route, type View } from "./lib/route.ts";
import { useStore } from "./state/store.tsx";
import { Artifacts } from "./views/Artifacts.tsx";
import { Asks } from "./views/Asks.tsx";
import { BootError, FirstRun, SignedOut } from "./views/FirstRun.tsx";
import { Integrations } from "./views/Integrations.tsx";
import { Accounts } from "./views/Accounts.tsx";
import { PoolBanner } from "./components/AccountsPool.tsx";
import { MachineDetail } from "./views/machine/MachineDetail.tsx";
import { Team } from "./views/Team.tsx";
import { Board } from "./views/board/Board.tsx";
import { MissionControl } from "./views/mission/MissionControl.tsx";
import { Orchestrator } from "./views/orchestrator/Orchestrator.tsx";
import { Projects } from "./views/projects/Projects.tsx";
import { Seats } from "./views/seats/Seats.tsx";
import { Updates } from "./views/updates/Updates.tsx";

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
  mission: "Mission Control", updates: "Updates", orchestrator: "WalkieTalkie", projects: "Projects", board: "Channels", asks: "Asks", artifacts: "Artifacts",
  team: "Team", integrations: "Integrations", accounts: "Accounts", seats: "Seats", machine: "Machine",
};

/** The route's view. */
function ViewOutlet({ route }: { route: Route }) {
  switch (route.view) {
    case "mission": return <MissionControl />;
    case "updates": return <Updates />;
    case "orchestrator": return <Orchestrator />;
    case "projects": return <Projects />;
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
  const openPalette = useCallback(() => setPalette(true), []);
  useGlobalHotkeys(openPalette);
  const { accountsPool, agents, archivedAgents } = useStore();
  const drawerAgent = route.agent ? agents.find((a) => a.id === route.agent) ?? archivedAgents.find((a) => a.id === route.agent) : undefined;

  return (
    <div className={`app view-${route.view}`}>
      <Sidebar onSearch={openPalette} />
      <MobileBar onSearch={openPalette} />
      <main className="main" id="main">
        <ErrorBoundary scope="item" name="Accounts banner" resetKeys={[accountsPool]}><PoolBanner pool={accountsPool} /></ErrorBoundary>
        {/* A view that throws gives way alone: the shell stays, and any other page works. */}
        <ErrorBoundary scope="view" name={VIEW_NAME[route.view]} resetKeys={[pageKey(route)]}><ViewOutlet route={route} /></ErrorBoundary>
      </main>
      <TabBar />
      {route.agent && <ErrorBoundary scope="item" name={`agent ${route.agent}`} resetKeys={[route.agent, drawerAgent]}><AgentDrawer key={route.agent} id={route.agent} /></ErrorBoundary>}
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}

export function App() {
  const { phase, me, error, signedOut } = useStore();
  if (phase === "loading") return <Loading />;
  if (phase === "error") return signedOut ? <SignedOut /> : <BootError message={error ?? "Can't reach the daemon."} />;
  if (phase === "no-team" && me) return <FirstRun me={me} />;
  return <Dashboard />;
}
