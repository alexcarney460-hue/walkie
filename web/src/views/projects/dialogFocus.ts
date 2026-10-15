import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function trapDialogTab(dialog: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== "Tab") return;
  const controls = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((element) => !element.hasAttribute("hidden") && !element.matches(":disabled") && element.getClientRects().length > 0);
  if (!controls.length) { event.preventDefault(); dialog.focus(); return; }
  const first = controls[0]!;
  const last = controls[controls.length - 1]!;
  const active = document.activeElement;
  if (!dialog.contains(active) || (event.shiftKey ? active === first || active === dialog : active === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

/** Keep keyboard navigation in an open project dialog and return focus to its opener. */
export function useDialogFocus(dialog: RefObject<HTMLElement | null>, initial: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    initial.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close.current(); return; }
      if (dialog.current) trapDialogTab(dialog.current, event);
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previous?.focus?.(); };
  }, [dialog, initial]);
}
