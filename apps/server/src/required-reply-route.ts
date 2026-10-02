import type { CommunicationEvent, CoordinationReplyAuthority } from "@ponderosa/core";
import type { CoordinationV3Store } from "@ponderosa/agents";

export function canonicalDefaultReplyRoute(coordination: CoordinationV3Store, runId: string, agentId: string): CoordinationReplyAuthority | undefined {
  const routes = coordination.requiredReplyObligationsForRun(runId)
    .filter((obligation) => !["cancelled", "failed", "superseded"].includes(obligation.state))
    .map((obligation) => obligation.replyAuthority);
  const hasCorrelatedRequest = coordination.requestIdsAttachedToRun(runId, agentId).length > 0;
    for (const { payload } of coordination.activationPayloads(agentId, coordination.activationIdsAttachedToRun(runId, agentId), runId)) {
      const communication = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as { communication?: Partial<CommunicationEvent> }).communication : undefined;
      if (communication?.sender?.kind === "user" && communication.intent === "broadcast") {
        routes.push({ intent: "broadcast" });
      } else if (communication?.sender?.kind === "user" && communication.intent === "user_dm") {
        routes.push({ intent: "direct_to_user" });
      } else if (!hasCorrelatedRequest && communication?.intent === "collaboration" && communication.sender?.kind === "agent") {
        routes.push({ intent: "collaboration", recipientAgentIds: [communication.sender.agentId] });
      }
    }
  const distinct = [...new Map(routes.map((route) => [requiredReplyAuthorityKey(route), route])).values()];
  return distinct.length === 1 ? distinct[0] : undefined;
}

export function requiredReplyAuthorityKey(
  authority: CoordinationReplyAuthority,
): string {
  return JSON.stringify({
    intent: authority.intent,
    ...(authority.recipientAgentIds?.length
      ? { recipientAgentIds: [...authority.recipientAgentIds].sort() }
      : {}),
  });
}

export function selectsRequiredReply(input: {
  inferredReply: boolean;
  selectedReplyAuthority: CoordinationReplyAuthority;
  pendingReplyAuthorities: readonly CoordinationReplyAuthority[];
  publishedReplyFingerprints?: Readonly<Record<string, string>>;
  requestedIdempotencyKey?: string;
  candidateReplyFingerprint: string;
  keyedReplayRequiredReplyFingerprint?: string;
  steeringFenceMatches: boolean;
}): {
  selectedReplyAuthorityKey: string;
  routeHasPendingReply: boolean;
  routeAlreadyPublished: boolean;
  requiredReplyAction: boolean;
} {
  const selectedReplyAuthorityKey = requiredReplyAuthorityKey(
    input.selectedReplyAuthority,
  );
  const routeHasPendingReply = input.pendingReplyAuthorities.some(
    (authority) =>
      requiredReplyAuthorityKey(authority) === selectedReplyAuthorityKey,
  );
  const routeAlreadyPublished =
    input.publishedReplyFingerprints?.[selectedReplyAuthorityKey] !== undefined;
  const publishedReplyFingerprint =
    input.publishedReplyFingerprints?.[selectedReplyAuthorityKey];
  const replaysKeyedRequiredReply = Boolean(
    input.requestedIdempotencyKey?.trim() &&
    input.steeringFenceMatches &&
    input.keyedReplayRequiredReplyFingerprint === input.candidateReplyFingerprint &&
    input.keyedReplayRequiredReplyFingerprint === publishedReplyFingerprint,
  );
  const requiredReplyAction = input.inferredReply
    ? routeHasPendingReply || routeAlreadyPublished
    : routeHasPendingReply ||
      replaysKeyedRequiredReply ||
      (routeAlreadyPublished && !input.requestedIdempotencyKey?.trim());
  return {
    selectedReplyAuthorityKey,
    routeHasPendingReply,
    routeAlreadyPublished,
    requiredReplyAction,
  };
}
