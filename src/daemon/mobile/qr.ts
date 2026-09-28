// QR code for the pairing link (WALKIE-PWA-1): the module matrix as rows of "0"/"1", so the dashboard draws it as SVG
// and the CLI as half-block characters, and neither needs a QR library of its own.
import qrcode from "qrcode-generator";

/** Rows of the QR matrix for `text` (error correction M, smallest version that fits). No quiet zone included. */
export function qrRows(text: string): string[] {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const rows: string[] = [];
  for (let r = 0; r < n; r++) {
    let row = "";
    for (let c = 0; c < n; c++) row += qr.isDark(r, c) ? "1" : "0";
    rows.push(row);
  }
  return rows;
}
