import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  WikiArticleDto,
  WikiArticleSummaryDto,
  WikiDocumentationPageDto,
  WikiIndexDto,
  WikiSearchResponseDto,
} from "@ponderosa/core";

const DEFAULT_PAGE_BYTES = 32 * 1024;
const MIN_PAGE_BYTES = 4 * 1024;
const MAX_PAGE_BYTES = 64 * 1024;
const REFERENCE_PREFIX = "ponderosa://docs/";
const REPOSITORY_SOURCE = "https://github.com/khaleelclark/Ponderosa/blob/master/";

interface ArticleRecord {
  article: WikiArticleDto;
  bytes: Buffer;
  searchable: string;
}

interface PageCursor {
  version: string;
  refsHash: string;
  maxBytes: number;
  itemIndex: number;
  byteOffset: number;
}

interface SearchCursor {
  v: 1;
  version: string;
  queryHash: string;
  limit: number;
  offset: number;
}

function defaultWikiRoot(): string {
  const relative = fileURLToPath(new URL("../../../../docs/wiki", import.meta.url));
  if (existsSync(relative)) return relative;
  const cwd = path.join(process.cwd(), "docs", "wiki");
  if (existsSync(cwd)) return cwd;
  throw new Error("version-controlled product wiki is unavailable");
}

function frontMatter(source: string): { metadata: Map<string, string>; markdown: string } {
  const normalized = source.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) throw new Error("wiki article is missing front matter");
  const metadata = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`invalid wiki front matter line: ${line}`);
    metadata.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return { metadata, markdown: match[2]!.trim() };
}

function required(metadata: Map<string, string>, key: string, file: string): string {
  const value = metadata.get(key)?.trim();
  if (!value) throw new Error(`${file}: wiki front matter requires ${key}`);
  return value;
}

function pairs(value: string | undefined, key: string, file: string): Array<{ label: string; value: string }> {
  if (!value?.trim()) return [];
  return value.split(";").map((entry) => {
    const [label, ...rest] = entry.split("|");
    const item = rest.join("|").trim();
    if (!label?.trim() || !item) throw new Error(`${file}: ${key} entries use label|value`);
    return { label: label.trim(), value: item };
  });
}

function headingId(text: string): string {
  return text.toLocaleLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-");
}

function plainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#|~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pageEnd(content: Buffer, start: number, tentativeEnd: number): number {
  let end = tentativeEnd;
  while (end > start && end < content.length && (content[end]! & 0xc0) === 0x80) end -= 1;
  return end > start ? end : tentativeEnd;
}

function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): PageCursor {
  if (!value || value.length > 4096) throw new Error("invalid documentation cursor");
  const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<PageCursor>;
  if (typeof decoded.version !== "string" || typeof decoded.refsHash !== "string" ||
      !Number.isSafeInteger(decoded.maxBytes) || !Number.isSafeInteger(decoded.itemIndex) ||
      !Number.isSafeInteger(decoded.byteOffset)) throw new Error("invalid documentation cursor");
  return decoded as PageCursor;
}

function encodeSearchCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeSearchCursor(value: string): SearchCursor {
  try {
    if (!value || value.length > 4096) throw new Error();
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<SearchCursor>;
    if (
      decoded.v !== 1 ||
      typeof decoded.version !== "string" ||
      typeof decoded.queryHash !== "string" ||
      !Number.isSafeInteger(decoded.limit) ||
      !Number.isSafeInteger(decoded.offset) ||
      (decoded.limit ?? 0) < 1 ||
      (decoded.offset ?? -1) < 0
    ) throw new Error();
    return decoded as SearchCursor;
  } catch {
    throw new Error("invalid Wiki search cursor");
  }
}

export class DocumentationReferenceIndex {
  readonly version: string;
  private readonly records: ArticleRecord[];
  private readonly byId = new Map<string, ArticleRecord>();
  private readonly assetFiles = new Set<string>();

  constructor(readonly root = defaultWikiRoot()) {
    const files = readdirSync(root).filter((file) => file.endsWith(".md") && file !== "README.md").sort();
    this.records = files.map((file) => this.loadArticle(file));
    this.records.sort((left, right) => left.article.order - right.article.order || left.article.title.localeCompare(right.article.title));
    for (const record of this.records) {
      if (this.byId.has(record.article.id)) throw new Error(`duplicate wiki article id: ${record.article.id}`);
      this.byId.set(record.article.id, record);
    }
    for (const record of this.records) {
      for (const ref of record.article.relatedRefs) {
        if (!this.byId.has(ref.slice(REFERENCE_PREFIX.length))) throw new Error(`${record.article.id}: unknown related reference ${ref}`);
      }
    }
    this.version = createHash("sha256").update(JSON.stringify(this.records.map((record) => record.article))).digest("hex").slice(0, 16);
  }

