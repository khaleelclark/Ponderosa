import type { CommunicationIntent } from "../communication.js";

export type HistoryMatchBasis = "lexical";

export type HistoryWarning =
  | "edited"
  | "possible_conflict"
  | "possible_stale"
  | "explicit_supersession"
  | "cross_conversation";

export interface HistoryMessageProvenanceDto {
  communicationEventId: string;
  revisionEventId?: string;
  conversation?: { id: string; label: string };
  scope: "organizational" | "agent_private" | "current_chat";
  communicationIntent: CommunicationIntent;
  author: {
    kind: "user" | "agent" | "system";
    label: string;
    agentId?: string;
  };
  createdAt: string;
  editedAt?: string;
  contentSha256: string;
}

export interface HistorySearchHitDto extends HistoryMessageProvenanceDto {
  matchBasis: HistoryMatchBasis;
  lexicalRank: number;
  score: number;
  excerpt: {
    text: string;
    sha256: string;
    startCodePoint: number;
    endCodePoint: number;
    clipped: boolean;
  };
  warnings: HistoryWarning[];
  relatedCommunicationEventIds: string[];
}

export interface HistoryExactMessageDto extends HistoryMessageProvenanceDto {
  text: string;
  warnings: HistoryWarning[];
}

export interface HistorySearchResponseDto {
  action: "search";
  query: string;
  normalizedQuery: string;
  strategy: "lexical";
  untrustedHistoricalData: true;
  notice: string;
  compactionBoundary: {
    canonicalOrdinal: number;
    communicationEventId?: string;
  };
  hits: HistorySearchHitDto[];
  hasMore: boolean;
  noMatch: boolean;
  eligibleMessages: number;
  excludedRecentTailMessages: number;
  returnedMessages: number;
  utf8Bytes: number;
}

export interface HistoryReadResponseDto {
  action: "read";
  untrustedHistoricalData: true;
  notice: string;
  requestedCommunicationEventId: string;
  messages: HistoryExactMessageDto[];
  requestedMessageIndex: number;
  utf8Bytes: number;
}

export type HistoryResponseDto = HistorySearchResponseDto | HistoryReadResponseDto;
