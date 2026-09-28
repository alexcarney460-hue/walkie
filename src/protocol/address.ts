// Ask/mention addresses: "@handle", "@handle/machine", "@handle/machine/agent".

export interface ParsedAddress { handle: string; machine?: string; agent?: string }

export function parseAddress(addr: string): ParsedAddress {
  const [handle = "", machine, agent] = addr.replace(/^@/, "").split("/");
  return { handle, ...(machine ? { machine } : {}), ...(agent ? { agent } : {}) };
}