  private loadArticle(file: string): ArticleRecord {
    const source = readFileSync(path.join(this.root, file), "utf8");
    const { metadata, markdown } = frontMatter(source);
    const id = required(metadata, "id", file);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || file !== `${id}.md`) throw new Error(`${file}: id must be a stable kebab-case filename`);
    const order = Number(required(metadata, "order", file));
    if (!Number.isSafeInteger(order) || order < 0) throw new Error(`${file}: order must be a non-negative integer`);
    const codeLinks = pairs(metadata.get("code"), "code", file).map(({ label, value }) => {
      if (path.isAbsolute(value) || value.split("/").includes("..")) throw new Error(`${file}: code links must be repository-relative`);
      return { label, path: value, url: `${REPOSITORY_SOURCE}${value.split("/").map(encodeURIComponent).join("/")}` };
    });
    const assets = pairs(metadata.get("assets"), "assets", file).map(({ label, value }) => {
      const prefix = "docs/wiki/assets/";
      if (!value.startsWith(prefix) || value.slice(prefix.length).includes("/")) throw new Error(`${file}: assets must be direct children of docs/wiki/assets`);
      const assetFile = value.slice(prefix.length);
      if (!existsSync(path.join(this.root, "assets", assetFile))) throw new Error(`${file}: missing asset ${assetFile}`);
      this.assetFiles.add(assetFile);
      return { alt: label, path: value, url: `/api/wiki/assets/${encodeURIComponent(assetFile)}` };
    });
    const headings = [...markdown.matchAll(/^(#{2,3})\s+(.+)$/gm)].map((match) => ({
      depth: match[1]!.length as 2 | 3,
      id: headingId(match[2]!),
      text: match[2]!.trim(),
    }));
    const article: WikiArticleDto = {
      id,
      ref: `${REFERENCE_PREFIX}${id}`,
      slug: id,
      title: required(metadata, "title", file),
      summary: required(metadata, "summary", file),
      section: required(metadata, "section", file),
      order,
      codeLinks,
      assets,
      markdown,
      headings,
      relatedRefs: (metadata.get("related") ?? "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => `${REFERENCE_PREFIX}${value}` as const),
    };
    const bytes = Buffer.from(markdown);
    return { article, bytes, searchable: `${article.title} ${article.summary} ${headings.map((heading) => heading.text).join(" ")} ${plainText(markdown)}`.toLocaleLowerCase() };
  }

  summary(article: WikiArticleDto): WikiArticleSummaryDto {
    const { markdown: _markdown, headings: _headings, relatedRefs: _relatedRefs, ...summary } = article;
    return summary;
  }

  index(): WikiIndexDto {
    const sections = new Map<string, WikiArticleSummaryDto[]>();
    for (const record of this.records) {
      const articles = sections.get(record.article.section) ?? [];
      articles.push(this.summary(record.article));
      sections.set(record.article.section, articles);
    }
    return {
      version: this.version,
      sections: [...sections].map(([title, articles]) => ({ id: headingId(title), title, articles })),
      totalArticles: this.records.length,
    };
  }

  article(idOrRef: string): WikiArticleDto | undefined {
    const id = idOrRef.startsWith(REFERENCE_PREFIX) ? idOrRef.slice(REFERENCE_PREFIX.length) : idOrRef;
    return this.byId.get(id)?.article;
  }

