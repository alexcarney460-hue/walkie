// PROJECT-PAGES-1: is this really a PNG, JPEG or WebP, and how big is it? Judged from the bytes' own signature and header
// (the type a caller declares is never believed; SVG, HTML, PDF and everything else are refused), in one linear pass, so a
// hostile file costs next to nothing to look at. A size past what a browser tab should be asked to decode is refused too:
// a few hundred bytes of compressed zeros can claim 900 million pixels.
import { SCREEN_IMAGE_TYPES, SCREEN_MAX_PIXELS, SCREEN_MAX_SIDE } from "./page-limits.ts";

export interface ImageInfo { mime: (typeof SCREEN_IMAGE_TYPES)[number]; width: number; height: number }

const be32 = (b: Uint8Array, i: number): number => ((b[i] as number) * 0x1000000) + (((b[i + 1] as number) << 16) | ((b[i + 2] as number) << 8) | (b[i + 3] as number));
const be16 = (b: Uint8Array, i: number): number => ((b[i] as number) << 8) | (b[i + 1] as number);
const le16 = (b: Uint8Array, i: number): number => (b[i] as number) | ((b[i + 1] as number) << 8);
const le24 = (b: Uint8Array, i: number): number => (b[i] as number) | ((b[i + 1] as number) << 8) | ((b[i + 2] as number) << 16);
const ascii = (b: Uint8Array, i: number, s: string): boolean => {
  if (i + s.length > b.length) return false;
  for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false;
  return true;
};

/** PNG: the signature, then the IHDR chunk first (its width and height). */
function png(b: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || sig.some((v, i) => b[i] !== v) || !ascii(b, 12, "IHDR")) return null;
  return { width: be32(b, 16), height: be32(b, 20) };
}

/** JPEG: markers in order until a start-of-frame one, which carries the height and then the width. Fill bytes and empty segments cost one step each. */
function jpeg(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null; // a segment starts with a marker
    while (i < b.length && b[i] === 0xff) i++; // any number of fill bytes may precede the marker code
    const code = b[i];
    if (code === undefined) return null;
    i++;
    if (code === 0x01 || (code >= 0xd0 && code <= 0xd8) || code === 0x00) continue; // standalone markers carry no length
    if (code === 0xd9 || code === 0xda) return null; // end of image, or the scan: no frame header came first
    if (i + 2 > b.length) return null;
    const len = be16(b, i);
    if (len < 2) return null;
    const sof = code >= 0xc0 && code <= 0xcf && code !== 0xc4 && code !== 0xc8 && code !== 0xcc;
    if (sof) return i + 7 <= b.length ? { height: be16(b, i + 3), width: be16(b, i + 5) } : null;
    i += len;
  }
  return null;
}

/** WebP: RIFF, then the first chunk: lossy (VP8 ), lossless (VP8L) or extended (VP8X) each keep the size in their own place. */
function webp(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 21 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8 ")) {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, "VP8L")) {
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const bits = (b[21] as number) | ((b[22] as number) << 8) | ((b[23] as number) << 16) | ((b[24] as number) * 0x1000000);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, "VP8X")) return b.length < 30 ? null : { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  return null;
}

/** The type and size of an image the page may show, or null: not a PNG, JPEG or WebP, cut short, empty, or too big to decode. */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  const read = ((): { mime: ImageInfo["mime"]; width: number; height: number } | null => {
    const p = png(bytes);
    if (p) return { mime: "image/png", ...p };
    const j = jpeg(bytes);
    if (j) return { mime: "image/jpeg", ...j };
    const w = webp(bytes);
    return w ? { mime: "image/webp", ...w } : null;
  })();
  if (!read) return null;
  const { width, height } = read;
  if (width < 1 || height < 1 || width > SCREEN_MAX_SIDE || height > SCREEN_MAX_SIDE || width * height > SCREEN_MAX_PIXELS) return null;
  return read;
}
