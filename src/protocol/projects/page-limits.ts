// PROJECT-PAGES-1: what a status page's screens may be. No imports: the dashboard bundles this (and the image check that uses
// it) as it is, without the schema's validator. schema.ts re-exports every name.
export const SCREEN_STATUSES = ["works", "partial", "empty", "not-built"] as const;
export const MAX_SCREENS = 120;
export const MAX_SCREEN_GROUPS = 12;
export const SCREEN_MAX_BYTES = 8 * 1024 * 1024;
export const SCREEN_MAX_SIDE = 12_000;
export const SCREEN_MAX_PIXELS = 25_000_000;
export const SCREEN_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
