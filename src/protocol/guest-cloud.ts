/** Cloud is a dashboard alias over the owner's signing node, never a roster node. */
export function isCloudAgent(value: { agent: string; status: { runtime: string; runtime_name?: string } }): boolean {
  return value.status.runtime === "other" && (
    value.agent.startsWith("dots-") && value.status.runtime_name === "dots"
    || value.agent.startsWith("grokbot-") && value.status.runtime_name === "grokbot"
  );
}

export function cloudAddress(value: { handle: string; agent: string }): string {
  return `@${value.handle}/cloud/${value.agent}`;
}
