import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QrCode, qrPath } from "../src/views/PhoneDevices.tsx";
import { qrRows } from "../../src/daemon/mobile/qr.ts";

test("qrPath draws one unit square per dark module, offset by the quiet zone", () => {
  expect(qrPath(["10", "01"], 4)).toBe("M4 4h1v1h-1zM5 5h1v1h-1z");
  expect(qrPath(["00"], 4)).toBe("");
});

test("the QR code renders black modules on white with a 4-module quiet zone", () => {
  const rows = qrRows("https://getwalkie.vercel.app/m#pair=AAAAAAAAAAAAAAAAAAAAAA");
  const html = renderToStaticMarkup(<QrCode rows={rows} />);
  const n = rows.length + 8;
  expect(html).toContain(`viewBox="0 0 ${n} ${n}"`);
  expect(html).toContain('fill="#fff"');
  expect(html).toContain('aria-label="QR code for the pairing link"');
  expect((html.match(/h1v1h-1z/g) ?? []).length).toBe(rows.join("").split("").filter((c) => c === "1").length);
});
