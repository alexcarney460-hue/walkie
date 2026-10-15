/** Translate retained status and recommendation wire bytes only when showing them to a person. */
export function displayStoredText(text: string): string;
export function displayStoredText<T>(text: T): T;
export function displayStoredText(text: unknown): unknown {
  if (typeof text !== "string") return text;
  if (text === "Connected to Walkie") return "Connected to Sqwakie";
  if (text === "Walkie access revoked") return "Sqwakie access revoked";
  return text
    .replace(/^\[WalkieTalkie recommendation ([^\]\r\n]+)\]/, "[Talkie recommendation $1]")
    .replace(/^WalkieTalkie recommends:/, "Talkie recommends:")
    .replace(/^(@[^\s]+ (?:approved|dismissed|retired) )WalkieTalkie's recommendation:/, "$1Talkie's recommendation:")
    .replace(/(\(Sent by @[^\r\n]+ on )WalkieTalkie's recommendation(?=[:.)])/, "$1Talkie's recommendation");
}