  search(
    query: string,
    requestedLimit = 20,
    cursorValue?: string,
  ): WikiSearchResponseDto {
    const normalized = query.trim().toLocaleLowerCase().replace(/\s+/g, " ");
    const limit = Math.min(50, Math.max(1, requestedLimit));
    if (!normalized) return { query: "", results: [], total: 0, limit };
    const queryHash = createHash("sha256")
      .update(`${this.version}\0${normalized}`)
      .digest("base64url");
    const cursor = cursorValue ? decodeSearchCursor(cursorValue) : undefined;
    if (
      cursor &&
      (cursor.version !== this.version ||
        cursor.queryHash !== queryHash ||
        cursor.limit !== limit)
    ) throw new Error("Wiki search cursor no longer matches this search");
    const offset = cursor?.offset ?? 0;
    const terms = [...new Set(normalized.split(" ").filter((term) => term.length > 1))];
    const ranked = this.records.flatMap((record) => {
      if (!terms.every((term) => record.searchable.includes(term))) return [];
      const title = record.article.title.toLocaleLowerCase();
      const summary = record.article.summary.toLocaleLowerCase();
      const score = terms.reduce((total, term) => total + (title.includes(term) ? 12 : 0) + (summary.includes(term) ? 6 : 0) + record.searchable.split(term).length - 1, 0);
      const text = plainText(record.article.markdown);
      const first = Math.max(0, terms.reduce((position, term) => {
        const match = text.toLocaleLowerCase().indexOf(term);
        return position < 0 || (match >= 0 && match < position) ? match : position;
      }, -1));
      const start = Math.max(0, first - 80);
      const snippet = `${start ? "…" : ""}${text.slice(start, start + 260)}${start + 260 < text.length ? "…" : ""}`;
      return [{ article: this.summary(record.article), snippet, score }];
    }).sort((left, right) => right.score - left.score || left.article.order - right.article.order);
    if (offset > ranked.length) throw new Error("invalid Wiki search cursor");
    const results = ranked.slice(offset, offset + limit);
    const nextOffset = offset + results.length;
    return {
      query: query.trim(),
      results,
      total: ranked.length,
      limit,
      ...(nextOffset < ranked.length
        ? {
            nextCursor: encodeSearchCursor({
              v: 1,
              version: this.version,
              queryHash,
              limit,
              offset: nextOffset,
            }),
          }
        : {}),
    };
  }

  asset(name: string): { body: Buffer; mediaType: string } | undefined {
    if (!this.assetFiles.has(name) || path.basename(name) !== name) return undefined;
    const file = path.join(this.root, "assets", name);
    return { body: readFileSync(file), mediaType: name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".png") ? "image/png" : "application/octet-stream" };
  }

  documentationPage(refs: string[], cursorValue?: string, requestedMaxBytes = DEFAULT_PAGE_BYTES): WikiDocumentationPageDto {
    if (refs.length < 1 || refs.length > 10 || new Set(refs).size !== refs.length) throw new Error("refs must contain 1 to 10 unique documentation references");
    const records = refs.map((ref) => {
      if (!ref.startsWith(REFERENCE_PREFIX)) throw new Error(`invalid documentation reference: ${ref}`);
      const record = this.byId.get(ref.slice(REFERENCE_PREFIX.length));
      if (!record) throw new Error(`unknown documentation reference: ${ref}`);
      return record;
    });
    if (!Number.isSafeInteger(requestedMaxBytes) || requestedMaxBytes < MIN_PAGE_BYTES || requestedMaxBytes > MAX_PAGE_BYTES) throw new Error(`maxBytes must be ${MIN_PAGE_BYTES} through ${MAX_PAGE_BYTES}`);
    const refsHash = createHash("sha256").update(JSON.stringify(refs)).digest("hex");
    const cursor = cursorValue ? decodeCursor(cursorValue) : undefined;
    if (cursor && (cursor.version !== this.version || cursor.refsHash !== refsHash || cursor.maxBytes !== requestedMaxBytes)) throw new Error("documentation cursor no longer matches the article version, reference order, or byte budget");
    let itemIndex = cursor?.itemIndex ?? 0;
    let byteOffset = cursor?.byteOffset ?? 0;
    if (itemIndex > records.length || (itemIndex < records.length && byteOffset > records[itemIndex]!.bytes.length)) throw new Error("documentation cursor is outside the content boundary");
    let remaining = requestedMaxBytes;
    const items: WikiDocumentationPageDto["items"] = [];
    while (itemIndex < records.length && remaining > 0) {
      const record = records[itemIndex]!;
      const start = byteOffset;
      const end = pageEnd(record.bytes, start, Math.min(record.bytes.length, start + remaining));
      const complete = end >= record.bytes.length;
      items.push({ ref: record.article.ref, title: record.article.title, mediaType: "text/markdown", totalBytes: record.bytes.length, range: { start, end }, content: record.bytes.subarray(start, end).toString("utf8"), complete });
      remaining -= end - start;
      if (!complete) { byteOffset = end; break; }
      itemIndex += 1;
      byteOffset = 0;
    }
    return {
      items,
      maxBytes: requestedMaxBytes,
      ...(itemIndex < records.length ? { nextCursor: encodeCursor({ version: this.version, refsHash, maxBytes: requestedMaxBytes, itemIndex, byteOffset }) } : {}),
    };
  }

}

export const documentationReferences = new DocumentationReferenceIndex();
