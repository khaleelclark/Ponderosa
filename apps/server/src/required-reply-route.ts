import type { CoordinationReplyAuthority } from "@ponderosa/core";

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
