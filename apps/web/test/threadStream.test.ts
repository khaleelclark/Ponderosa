import type { MessageDto, SseEventEnvelope, ThreadDetailDto } from "@ponderosa/core";
import { describe, expect, it } from "vitest";
import { updateThreadDetail } from "../src/hooks/useThreadStream";

describe("updateThreadDetail", () => {
  it("ignores an invalid cached message while appending streamed text", () => {
    const liveMessage: MessageDto = {
      id: "live-agent-thread-1-2",
      threadId: "thread-1",
      seq: 2,
      role: "assistant",
      text: "Hello",
      createdAt: "2026-07-11T08:00:00.000Z",
    };
    const detail = {
      messages: [undefined, liveMessage],
      tasks: [],
      artifacts: [],
      thread: { activeEngine: "codex" },
    } as unknown as ThreadDetailDto;
    const envelope = {
      seq: 3,
      ts: "2026-07-11T08:00:01.000Z",
      event: { type: "text", delta: " world" },
    } as SseEventEnvelope;

    expect(updateThreadDetail("thread-1", envelope, detail).messages).toEqual([
      { ...liveMessage, text: "Hello world" },
    ]);
  });
});
