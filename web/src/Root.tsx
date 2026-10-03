import { StrictMode } from "react";
import { App } from "./App.tsx";
import { RootBoundary } from "./components/ErrorBoundary.tsx";
import { GlassFilters } from "./components/GlassFilters.tsx";
import { StoreProvider } from "./state/store.tsx";

/**
 * The whole dashboard, as main.tsx mounts it. The root boundary sits OUTSIDE StoreProvider on purpose: a state change the
 * reducer cannot fold is thrown while StoreProvider itself renders, and only a boundary above it can catch that.
 */
export function Root() {
  return (
    <StrictMode>
      <RootBoundary>
        <StoreProvider>
          <GlassFilters />
          <App />
        </StoreProvider>
      </RootBoundary>
    </StrictMode>
  );
}
