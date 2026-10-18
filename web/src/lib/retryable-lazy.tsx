import { lazy, type ComponentType } from "react";

/** A failed chunk gets a fresh React.lazy promise when this route is opened again. */
export function retryableLazy(load: () => Promise<{ default: ComponentType }>) {
  let failed = false;
  const onNavigation = () => {
    if (!failed) return;
    failed = false;
    window.removeEventListener("hashchange", onNavigation);
    current = make();
  };
  const make = () => lazy(() => load().catch((error: unknown) => {
    if (!failed && typeof window !== "undefined") {
      failed = true;
      window.addEventListener("hashchange", onNavigation);
    }
    throw error;
  }));
  let current = make();
  return function RetryablePage() {
    const Page = current;
    return <Page />;
  };
}
