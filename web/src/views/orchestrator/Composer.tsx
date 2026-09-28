import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Square } from "lucide-react";

export interface ComposerHandle { focus(): void; fill(text: string): void }

interface Props {
  busy: boolean;
  disabled?: boolean;
  placeholder: string;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
}

const MAX_HEIGHT = 220;

/** ChatGPT-style composer: auto-growing, Enter sends, Shift+Enter adds a line, stop while a reply runs. */
export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ busy, disabled, placeholder, onSend, onStop }, ref) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    fill: (t: string) => { setText(t); requestAnimationFrame(() => area.current?.focus()); },
  }), []);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);

  const canSend = !!text.trim() && !busy && !sending && !disabled;

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    const ok = await onSend(text.trim());
    setSending(false);
    if (ok) setText("");
    area.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
    if (e.key === "Escape" && busy) {
      e.preventDefault();
      onStop();
    }
  };

  return (
    <form className={`orch-composer${disabled ? " is-disabled" : ""}`} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <label htmlFor="orch-input" className="sr-only">Message WalkieTalkie</label>
      <textarea
        id="orch-input"
        ref={area}
        rows={1}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        aria-describedby="orch-hint"
      />
      {busy ? (
        <button type="button" className="orch-send orch-stop" onClick={onStop} aria-label="Stop the reply" title="Stop (Esc)">
          <Square size={12} strokeWidth={0} fill="currentColor" aria-hidden="true" />
        </button>
      ) : (
        <button type="submit" className="orch-send" disabled={!canSend} aria-label="Send message" title="Send (Enter)">
          <ArrowUp size={17} strokeWidth={2.25} aria-hidden="true" />
        </button>
      )}
      <span id="orch-hint" className="sr-only">Enter sends, Shift+Enter adds a new line{busy ? ", Escape stops the reply" : ""}.</span>
    </form>
  );
});
