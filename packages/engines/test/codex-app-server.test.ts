import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@ponderosa/core";
import { CodexAppServerSession, mapCodexAppServerNotification, mapCodexTokenUsage, reconcileProviderRequestUsage, subtractUsage, sumProviderRequestUsage } from "../src/codex-app-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "fake-codex-app-server.mjs");

describe("Codex app-server persistent runtime", () => {
  it("injects canonical history into the first turn of a fresh persistent session", async () => {
    const controller = new AbortController();
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) => spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "history", cwd: here, history: [{ role: "assistant", text: "History marker" }],
      signal: controller.signal, bin: "codex", spawnFn, sandboxMode: "workspace-write", killGraceMs: 50,
    });
    const text: string[] = [];
    const collecting = (async () => { for await (const event of session.events) {
      if (event.type === "text") text.push(event.delta);
      if (event.type === "turn_done") return;
    } })();
    await session.startTurn({ prompt: "Current work", kind: "user_message" });
    await collecting;
    expect(text.join("")).toContain("Conversation so far:\nAssistant: History marker\n\nCurrent request:\nCurrent work");
    await session.close();
  });
  it("normalizes the per-turn usage breakdown without double-counting cached tokens", () => {
    expect(mapCodexTokenUsage({ totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2 }))
      .toEqual({ totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2 });
  });
  it("derives one execution from compatible absolute thread checkpoints and rejects resets", () => {
    expect(subtractUsage(
      { totalTokens: 999, inputTokens: 800, cachedInputTokens: 400, outputTokens: 199, reasoningOutputTokens: 100 },
      { totalTokens: 981, inputTokens: 785, cachedInputTokens: 396, outputTokens: 196, reasoningOutputTokens: 98 },
    )).toEqual({ totalTokens: 18, inputTokens: 15, cachedInputTokens: 4, outputTokens: 3, reasoningOutputTokens: 2 });
    expect(subtractUsage(
      { totalTokens: 10, inputTokens: 8, outputTokens: 2 },
      { totalTokens: 20, inputTokens: 16, outputTokens: 4 },
    )).toBeUndefined();
  });
  it("keeps request detail only when it reconciles to the turn aggregate", () => {
    const requests = [
      { totalTokens: 7, inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 },
      { totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6 },
    ];
    expect(reconcileProviderRequestUsage(
      { totalTokens: 25, inputTokens: 17, cachedInputTokens: 4, outputTokens: 8 },
      requests,
    )).toEqual(requests);
    expect(reconcileProviderRequestUsage(
      { totalTokens: 26, inputTokens: 18, cachedInputTokens: 4, outputTokens: 8 },
      requests,
    )).toBeUndefined();
  });
  it("derives an exact aggregate from complete per-request checkpoints", () => {
    expect(sumProviderRequestUsage([
      { totalTokens: 7, inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
      { totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2 },
    ])).toEqual({ totalTokens: 25, inputTokens: 17, cachedInputTokens: 4, outputTokens: 8, reasoningOutputTokens: 2 });
    expect(sumProviderRequestUsage([{ totalTokens: 7, inputTokens: 5 }])).toBeUndefined();
  });
  it("separates completed response blocks in Work log output", () => {
    const completed = (id: string, text: string) => mapCodexAppServerNotification({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { id, type: "agentMessage", text } },
    } as never, "/repo");

    const text = [...completed("one", "Acadia."), ...completed("two", "The review is complete.")]
      .flatMap((event) => event.type === "text" ? [event.delta] : [])
      .join("");
    expect(text).toBe("Acadia.\n\nThe review is complete.\n\n");
  });

  it("starts one persistent thread and steers its active turn without spawning another", async () => {
    const controller = new AbortController();
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "ponderosa-thread",
      cwd: here,
      history: [],
      signal: controller.signal,
      bin: "codex",
      spawnFn,
      sandboxMode: "danger-full-access",
      killGraceMs: 50,
    });
    expect(session.engineAgentId).toBe("codex-thread-v1");
    const events: AgentEvent[] = [];
    const collecting = (async () => {
      for await (const event of session.events) {
        events.push(event);
        if (event.type === "turn_done") return;
      }
    })();
    await session.startTurn({ prompt: "initial work", kind: "user_message" });
    expect(await session.steer({ prompt: "new direction", kind: "user_message" }))
      .toEqual({ status: "accepted", turnId: "turn-1" });
    await collecting;
    expect(events).toEqual([
      { type: "session", sessionId: "codex-thread-v1" },
      { type: "text", delta: "steered response\n\n" },
      { type: "command", command: "git status", cwd: "/repo" },
      { type: "tool_result", id: "c1", output: "clean" },
      {
        type: "turn_done",
        usage: { totalTokens: 25, inputTokens: 17, cachedInputTokens: 4, outputTokens: 8, reasoningOutputTokens: 2 },
        providerRequestUsage: [
          { totalTokens: 7, inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
          { totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2 },
        ],
      },
    ]);
    await session.close();
  });

  it("costs the first resumed turn from per-request checkpoints when no cumulative baseline is replayed", async () => {
    const controller = new AbortController();
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const session = await CodexAppServerSession.open({
      agentId: "ponderosa-thread", cwd: here, history: [], resumeSessionId: "codex-thread-v1",
      signal: controller.signal, bin: "codex", spawnFn, sandboxMode: "danger-full-access", killGraceMs: 50,
    });
    const events: AgentEvent[] = [];
    const collecting = (async () => {
      for await (const event of session.events) {
        events.push(event);
        if (event.type === "turn_done") return;
      }
    })();
    await session.startTurn({ prompt: "resumed work", kind: "user_message" });
    await session.steer({ prompt: "finish resumed work", kind: "user_message" });
    await collecting;
    expect(events.at(-1)).toEqual({
      type: "turn_done",
      usage: { totalTokens: 25, inputTokens: 17, cachedInputTokens: 4, outputTokens: 8, reasoningOutputTokens: 2 },
      providerRequestUsage: [
        { totalTokens: 7, inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
        { totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2 },
      ],
    });
    await session.close();
  });

  it("executes host-owned dynamic tools without using the runtime shell", async () => {
    const controller = new AbortController();
    const spawnFn = ((_bin: string, _args: readonly string[], opts: object) =>
      spawn(process.execPath, [fake], opts)) as unknown as typeof spawn;
    const calls: Array<{ name: string; arguments: unknown }> = [];
    const session = await CodexAppServerSession.open({
      agentId: "ponderosa-thread",
      cwd: here,
      history: [],
      signal: controller.signal,
      bin: "codex",
      spawnFn,
      sandboxMode: "workspace-write",
      killGraceMs: 50,
      dynamicTools: [{
        name: "ponderosa_message",
        description: "Send an explicitly scoped Ponderosa message.",
        inputSchema: { type: "object", required: ["intent", "text"] },
      }],
      handleDynamicToolCall: async (call) => {
        calls.push(call);
        return { success: true, text: JSON.stringify({ messageId: "message-1" }) };
      },
    });
    const events: AgentEvent[] = [];
    const collecting = (async () => {
      for await (const event of session.events) {
        events.push(event);
        if (event.type === "turn_done") return;
      }
    })();
    await session.startTurn({ prompt: "send the result", kind: "user_message" });
    await collecting;
    expect(calls).toEqual([{
      name: "ponderosa_message",
      arguments: { intent: "broadcast", text: "Managed result" },
    }]);
    expect(events).toContainEqual({
      type: "tool_call",
      id: "tool-1",
      name: "ponderosa_message",
      input: { intent: "broadcast", text: "Managed result" },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "tool-1" }));
    expect(events).toContainEqual({ type: "text", delta: "Sent through Ponderosa.\n\n" });
    await session.close();
  });
});
