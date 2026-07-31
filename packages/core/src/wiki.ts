export const WIKI_REFERENCE_PREFIX = "ponderosa://docs/" as const;

export interface WikiCodeLinkDto {
  label: string;
  path: string;
  url: string;
}

export interface WikiAssetDto {
  alt: string;
  path: string;
  url: string;
}

export interface WikiArticleSummaryDto {
  id: string;
  ref: `${typeof WIKI_REFERENCE_PREFIX}${string}`;
  slug: string;
  title: string;
  summary: string;
  section: string;
  order: number;
  codeLinks: WikiCodeLinkDto[];
  assets: WikiAssetDto[];
}

export interface WikiSectionDto {
  id: string;
  title: string;
  articles: WikiArticleSummaryDto[];
}

export interface WikiIndexDto {
  version: string;
  sections: WikiSectionDto[];
  totalArticles: number;
}

export interface WikiHeadingDto {
  depth: 2 | 3;
  id: string;
  text: string;
}

export interface WikiArticleDto extends WikiArticleSummaryDto {
  markdown: string;
  headings: WikiHeadingDto[];
  relatedRefs: Array<`${typeof WIKI_REFERENCE_PREFIX}${string}`>;
}

export interface WikiSearchResultDto {
  article: WikiArticleSummaryDto;
  snippet: string;
  score: number;
}

export interface WikiSearchResponseDto {
  query: string;
  results: WikiSearchResultDto[];
  total: number;
  limit: number;
  nextCursor?: string;
}

export interface WikiDocumentationPageDto {
  items: Array<{
    ref: `${typeof WIKI_REFERENCE_PREFIX}${string}`;
    title: string;
    mediaType: "text/markdown";
    totalBytes: number;
    range: { start: number; end: number };
    content: string;
    complete: boolean;
  }>;
  maxBytes: number;
  nextCursor?: string;
}
