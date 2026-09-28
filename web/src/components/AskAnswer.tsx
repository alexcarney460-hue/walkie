import { useState } from "react";
import { api, friendlyError } from "../api/client.ts";
import type { AskView } from "../api/types.ts";
import { useActions } from "../state/store.tsx";

type Mode = "answer" | "decline";

/** Inline answer / decline for an open ask. No modal: the form opens in place. */
export function AskAnswer({ view }: { view: AskView }) {
  const { applyEvents } = useActions();
  const [mode, setMode] = useState<Mode | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const declined = mode === "decline";
    const body = text.trim() || (declined ? "Declined from the dashboard." : "");
    if (!body) {
      setError("Write an answer first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { event } = await api.answer({ ask: view.ask.id, text: body, ...(declined ? { declined: true } : {}) });
      applyEvents([event]);
      setMode(null);
      setText("");
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!mode) {
    return (
      <div className="ask-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setMode("answer")}>Answer</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode("decline")}>Decline</button>
      </div>
    );
  }

  const declining = mode === "decline";
  return (
    <form className="ask-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <label className="sr-only" htmlFor={`ans-${view.ask.id}`}>{declining ? "Reason for declining" : "Your answer"}</label>
      <textarea
        id={`ans-${view.ask.id}`}
        className="textarea"
        rows={declining ? 2 : 3}
        value={text}
        autoFocus
        placeholder={declining ? "Reason (optional). The agent sees it and stops waiting." : "Your answer. The asking agent receives it immediately."}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
          if (e.key === "Escape") setMode(null);
        }}
        maxLength={32_000}
      />
      <div className="ask-actions">
        <button type="submit" className={declining ? "btn btn-danger btn-sm" : "btn btn-primary btn-sm"} disabled={busy}>
          {busy ? "Sending…" : declining ? "Decline ask" : "Send answer"}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setMode(null); setError(null); }}>Cancel</button>
        <span className="ask-hint muted"><kbd>⌘</kbd><kbd>↵</kbd></span>
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
    </form>
  );
}
