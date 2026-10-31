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
  /** Inline text/hash remains canonical; these separately verified managed
   * files contain referenced full documents. Metadata is historical data. */
  referencedFiles?: Array<{ artifactId: string; available?: false; localPath?: string; byteLength?: number; sha256?: string }>;
  /** Supplemental descriptors omitted from this chunk's bounded metadata.
   * Canonical text and artifact identities are never rewritten or truncated. */
  referencedFilesOmitted?: number;
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
  startCodePoint?: number;
  endCodePoint?: number;
  totalCodePoints?: number;
  totalUtf8Bytes?: number;
  complete?: boolean;
  continuation?: string;
  warnings: HistoryWarning[];
}

export interface HistorySearchResponseDto {
  source?: "canonical";
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
  source?: "canonical";
  action: "read";
  untrustedHistoricalData: true;
  notice: string;
  requestedCommunicationEventId: string;
  messages: HistoryExactMessageDto[];
  requestedMessageIndex: number;
  utf8Bytes: number;
}

/** Portable transcript provenance. None of these values assert authored
 * Communication identity, original authorship, or a compaction boundary. */
export interface ImportedHistoryMessageProvenanceDto {
  reference: string;
  sourceLabel: "Imported History" | "Imported Guidance";
  role: "user" | "assistant" | "system";
  sequence: number;
  contentSha256: string;
  archiveVersion: string;
  createdAt?: string;
  importedAt: string;
}

export interface ImportedHistorySearchHitDto extends ImportedHistoryMessageProvenanceDto {
  matchBasis: HistoryMatchBasis;
  lexicalRank: number;
  score: number;
  excerpt: HistorySearchHitDto["excerpt"];
}

export interface ImportedHistoryExactMessageDto extends ImportedHistoryMessageProvenanceDto {
  text: string;
  startCodePoint: number;
  endCodePoint: number;
  totalCodePoints: number;
  totalUtf8Bytes: number;
  complete: boolean;
  continuation?: string;
}

export interface ImportedHistorySearchResponseDto {
  source: "imported";
  action: "search";
  query: string;
  normalizedQuery: string;
  strategy: "lexical";
  untrustedHistoricalData: true;
  notice: string;
  archiveVersion: string;
  hits: ImportedHistorySearchHitDto[];
  hasMore: boolean;
  noMatch: boolean;
  eligibleMessages: number;
  returnedMessages: number;
  utf8Bytes: number;
}

export interface ImportedHistoryReadResponseDto {
  source: "imported";
  action: "read";
  untrustedHistoricalData: true;
  notice: string;
  archiveVersion: string;
  requestedReference: string;
  messages: ImportedHistoryExactMessageDto[];
  requestedMessageIndex: number;
  utf8Bytes: number;
}

export type HistoryResponseDto = HistorySearchResponseDto | HistoryReadResponseDto |
  ImportedHistorySearchResponseDto | ImportedHistoryReadResponseDto;
