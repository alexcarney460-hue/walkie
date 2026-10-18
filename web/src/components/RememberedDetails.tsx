import { useState, type ReactNode } from "react";

/** Page disclosures start closed and tolerate blocked or unavailable storage. */
export function RememberedDetails({ id, summary, children, className }: {
  id: string; summary: ReactNode | ((open: boolean) => ReactNode); children: ReactNode; className?: string;
}) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(`sqwakie-details:${id}`) === "open"; }
    catch { return false; }
  });
  return <details className={className} open={open} onToggle={(event) => {
    const next = event.currentTarget.open;
    setOpen(next);
    try { localStorage.setItem(`sqwakie-details:${id}`, next ? "open" : "closed"); } catch { /* storage is optional */ }
  }}><summary>{typeof summary === "function" ? summary(open) : summary}</summary>{children}</details>;
}
