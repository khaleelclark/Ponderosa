import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ContextCursor {
  threadId: string;
  engine: string;
  model: string;
  sessionId: string;
  masterChatId: string;
  channel: "main" | "collaboration";
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
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (!existsSync(this.file)) closeSync(openSync(this.file, "a", 0o600));
    chmodSync(this.file, 0o600);
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line) continue;
      const cursor = (JSON.parse(line) as { cursor?: ContextCursor }).cursor;
      if (cursor) this.cursors.set(ContextCursorStore.key(cursor), cursor);
    }
  }

  private static key(cursor: Omit<ContextCursor, "lastMessageId" | "routingHash" | "updatedAt">): string {
    return [cursor.threadId, cursor.engine, cursor.model, cursor.sessionId, cursor.masterChatId, cursor.channel].join("\0");
  }

  get(scope: Omit<ContextCursor, "lastMessageId" | "routingHash" | "updatedAt">): ContextCursor | undefined {
    return this.cursors.get(ContextCursorStore.key(scope));
  }

  latestForSession(threadId: string, sessionId: string): ContextCursor | undefined {
    return [...this.cursors.values()]
      .filter((cursor) => cursor.threadId === threadId && cursor.sessionId === sessionId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  commit(cursor: Omit<ContextCursor, "updatedAt">): void {
    const stored = { ...cursor, updatedAt: new Date().toISOString() };
    appendFileSync(this.file, `${JSON.stringify({ type: "cursor", cursor: stored })}\n`, "utf8");
    this.cursors.set(ContextCursorStore.key(stored), stored);
  }
}
