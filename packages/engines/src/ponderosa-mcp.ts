import { createInterface } from "node:readline";
import { PONDEROSA_SEND_MESSAGE_TOOL } from "@ponderosa/core";

type RpcRequest = { id?: string | number; method?: string; params?: unknown };

const messageUrl = process.env.PONDEROSA_AGENT_MESSAGE_URL;
const messageToken = process.env.PONDEROSA_AGENT_MESSAGE_TOKEN;

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function handle(request: RpcRequest): Promise<void> {
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "ponderosa", version: "1.0.0" },
      },
    });
    return;
  }
  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [{
          name: "send_message",
          description: PONDEROSA_SEND_MESSAGE_TOOL.description,
          inputSchema: PONDEROSA_SEND_MESSAGE_TOOL.inputSchema,
        }],
      },
    });
    return;
  }
  if (request.method === "tools/call") {
    const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
    if (params?.name !== "send_message" || !messageUrl || !messageToken) {
      send({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: "Ponderosa messaging is unavailable." }] } });
      return;
    }
    try {
      const response = await fetch(messageUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${messageToken}`, "content-type": "application/json" },
        body: JSON.stringify(params.arguments ?? {}),
      });
      const text = await response.text();
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { isError: !response.ok, content: [{ type: "text", text }] },
      });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] },
      });
    }
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Unknown method: ${request.method ?? ""}` } });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  try {
    const request = JSON.parse(line) as RpcRequest;
    void handle(request);
  } catch {
    // MCP transports ignore malformed client input and keep serving later calls.
  }
});
