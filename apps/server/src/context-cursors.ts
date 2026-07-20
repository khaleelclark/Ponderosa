import path from "node:path";
import { readRepairableJsonl, writeAtomicFsyncedJsonl } from "@ponderosa/agents";

export interface ContextCursor {
  agentId: string;
  engine: string;
  model: string;
  sessionId: string;
  conversationId: string;
  channel: "main" | "collaboration" | "broadcast";
  lastMessageId?: string;
  routingHash: string;
  updatedAt: string;
}

/** Durable accepted-context ledger. Commits happen only after successful turns. */
export class ContextCursorStore {
  private readonly cursors = new Map<string, ContextCursor>();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "context-cursors.jsonl");
    for (const record of readRepairableJsonl<{ cursor?: ContextCursor }>(this.file, "context cursor journal", true)) {
      const cursor = record.cursor;
      if (cursor) this.cursors.set(ContextCursorStore.key(cursor), cursor);
    }
    this.persist(this.cursors);
  }

  private static key(cursor: Omit<ContextCursor, "lastMessageId" | "routingHash" | "updatedAt">): string {
    return [cursor.agentId, cursor.engine, cursor.model, cursor.sessionId, cursor.conversationId, cursor.channel].join("\0");
  }

  get(scope: Omit<ContextCursor, "lastMessageId" | "routingHash" | "updatedAt">): ContextCursor | undefined {
    return this.cursors.get(ContextCursorStore.key(scope));
  }

  latestForSession(agentId: string, sessionId: string): ContextCursor | undefined {
    return [...this.cursors.values()]
      .filter((cursor) => cursor.agentId === agentId && cursor.sessionId === sessionId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  commit(cursor: Omit<ContextCursor, "updatedAt">): void {
    const stored = { ...cursor, updatedAt: new Date().toISOString() };
    const next = new Map(this.cursors);
    next.set(ContextCursorStore.key(stored), stored);
    this.persist(next);
    this.replaceInMemory(next);
  }

  deleteAgents(agentIds: ReadonlySet<string>): void {
    const next = new Map([...this.cursors].filter(([, cursor]) => !agentIds.has(cursor.agentId)));
    this.persist(next);
    this.replaceInMemory(next);
  }

  private persist(cursors: ReadonlyMap<string, ContextCursor>): void {
    writeAtomicFsyncedJsonl(this.file, [...cursors.values()].map((cursor) => ({ type: "cursor", cursor })));
  }

  private replaceInMemory(cursors: ReadonlyMap<string, ContextCursor>): void {
    this.cursors.clear();
    for (const [key, cursor] of cursors) this.cursors.set(key, cursor);
  }
}
