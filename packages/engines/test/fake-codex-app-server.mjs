import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let dynamicToolEnabled = false;

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    dynamicToolEnabled = Array.isArray(message.params?.dynamicTools) && message.params.dynamicTools.length > 0;
    return send({ id: message.id, result: { thread: { id: "codex-thread-v1" } } });
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({ method: "turn/started", params: { threadId: "codex-thread-v1", turn: { id: "turn-1", status: "inProgress" } } });
    if (dynamicToolEnabled) {
      send({ method: "item/started", params: { threadId: "codex-thread-v1", turnId: "turn-1", item: { type: "dynamicToolCall", id: "tool-1", tool: "ponderosa_send_message", arguments: { intent: "broadcast", text: "Managed result" }, status: "inProgress" } } });
      send({
        id: 900,
        method: "item/tool/call",
        params: {
          threadId: "codex-thread-v1",
          turnId: "turn-1",
          callId: "tool-1",
          tool: "ponderosa_send_message",
          arguments: { intent: "broadcast", text: "Managed result" },
        },
      });
    }
    return;
  }
  if (message.id === 900 && message.result) {
    send({ method: "item/completed", params: { threadId: "codex-thread-v1", turnId: "turn-1", item: { type: "dynamicToolCall", id: "tool-1", tool: "ponderosa_send_message", arguments: { intent: "broadcast", text: "Managed result" }, status: "completed", success: true, contentItems: message.result.contentItems } } });
    send({ method: "item/completed", params: { threadId: "codex-thread-v1", turnId: "turn-1", item: { type: "agentMessage", id: "m2", text: "Sent through Ponderosa." } } });
    send({ method: "turn/completed", params: { threadId: "codex-thread-v1", turn: { id: "turn-1", status: "completed", error: null } } });
    return;
  }
  if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: "turn-1" } });
    send({ method: "item/agentMessage/delta", params: { threadId: "codex-thread-v1", turnId: "turn-1", itemId: "m1", delta: "steered " } });
    send({ method: "item/agentMessage/delta", params: { threadId: "codex-thread-v1", turnId: "turn-1", itemId: "m1", delta: "response" } });
    send({ method: "item/completed", params: { threadId: "codex-thread-v1", turnId: "turn-1", item: { type: "agentMessage", id: "m1", text: "steered response" } } });
    send({ method: "item/started", params: { threadId: "codex-thread-v1", turnId: "turn-1", item: { type: "commandExecution", id: "c1", command: "git status", cwd: "/repo" } } });
    send({ method: "item/completed", params: { threadId: "codex-thread-v1", turnId: "turn-1", item: { type: "commandExecution", id: "c1", command: "git status", cwd: "/repo", aggregatedOutput: "clean", exitCode: 0 } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "codex-thread-v1", turnId: "turn-1", tokenUsage: { total: { totalTokens: 981 }, last: { totalTokens: 7, inputTokens: 5, outputTokens: 2 } } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "codex-thread-v1", turnId: "turn-1", tokenUsage: { total: { totalTokens: 999 }, last: { totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2 } } } });
    send({ method: "turn/completed", params: { threadId: "codex-thread-v1", turn: { id: "turn-1", status: "completed", error: null } } });
    return;
  }
  if (message.method === "turn/interrupt") return send({ id: message.id, result: {} });
  send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
});
