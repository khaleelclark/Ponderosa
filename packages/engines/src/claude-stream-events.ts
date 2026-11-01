import { LONG_TEXT_MAX_UTF8_BYTES, utf8ByteLength, type AgentEvent } from "@ponderosa/core";
import { mapClaudeEvent } from "./claude-events.js";
import type { CodexMapContext } from "./events.js";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

/** Partials remain execution telemetry. Only a matched native result from the
 * explicit host voice tool can arm candidate bytes; the host retains authority. */
export function claudeStreamEventMapper(): (raw: unknown, context?: CodexMapContext) => AgentEvent[] {
  let sessionId: string | undefined;
  let messageId: string | undefined;
  let voiceReady = false;
  let voiceCallId: string | undefined;
  const blocks = new Map<number, string>();
  let bytes = 0;
  let paused = false;
  const clear = () => { messageId = undefined; blocks.clear(); bytes = 0; paused = false; };
  const candidate = (id: string, index: number, kind: "start" | "delta" | "complete", text: string): AgentEvent[] =>
    voiceReady ? [{ type: "response_text", providerTurnId: id, itemId: String(index), phase: "final_answer", kind, text }] : [];
  return (raw, context = {}) => {
    const envelope = object(raw);
    if (!envelope) return mapClaudeEvent(raw, context);
    if (envelope.type === "system" && envelope.subtype === "init" && identity(envelope.session_id)) {
      sessionId = envelope.session_id; clear(); voiceReady = false; voiceCallId = undefined;
    }
    if (envelope.type === "result") { clear(); voiceReady = false; voiceCallId = undefined; }
    const main = Boolean(sessionId) && envelope.session_id === sessionId && envelope.parent_tool_use_id === null && envelope.isReplay !== true;
    if (envelope.type === "user" && main) {
      const content = object(envelope.message)?.content;
      const mapped = mapClaudeEvent(raw, context);
      for (const value of Array.isArray(content) ? content : []) {
        const block = object(value);
        if (block?.type !== "tool_result" || !identity(block.tool_use_id) || block.tool_use_id !== voiceCallId) continue;
        voiceCallId = undefined;
        if (block.is_error === true) { voiceReady = false; continue; }
        const parts = block.content;
        if (!Array.isArray(parts) || parts.length !== 1) continue;
        const part = object(parts[0]);
        if (part?.type !== "text" || typeof part.text !== "string") continue;
        try {
          const receipt = object(JSON.parse(part.text));
          const result = mapped.find((event): event is Extract<AgentEvent, { type: "tool_result" }> => event.type === "tool_result" && event.id === block.tool_use_id);
          if (!result || result.isError || receipt?.authorized !== true || !identity(receipt.operationId) ||
              typeof receipt.streamId !== "string" || !receipt.streamId || receipt.streamId.length > 512) continue;
          result.voiceReplyStreamId = receipt.streamId; result.voiceReplyOperationId = receipt.operationId; result.isError = false;
          voiceReady = true;
        } catch { /* Arbitrary prose or receipts from other tools never arm speech. */ }
      }
      return mapped;
    }
    if (envelope.type === "stream_event") {
      if (!main) return [];
      const event = object(envelope.event);
      if (event?.type === "message_start") {
        clear();
        const id = object(event.message)?.id;
        if (identity(id)) messageId = id;
        return [];
      }
      if (!messageId || !event || !Number.isSafeInteger(event.index) || (event.index as number) < 0) return [];
      const index = event.index as number;
      const block = object(event.content_block);
      const delta = object(event.delta);
      if (event.type === "content_block_start" && !["text", "thinking", "redacted_thinking"].includes(String(block?.type))) {
        voiceReady = false;
        return [{ type: "work_start", kind: "native_tool" }];
      }
      const start = event.type === "content_block_start" && block?.type === "text" && !blocks.has(index);
      const text = start ? block?.text : event.type === "content_block_delta" && delta?.type === "text_delta" && blocks.has(index) ? delta.text : undefined;
      if (typeof text !== "string" || paused) return [];
      const nextBytes = bytes + utf8ByteLength(text) + (blocks.has(index) ? 0 : 1);
      if (nextBytes > LONG_TEXT_MAX_UTF8_BYTES) {
        paused = true;
        return [{ type: "text", delta: "\n[Claude partial stream paused at the text buffer limit; awaiting the complete snapshot]\n" }];
      }
      blocks.set(index, (blocks.get(index) ?? "") + text); bytes = nextBytes;
      return [...(start ? candidate(messageId, index, "start", "") : []),
        ...(text ? candidate(messageId, index, "delta", text) : []), ...(text ? [{ type: "text" as const, delta: text }] : [])];
    }
    if (envelope.type !== "assistant" || envelope.error || !main) return mapClaudeEvent(raw, context);
    const message = object(envelope.message);
    if (!message || !identity(message.id) || !Array.isArray(message.content)) return mapClaudeEvent(raw, context);
    const mapped: AgentEvent[] = [];
    for (const [index, value] of message.content.entries()) {
      const block = object(value);
      const prefix = message.id === messageId ? blocks.get(index) : undefined;
      if (block?.type === "tool_use") {
        voiceReady = false;
        if (block.name === "mcp__ponderosa__voice_reply" && identity(block.id)) voiceCallId = block.id;
      }
      if (block?.type === "text" && typeof block.text === "string") {
        if (prefix === undefined) mapped.push(...candidate(message.id, index, "start", ""));
        mapped.push(...candidate(message.id, index, "complete", block.text));
        const delta = prefix === undefined ? block.text : block.text.startsWith(prefix) ? block.text.slice(prefix.length)
          : `\n[Claude corrected provisional streamed text; complete text follows]\n${block.text}`;
        if (delta) mapped.push({ type: "text", delta });
      } else {
        mapped.push(...mapClaudeEvent({ ...envelope, message: { ...message, content: [value] } }, context));
      }
    }
    clear();
    return mapped;
  };
}
