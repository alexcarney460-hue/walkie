// Image bytes for the status page tests: just enough of a PNG, JPEG or WebP header for the page's own check (page-image.ts) to
// read a type and a size, plus `salt` bytes of padding so two images with one size are not the same file. They are not
// pictures; the dashboard render uses real screenshots.
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const le = (v: number, bytes: number) => Array.from({ length: bytes }, (_, i) => (v >>> (8 * i)) & 255);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const pad = (salt: number) => (salt > 0 ? Array.from({ length: salt }, (_, i) => (i * 31 + salt) & 255) : []);

export const png = (w: number, h: number, salt = 0): Uint8Array =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(w), ...u32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0, ...pad(salt)]);

export const jpeg = (w: number, h: number, withApp = true, salt = 0): Uint8Array => Uint8Array.from([
  0xff, 0xd8, ...(withApp ? [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0] : []),
  0xff, 0xc4, 0x00, 0x04, 0x00, 0x00, // a Huffman table, not a frame header
  0xff, 0xc0, 0x00, 0x11, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, ...pad(salt),
]);

export const webpLossy = (w: number, h: number, salt = 0): Uint8Array =>
  Uint8Array.from([...ascii("RIFF"), ...le(30, 4), ...ascii("WEBP"), ...ascii("VP8 "), ...le(10, 4), 0, 0, 0, 0x9d, 0x01, 0x2a, ...le(w, 2), ...le(h, 2), ...pad(salt)]);

export const webpLossless = (w: number, h: number, salt = 0): Uint8Array => {
  const bits = (w - 1) | ((h - 1) << 14); // 14 bits each
  return Uint8Array.from([...ascii("RIFF"), ...le(30, 4), ...ascii("WEBP"), ...ascii("VP8L"), ...le(5, 4), 0x2f, ...le(bits, 4), ...pad(salt)]);
};

export const webpExtended = (w: number, h: number, salt = 0): Uint8Array =>
  Uint8Array.from([...ascii("RIFF"), ...le(30, 4), ...ascii("WEBP"), ...ascii("VP8X"), ...le(10, 4), 0, 0, 0, 0, ...le(w - 1, 3), ...le(h - 1, 3), ...pad(salt)]);
