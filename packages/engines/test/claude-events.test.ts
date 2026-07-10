import { describe, expect, it } from "vitest";
import { mapClaudeEvent } from "../src/claude-events.js";

describe("mapClaudeEvent — per event type", () => {
  it("system/init → session", () => {
    expect(
      mapClaudeEvent({ type: "system", subtype: "init", session_id: "s-1", cwd: "/p" }),
    ).toEqual([{ type: "session", sessionId: "s-1" }]);
  });

  it("system non-init → []", () => {
    expect(mapClaudeEvent({ type: "system", subtype: "other" })).toEqual([]);
  });

  it("assistant text block → text", () => {
    expect(
      mapClaudeEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
    ).toEqual([{ type: "text", delta: "hello" }]);
  });

  it("assistant thinking block → reasoning", () => {
    expect(
      mapClaudeEvent({
        type: "assistant",
        message: { content: [{ type: "thinking", thinking: "hmm" }] },
      }),
    ).toEqual([{ type: "reasoning", delta: "hmm" }]);
  });

  it("assistant Bash tool_use → command (with run cwd)", () => {
    expect(
      mapClaudeEvent(
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -a" } },
            ],
          },
        },
        { cwd: "/work" },
      ),
    ).toEqual([{ type: "command", command: "ls -a", cwd: "/work" }]);
  });

  it("assistant Write tool_use → file_change create", () => {
    expect(
      mapClaudeEvent({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t2", name: "Write", input: { file_path: "a.ts" } },
          ],
        },
      }),
    ).toEqual([{ type: "file_change", path: "a.ts", kind: "create" }]);
  });

  it("assistant Edit tool_use → file_change edit", () => {
    expect(
      mapClaudeEvent({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t3", name: "Edit", input: { file_path: "b.ts" } },
          ],
        },
      }),
    ).toEqual([{ type: "file_change", path: "b.ts", kind: "edit" }]);
  });

  it("assistant other tool_use → tool_call", () => {
    expect(
      mapClaudeEvent({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t4", name: "Grep", input: { pattern: "foo" } },
          ],
        },
      }),
    ).toEqual([{ type: "tool_call", id: "t4", name: "Grep", input: { pattern: "foo" } }]);
  });

  it("user tool_result → tool_result", () => {
    expect(
      mapClaudeEvent({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "output text", is_error: false },
          ],
        },
      }),
    ).toEqual([{ type: "tool_result", id: "t1", output: "output text", isError: false }]);
  });

  it("user tool_result with array content → joined text + isError", () => {
    expect(
      mapClaudeEvent({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t9",
              content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }],
              is_error: true,
            },
          ],
        },
      }),
    ).toEqual([{ type: "tool_result", id: "t9", output: "line1line2", isError: true }]);
  });

  it("result success → turn_done with normalized usage", () => {
    expect(
      mapClaudeEvent({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
    ).toEqual([{ type: "turn_done", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }]);
  });

  it("result error → error then turn_done", () => {
    expect(
      mapClaudeEvent({ type: "result", subtype: "error", is_error: true, result: "boom" }),
    ).toEqual([{ type: "error", message: "boom" }, { type: "turn_done", usage: undefined }]);
  });

  it("rate_limit_event and unknown types → []", () => {
    expect(mapClaudeEvent({ type: "rate_limit_event", rate_limit_info: {} })).toEqual([]);
    expect(mapClaudeEvent({ type: "future_event" })).toEqual([]);
    expect(mapClaudeEvent(null)).toEqual([]);
    expect(mapClaudeEvent("nope")).toEqual([]);
  });

  it("multiple blocks in one assistant message map in order", () => {
    expect(
      mapClaudeEvent(
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "working" },
              { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } },
            ],
          },
        },
        { cwd: "/w" },
      ),
    ).toEqual([
      { type: "text", delta: "working" },
      { type: "command", command: "echo hi", cwd: "/w" },
    ]);
  });
});
