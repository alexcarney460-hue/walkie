/** WhatsApp Web selectors. Keep markup assumptions in this file so a site change fails closed. */
export const whatsappWeb = {
  id: "whatsapp-web" as const,
  url: "https://web.whatsapp.com/",
  host: "web.whatsapp.com",
  linked: '[data-testid="chat-list"]',
  loggedOut: 'canvas[aria-label*="QR"], [data-testid="qrcode"]',
  blocked: 'text=/account is banned|account is blocked/i',
  unread: '[data-testid="chat-list"] [aria-label*="unread"]',
  chat: '[data-testid="chat-list"] [role="row"]',
  active: '[data-testid="conversation-panel-wrapper"][data-id]',
  incoming: '[data-testid="msg-container"].message-in',
  composer: '[contenteditable="true"][data-tab="10"]',
  conversationId(value: string): string | null {
    return /^[1-9]\d{6,14}@c\.us$/.test(value) ? value : null;
  },
  incomingId(id: string, conversation: string): { sender: string; conversation: string } | null {
    const match = /^false_([1-9]\d{6,14})@c\.us_([^\s]+)$/.exec(id);
    return match && `${match[1]}@c.us` === conversation
      ? { sender: `+${match[1]}`, conversation } : null;
  },
  chatFor(conversation: string): string {
    return `[data-testid="chat-list"] [role="row"][data-id="${conversation}"]`;
  },
} as const;
