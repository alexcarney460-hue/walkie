// Render error boundaries (DASH-BLANK-1, WALKIE-98). A render exception used to unmount the whole React tree and leave a
// white page with no message. Now it is caught at three sizes, so the smallest piece that broke is what gives way:
//   root  a plain screen in the dashboard's style: what happened, Reload, and a way back to Mission Control
//   view  one view (the route's outlet) shows its name and a short message; the shell around it keeps working
//   item  one card, message or row shows "This item could not be shown"; its neighbours and the page keep working
// Every fallback has a closed "Details" disclosure with where it happened and the stack. A boundary tries its children
// again when its reset keys change: the route for a view, the item's data for an item.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { hrefFor, pageKey, useRoute } from "../lib/route.ts";
import { Logo } from "./Shell.tsx";

export type BoundaryScope = "root" | "view" | "item";

export interface ErrorBoundaryProps {
  scope: BoundaryScope;
  /** What this boundary guards ("Mission Control", "agent cc-1a2b"): shown under Details and in the console line. */
  name: string;
  /**
   * The boundary tries its children again when one of these changes (Object.is, element by element; a different
   * length is a change). Keys must keep their identity between renders unless the data changed: a fresh array is
   * fine, a fresh object each render is not.
   */
  resetKeys?: readonly unknown[];
  /** Item scope inside a list: the element the fallback is, so the list stays valid. */
  as?: "div" | "li";
  children?: ReactNode;
}

interface Caught { error: unknown; componentStack: string }
interface BoundaryState { caught: Caught | null }

const ITEM_TEXT = "This item could not be shown";
const MESSAGE_MAX = 400;
const NO_KEYS: readonly unknown[] = [];

export interface ErrorDescription {
  /** One short line: what was thrown. Never empty, never longer than a few hundred characters. */
  message: string;
  /** "Name: message" and the frames, for the Details. */
  stack: string;
}

/** What was thrown, as text, whatever it was (an Error, a string, null, an object that cannot even be printed). */
export function describeError(error: unknown): ErrorDescription {
  let name = "Error";
  let message = "";
  let frames = "";
  try {
    if (error instanceof Error) {
      name = error.name || "Error";
      message = String(error.message ?? "");
      frames = typeof error.stack === "string" ? error.stack : "";
    } else if (typeof error === "string") {
      message = error;
    } else if (error === null || error === undefined) {
      message = `${String(error)} was thrown`;
    } else if (typeof error === "object") {
      try { message = JSON.stringify(error) ?? ""; } catch { message = String(error); }
    } else {
      message = String(error);
    }
  } catch {
    message = "";
  }
  const shown = message.trim() ? message : `${name} with no message`;
  const short = shown.length > MESSAGE_MAX ? `${shown.slice(0, MESSAGE_MAX - 1)}…` : shown;
  const header = `${name}: ${shown}`;
  // V8 puts "Name: message" first in `stack`, other engines only the frames: say it once.
  const stack = frames.startsWith(header) || frames.startsWith(`${name}: ${message}`) ? frames : frames ? `${header}\n${frames}` : header;
  return { message: short, stack };
}

function keysChanged(prev: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean {
  const a = prev ?? NO_KEYS;
  const b = next ?? NO_KEYS;
  return a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
}

// ---- the console line: once per distinct failure ---------------------------------------------------------------------
// An item whose data keeps changing and keeps failing the same way would otherwise write a line per update.
const LOGGED_MAX = 100;
const logged = new Set<string>();

function logOnce(scope: BoundaryScope, name: string, error: unknown, componentStack: string): void {
  const { message } = describeError(error);
  const signature = `${scope}\u0000${name}\u0000${message}`;
  if (logged.has(signature)) return;
  if (logged.size >= LOGGED_MAX) logged.clear();
  logged.add(signature);
  console.error(`[walkie] ${scope === "root" ? "the dashboard" : scope === "view" ? "a view" : "an item"} hit an error in ${name}: ${message}`, error, componentStack);
}

/** For tests: lets the same failure be logged again. */
export function forgetLoggedErrors(): void {
  logged.clear();
}

// ---- fallbacks ------------------------------------------------------------------------------------------------------

function Details({ text }: { text: string }) {
  return (
    <details className="boundary-details">
      <summary>Details</summary>
      <pre className="boundary-stack">{text}</pre>
    </details>
  );
}

function ItemFallback({ as, detail }: { as?: "div" | "li"; detail: string }) {
  const Tag = as ?? "div";
  return (
    <Tag className="error-state error-compact boundary-item" data-testid="boundary-item">
      <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
      <span className="boundary-item-title">{ITEM_TEXT}</span>
      <Details text={detail} />
    </Tag>
  );
}

function ViewFallback({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="page boundary-view" data-testid="boundary-view">
      <h1 className="page-title">{name}</h1>
      <ItemFallback detail={detail} />
    </div>
  );
}

function RootFallback({ message, detail, onBack }: { message: string; detail: string; onBack: () => void }) {
  return (
    <main className="firstrun boundary-root" data-testid="boundary-root">
      <div className="firstrun-inner">
        <div className="firstrun-brand"><Logo size={28} /><span>Walkie</span></div>
        <div className="boundary-alert" role="alert">
          <h1 className="firstrun-title">Walkie's dashboard hit an error</h1>
          <p className="firstrun-lede boundary-message">{message}</p>
        </div>
        <Details text={detail} />
        <div className="firstrun-actions">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
          <a className="btn" href={hrefFor({ view: "mission" })} onClick={onBack}>Back to Mission Control</a>
        </div>
      </div>
    </main>
  );
}

// ---- the boundary ---------------------------------------------------------------------------------------------------

export class ErrorBoundary extends Component<ErrorBoundaryProps, BoundaryState> {
  state: BoundaryState = { caught: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { caught: { error, componentStack: "" } };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const componentStack = typeof info.componentStack === "string" ? info.componentStack : "";
    logOnce(this.props.scope, this.props.name, error, componentStack);
    this.setState({ caught: { error, componentStack } });
  }

  /**
   * Retry when the keys changed since the last commit, but only if the error was already showing before this update:
   * a failure caused by the update that changed the keys must not be retried at once.
   */
  componentDidUpdate(prevProps: ErrorBoundaryProps, prevState: BoundaryState): void {
    if (this.state.caught && prevState.caught && keysChanged(prevProps.resetKeys, this.props.resetKeys)) this.reset();
  }

  private readonly reset = (): void => {
    this.setState({ caught: null });
  };

  render(): ReactNode {
    const { caught } = this.state;
    if (!caught) return this.props.children;
    const { message, stack } = describeError(caught.error);
    const detail = [`Where: ${this.props.name}`, stack, caught.componentStack ? `Component stack:${caught.componentStack}` : ""].filter(Boolean).join("\n\n");
    switch (this.props.scope) {
      case "root": return <RootFallback message={message} detail={detail} onBack={this.reset} />;
      case "view": return <ViewFallback name={this.props.name} detail={detail} />;
      case "item": return <ItemFallback as={this.props.as} detail={detail} />;
    }
  }
}

/**
 * The outermost boundary: it also catches StoreProvider's own errors (a state change the reducer cannot fold is thrown
 * while rendering it). Tries again when the page changes: "Back to Mission Control" is a route change.
 */
export function RootBoundary({ children }: { children?: ReactNode }) {
  const route = useRoute();
  return <ErrorBoundary scope="root" name="Walkie dashboard" resetKeys={[pageKey(route)]}>{children}</ErrorBoundary>;
}
