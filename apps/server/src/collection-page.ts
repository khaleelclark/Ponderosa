import type { CollectionPageDto } from "@ponderosa/core";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyReply } from "fastify";

export interface CollectionQuery {
  limit?: string;
  cursor?: string;
  search?: string;
}

export type CollectionPage<T> = CollectionPageDto<T>;

type CollectionOrder = "updated" | "title";

interface CollectionGeneration {
  revision: string;
}

const sqliteGenerationIds = new WeakMap<Database.Database, string>();
const DEFAULT_COLLECTION_GENERATION_KEYS = [
  "projects", "conversations", "agents", "memberships",
  "scheduler_runs", "context_rollovers",
] as const;

export class StaleCollectionCursorError extends Error {
  readonly code = "stale_collection_cursor";
  constructor(message = "stale collection cursor") { super(message); }
}

export function collectionGenerationKey(collection: string, scope: string): string {
  return `${collection}:${scope}`;
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
  generationKeys: readonly string[] = DEFAULT_COLLECTION_GENERATION_KEYS,
): { revision: string; total: number } {
  const revision = sqliteCollectionGeneration(sqlite, generationKeys);
  const total = (sqlite.prepare(`SELECT COUNT(*) AS value FROM (${baseSql}) revision_collection`)
    .get(...params) as { value: number }).value;
  return { revision, total };
}

/** O(1) collection generation. The per-connection nonce prevents a cursor
 * from a prior daemon boot from colliding after SQLite resets total_changes. */
export function sqliteCollectionGeneration(
  sqlite: Database.Database,
  generationKeys: readonly string[] = DEFAULT_COLLECTION_GENERATION_KEYS,
): string {
  let generationId = sqliteGenerationIds.get(sqlite);
  if (!generationId) {
    generationId = randomUUID();
    sqliteGenerationIds.set(sqlite, generationId);
  }
  const keys = [...new Set(generationKeys)].sort();
  if (keys.length === 0) return generationId;
  const rows = sqlite.prepare(`
    SELECT name, generation FROM collection_generations
    WHERE name IN (${keys.map(() => "?").join(", ")})
  `).all(...keys) as Array<{ name: string; generation: number }>;
  const generations = new Map(rows.map((row) => [row.name, row.generation]));
  return `${generationId}:${keys.map((key) => `${key}=${generations.get(key) ?? 0}`).join(",")}`;
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
      throw new StaleCollectionCursorError();
    }
    return cursor as CollectionCursor;
  } catch (error) {
    if (error instanceof StaleCollectionCursorError) throw error;
    throw new Error("invalid collection cursor");
  }
}

export function sendCollectionPageError(
  reply: FastifyReply,
  error: unknown,
  fallback = "invalid collection cursor",
): unknown {
  if (error instanceof StaleCollectionCursorError) {
    return reply.code(409).send({ error: error.message, code: error.code });
  }
  return reply.code(400).send({ error: error instanceof Error ? error.message : fallback });
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
    generationKeys?: readonly string[];
  },
): CollectionPage<T> {
  const maximum = options.maxLimit ?? 100;
  const limit = parseLimit(query, options.defaultLimit ?? maximum, maximum);
  const scope = queryScope(options.scope, query);
  const params = [...(options.params ?? [])];
  const collection = sqliteCollectionRevision(sqlite, options.baseSql, params, options.generationKeys);
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
