import { useState, type CSSProperties, type ReactNode } from "react";
import { Check, Copy, RefreshCw, TriangleAlert } from "lucide-react";
import type { AgentState, Runtime } from "../api/types.ts";
import { STATE_LABEL, hueFor, initials } from "../lib/format.ts";
import { ago, agoLong, agoPlain, fullTime, useNow } from "../lib/time.ts";
import { runtimeLabel } from "../../../src/protocol/runtime-label.ts";

/** An inline hue custom property (UI-POLISH-2): `--mh` machine, `--ph` person, `--th` tag. */
export function hueVar(name: "--mh" | "--ph" | "--th", hue: number): CSSProperties {
  return { [name]: hue } as CSSProperties;
}

export function Avatar({ handle, name, size = 24, agent }: { handle: string; name: string; size?: number; agent?: boolean }) {
  const hue = hueFor(handle);
  const style = { "--av-h": hue, width: size, height: size, fontSize: Math.round(size * 0.4) } as CSSProperties;
  return (
    <span className={agent ? "avatar avatar-agent" : "avatar"} style={style} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function StatePill({ state, compact }: { state: AgentState; compact?: boolean }) {
  return (
    <span className={`state-pill state-${state}`} data-compact={compact || undefined}>
      <span className="state-dot" aria-hidden="true" />
      {!compact && STATE_LABEL[state]}
      {compact && <span className="sr-only">{STATE_LABEL[state]}</span>}
    </span>
  );
}

export function RuntimeBadge(status: { runtime: Runtime; runtime_name?: string; launch?: string }) {
  return <span className={`runtime rt-${status.runtime}`}>{runtimeLabel(status, true)}</span>;
}

export function RelTime({ ts, long, className }: { ts: number; long?: boolean; className?: string }) {
  const now = useNow();
  return (
    <time className={`tnum ${className ?? ""}`} dateTime={new Date(ts).toISOString()} title={fullTime(ts)}>
      {long ? agoLong(ts, now) : ago(ts, now)}
    </time>
  );
}

/** A time in whole words ("3 weeks ago", never "3w"), counting on its own, with the exact moment on hover: for pages read by people who are not on a terminal. */
export function PlainTime({ ts, className }: { ts: number; className?: string }) {
  const now = useNow();
  return <time className={className} dateTime={new Date(ts).toISOString()} title={fullTime(ts)}>{agoPlain(ts, now)}</time>;
}

/** The default empty-state picture: two little chat bubbles, one waiting for a reply. */
function EmptyArt() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <path d="M4 7.5A3.5 3.5 0 0 1 7.5 4h8A3.5 3.5 0 0 1 19 7.5v4a3.5 3.5 0 0 1-3.5 3.5H10l-3.4 2.7c-.5.4-1.1 0-1.1-.5V15A3.5 3.5 0 0 1 4 11.5v-4Z" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="8.6" cy="9.6" r="1.1" fill="currentColor" />
      <circle cx="11.5" cy="9.6" r="1.1" fill="currentColor" />
      <circle cx="14.4" cy="9.6" r="1.1" fill="currentColor" />
      <path d="M21.5 12.5a2.5 2.5 0 0 1 .5 1.5v3a2.5 2.5 0 0 1-2.5 2.5v1.8l-2.6-1.8H14" stroke="var(--signal)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function EmptyState({ icon, title, children, command }: { icon?: ReactNode; title: string; children?: ReactNode; command?: string }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">{icon ?? <EmptyArt />}</div>
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
      {command && <CopyCommand command={command} />}
    </div>
  );
}

export function ErrorState({ message, onRetry, compact }: { message: string; onRetry?: () => void; compact?: boolean }) {
  return (
    <div className={compact ? "error-state error-compact" : "error-state"} role="alert">
      <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          <RefreshCw size={13} strokeWidth={1.75} aria-hidden="true" />
          Retry
        </button>
      )}
    </div>
  );
}

/** A command (or, with `prompt={false}`, any text such as an invite code) with a copy button. */
export function CopyCommand({ command, label, prompt = true }: { command: string; label?: string; prompt?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_600);
    } catch {
      /* clipboard blocked: the command is still selectable */
    }
  };
  return (
    <div className={prompt ? "cmd" : "cmd cmd-wrap"}>
      {label && <span className="cmd-label">{label}</span>}
      <code className="cmd-code">{prompt && <span className="cmd-prompt" aria-hidden="true">$</span>}{command}</code>
      <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={copy} aria-label={copied ? "Copied" : prompt ? `Copy command: ${command}` : `Copy ${label ?? "text"}`}>
        {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.75} />}
      </button>
    </div>
  );
}

export function SkeletonRows({ rows = 5, avatar }: { rows?: number; avatar?: boolean }) {
  return (
    <div className="skeleton-rows" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row">
          {avatar && <span className="skeleton" style={{ width: 28, height: 28, borderRadius: 7 }} />}
          <div style={{ flex: 1, display: "grid", gap: 6 }}>
            <span className="skeleton" style={{ width: `${28 + ((i * 17) % 20)}%`, height: 10 }} />
            <span className="skeleton" style={{ width: `${55 + ((i * 29) % 35)}%`, height: 10 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Section({ title, meta, actions, children, id }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="section" aria-labelledby={id}>
      <header className="section-head">
        <h2 className="section-title" id={id}>{title}</h2>
        {meta && <span className="section-meta">{meta}</span>}
        {actions && <div className="section-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}
