/** Google Voice selectors. A changed UI must report logged_out/blocked, never send blind. */
export const smsGvoice = {
  id: "sms-gvoice" as const,
  url: "https://voice.google.com/u/0/messages",
  host: "voice.google.com",
  linked: 'gv-message-list',
  loggedOut: 'a[href*="accounts.google.com"], [data-testid="sign-in"]',
  blocked: 'text=/account suspended|Google Voice is not available/i',
  unread: 'gv-conversation-list [aria-label*="unread"]',
  chat: 'gv-conversation-list gv-conversation-row',
  incoming: 'gv-message-item[incoming]',
  composer: 'gv-message-input [contenteditable="true"]',
  conversationId(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== "voice.google.com") return null;
      const item = decodeURIComponent(parsed.pathname.split("/").at(-1) ?? "");
      return /^t\.\+[1-9]\d{6,14}$/.test(item) ? item : null;
    } catch { return null; }
  },
  incomingId(id: string, conversation: string): { sender: string; conversation: string } | null {
    const match = /^incoming_(t\.\+[1-9]\d{6,14})_([^\s]+)$/.exec(id);
    return match && match[1] === conversation ? { sender: match[1].slice(2), conversation } : null;
  },
  chatFor(conversation: string): string {
    return `gv-conversation-list gv-conversation-row[data-item-id="${conversation}"]`;
  },
} as const;
