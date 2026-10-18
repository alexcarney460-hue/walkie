import { ErrorBoundary } from "../../components/ErrorBoundary.tsx";
import { LocalModelsCard, LocalModelsSection } from "../../components/LocalModels.tsx";
import { PageHeader } from "../../components/Shell.tsx";
import { hrefFor } from "../../lib/route.ts";
import { useStore } from "../../state/store.tsx";

export function LocalModelsPage() {
  const { nodes } = useStore();
  return <div className="page settings-page">
    <a href={hrefFor({ view: "settings" })}>Back to Settings</a>
    <PageHeader title="Local models" />
    <ErrorBoundary scope="item" name="local models" resetKeys={[nodes]}><LocalModelsCard nodes={nodes} /></ErrorBoundary>
    <section id="model-details" aria-label="Local model details">
      <ErrorBoundary scope="item" name="local model details" resetKeys={[nodes]}><LocalModelsSection nodes={nodes} /></ErrorBoundary>
    </section>
  </div>;
}
