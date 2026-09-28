// Text from outside (a peer's error message, a path) made safe for one terminal line (round 1, Opus 8): escape
// sequences (CSI, OSC) removed, other control characters and bidi overrides turned into spaces, length capped.
export function plainText(s: string, max = 200): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ")
    .slice(0, max);
}
