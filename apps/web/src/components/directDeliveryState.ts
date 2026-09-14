import type { MultiAgentDirectMessageResponse } from "@ponderosa/core";

export function activeDirectDeliveryAgentIds(
  response: MultiAgentDirectMessageResponse,
): string[] {
  return response.recipients.flatMap((recipient) =>
    !recipient.queued && (recipient.state === "started" || recipient.state === "steered")
      ? [recipient.agentId]
      : []);
}
