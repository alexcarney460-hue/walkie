// PROJECT-PAGES-1 in the dashboard: a screen's image, fetched with the session header from the Data Room's own route, judged
// from its own bytes (a PNG, JPEG or WebP of a size a tab can decode; the type the file claims is never believed) and shown as
// a data URL, because the page's content policy allows `data:` images and nothing it would have to loosen (a bare <img src>
// cannot carry the session). A bounded number are kept; a failure is never kept, so a machine that comes back online works.
import { api, ApiError } from "../api/client.ts";
import { sniffImage } from "../../../src/protocol/projects/page-image.ts";

export type ScreenImage = { status: "ready"; url: string; width: number; height: number } | { status: "missing" } | { status: "broken" };

const MAX_KEPT = 64;
const kept = new Map<string, Extract<ScreenImage, { status: "ready" }>>();
const running = new Map<string, Promise<ScreenImage>>();

export const imageKey = (channel: string, file: string, version: number): string => `${channel}/${file}@${version}`;

/** An image already loaded (and marked as recently used), or undefined. */
export function peekImage(key: string): Extract<ScreenImage, { status: "ready" }> | undefined {
  const hit = kept.get(key);
  if (hit) { kept.delete(key); kept.set(key, hit); }
  return hit;
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Loads one screen's current version: its image, "missing" (no online machine has it right now), or "broken" (not an image the page shows). */
export function loadImage(channel: string, file: string, version: number): Promise<ScreenImage> {
  const key = imageKey(channel, file, version);
  const hit = peekImage(key);
  if (hit) return Promise.resolve(hit);
  const pending = running.get(key);
  if (pending) return pending;
  const job = (async (): Promise<ScreenImage> => {
    try {
      const bytes = await api.roomBytes(channel, file, version);
      const info = sniffImage(bytes);
      if (!info) return { status: "broken" };
      const url = await readAsDataUrl(new Blob([bytes as unknown as BlobPart], { type: info.mime }));
      const ready = { status: "ready" as const, url, width: info.width, height: info.height };
      kept.set(key, ready);
      while (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string);
      return ready;
    } catch (err) {
      return err instanceof ApiError && err.status === 404 ? { status: "missing" } : { status: "broken" };
    } finally {
      running.delete(key);
    }
  })();
  running.set(key, job);
  return job;
}
