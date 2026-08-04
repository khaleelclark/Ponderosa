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

type CollectionOrder = "updated" | "title";

interface CollectionGeneration {
  revision: string;
}

interface CollectionCursor {
  v: 3;
  scope: string;
  order: CollectionOrder;
  generation: CollectionGeneration;
  updatedAt?: string;
  title: string;
  id: string;
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

export function sqliteCollectionRevision(
  sqlite: Database.Database,
  baseSql: string,
  params: readonly unknown[] = [],
): { revision: string; total: number } {
  const hash = createHash("sha256");
  let total = 0;
  const rows = sqlite.prepare(`
    SELECT id, title, updated_at
    FROM (${baseSql}) revision_collection
    ORDER BY id ASC
  `).iterate(...params) as Iterable<{
    id: string;
    title: string;
    updated_at: string;
  }>;
  for (const row of rows) {
    total += 1;
    for (const value of [row.id, row.title, row.updated_at]) {
      const encoded = Buffer.from(value, "utf8");
      hash.update(String(encoded.length)).update(":").update(encoded).update(";");
    }
  }
  return { revision: hash.digest("base64url"), total };
}

function encodeCollectionCursor(cursor: CollectionCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCollectionCursor(
  value: string | undefined,
  expected: {
    scope: string;
    order: CollectionOrder;
    generation: CollectionGeneration;
  },
): CollectionCursor | undefined {
  if (!value) return undefined;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CollectionCursor>;
    const generation = cursor.generation;
    if (
      cursor.v !== 3 ||
      cursor.scope !== expected.scope ||
      cursor.order !== expected.order ||
      !generation ||
      typeof generation.revision !== "string" ||
      typeof cursor.title !== "string" ||
      typeof cursor.id !== "string" ||
      (expected.order === "updated" && typeof cursor.updatedAt !== "string")
    ) {
      throw new Error();
    }
    if (
      generation.revision !== expected.generation.revision
    ) {
      throw new Error("stale collection cursor");
    }
    return cursor as CollectionCursor;
  } catch (error) {
    if (error instanceof Error && error.message === "stale collection cursor") throw error;
    throw new Error("invalid collection cursor");
  }
}

export function sqliteCollectionPage<T>(
  sqlite: Database.Database,
  query: CollectionQuery,
  options: {
    /** SQL selecting id, title, and updated_at. */
    baseSql: string;
    params?: readonly unknown[];
    order: CollectionOrder;
    scope: string;
    hydrate: (id: string) => T | undefined;
    defaultLimit?: number;
    maxLimit?: number;
  },
): CollectionPage<T> {
  const maximum = options.maxLimit ?? 100;
  const limit = parseLimit(query, options.defaultLimit ?? maximum, maximum);
  const scope = queryScope(options.scope, query);
  const params = [...(options.params ?? [])];
  const collection = sqliteCollectionRevision(sqlite, options.baseSql, params);
  const generation: CollectionGeneration = {
    revision: collection.revision,
  };
  const cursor = decodeCollectionCursor(query.cursor, {
    scope,
    order: options.order,
    generation,
  });
  const cursorSql = !cursor
    ? ""
    : options.order === "updated"
      ? `WHERE (
          updated_at < ? OR
          (updated_at = ? AND (
            lower(title) > ? OR
            (lower(title) = ? AND id > ?)
          ))
        )`
      : `WHERE (
          lower(title) > ? OR
          (lower(title) = ? AND id > ?)
        )`;
  const cursorParams = !cursor
    ? []
    : options.order === "updated"
      ? [cursor.updatedAt, cursor.updatedAt, cursor.title, cursor.title, cursor.id]
      : [cursor.title, cursor.title, cursor.id];
  const orderBy = options.order === "updated"
    ? "updated_at DESC, lower(title) ASC, id ASC"
    : "lower(title) ASC, id ASC";
  const rows = sqlite.prepare(`
    SELECT id, title, lower(title) AS sort_title, updated_at
    FROM (${options.baseSql}) bounded_collection
    ${cursorSql}
    ORDER BY ${orderBy}
    LIMIT ?
  `).all(...params, ...cursorParams, limit + 1) as Array<{
    id: string;
    title: string;
    sort_title: string;
    updated_at: string;
  }>;
  const pageRows = rows.slice(0, limit);
  const items = pageRows.flatMap(({ id }) => {
    const item = options.hydrate(id);
    return item ? [item] : [];
  });
  const hasMore = rows.length > limit;
  const last = pageRows.at(-1);
  return {
    items,
    total: collection.total,
    limit,
    hasMore,
    ...(hasMore && last
      ? {
          cursor: encodeCollectionCursor({
            v: 3,
            scope,
            order: options.order,
            generation,
            ...(options.order === "updated" ? { updatedAt: last.updated_at } : {}),
            title: last.sort_title,
            id: last.id,
          }),
        }
      : {}),
  };
}

export function applyCollectionPageHeaders(reply: FastifyReply, page: CollectionPage<unknown>): void {
  reply.header("X-Total-Count", String(page.total));
  reply.header("X-Page-Limit", String(page.limit));
  reply.header("X-Collection-Has-More", String(page.hasMore));
  if (page.cursor) reply.header("X-Next-Cursor", page.cursor);
}
