// Shared helpers for turning provider numbers into AccountWindow values and a Reading.
import { MAX_WINDOWS, type AccountWindow, type UsageSource, type WindowKind } from "../protocol/accounts.ts";
import type { Reading } from "./types.ts";

const HOUR = 3600;
const DAY = 86_400;

/** Label a window by its length: ≤ 6 h is the session window, ≥ 6 days the weekly one. */
export function kindForSeconds(s: number | null): WindowKind {
  if (s === null) return "other";
  if (s <= 6 * HOUR) return "session";
  if (s >= 6 * DAY && s <= 8 * DAY) return "weekly";
  return "other";
}

export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function pct(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10));
}

/** An ISO date-time without a zone ("2026-09-26T12:16:12.312460", Grok's auth.json): read as UTC, never local. */
const NAIVE_ISO = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?$/;

/** ISO string (a zone-less one as UTC) or unix seconds/ms → unix ms. */
export function toMs(v: unknown): number | null {
  if (typeof v === "string" && v) {
    const naive = NAIVE_ISO.exec(v.trim());
    const t = naive ? Date.parse(`${naive[1]}T${naive[2]}${(naive[3] ?? "").slice(0, 4)}Z`) : Date.parse(v);
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  const n = num(v);
  if (n === null || n <= 0) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

export function window(kind: WindowKind, usedPct: number, resetsAt: number | null, windowS: number | null, scope: string | null = null): AccountWindow {
  return {
    kind, used_pct: pct(usedPct), resets_at: resetsAt,
    window_s: windowS !== null && windowS > 0 && windowS <= 90 * DAY ? Math.round(windowS) : null, scope,
  };
}

/** A reading from windows: exhausted when a window is fully used (until its reset), else ok. */
export function readingFrom(at: number, windows: AccountWindow[], source: UsageSource, limitReached = false): Reading {
  const kept = windows.slice(0, MAX_WINDOWS);
  const full = kept.filter((w) => w.used_pct >= 100);
  if (full.length || limitReached) {
    const resets = (full.length ? full : kept).map((w) => w.resets_at).filter((x): x is number => x !== null);
    return { at, state: "exhausted", reason: "limit_reached", source, windows: kept, until: resets.length ? Math.max(...resets) : null };
  }
  return { at, state: "ok", reason: null, source, windows: kept, until: null };
}
