import { Suspense, useEffect, useState } from "react";
import { Armchair, ChevronRight, Cpu, FileText, Gauge, LayoutList, ListChecks, Plug, Server, Users, type LucideIcon } from "lucide-react";
import { api } from "../../api/client.ts";
import type { IntegrationView, SeatsView } from "../../api/types.ts";
import { ErrorBoundary } from "../../components/ErrorBoundary.tsx";
import { PageHeader } from "../../components/Shell.tsx";
import { SkeletonRows } from "../../components/primitives.tsx";
import { inUse } from "../../components/Accounts.tsx";
import { planBadgeText } from "../../lib/plan.ts";
import { hrefFor, useRoute, type Route } from "../../lib/route.ts";
import { retryableLazy } from "../../lib/retryable-lazy.tsx";
import { useNow } from "../../lib/time.ts";
import { reportedProjects } from "../../lib/updates.ts";
import { projectsStore, useProjects } from "../../state/projects.ts";
import { useStore } from "../../state/store.tsx";
import { useHomeNeeds } from "../home/needs.tsx";
import { settingsWarnings } from "./model.ts";

const LocalModelsPage = retryableLazy(() => import("./LocalModelsPage.tsx").then((module) => ({ default: module.LocalModelsPage })));

interface Row { title: string; route: Route; icon: LucideIcon; status: string; warning?: boolean; loading?: boolean; error?: boolean; onRetry?: () => void }

export function Settings() {
  const route = useRoute();
  const store = useStore();
  const { pending, pendingStatus, retryPending } = useHomeNeeds();
  const projects = useProjects();
  const now = useNow();
  const [seats, setSeats] = useState<SeatsView | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationView[] | null>(null);
  const [seatsError, setSeatsError] = useState(false);
  const [integrationsError, setIntegrationsError] = useState(false);
  const [seatsNonce, setSeatsNonce] = useState(0);
  const [integrationsNonce, setIntegrationsNonce] = useState(0);
  useEffect(() => {
    void projectsStore.refresh();
  }, []);
  useEffect(() => {
    let cancelled = false;
    void api.seats().then((value) => { if (!cancelled) setSeats(value); }).catch(() => { if (!cancelled) setSeatsError(true); });
    return () => { cancelled = true; };
  }, [seatsNonce]);
  useEffect(() => {
    let cancelled = false;
    void api.integrations().then((value) => { if (!cancelled) setIntegrations(value.integrations); }).catch(() => { if (!cancelled) setIntegrationsError(true); });
    return () => { cancelled = true; };
  }, [integrationsNonce]);
  if (route.tab === "models") return <Suspense fallback={<div className="page settings-page" aria-label="Loading Local models"><PageHeader title="Local models" /><SkeletonRows rows={2} /></div>}><LocalModelsPage /></Suspense>;

  const plan = store.team?.plan ?? store.me?.plan;
  const online = store.nodes.filter((node) => node.online).length;
  const working = store.agents.filter((agent) => agent.effective_state === "working").length;
  const reportCount = reportedProjects(projects.projects).length;
  const validAccounts = store.accounts.filter((account) => Array.isArray(account.owners) && Array.isArray(account.machines));
  const warnings = settingsWarnings(store, now, pending.length);
  const rows: Row[] = [
    { title: "Team and billing", route: { view: "team" }, icon: Users,
      status: `${store.team?.members.length ?? 0} people${pending.length && store.me?.role === "owner" ? ` · ${pending.length} machine${pending.length === 1 ? "" : "s"} waiting to join` : ""}${plan ? ` · ${planBadgeText(plan)}` : ""}`,
      warning: warnings.team, error: pendingStatus === "error" && store.me?.role === "owner", onRetry: retryPending },
    { title: "Machines and agents", route: { view: "agents" }, icon: Server,
      status: `${online} of ${store.nodes.length} online · ${working} agents working`, warning: warnings.agents },
    { title: "Accounts", route: { view: "accounts" }, icon: Gauge,
      status: `${validAccounts.length} accounts · ${validAccounts.filter(inUse).length} in use`, warning: warnings.accounts },
    { title: "Seats", route: { view: "seats" }, icon: Armchair,
      status: seats ? seats.seats.filter((seat) => seat.state === "running").length
        ? `${seats.seats.filter((seat) => seat.state === "running").length} running` : seats.local.allow ? "On here · none running" : "Off on this machine"
        : seatsError ? "Seats unavailable" : "Checking seats…", loading: !seats && !seatsError, error: seatsError,
      onRetry: () => { setSeatsError(false); setSeats(null); setSeatsNonce((n) => n + 1); } },
    { title: "Integrations", route: { view: "integrations" }, icon: Plug,
      status: integrations ? integrations.filter((item) => item.enabled).map((item) => item.name).join(", ") || "None connected"
        : integrationsError ? "Integrations unavailable" : "Checking integrations…", loading: !integrations && !integrationsError, error: integrationsError,
      onRetry: () => { setIntegrationsError(false); setIntegrations(null); setIntegrationsNonce((n) => n + 1); } },
    { title: "Files", route: { view: "artifacts" }, icon: FileText, status: "Files agents shared" },
    { title: "Status reports", route: { view: "updates" }, icon: LayoutList,
      status: projects.status === "error" ? "Status reports unavailable" : projects.status !== "ready" ? "Checking status reports…"
        : reportCount ? `${reportCount} project${reportCount === 1 ? "" : "s"} report${reportCount === 1 ? "s" : ""} hourly` : "Off",
      loading: projects.status !== "ready" && projects.status !== "error", error: projects.status === "error",
      onRetry: () => void projectsStore.refresh() },
    { title: "Local models", route: { view: "settings", tab: "models" }, icon: Cpu, status: "What this team can run on its own machines" },
    { title: "Plain-language board", route: { view: "simple" }, icon: ListChecks, status: "Large text, no jargon" },
  ];
  return <div className="page settings-page">
    <PageHeader title="Settings" />
    <ul className="settings-list">{rows.map((row) => <ErrorBoundary key={row.title} scope="item" as="li" name={row.title} resetKeys={[row.status, row.warning]}>
      <li className="settings-item"><a className={`settings-row${row.warning ? " is-warning" : ""}`} href={hrefFor(row.route)}>
        <row.icon size={20} aria-hidden="true" />
        <span><strong>{row.title}</strong><span className="settings-status">{row.loading ? <span className="skeleton settings-skeleton" aria-label={`Loading ${row.title}`} /> : row.status}</span></span>
        <ChevronRight size={17} aria-hidden="true" />
      </a>{row.error && row.onRetry && <button type="button" className="btn btn-ghost btn-sm settings-retry" onClick={row.onRetry}>Retry {row.title}</button>}</li>
    </ErrorBoundary>)}</ul>
  </div>;
}
