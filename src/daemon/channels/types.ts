export const CHANNELS = ["whatsapp-web", "sms-gvoice"] as const;
export type ChannelId = (typeof CHANNELS)[number];
export type ChannelState = "linked" | "logged_out" | "blocked";

export interface IncomingMessage {
  readonly id: string;
  readonly from: string;
  readonly conversation: string;
  readonly text: string;
}

export interface ChannelAdapter {
  readonly id: ChannelId;
  openForLink(): Promise<void>;
  status(): Promise<ChannelState>;
  poll(): Promise<readonly IncomingMessage[]>;
  acknowledge(id: string): Promise<void>;
  send(to: string, text: string, conversation: string): Promise<void>;
  close(): Promise<void>;
}
