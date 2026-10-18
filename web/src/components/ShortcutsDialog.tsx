import { useEffect, useRef } from "react";
import { SHORTCUTS } from "../lib/hotkeys.ts";

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") { event.preventDefault(); closeRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previous?.focus?.(); };
  }, [onClose]);

  const groups = [
    { title: "Global", items: SHORTCUTS.filter(({ label }) => !label.startsWith("Board:")) },
    { title: "Board", items: SHORTCUTS.filter(({ label }) => label.startsWith("Board:")) },
  ];
  return <div className="palette-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="palette shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
      <div className="shortcuts-head"><h2 id="shortcuts-title">Keyboard shortcuts</h2>
        <button ref={closeRef} type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button></div>
      <div className="shortcuts-body">{groups.map(({ title, items }) =>
        <section key={title} aria-label={title}><h3>{title}</h3><ul>
          {items.map(({ keys, label }) => <li key={label}><span>{label.replace(/^Board: /, "")}</span>
            <span className="shortcuts-keys">{keys.map((key) => <kbd key={key}>{key}</kbd>)}</span></li>)}
        </ul></section>)}</div>
    </section>
  </div>;
}
