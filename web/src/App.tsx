import { useCallback, useState } from "react";
import { AgentDrawer } from "./components/AgentDrawer.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { MobileBar, Sidebar, TabBar, Logo } from "./components/Shell.tsx";
import { useGlobalHotkeys } from "./lib/hotkeys.ts";
import { useRoute } from "./lib/route.ts";
import { useStore } from "./state/store.tsx";
import { Artifacts } from "./views/Artifacts.tsx";
import { Asks } from "./views/Asks.tsx";
import { BootError, FirstRun, SignedOut } from "./views/FirstRun.tsx";
import { Integrations } from "./views/Integrations.tsx";
import { Accounts } from "./views/Accounts.tsx";
import { MachineDetail } from "./views/machine/MachineDetail.tsx";
import { Team } from "./views/Team.tsx";
import { Board } from "./views/board/Board.tsx";
import { MissionControl } from "./views/mission/MissionControl.tsx";
import { Orchestrator } from "./views/orchestrator/Orchestrator.tsx";
import { Projects } from "./views/projects/Projects.tsx";
import { Seats } from "./views/seats/Seats.tsx";

function Loading() {
  return (
    <main className="boot" aria-busy="true">
      <Logo size={28} />
      <span className="boot-label">Connecting to the daemon…</span>
    </main>
  );
}

function Dashboard() {
  const route = useRoute();
  const [palette, setPalette] = useState(false);
  const openPalette = useCallback(() => setPalette(true), []);
  useGlobalHotkeys(openPalette);

  return (
    <div className={`app view-${route.view}`}>
      <Sidebar onSearch={openPalette} />
      <MobileBar onSearch={openPalette} />
      <main className="main" id="main">
        {route.view === "mission" && <MissionControl />}
        {route.view === "orchestrator" && <Orchestrator />}
        {route.view === "projects" && <Projects />}
        {route.view === "board" && <Board />}
        {route.view === "asks" && <Asks />}
        {route.view === "artifacts" && <Artifacts />}
        {route.view === "team" && <Team />}
        {route.view === "integrations" && <Integrations />}
        {route.view === "accounts" && <Accounts />}
        {route.view === "seats" && <Seats />}
        {route.view === "machine" && <MachineDetail key={route.node} />}
      </main>
      <TabBar />
      {route.agent && <AgentDrawer key={route.agent} id={route.agent} />}
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
