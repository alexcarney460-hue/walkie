// What the local API says about Walkie on your phone (GET /v1/mobile, POST /v1/mobile/pair). Types only, shared with
// the dashboard (web/src/api/types.ts), so nothing here may import node modules.

/** A paired phone as the dashboard and the CLI see it: never its key. */
export interface DeviceView {
  readonly id: string; readonly name: string; readonly created_at: number; readonly last_seen: number; readonly expires_at: number;
}

export interface MobileStatus {
  /** Connected to the relay (only while a phone is paired or a pairing is open). */
  readonly linked: boolean;
  readonly relay: string;
  readonly pairing: number;
  readonly devices: DeviceView[];
  /** Paired phones connected right now. */
  readonly connected: number;
  /** Something the person should know (e.g. a pairing code the relay withdrew), or null. */
  readonly notice: string | null;
}

export interface PairView {
  /** The link the QR code carries: the secret rides in the fragment, which is never sent to a server. */
  readonly url: string;
  /** The same secret, for pasting into the installed app (iOS keeps a Home Screen app's storage apart from Safari). */
  readonly code: string;
  readonly expires_at: number;
  /** QR modules, one string of "0"/"1" per row (no quiet zone). */
  readonly qr: string[];
}
