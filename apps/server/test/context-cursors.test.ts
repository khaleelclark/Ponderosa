import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContextCursorStore, type ContextCursor } from "../src/context-cursors.js";

describe("ContextCursorStore durability", () => {
  const cleanup: string[] = [];
  afterEach(() => cleanup.splice(0).forEach((entry) => rmSync(entry, { recursive: true, force: true })));

  const cursor = (lastMessageId: string): Omit<ContextCursor, "updatedAt"> => ({
    agentId: "agent-1",
    engine: "codex",
    model: "gpt-5",
    sessionId: "session-1",
    conversationId: "conversation-1",
    channel: "main",
    lastMessageId,
    routingHash: `hash-${lastMessageId}`,
  });

  it("repairs a crash-torn final record and keeps one latest snapshot record per scope", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ponderosa-context-cursor-"));
    cleanup.push(dir);
    const file = path.join(dir, "context-cursors.jsonl");
    const first = new ContextCursorStore(dir);
    for (let index = 0; index < 20; index += 1) first.commit(cursor(`message-${index}`));
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);

    appendFileSync(file, '{"type":"cursor","cursor":{"agentId":"torn', "utf8");
    const restarted = new ContextCursorStore(dir);
    expect(restarted.latestForSession("agent-1", "session-1")).toMatchObject({
      lastMessageId: "message-19",
      routingHash: "hash-message-19",
    });
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("fails closed when corruption is not confined to an incomplete tail", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ponderosa-context-corrupt-"));
    cleanup.push(dir);
    const file = path.join(dir, "context-cursors.jsonl");
    const valid = { type: "cursor", cursor: { ...cursor("valid"), updatedAt: "2026-07-20T00:00:00.000Z" } };
    writeFileSync(file, `{not-json}\n${JSON.stringify(valid)}\n`, "utf8");
    expect(() => new ContextCursorStore(dir)).toThrow("context cursor journal contains non-tail corruption");
  });
});
