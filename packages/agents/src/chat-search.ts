import type {
  GlobalChatSearchAuthorDto,
  GlobalChatSearchResponseDto,
  GlobalChatTargetDto,
  ProjectDto,
  SearchHighlightRangeDto,
} from "@ponderosa/core";

export interface ProjectedChatSearchCandidate {
  project: Pick<ProjectDto, "id" | "label">;
  chat: GlobalChatTargetDto;
  messageId: string;
  communicationEventId?: string;
  author: GlobalChatSearchAuthorDto;
  timestamp: string;
  text: string;
  unread: boolean;
}

export interface ProjectedChatSearchOptions {
  query: string;
  limit: number;
  maxScannedMessages: number;
}

const SNIPPET_LENGTH = 180;

/** Build a compact plain-text snippet plus safe character ranges for UI emphasis. */
export function highlightedSearchSnippet(text: string, query: string): {
  snippet: string;
  highlights: SearchHighlightRangeDto[];
} {
  const cleanText = text.replace(/\s+/gu, " ").trim();
  const cleanQuery = query.trim();
  if (!cleanQuery) {
    const clipped = cleanText.slice(0, SNIPPET_LENGTH);
    return { snippet: clipped + (cleanText.length > clipped.length ? "…" : ""), highlights: [] };
  }
  const lowerText = cleanText.toLocaleLowerCase();
  const lowerQuery = cleanQuery.toLocaleLowerCase();
  const match = lowerText.indexOf(lowerQuery);
  if (match < 0) return { snippet: "", highlights: [] };

  const rawStart = Math.max(0, Math.min(match - 60, Math.max(0, cleanText.length - SNIPPET_LENGTH)));
  const rawEnd = Math.min(cleanText.length, rawStart + SNIPPET_LENGTH);
  const prefix = rawStart > 0 ? "…" : "";
  const suffix = rawEnd < cleanText.length ? "…" : "";
  const body = cleanText.slice(rawStart, rawEnd);
  const highlights: SearchHighlightRangeDto[] = [];
  let cursor = 0;
  const lowerBody = body.toLocaleLowerCase();
  while (cursor < lowerBody.length) {
    const index = lowerBody.indexOf(lowerQuery, cursor);
    if (index < 0) break;
    highlights.push({ start: prefix.length + index, length: cleanQuery.length });
    cursor = index + Math.max(1, lowerQuery.length);
  }
  return { snippet: `${prefix}${body}${suffix}`, highlights };
}

/** Search only projected chat candidates. Runtime output never enters this input. */
export function searchProjectedChatMessages(
  candidates: ProjectedChatSearchCandidate[],
  options: ProjectedChatSearchOptions,
): Pick<GlobalChatSearchResponseDto, "query" | "results" | "scannedMessages" | "truncated"> {
  const query = options.query.trim();
  const scanLimit = Math.max(1, options.maxScannedMessages);
  const resultLimit = Math.max(1, options.limit);
  const newestFirst = [...candidates].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const scanned = newestFirst.slice(0, scanLimit);
  const matches = scanned.flatMap((candidate) => {
    if (!query && !candidate.unread) return [];
    const { snippet, highlights } = highlightedSearchSnippet(candidate.text, query);
    if (query && !snippet) return [];
    const { text: _text, ...result } = candidate;
    return [{ ...result, snippet, highlights }];
  }).slice(0, resultLimit);
  return {
    query,
    results: matches,
    scannedMessages: scanned.length,
    truncated: newestFirst.length > scanned.length,
  };
}
