import type { CoordinationReplyAuthority } from "@ponderosa/core";
import { describe, expect, test } from "vitest";
import {
  requiredReplyAuthorityKey,
  selectsRequiredReply,
} from "./required-reply-route.js";

const DIRECT: CoordinationReplyAuthority = { intent: "direct_to_user" };
const BROADCAST: CoordinationReplyAuthority = { intent: "broadcast" };
const COLLABORATION: CoordinationReplyAuthority = {
  intent: "collaboration",
  recipientAgentIds: ["agent-b", "agent-a"],
};

describe("required reply route selection", () => {
  test.each([
    { label: "inferred", inferredReply: true },
    { label: "explicit", inferredReply: false },
  ])("counts a matching $label inherited route", ({ inferredReply }) => {
    expect(selectsRequiredReply({
      inferredReply,
      selectedReplyAuthority: DIRECT,
      pendingReplyAuthorities: [DIRECT],
      candidateReplyFingerprint: "candidate-fingerprint",
      steeringFenceMatches: true,
    })).toMatchObject({
      routeHasPendingReply: true,
      routeAlreadyPublished: false,
      requiredReplyAction: true,
    });
  });

  test.each([
    {
      label: "intent",
      selectedReplyAuthority: BROADCAST,
      pendingReplyAuthorities: [DIRECT],
    },
    {
      label: "collaboration recipients",
      selectedReplyAuthority: {
        intent: "collaboration" as const,
        recipientAgentIds: ["agent-a", "agent-c"],
      },
      pendingReplyAuthorities: [COLLABORATION],
    },
  ])("does not count an explicit $label mismatch", ({
    selectedReplyAuthority,
    pendingReplyAuthorities,
  }) => {
    expect(selectsRequiredReply({
      inferredReply: false,
      selectedReplyAuthority,
      pendingReplyAuthorities,
      candidateReplyFingerprint: "candidate-fingerprint",
      steeringFenceMatches: true,
    }).requiredReplyAction).toBe(false);
  });

  test("replays the required publication exactly once unless an advanced idempotency key opts out", () => {
    const selectedReplyAuthorityKey = requiredReplyAuthorityKey(DIRECT);
    const publishedReplyFingerprints = {
      [selectedReplyAuthorityKey]: "published-fingerprint",
    };
    expect(selectsRequiredReply({
      inferredReply: false,
      selectedReplyAuthority: DIRECT,
      pendingReplyAuthorities: [],
      publishedReplyFingerprints,
      candidateReplyFingerprint: "published-fingerprint",
      steeringFenceMatches: true,
    }).requiredReplyAction).toBe(true);
    expect(selectsRequiredReply({
      inferredReply: false,
      selectedReplyAuthority: DIRECT,
      pendingReplyAuthorities: [],
      publishedReplyFingerprints,
      requestedIdempotencyKey: "additional-message",
      candidateReplyFingerprint: "published-fingerprint",
      steeringFenceMatches: true,
    }).requiredReplyAction).toBe(false);
  });

  test("preserves a keyed required-reply envelope only for the identical replay", () => {
    const selectedReplyAuthorityKey = requiredReplyAuthorityKey(DIRECT);
    const publishedReplyFingerprints = {
      [selectedReplyAuthorityKey]: "published-fingerprint",
    };
    expect(selectsRequiredReply({
      inferredReply: false,
      selectedReplyAuthority: DIRECT,
      pendingReplyAuthorities: [],
      publishedReplyFingerprints,
      requestedIdempotencyKey: "stable-required-reply",
      candidateReplyFingerprint: "published-fingerprint",
      keyedReplayRequiredReplyFingerprint: "published-fingerprint",
      steeringFenceMatches: true,
    }).requiredReplyAction).toBe(true);
    expect(selectsRequiredReply({
      inferredReply: false,
      selectedReplyAuthority: DIRECT,
      pendingReplyAuthorities: [],
      publishedReplyFingerprints,
      requestedIdempotencyKey: "stable-required-reply",
      candidateReplyFingerprint: "changed-fingerprint",
      keyedReplayRequiredReplyFingerprint: "published-fingerprint",
      steeringFenceMatches: true,
    }).requiredReplyAction).toBe(false);
    expect(selectsRequiredReply({
      inferredReply: false,
      selectedReplyAuthority: DIRECT,
      pendingReplyAuthorities: [],
      publishedReplyFingerprints,
      requestedIdempotencyKey: "stable-required-reply",
      candidateReplyFingerprint: "published-fingerprint",
      keyedReplayRequiredReplyFingerprint: "published-fingerprint",
      steeringFenceMatches: false,
    }).requiredReplyAction).toBe(false);
  });
});
