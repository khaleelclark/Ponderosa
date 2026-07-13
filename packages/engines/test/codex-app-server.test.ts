import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@ponderosa/core";
import { CodexAppServerSession } from "../src/codex-app-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, "fake-codex-app-server.mjs");

describe("Codex app-server persistent runtime", () => {
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
      { type: "text", delta: "steered response" },
      { type: "command", command: "git status", cwd: "/repo" },
      { type: "tool_result", id: "c1", output: "clean" },
      { type: "turn_done" },
    ]);
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
        name: "ponderosa_send_message",
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
      name: "ponderosa_send_message",
      arguments: { intent: "broadcast", text: "Managed result" },
    }]);
    expect(events).toContainEqual({
      type: "tool_call",
      id: "tool-1",
      name: "ponderosa_send_message",
      input: { intent: "broadcast", text: "Managed result" },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "tool-1" }));
    expect(events).toContainEqual({ type: "text", delta: "Sent through Ponderosa." });
    await session.close();
  });
});
