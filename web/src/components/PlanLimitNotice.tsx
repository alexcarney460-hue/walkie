import { ArrowUpRight } from "lucide-react";
import type { PlanLimitDetails } from "../api/types.ts";
import { limitMessage, safeExternalUrl } from "../lib/plan.ts";

/**
 * Inline upgrade prompt for a 402 plan_limit refusal (invite, channel, machine, integration). A team that
 * already subscribes (`subscribed`) is sent to the billing portal to add seats, never to a second checkout.
 */
export function PlanLimitNotice({ details }: { details: PlanLimitDetails }) {
  const href = safeExternalUrl(details.upgrade_url);
  const portal = details.subscribed === true;
  return (
    <div className="plan-limit" role="alert">
      <p>{limitMessage(details)}{portal ? " You already subscribe: add seats to your subscription in the billing portal." : ""}</p>
      {href && (
        <a className="btn btn-sm btn-primary" href={href} target="_blank" rel="noopener noreferrer">
          {portal ? "Add seats" : "Upgrade"}<ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />
          <span className="sr-only"> (opens {portal ? "the billing portal" : "the checkout"} in a new tab)</span>
        </a>
      )}
    </div>
  );
}
