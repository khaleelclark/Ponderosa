import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const lines = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let dynamicToolEnabled = false;
const discovery = process.env.PONDEROSA_TEST_CODEX_CATALOG
  ? JSON.parse(process.env.PONDEROSA_TEST_CODEX_CATALOG)
  : {};
if (process.env.PONDEROSA_TEST_IGNORE_SIGTERM === "1") setInterval(() => undefined, 1_000);

process.on("SIGTERM", () => {
  if (process.env.PONDEROSA_TEST_IGNORE_SIGTERM === "1") return;
  process.exit(0);
});

if (process.env.PONDEROSA_TEST_DESCENDANT_PID_FILE) {
  spawn(process.execPath, [fileURLToPath(new URL("./fake-stubborn-descendant.mjs", import.meta.url))], {
    stdio: "ignore",
    env: {
      ...process.env,
      PONDEROSA_TEST_PROVIDER_PID: String(process.pid),
    },
  });
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") return;
  if (message.method === "initialize") {
    if (process.env.PONDEROSA_TEST_FAIL_INITIALIZE === "1") {
      return send({ id: message.id, error: { code: -32000, message: "simulated initialize failure" } });
    }
    return send({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    if (process.env.PONDEROSA_TEST_FAIL_THREAD_OPEN === "1") {
      return send({ id: message.id, error: { code: -32000, message: "simulated thread open failure" } });
    }
    dynamicToolEnabled = Array.isArray(message.params?.dynamicTools) && message.params.dynamicTools.length > 0;
    send({ id: message.id, result: { thread: { id: "codex-thread-v1" } } });
    for (const notification of discovery.notifications ?? []) send(notification);
    return;
  }
  if (message.method === "skills/list") return send({ id: message.id, result: discovery.skills ?? { data: [{ cwd: process.cwd(), skills: [], errors: [] }] } });
  if (message.method === "plugin/installed") return send({ id: message.id, result: discovery.plugins ?? { marketplaces: [], marketplaceLoadErrors: [] } });
  if (message.method === "plugin/read") {
    const detail = discovery.pluginDetails?.[message.params?.pluginName];
    return detail
      ? send({ id: message.id, result: detail })
      : send({ id: message.id, error: { code: -32000, message: `unknown plugin ${message.params?.pluginName}` } });
  }
  if (message.method === "model/list") {
    const page = Number(message.params?.cursor ?? 0);
    const result = discovery.modelPages?.[page] ?? discovery.models ?? { data: [{ id: "test-model", model: "test-model", hidden: false, isDefault: true }], nextCursor: null };
    return send({ id: message.id, result: discovery.modelPages ? { ...result, nextCursor: page + 1 < discovery.modelPages.length ? String(page + 1) : null } : result });
  }
  if (message.method === "modelProvider/capabilities/read") return send({ id: message.id, result: discovery.modelProviderCapabilities ?? { namespaceTools: true, imageGeneration: false, webSearch: true } });
  if (message.method === "mcpServerStatus/list") {
    const page = Number(message.params?.cursor ?? 0);
    const result = discovery.mcpStatusPages?.[page] ?? discovery.mcpStatuses ?? { data: [], nextCursor: null };
    send({ id: message.id, result: discovery.mcpStatusPages ? { ...result, nextCursor: page + 1 < discovery.mcpStatusPages.length ? String(page + 1) : null } : result });
    if (discovery.notificationsAfterMcpDiscovery) {
      setTimeout(() => {
        for (const notification of discovery.notificationsAfterMcpDiscovery) send(notification);
      }, 10);
    }
    return;
  }
  if (message.method === "thread/compact/start") return send({ id: message.id, result: {} });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({ method: "turn/started", params: { threadId: "codex-thread-v1", turn: { id: "turn-1", status: "inProgress" } } });
    if (message.params?.input?.[0]?.text?.includes("History marker")) {
      send({ method: "item/completed", params: { threadId: "codex-thread-v1", turnId: "turn-1", item: { type: "agentMessage", id: "history", text: message.params.input[0].text } } });
      send({ method: "turn/completed", params: { threadId: "codex-thread-v1", turn: { id: "turn-1", status: "completed", error: null } } });
      return;
    }
    if (dynamicToolEnabled) {
      send({ method: "item/started", params: { threadId: "codex-thread-v1", turnId: "turn-1", item: { type: "dynamicToolCall", id: "tool-1", tool: "ponderosa_message", arguments: { intent: "broadcast", text: "Managed result" }, status: "inProgress" } } });
      send({
        id: 900,
        method: "item/tool/call",
        params: {
          threadId: "codex-thread-v1",
          turnId: "turn-1",
          callId: "tool-1",
          tool: "ponderosa_message",
          arguments: { intent: "broadcast", text: "Managed result" },
        },
      });
    }
    return;
  }
  if (message.id === 900 && message.result) {
    send({ method: "item/completed", params: { threadId: "codex-thread-v1", turnId: "turn-1", item: { type: "dynamicToolCall", id: "tool-1", tool: "ponderosa_message", arguments: { intent: "broadcast", text: "Managed result" }, status: "completed", success: true, contentItems: message.result.contentItems } } });
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
    send({ method: "thread/tokenUsage/updated", params: { threadId: "codex-thread-v1", turnId: "turn-1", tokenUsage: { total: { totalTokens: 7, inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 }, last: { totalTokens: 7, inputTokens: 5, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 } } } });
    send({ method: "thread/tokenUsage/updated", params: { threadId: "codex-thread-v1", turnId: "turn-1", tokenUsage: { total: { totalTokens: 25, inputTokens: 17, cachedInputTokens: 4, outputTokens: 8, reasoningOutputTokens: 2 }, last: { totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2 } } } });
    // Duplicate cumulative checkpoints are possible and must not duplicate the last request.
    send({ method: "thread/tokenUsage/updated", params: { threadId: "codex-thread-v1", turnId: "turn-1", tokenUsage: { total: { totalTokens: 25, inputTokens: 17, cachedInputTokens: 4, outputTokens: 8, reasoningOutputTokens: 2 }, last: { totalTokens: 18, inputTokens: 12, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2 } } } });
    send({ method: "turn/completed", params: { threadId: "codex-thread-v1", turn: { id: "turn-1", status: "completed", error: null } } });
    return;
  }
  if (message.method === "turn/interrupt") return send({ id: message.id, result: {} });
  send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
});
