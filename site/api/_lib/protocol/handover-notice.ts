// Site-owned copy of src/daemon/compute/handover-notice.ts text formatting.
export interface HandoverNotice {
  readonly v: 1;
  readonly team: string;
  readonly proposed_by: string;
  readonly old_chain: string;
  readonly proposed_chain: string;
  readonly accounts: string[];
  readonly proposed_at: number;
  readonly completes_at: number | null;
  readonly objected: boolean;
}

export function handoverNoticeText(n: HandoverNotice): string {
  return `Compute handover pending: ${n.proposed_by} proposes control of ${n.accounts.join(', ')}. ` +
    `${n.completes_at === null ? `A 24-hour objection window starts when another owner acknowledges this notice. Unacknowledged proposal expires ${new Date(n.proposed_at + 72 * 3_600_000).toISOString()}.` :
      `Completes ${new Date(n.completes_at).toISOString()} unless a current owner objects.`} ` +
    `Object: walkie compute handover object. Proposal ${n.proposed_chain}.`;
}
