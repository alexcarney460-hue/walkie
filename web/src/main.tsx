import "./lib/session.ts"; // first: takes the login session out of the address bar before the router reads it
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/geist-sans/latin-400.css";
import "@fontsource/geist-sans/latin-500.css";
import "@fontsource/geist-sans/latin-600.css";
import "@fontsource/geist-mono/latin-400.css";
import "@fontsource/geist-mono/latin-500.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/shell.css";
import "./styles/mission.css";
import "./styles/board.css";
import "./styles/orchestrator.css";
import "./styles/pages.css";
import "./styles/integrations.css";
import "./styles/overlays.css";
import "./styles/machine-stats.css";
import "./styles/local-models.css";
import "./styles/accounts.css";
import "./styles/seats.css";
import "./styles/phone.css";
import "./styles/projects.css";
import "./styles/compute.css";
import "./lib/theme.ts";
import "./styles/machine.css";
import "./styles/glass.css"; // the glass layer restyles the view surfaces
import "./styles/color.css"; // last: the colour layer (UI-POLISH-2) tints the glass surfaces
import { App } from "./App.tsx";
import { GlassFilters } from "./components/GlassFilters.tsx";
import { StoreProvider } from "./state/store.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <StoreProvider>
      <GlassFilters />
      <App />
    </StoreProvider>
  </StrictMode>,
);
