import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Bot, Laptop, User } from "lucide-react";
import { api, friendlyError } from "../../api/client.ts";
import { useActions, useStore } from "../../state/store.tsx";

interface Suggestion { address: string; label: string; kind: "person" | "machine" | "agent" }

const MENTION_AT_CARET = /(^|\s)(@[a-z0-9./-]*)$/;
const MAX_ROWS_PX = 200;

function useAddressBook(): Suggestion[] {
  const { team, nodes, agents } = useStore();
  return useMemo(() => {
    const people: Suggestion[] = (team?.members ?? []).map((m) => ({ address: `@${m.handle}`, label: m.display_name ?? m.handle, kind: "person" }));
    const machines: Suggestion[] = nodes.map((n) => ({ address: `@${n.handle}/${n.hostname}`, label: `any agent on ${n.hostname}`, kind: "machine" }));
    const agentList: Suggestion[] = agents.map((a) => ({ address: `@${a.handle}/${a.hostname}/${a.agent}`, label: a.status.title ?? a.agent, kind: "agent" }));
    return [...people, ...agentList, ...machines];
  }, [team?.members, nodes, agents]);
}

export function Composer({ channel, thread, placeholder, autoFocus }: { channel: string; thread?: string; placeholder: string; autoFocus?: boolean }) {
  const { me } = useStore();
  const { applyEvents } = useActions();
  const book = useAddressBook();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [sel, setSel] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, [text]);

  const matches = useMemo(() => {
    if (query === null) return [];
    const q = query.slice(1).toLowerCase();
    return book.filter((s) => s.address.slice(1).startsWith(q) || (q.length > 1 && s.address.includes(q))).slice(0, 8);
  }, [query, book]);

  if (me?.role === "observer") {
    return <div className="composer composer-readonly">Observers can read the board but not post.</div>;
  }

  const syncQuery = (value: string, caret: number) => {
    const m = value.slice(0, caret).match(MENTION_AT_CARET);
    setQuery(m ? m[2] ?? null : null);
    setSel(0);
  };

  const accept = (s: Suggestion) => {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = text.slice(0, caret).replace(/@[a-z0-9./-]*$/, `${s.address} `);
    const next = before + text.slice(caret);
    setText(next);
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { event } = await api.post({ channel, text: body, ...(thread ? { thread } : {}) });
      applyEvents([event]);
      setText("");
      setQuery(null);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  };

  const listId = `mentions-${thread ?? channel}`;
  const open = matches.length > 0;
  return (
    <div className="composer">
      {open && (
        <ul className="mention-menu" role="listbox" id={listId} aria-label="Mention suggestions">
          {matches.map((s, i) => {
            const Icon = s.kind === "agent" ? Bot : s.kind === "machine" ? Laptop : User;
            return (
              <li key={s.address} role="option" id={`${listId}-${i}`} aria-selected={i === sel}>
                <button type="button" className={i === sel ? "mention-opt is-sel" : "mention-opt"} onMouseDown={(e) => { e.preventDefault(); accept(s); }}>
                  <Icon size={13} strokeWidth={1.75} aria-hidden="true" />
                  <span className="mono mention-addr truncate">{s.address}</span>
                  <span className="mention-label truncate">{s.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="composer-box">
        <label htmlFor={`compose-${thread ?? channel}`} className="sr-only">{placeholder}</label>
        <textarea
          ref={ref}
          id={`compose-${thread ?? channel}`}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={placeholder}
          autoFocus={autoFocus}
          maxLength={32_000}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${sel}` : undefined}
          aria-autocomplete="list"
          onChange={(e) => { setText(e.target.value); syncQuery(e.target.value, e.target.selectionStart); }}
          onClick={(e) => syncQuery(text, e.currentTarget.selectionStart)}
          onKeyDown={(e) => {
            if (open) {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => (i + 1) % matches.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => (i - 1 + matches.length) % matches.length); return; }
              if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") { e.preventDefault(); const s = matches[sel]; if (s) accept(s); return; }
              if (e.key === "Escape") { e.preventDefault(); setQuery(null); return; }
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
          }}
        />
        <div className="composer-bar">
          <span className="composer-hint muted"><span className="mono">@</span> to mention an agent · <kbd>⌘</kbd><kbd>↵</kbd> to send</span>
          <button type="button" className="btn btn-primary btn-sm composer-send" onClick={() => void send()} disabled={!text.trim() || busy} aria-label="Send message">
            <ArrowUp size={14} strokeWidth={2} aria-hidden="true" />
            {busy ? "Sending" : "Send"}
          </button>
        </div>
      </div>
      {error && (
        <p className="composer-error" role="alert">
          {error} Your message is still here.
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void send()}>Retry</button>
        </p>
      )}
    </div>
  );
}
