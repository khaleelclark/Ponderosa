import { describe, expect, it } from "vitest";
import { AgentEventProjectionError, projectAgentEvent } from "./agent-event-projection.js";

describe("projectAgentEvent", () => {
  it("copies every legitimate variant into closed plain data", () => {
    const events = [
      { type: "session", sessionId: "session-1" },
      { type: "context_usage", providerSessionId: "session-1", providerSessionGeneration: "generation-1", usedTokens: 12, aggregateTokens: 20, windowTokens: 100 },
      { type: "context_rollover_seed_overflow", executionId: "run-1", rolloverId: "rollover-1", usedTokens: 90, lowWaterMark: 30, seedPromptUtf8Bytes: 100, contextSections: [{ kind: "history", count: 2 }] },
      { type: "context_rollover_completed", executionId: "run-1", rolloverId: "rollover-1", previousProviderSessionId: "old", replacementProviderSessionId: "new", startingOccupancy: 10 },
      { type: "text", delta: "answer\n" },
      { type: "reasoning", delta: "thought" },
      { type: "tool_call", id: "call-1", name: "read", input: { path: "README.md", rows: [1, true, null] } },
      { type: "tool_result", id: "call-1", output: "ok", isError: false },
      { type: "command", command: "pwd", cwd: "/tmp", callId: "call-2" },
      { type: "file_change", path: "src/a.ts", kind: "edit", diff: "@@", callId: "call-3" },
      { type: "test_result", passed: true, summary: "passed" },
      { type: "browser_session", sessionId: "browser-1", executionId: "run-1", status: "ready", controlOwner: "agent", controlEpoch: 1, url: "https://example.test", title: "Example" },
      { type: "browser_action", sessionId: "browser-1", executionId: "run-1", actor: "agent", action: "click", summary: "clicked", url: "https://example.test" },
      { type: "browser_console", sessionId: "browser-1", executionId: "run-1", level: "warning", text: "warning" },
      { type: "browser_screenshot", sessionId: "browser-1", executionId: "run-1", artifactId: "artifact-1", path: "capture.png", width: 10, height: 20, size: 30, sha256: "a".repeat(64) },
      { type: "work_item_update", workItemId: "work-1", status: "done", title: "Done", executionId: "run-1" },
      { type: "turn_done", usage: { inputTokens: 2, cachedInputTokens: 1, cacheWriteInputTokens: 1, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 4 }, providerRequestUsage: [{ inputTokens: 1, outputTokens: 2 }] },
      { type: "error", message: "provider failed", code: "network", category: "unavailable", remediation: "retry" },
    ];

    for (const event of events) {
      const projected = projectAgentEvent(event);
      expect(projected).toEqual(event);
      expect(projected).not.toBe(event);
      expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
      expect(JSON.parse(JSON.stringify(projected))).toEqual(event);
    }
  });

  it("does not invoke accessors or custom serialization", () => {
    let invoked = false;
    const accessor = { type: "text" } as Record<string, unknown>;
    Object.defineProperty(accessor, "delta", {
      enumerable: true,
      get: () => {
        invoked = true;
        throw new Error("getter marker");
      },
    });
    const custom = {
      type: "text",
      delta: "safe",
      toJSON: () => ({ type: "text", delta: "TO_JSON_MARKER" }),
    };

    expect(() => projectAgentEvent(accessor)).toThrow(AgentEventProjectionError);
    expect(() => projectAgentEvent(custom)).toThrow(AgentEventProjectionError);
    expect(invoked).toBe(false);
  });

  it.each([
    ["infinite usage", { type: "turn_done", usage: { inputTokens: 1e400 } }],
    ["unsafe session", { type: "session", sessionId: "session\0access_token=private" }],
    ["secret-shaped session", { type: "session", sessionId: "access_token=private" }],
    ["unknown secret", { type: "text", delta: "safe", access_token: "private" }],
    ["invalid enum", { type: "file_change", path: "a", kind: "replace" }],
    ["function", { type: "tool_call", id: "1", name: "tool", input: { value: () => undefined } }],
    ["symbol", { type: "tool_call", id: "1", name: "tool", input: { value: Symbol("x") } }],
    ["bigint", { type: "tool_call", id: "1", name: "tool", input: { value: 1n } }],
    ["wide", { type: "tool_call", id: "1", name: "tool", input: Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [`k${index}`, index])) }],
    ["huge", { type: "text", delta: "x".repeat(4 * 1024 * 1024) }],
  ])("rejects %s data", (_name, event) => {
    expect(() => projectAgentEvent(event)).toThrow(AgentEventProjectionError);
  });

  it("rejects cycles, deep values, ordinary proxies, trapped proxies, and revoked proxies", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    let deep: unknown = "leaf";
    for (let index = 0; index < 18; index += 1) deep = { child: deep };
    const trapped = new Proxy({ type: "turn_done" }, {
      ownKeys: () => { throw new Error("ownKeys marker"); },
      getOwnPropertyDescriptor: () => { throw new Error("descriptor marker"); },
    });
    const revocable = Proxy.revocable({ type: "turn_done" }, {});
    revocable.revoke();

    for (const event of [
      { type: "tool_call", id: "1", name: "tool", input: circular },
      { type: "tool_call", id: "1", name: "tool", input: deep },
      new Proxy({ type: "turn_done" }, {}),
      trapped,
      revocable.proxy,
    ]) {
      expect(() => projectAgentEvent(event)).toThrow(AgentEventProjectionError);
    }
  });

  it("enforces one cumulative event budget across nested mixed data", () => {
    const input = Object.fromEntries(Array.from({ length: 4_000 }, (_, index) => [
      `key-${index}`,
      ["x".repeat(1_024), { index }],
    ]));
    expect(() => projectAgentEvent({ type: "tool_call", id: "1", name: "tool", input }))
      .toThrow(AgentEventProjectionError);
  });

  it("preserves an own __proto__ JSON key without mutating the projection prototype", () => {
    const input = JSON.parse('{"__proto__":{"marker":"ordinary JSON"},"safe":true}') as Record<string, unknown>;
    const projected = projectAgentEvent({ type: "tool_call", id: "1", name: "tool", input });
    expect(projected.type).toBe("tool_call");
    if (projected.type !== "tool_call") throw new Error("unexpected event type");

    expect(Object.getPrototypeOf(projected.input)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(projected.input, "__proto__")).toBe(true);
    expect(JSON.stringify(projected.input)).toBe('{"__proto__":{"marker":"ordinary JSON"},"safe":true}');
    expect((projected.input as Record<string, unknown>).marker).toBeUndefined();
    expect(({} as Record<string, unknown>).marker).toBeUndefined();
  });

  it.each([
    ["cache counters without input", { cachedInputTokens: 1 }],
    ["cache counters above input", { inputTokens: 2, cachedInputTokens: 2, cacheWriteInputTokens: 1 }],
    ["unsafe cache counter sum", { inputTokens: Number.MAX_SAFE_INTEGER, cachedInputTokens: Number.MAX_SAFE_INTEGER, cacheWriteInputTokens: 1 }],
    ["reasoning without output", { reasoningOutputTokens: 1 }],
    ["reasoning above output", { outputTokens: 1, reasoningOutputTokens: 2 }],
    ["mismatched total", { inputTokens: 2, outputTokens: 3, totalTokens: 6 }],
    ["unsafe computed total", { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }],
    ["total below known input", { inputTokens: 2, totalTokens: 1 }],
    ["total below known output", { outputTokens: 2, totalTokens: 1 }],
  ])("rejects the %s token-usage invariant", (_name, usage) => {
    expect(() => projectAgentEvent({ type: "turn_done", usage }))
      .toThrow(AgentEventProjectionError);
    expect(() => projectAgentEvent({ type: "turn_done", providerRequestUsage: [usage] }))
      .toThrow(AgentEventProjectionError);
  });
});
