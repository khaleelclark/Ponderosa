import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyReply } from "fastify";

export interface CollectionQuery {
  limit?: string;
  cursor?: string;
  search?: string;
}

export interface CollectionPage<T> {
  items: T[];
  total: number;
  limit: number;
  hasMore: boolean;
  cursor?: string;
}

function parseLimit(query: CollectionQuery, fallback: number, maximum: number): number {
  const parsed = Number(query.limit ?? fallback);
  return Math.min(maximum, Math.max(1, Number.isFinite(parsed) ? Math.floor(parsed) : fallback));
}

function queryScope(scope: string, query: CollectionQuery): string {
  return createHash("sha256")
    .update(JSON.stringify({ scope, search: query.search?.trim().toLocaleLowerCase() ?? "" }))
    .digest("base64url")
    .slice(0, 24);
}

export function encodeCollectionCursor(scopeName: string, query: CollectionQuery, offset: number): string {
  const scope = queryScope(scopeName, query);
  return Buffer.from(JSON.stringify({ v: 2, offset, scope })).toString("base64url");
}

function decodeSqlOffset(cursor: string | undefined, scope: string): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      offset?: unknown;
      scope?: unknown;
    };
    if (
      value.v !== 2 || value.scope !== scope ||
      !Number.isSafeInteger(value.offset) || Number(value.offset) < 0
    ) throw new Error();
    return Number(value.offset);
  } catch {
    throw new Error("invalid collection cursor");
  }
}

export function sqliteCollectionPage<T>(
  sqlite: Database.Database,
  query: CollectionQuery,
  options: {
    /** SQL selecting at least an id column plus every column referenced by orderBy. */
    baseSql: string;
    params?: readonly unknown[];
    orderBy: string;
    scope: string;
    hydrate: (id: string) => T | undefined;
    defaultLimit?: number;
    maxLimit?: number;
  },
): CollectionPage<T> {
  const maximum = options.maxLimit ?? 100;
  const limit = parseLimit(query, options.defaultLimit ?? maximum, maximum);
  const scope = queryScope(options.scope, query);
  const offset = decodeSqlOffset(query.cursor, scope);
  const params = [...(options.params ?? [])];
  const total = (sqlite.prepare(`SELECT COUNT(*) AS count FROM (${options.baseSql}) bounded_collection`)
    .get(...params) as { count: number }).count;
  if (offset > total) throw new Error("invalid collection cursor");
  const rows = sqlite.prepare(`
    SELECT id FROM (${options.baseSql}) bounded_collection
    ORDER BY ${options.orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<{ id: string }>;
  const items = rows.flatMap(({ id }) => {
    const item = options.hydrate(id);
    return item ? [item] : [];
  });
  const nextOffset = offset + rows.length;
  const hasMore = nextOffset < total;
  return {
    items,
    total,
    limit,
    hasMore,
    ...(hasMore
      ? { cursor: encodeCollectionCursor(options.scope, query, nextOffset) }
      : {}),
  };
}

export function applyCollectionPageHeaders(reply: FastifyReply, page: CollectionPage<unknown>): void {
  reply.header("X-Total-Count", String(page.total));
  reply.header("X-Page-Limit", String(page.limit));
  reply.header("X-Collection-Has-More", String(page.hasMore));
  if (page.cursor) reply.header("X-Next-Cursor", page.cursor);
}
