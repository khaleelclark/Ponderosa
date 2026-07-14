import { createInterface } from "node:readline";
import { PONDEROSA_SEND_MESSAGE_TOOL, PONDEROSA_SPAWN_AGENT_TOOL, PONDEROSA_WAIT_FOR_REPORTS_TOOL } from "@ponderosa/core";

type RpcRequest = { id?: string | number; method?: string; params?: unknown };

const messageUrl = process.env.PONDEROSA_AGENT_MESSAGE_URL;
const spawnUrl = process.env.PONDEROSA_AGENT_SPAWN_URL;
const waitUrl = process.env.PONDEROSA_AGENT_WAIT_URL;
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
        tools: [
          {
            name: "send_message",
            description: PONDEROSA_SEND_MESSAGE_TOOL.description,
            inputSchema: PONDEROSA_SEND_MESSAGE_TOOL.inputSchema,
          },
          {
            name: "spawn_agent",
            description: PONDEROSA_SPAWN_AGENT_TOOL.description,
            inputSchema: PONDEROSA_SPAWN_AGENT_TOOL.inputSchema,
          },
          {
            name: "wait_for_reports",
            description: PONDEROSA_WAIT_FOR_REPORTS_TOOL.description,
            inputSchema: PONDEROSA_WAIT_FOR_REPORTS_TOOL.inputSchema,
          },
        ],
      },
    });
    return;
  }
  if (request.method === "tools/call") {
    const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
    const targetUrl = params?.name === "send_message"
      ? messageUrl
      : params?.name === "spawn_agent"
        ? spawnUrl
        : params?.name === "wait_for_reports"
          ? waitUrl
        : undefined;
    if (!targetUrl || !messageToken) {
      send({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: "The requested Ponderosa capability is unavailable." }] } });
      return;
    }
    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${messageToken}`, "content-type": "application/json" },
        body: JSON.stringify(params?.arguments ?? {}),
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
