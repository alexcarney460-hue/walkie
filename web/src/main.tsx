import "./lib/session.ts"; // first: takes the login session out of the address bar before the router reads it
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
import "./styles/status-page.css";
import "./styles/updates.css";
import "./styles/compute.css";
import "./lib/theme.ts";
import "./styles/machine.css";
import "./styles/boundary.css";
import "./styles/glass.css"; // the glass layer restyles the view surfaces
import "./styles/color.css"; // the colour layer (UI-POLISH-2) tints the glass surfaces
import "./styles/simple.css"; // last: Simple mode's 18px type and 44px targets win over the glass buttons
import { Root } from "./Root.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// The error boundaries write what they catch to the console themselves, once per failure
// (components/ErrorBoundary.tsx): React's own report of a caught error would write it a second time.
createRoot(root, { onCaughtError: () => {} }).render(<Root />);
