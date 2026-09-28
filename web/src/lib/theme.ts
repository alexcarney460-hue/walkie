import { useSyncExternalStore } from "react";
import { load, save } from "./storage.ts";

export type ThemePref = "system" | "light" | "dark";
const KEY = "walkie.theme";

const media = window.matchMedia("(prefers-color-scheme: light)");
let pref: ThemePref = load<ThemePref>(KEY, "system");
const subs = new Set<() => void>();

function apply(): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}
apply();
media.addEventListener("change", () => subs.forEach((s) => s()));

export function setTheme(next: ThemePref): void {
  pref = next;
  save(KEY, next);
  apply();
  subs.forEach((s) => s());
}

export function effectiveTheme(): "light" | "dark" {
  if (pref === "system") return media.matches ? "light" : "dark";
  return pref;
}

export function toggleTheme(): void {
  setTheme(effectiveTheme() === "dark" ? "light" : "dark");
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function useTheme(): { pref: ThemePref; effective: "light" | "dark" } {
  const p = useSyncExternalStore(subscribe, () => pref, () => pref);
  const eff = useSyncExternalStore(subscribe, effectiveTheme, effectiveTheme);
  return { pref: p, effective: eff };
}
